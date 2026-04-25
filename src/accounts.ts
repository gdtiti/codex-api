import { randomUUID } from 'crypto';
import { readJSON, writeJSON } from './storage.js';
import { refreshToken } from './oauth.js';
import { logger } from './logger.js';
import { getSetting } from './config.js';
import { request } from './http.js';

export interface AccountCredential {
  id: string;
  customName?: string;
  email?: string;
  refreshToken: string;
  accessToken?: string;
  accessTokenExpiry?: number;
  enabled: boolean;
  concurrentLimit: number;
  maxErrorCount: number;
  createdAt: string;
}

export interface AccountQuota {
  accountId: string;
  isHealthy: boolean;
  errorCount: number;
  usageCount: number;
  inputTokens?: number;
  outputTokens?: number;
  currentConcurrent: number;
  lastError?: string;
  lastErrorTime?: string;
  quotaInfo?: QuotaInfo;
}

export interface QuotaInfo {
  models?: Record<string, { remaining: number; used_percent: number }>;
  lastUpdated?: string;
}

const concurrentSlots = new Map<string, number>();
let roundRobinIndex = 0;

export async function loadAccounts(): Promise<AccountCredential[]> {
  const data = await readJSON<{ accounts: AccountCredential[] }>('accounts.json');
  return data?.accounts || [];
}

async function saveAccounts(accounts: AccountCredential[]): Promise<void> {
  await writeJSON('accounts.json', { accounts });
}

export async function loadQuotas(): Promise<AccountQuota[]> {
  const data = await readJSON<{ quotas: AccountQuota[] }>('quotas.json');
  return data?.quotas || [];
}

async function saveQuotas(quotas: AccountQuota[]): Promise<void> {
  await writeJSON('quotas.json', { quotas });
}

export async function getAccount(accountId: string): Promise<AccountCredential | null> {
  const accounts = await loadAccounts();
  return accounts.find((a) => a.id === accountId) || null;
}

export async function getQuota(accountId: string): Promise<AccountQuota | null> {
  const quotas = await loadQuotas();
  return quotas.find((q) => q.accountId === accountId) || null;
}

export async function getAvailableAccount(): Promise<AccountCredential | null> {
  const accounts = await loadAccounts();
  const quotas = await loadQuotas();

  if (accounts.length === 0) {
    roundRobinIndex = 0;
    return null;
  }

  const startIndex = roundRobinIndex % accounts.length;

  for (let offset = 0; offset < accounts.length; offset++) {
    const index = (startIndex + offset) % accounts.length;
    const account = accounts[index];
    if (!account.enabled) continue;

    const quota = quotas.find((q) => q.accountId === account.id);
    if (!quota || !quota.isHealthy) continue;

    const currentSlots = concurrentSlots.get(account.id) || 0;
    if (currentSlots >= account.concurrentLimit) continue;

    roundRobinIndex = (index + 1) % accounts.length;
    acquireSlot(account.id);
    return account;
  }

  roundRobinIndex = startIndex;
  return null;
}

export async function addAccount(
  refreshTokenValue: string,
  customName?: string
): Promise<AccountCredential> {
  const accounts = await loadAccounts();
  const quotas = await loadQuotas();
  const accountConfig = await getSetting('account');

  const id = `acc_${randomUUID().replace(/-/g, '').slice(0, 16)}`;

  const account: AccountCredential = {
    id,
    customName,
    refreshToken: refreshTokenValue,
    enabled: true,
    concurrentLimit: accountConfig.defaultConcurrentLimit,
    maxErrorCount: accountConfig.defaultMaxErrorCount,
    createdAt: new Date().toISOString(),
  };

  try {
    const result = await refreshToken(refreshTokenValue);
    account.accessToken = result.accessToken;
    account.accessTokenExpiry = Date.now() + result.expiresIn * 1000;

    try {
      const parts = result.accessToken.split('.');
      if (parts.length === 3) {
        const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf-8'));
        account.email = payload['https://api.openai.com/profile']?.email || payload.email;
      }
    } catch {}
  } catch (error) {
    logger.warn(`Failed to get initial token for ${id}: ${(error as Error).message}`);
  }

  accounts.push(account);
  await saveAccounts(accounts);

  const quota: AccountQuota = {
    accountId: id,
    isHealthy: true,
    errorCount: 0,
    usageCount: 0,
    currentConcurrent: 0,
  };
  quotas.push(quota);
  await saveQuotas(quotas);

  logger.info(`Added account: ${id} (${customName || 'unnamed'})`);
  return account;
}

