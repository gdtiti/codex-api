import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { logger } from './logger.js';

const DATA_DIR = join(process.cwd(), 'data');

export async function ensureDataDir(): Promise<void> {
  if (!existsSync(DATA_DIR)) {
    await mkdir(DATA_DIR, { recursive: true });
    logger.info('Created data directory');
  }
}

export async function readJSON<T>(filename: string): Promise<T | null> {
  const filepath = join(DATA_DIR, filename);
  try {
    if (!existsSync(filepath)) return null;
    const content = await readFile(filepath, 'utf-8');
    return JSON.parse(content);
  } catch (error) {
    logger.error(`Failed to read ${filename}: ${(error as Error).message}`);
    return null;
  }
}

export async function writeJSON(filename: string, data: unknown): Promise<void> {
  const filepath = join(DATA_DIR, filename);
  try {
    await ensureDataDir();
    await writeFile(filepath, JSON.stringify(data, null, 2), 'utf-8');
  } catch (error) {
    logger.error(`Failed to write ${filename}: ${(error as Error).message}`);
    throw error;
  }
}

export async function initializeDataFiles(): Promise<void> {
  await ensureDataDir();

  const accounts = await readJSON('accounts.json');
  if (!accounts) {
    await writeJSON('accounts.json', { accounts: [] });
    logger.info('Initialized accounts.json');
  }

  const quotas = await readJSON('quotas.json');
  if (!quotas) {
    await writeJSON('quotas.json', { quotas: [] });
    logger.info('Initialized quotas.json');
  }

  const models = await readJSON('models.json');
  if (!models) {
    await writeJSON('models.json', { models: [], lastUpdated: null });
    logger.info('Initialized models.json');
  }

  const settings = await readJSON('settings.json');
  if (!settings) {
    await writeJSON('settings.json', {
      retry: {
        maxAttempts: 3,
        switchAccountOnError: true,
      },
      logging: {
        requestLogs: true,
        maxLogSize: 1000,
      },
    });
    logger.info('Initialized settings.json');
  }
}
