import { getEnvConfig, loadSettings } from './config.js';
import { initializeDataFiles } from './storage.js';
import { createServer } from './server.js';
import { startAutoRefresh, stopAutoRefresh } from './oauth.js';
import { refreshAllTokens } from './accounts.js';
import { logger } from './logger.js';

async function main() {
  const envConfig = getEnvConfig();
  const settings = await loadSettings();

  logger.info('Starting Codex API...');

  await initializeDataFiles();

  if (settings.tokenRefresh.enabled) {
    startAutoRefresh(settings.tokenRefresh.intervalMinutes, refreshAllTokens);
  }

  const app = await createServer();

  await app.listen({
    port: envConfig.server.port,
    host: envConfig.server.host,
  });

  logger.info(`Server listening on ${envConfig.server.host}:${envConfig.server.port}`);

  const shutdown = async (signal: string) => {
    logger.info(`Received ${signal}, shutting down...`);
    stopAutoRefresh();
    await app.close();
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((error) => {
  logger.fatal(`Failed to start server: ${error.stack || error}`);
  process.exit(1);
});