export async function deleteAccount(accountId: string): Promise<void> {
  const accounts = await loadAccounts();
  const quotas = await loadQuotas();

  const filtered = accounts.filter((a) => a.id !== accountId);
  await saveAccounts(filtered);

  const filteredQuotas = quotas.filter((q) => q.accountId !== accountId);
  await saveQuotas(filteredQuotas);

  concurrentSlots.delete(accountId);
  logger.info(`Deleted account: ${accountId}`);
}

export async function toggleAccount(accountId: string, enabled: boolean): Promise<void> {
  const accounts = await loadAccounts();
  const account = accounts.find((a) => a.id === accountId);
  if (!account) throw new Error('Account not found');

  account.enabled = enabled;
  await saveAccounts(accounts);
  logger.info(`Toggled account ${accountId}: ${enabled ? 'enabled' : 'disabled'}`);
}

export async function markAccountError(accountId: string, error: string): Promise<void> {
  const accounts = await loadAccounts();
  const quotas = await loadQuotas();

  const account = accounts.find((a) => a.id === accountId);
  const quota = quotas.find((q) => q.accountId === accountId);

  if (!account || !quota) return;

  quota.errorCount++;
  quota.lastError = error;
  quota.lastErrorTime = new Date().toISOString();

  let accountsUpdated = false;
  if (quota.errorCount >= account.maxErrorCount) {
    quota.isHealthy = false;
    account.enabled = false;
    accountsUpdated = true;
    logger.warn(`Account ${accountId} marked unhealthy and disabled (errors: ${quota.errorCount})`);
  }

  await saveQuotas(quotas);
  if (accountsUpdated) {
    await saveAccounts(accounts);
  }
}

export async function incrementUsageCount(accountId: string, inputTokens = 0, outputTokens = 0): Promise<void> {
  const quotas = await loadQuotas();
  const quota = quotas.find((q) => q.accountId === accountId);

  if (!quota) return;

  quota.usageCount = (quota.usageCount || 0) + 1;
  quota.inputTokens = (quota.inputTokens || 0) + inputTokens;
  quota.outputTokens = (quota.outputTokens || 0) + outputTokens;

  if (quota.errorCount > 0 || !quota.isHealthy) {
    quota.errorCount = 0;
    quota.isHealthy = true;
    quota.lastError = undefined;
    quota.lastErrorTime = undefined;
  }
  await saveQuotas(quotas);
}

export async function refreshAccountQuota(accountId: string): Promise<void> {
  logger.info(`Refreshing quota for account: ${accountId}`);

  try {
    const accessToken = await getAccessToken(accountId);
    const apiConfig = await getSetting('api');
    const url = 'https://chatgpt.com/backend-api/wham/usage';

    const headers: Record<string, string> = {
      'authorization': `Bearer ${accessToken}`,
      'user-agent': `codex_cli_rs/${apiConfig.clientVersion || '0.125.0'} (Windows 10.0.26100; x86_64) WindowsTerminal`,
      'accept': '*/*',
      'host': 'chatgpt.com'
    };

    try {
      if (accessToken.startsWith('eyJ')) {
        const parts = accessToken.split('.');
        if (parts.length === 3) {
          const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf-8'));
          if (payload['chatgpt_account_id']) {
            headers['chatgpt-account-id'] = payload['chatgpt_account_id'];
          }
        }
      }
    } catch {}

    const response = await request(url, {
      method: 'GET',
      headers
    });

    if (!response.ok) {
      throw new Error(`Usage API returned HTTP ${response.status}`);
    }

    const data = (await response.json()) as any;
    const quotas = await loadQuotas();
    const quota = quotas.find(q => q.accountId === accountId);

    if (quota) {

      if (!quota.isHealthy) {
        quota.isHealthy = true;
        quota.errorCount = 0;
        logger.info(`Account ${accountId} health auto-reset on successful quota refresh`);
      }

      if (!quota.quotaInfo) quota.quotaInfo = {};
      quota.quotaInfo.models = {};

      if (data.rate_limit && data.rate_limit.primary_window) {
        const primaryWindow = data.rate_limit.primary_window;
        const usedPercent = primaryWindow.used_percent || 0;
        const remaining = Math.max(0, Math.min(1, 1 - (usedPercent / 100)));

        quota.quotaInfo.models['default'] = {
          remaining,
          used_percent: usedPercent
        };
      }

      (quota.quotaInfo as any).planType = data.plan_type || 'unknown';
      (quota.quotaInfo as any).raw = {
        planType: data.plan_type || 'unknown',
        rateLimit: data.rate_limit,
        codeReviewRateLimit: data.code_review_rate_limit,
        credits: data.credits
      };

      quota.quotaInfo.lastUpdated = new Date().toISOString();
      await saveQuotas(quotas);
      logger.info(`Quota refreshed for ${accountId} (Plan: ${data.plan_type || 'unknown'})`);
    }
  } catch (error) {
    logger.error(`Failed to refresh quota for ${accountId}: ${(error as Error).message}`);
    throw error;
  }
}

