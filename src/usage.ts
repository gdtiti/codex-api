import { readJSON, writeJSON } from './storage.js';
import { logger } from './logger.js';

export interface ModelUsage {
  modelId: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
}

export async function loadModelUsage(): Promise<ModelUsage[]> {
  const data = await readJSON<{ usage: ModelUsage[] }>('usage.json');
  return data?.usage || [];
}

export async function saveModelUsage(usage: ModelUsage[]): Promise<void> {
  await writeJSON('usage.json', { usage });
}

export async function incrementModelUsage(modelId: string, inputTokens = 0, outputTokens = 0): Promise<void> {
  if (!modelId) return;
  try {
    const usages = await loadModelUsage();
    let usage = usages.find(u => u.modelId === modelId);
    if (!usage) {
      usage = { modelId, requests: 0, inputTokens: 0, outputTokens: 0 };
      usages.push(usage);
    }
    usage.requests += 1;
    usage.inputTokens += inputTokens;
    usage.outputTokens += outputTokens;
    await saveModelUsage(usages);
  } catch (e) {
    logger.error(`Failed to increment model usage: ${e}`);
  }
}
