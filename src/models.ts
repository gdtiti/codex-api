import { request } from './http.js';
import { readJSON, writeJSON } from './storage.js';
import { getAccessToken } from './accounts.js';
import { logger } from './logger.js';
import { getSetting } from './config.js';

export interface ModelInfo {
  id: string;
  name: string;
  contextWindow: number;
  maxOutputTokens: number;
  inputPrice: number;
  outputPrice: number;
  capabilities: string[];
  enabled?: boolean;
}

export async function getModels(): Promise<ModelInfo[]> {
  const data = await readJSON<{ models: ModelInfo[]; lastUpdated: string | null }>('models.json');
  return data?.models || [];
}

export async function fetchModels(accountId: string): Promise<ModelInfo[]> {
  const accessToken = await getAccessToken(accountId);
  const apiConfig = await getSetting('api');

  const url = `${apiConfig.modelsApiUrl}?client_version=${apiConfig.clientVersion}`;

  const response = await request(url, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to fetch models: ${text}`);
  }

  const etag = response.headers.get('etag');
  if (etag) {
    logger.debug(`Models ETag: ${etag}`);
  }

  const data = (await response.json()) as { models: Array<any> };

  const codexModels = data.models || [];

  const models: ModelInfo[] = codexModels.map((m) => {
    const capabilities: string[] = ['text'];
    if (m.input_modalities && m.input_modalities.includes('image')) {
      capabilities.push('vision');
    }
    if (m.supported_reasoning_levels && m.supported_reasoning_levels.length > 0) {
      capabilities.push('thinking');
    }

    return {
      id: m.slug,
      name: m.display_name || m.slug,
      contextWindow: m.context_window || m.max_context_window || 128000,
      maxOutputTokens: 8192,
      inputPrice: 0,
      outputPrice: 0,
      capabilities,
    };
  });

  return models;
}

export async function updateModels(accountId: string): Promise<void> {
  logger.info('Updating models cache...');
  const newModels = await fetchModels(accountId);
  const oldModels = await getModels();

  const models = newModels.map(nm => {
    const old = oldModels.find(om => om.id === nm.id);
    return {
      ...nm,
      enabled: old?.enabled ?? true,
    };
  });

  await writeJSON('models.json', {
    models,
    lastUpdated: new Date().toISOString(),
  });

  logger.info(`Updated ${models.length} models`);
}

export async function toggleModel(modelId: string, enabled: boolean): Promise<void> {
  const data = await readJSON<{ models: ModelInfo[]; lastUpdated: string | null }>('models.json');
  if (!data || !data.models) return;
  const model = data.models.find(m => m.id === modelId);
  if (model) {
    model.enabled = enabled;
    await writeJSON('models.json', data);
  }
}