export async function resetUnhealthyAccounts(): Promise<number> {
  const quotas = await loadQuotas();
  let count = 0;

  for (const quota of quotas) {
    if (!quota.isHealthy || quota.errorCount > 0) {
      quota.isHealthy = true;
      quota.errorCount = 0;
      quota.lastError = undefined;
      quota.lastErrorTime = undefined;
      count++;
    }
  }

  if (count > 0) {
    await saveQuotas(quotas);
    logger.info(`Reset ${count} unhealthy accounts`);
  }

  return count;
}

export async function deleteUnhealthyAccounts(): Promise<number> {
  const accounts = await loadAccounts();
  const quotas = await loadQuotas();

  const unhealthyIds = new Set(
    quotas.filter(q => !q.isHealthy).map(q => q.accountId)
  );

  if (unhealthyIds.size === 0) return 0;

  const filteredAccounts = accounts.filter(a => !unhealthyIds.has(a.id));
  const filteredQuotas = quotas.filter(q => !unhealthyIds.has(q.accountId));

  await saveAccounts(filteredAccounts);
  await saveQuotas(filteredQuotas);

  for (const id of unhealthyIds) {
    concurrentSlots.delete(id);
  }

  logger.info(`Deleted ${unhealthyIds.size} unhealthy accounts`);
  return unhealthyIds.size;
}

export function acquireSlot(accountId: string): boolean {
  const current = concurrentSlots.get(accountId) || 0;
  concurrentSlots.set(accountId, current + 1);
  return true;
}

export function releaseSlot(accountId: string): void {
  const current = concurrentSlots.get(accountId) || 0;
  if (current > 0) {
    concurrentSlots.set(accountId, current - 1);
  }
}

export async function refreshAllTokens(): Promise<void> {
  const accounts = await loadAccounts();
  const nearMs = 5 * 60 * 1000;

  for (const account of accounts) {
    if (!account.enabled) continue;
    if (account.accessTokenExpiry && account.accessTokenExpiry - Date.now() > nearMs) continue;

    try {
      logger.debug(`Refreshing token for account: ${account.id}`);
      const result = await refreshToken(account.refreshToken);
      account.accessToken = result.accessToken;
      account.accessTokenExpiry = Date.now() + result.expiresIn * 1000;
      if (result.refreshToken !== account.refreshToken) {
        account.refreshToken = result.refreshToken;
      }
    } catch (error) {
      logger.warn(`Token refresh failed for ${account.id}: ${(error as Error).message}`);
    }
  }

  await saveAccounts(accounts);
}

export async function getAccessToken(accountId: string): Promise<string> {
  const accounts = await loadAccounts();
  const account = accounts.find((a) => a.id === accountId);

  if (!account) throw new Error('Account not found');

  if (account.accessToken && account.accessTokenExpiry) {
    if (Date.now() < account.accessTokenExpiry - 60000) {
      return account.accessToken;
    }
  }

  const result = await refreshToken(account.refreshToken);
  account.accessToken = result.accessToken;
  account.accessTokenExpiry = Date.now() + result.expiresIn * 1000;
  if (result.refreshToken !== account.refreshToken) {
    account.refreshToken = result.refreshToken;
  }

  try {
    const parts = result.accessToken.split('.');
    if (parts.length === 3) {
      const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf-8'));
      account.email = payload['https://api.openai.com/profile']?.email || payload.email || account.email;
    }
  } catch {}

  await saveAccounts(accounts);
  return account.accessToken;
}
