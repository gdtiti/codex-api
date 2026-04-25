import { createHash, randomBytes, randomUUID } from 'crypto';
import { request } from './http.js';
import { logger } from './logger.js';
import { getSetting } from './config.js';

const pkceStore = new Map<string, { codeVerifier: string; redirectUri: string }>();

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
}

interface TokenResult {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

function generateCodeVerifier(): string {
  return randomBytes(32).toString('base64url');
}

function generateCodeChallenge(codeVerifier: string): string {
  return createHash('sha256').update(codeVerifier).digest('base64url');
}

export function buildRedirectUri(port?: number): string {
  const serverPort = port || 3000;
  return `http://localhost:${serverPort}/api/oauth/callback`;
}

export async function startAuth(redirectUri?: string): Promise<{ url: string; state: string }> {
  const oauthConfig = await getSetting('oauth');
  const resolvedRedirectUri = redirectUri || buildRedirectUri();
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = generateCodeChallenge(codeVerifier);
  const state = randomUUID();

  pkceStore.set(state, { codeVerifier, redirectUri: resolvedRedirectUri });
  setTimeout(() => pkceStore.delete(state), 10 * 60 * 1000);

  const params = new URLSearchParams({
    client_id: oauthConfig.clientId,
    redirect_uri: resolvedRedirectUri,
    response_type: 'code',
    scope: 'openid offline_access',
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    state,
  });

  const url = `${oauthConfig.authUrl}?${params}`;
  return { url, state };
}

export async function exchangeCode(code: string, state: string): Promise<TokenResult> {
  const oauthConfig = await getSetting('oauth');
  const storedPkce = pkceStore.get(state);
  if (!storedPkce) {
    throw new Error('Invalid or expired OAuth state');
  }

  pkceStore.delete(state);

  const response = await request(oauthConfig.tokenUrl, {
    method: 'POST',
    body: {
      grant_type: 'authorization_code',
      client_id: oauthConfig.clientId,
      code,
      redirect_uri: storedPkce.redirectUri,
      code_verifier: storedPkce.codeVerifier,
    },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Token exchange failed: ${text}`);
  }

  const data = (await response.json()) as TokenResponse;

  if (!data.refresh_token) {
    throw new Error('No refresh_token in response');
  }

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresIn: data.expires_in || 3600,
  };
}

export async function refreshToken(refreshTokenValue: string): Promise<TokenResult> {
  const oauthConfig = await getSetting('oauth');

  if (refreshTokenValue.startsWith('eyJ')) {
    return {
      accessToken: refreshTokenValue,
      refreshToken: refreshTokenValue,
      expiresIn: 86400 * 10,
    };
  }

  const response = await request(oauthConfig.tokenUrl, {
    method: 'POST',
    body: {
      grant_type: 'refresh_token',
      client_id: oauthConfig.clientId,
      refresh_token: refreshTokenValue,
    },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Token refresh failed: ${text}`);
  }

  const data = (await response.json()) as TokenResponse;

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || refreshTokenValue,
    expiresIn: data.expires_in || 3600,
  };
}

let refreshInterval: NodeJS.Timeout | null = null;

export function startAutoRefresh(
  intervalMinutes: number,
  refreshCallback: () => Promise<void>
): void {
  if (refreshInterval) {
    clearInterval(refreshInterval);
  }

  const intervalMs = Math.max(intervalMinutes * 60 * 1000, 60000);
  refreshInterval = setInterval(() => {
    refreshCallback().catch((error) => {
      logger.error(`Auto-refresh failed: ${(error as Error).message}`);
    });
  }, intervalMs);

  logger.info(`Token auto-refresh enabled, interval: ${intervalMinutes}min`);
}

export function stopAutoRefresh(): void {
  if (refreshInterval) {
    clearInterval(refreshInterval);
    refreshInterval = null;
    logger.info('Token auto-refresh stopped');
  }
}
