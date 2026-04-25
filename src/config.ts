import { z } from 'zod';
import dotenv from 'dotenv';
import { readJSON, writeJSON } from './storage.js';
import { logger } from './logger.js';

dotenv.config();

const envConfigSchema = z.object({
  server: z.object({
    port: z.number().default(3000),
    host: z.string().default('0.0.0.0'),
  }),
  auth: z.object({
    adminPassword: z.string().min(1),
  }),
  logging: z.object({
    level: z.string().default('info'),
  }),
});

export type EnvConfig = z.infer<typeof envConfigSchema>;

let cachedEnvConfig: EnvConfig | null = null;

export function getEnvConfig(): EnvConfig {
  if (cachedEnvConfig) return cachedEnvConfig;

  const adminPassword = process.env.ADMIN_PASSWORD || 'admin';
  
  if (adminPassword === 'admin' && process.env.NODE_ENV === 'production') {
    logger.warn('⚠️ [SECURITY WARNING] You are using the default admin password "admin" in production!');
    logger.warn('⚠️ Please set the ADMIN_PASSWORD environment variable immediately.');
  }

  const config = envConfigSchema.parse({
    server: {
      port: parseInt(process.env.PORT || '3000', 10),
      host: process.env.HOST || '0.0.0.0',
    },
    auth: {
      adminPassword,
    },
    logging: {
      level: process.env.LOG_LEVEL || 'info',
    },
  });

  cachedEnvConfig = config;
  return config;
}

export interface SystemSettings {

  apiKeys: string[];

  tokenRefresh: {
    enabled: boolean;
    intervalMinutes: number;
  };

  retry: {
    maxAttempts: number;
    switchAccountOnError: boolean;
  };

  account: {
    defaultConcurrentLimit: number;
    defaultMaxErrorCount: number;
  };

  api: {
    clientVersion: string;
    codexBaseUrl: string;
    modelsApiUrl: string;
  };

  oauth: {
    clientId: string;
    tokenUrl: string;
    authUrl: string;
  };

  logging: {
    requestLogs: boolean;
    maxLogSize: number;
  };
}

const defaultSettings: SystemSettings = {
  apiKeys: [],
  tokenRefresh: {
    enabled: true,
    intervalMinutes: 30,
  },
  retry: {
    maxAttempts: 3,
    switchAccountOnError: true,
  },
  account: {
    defaultConcurrentLimit: 5,
    defaultMaxErrorCount: 5,
  },
  api: {
    clientVersion: '0.125.0',
    codexBaseUrl: 'https://chatgpt.com/backend-api/codex',
    modelsApiUrl: 'https://chatgpt.com/backend-api/codex/models',
  },
  oauth: {
    clientId: 'app_EMoamEEZ73f0CkXaXp7hrann',
    tokenUrl: 'https://auth.openai.com/oauth/token',
    authUrl: 'https://auth.openai.com/oauth/authorize',
  },
  logging: {
    requestLogs: true,
    maxLogSize: 1000,
  },
};

let cachedSettings: SystemSettings | null = null;

export async function loadSettings(): Promise<SystemSettings> {
  if (cachedSettings) return cachedSettings;

  const data = await readJSON<SystemSettings>('settings.json');

  if (!data) {

    const initialSettings: SystemSettings = {
      ...defaultSettings,
      apiKeys: (process.env.API_KEYS || '').split(',').filter(Boolean) || defaultSettings.apiKeys,
      tokenRefresh: {
        enabled: process.env.AUTO_REFRESH_TOKEN !== 'false',
        intervalMinutes: parseInt(process.env.REFRESH_INTERVAL_MINUTES || '30', 10),
      },
    };

    await writeJSON('settings.json', initialSettings);
    cachedSettings = initialSettings;
    logger.info('Initialized settings.json with defaults');
    return initialSettings;
  }

  cachedSettings = data;
  return data;
}

export async function saveSettings(settings: SystemSettings): Promise<void> {
  await writeJSON('settings.json', settings);
  cachedSettings = settings;
  logger.info('Settings updated');
}

function deepMerge<T extends Record<string, any>>(target: T, source: Partial<T>): T {
  const result = { ...target };
  for (const key of Object.keys(source) as (keyof T)[]) {
    const sourceVal = source[key];
    const targetVal = target[key];
    if (
      sourceVal !== undefined &&
      sourceVal !== null &&
      typeof sourceVal === 'object' &&
      !Array.isArray(sourceVal) &&
      typeof targetVal === 'object' &&
      !Array.isArray(targetVal) &&
      targetVal !== null
    ) {
      (result as any)[key] = deepMerge(targetVal as any, sourceVal as any);
    } else if (sourceVal !== undefined) {
      (result as any)[key] = sourceVal;
    }
  }
  return result;
}

export async function updateSettings(partial: Partial<SystemSettings>): Promise<SystemSettings> {
  const current = await loadSettings();
  const updated = deepMerge(current, partial);
  await saveSettings(updated);
  return updated;
}

export function reloadSettings(): void {
  cachedSettings = null;
}

export async function getSetting<K extends keyof SystemSettings>(key: K): Promise<SystemSettings[K]> {
  const settings = await loadSettings();
  return settings[key];
}

export interface Config {
  server: EnvConfig['server'];
  auth: {
    adminPassword: string;
    apiKeys: string[];
  };
  tokenRefresh: SystemSettings['tokenRefresh'];
  retry: SystemSettings['retry'];
  logging: EnvConfig['logging'] & SystemSettings['logging'];
}

export async function getConfig(): Promise<Config> {
  const env = getEnvConfig();
  const settings = await loadSettings();

  return {
    server: env.server,
    auth: {
      adminPassword: env.auth.adminPassword,
      apiKeys: settings.apiKeys,
    },
    tokenRefresh: settings.tokenRefresh,
    retry: settings.retry,
    logging: {
      level: env.logging.level,
      requestLogs: settings.logging.requestLogs,
      maxLogSize: settings.logging.maxLogSize,
    },
  };
}
