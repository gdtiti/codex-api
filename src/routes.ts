import os from 'os';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { handleChatCompletion, handleResponses } from './handler.js';
import { getModels, updateModels, toggleModel } from './models.js';
import { loadModelUsage } from './usage.js';
import { apiKeyAuth, adminAuth } from './middleware.js';
import {
  loadAccounts,
  loadQuotas,
  addAccount,
  deleteAccount,
  toggleAccount,
  refreshAccountQuota,
  resetUnhealthyAccounts,
  deleteUnhealthyAccounts,
} from './accounts.js';
import { startAuth, exchangeCode } from './oauth.js';
import { getEnvConfig, loadSettings, updateSettings, type SystemSettings } from './config.js';
import { logStream, type LogEvent } from './logs.js';
import type { OpenAIChatRequest, OpenAIResponsesRequest } from './converter.js';

export function registerRoutes(app: FastifyInstance): void {

  app.post('/v1/chat/completions', {
    preHandler: apiKeyAuth,
    handler: async (request: FastifyRequest, reply: FastifyReply) => {
      const body = request.body as OpenAIChatRequest;
      const stream = body.stream || false;

      const response = await handleChatCompletion(body, stream);

      reply.code(response.status);
      for (const [key, value] of response.headers.entries()) {
        reply.header(key, value);
      }

      return reply.send(response.body);
    },
  });

  app.post('/v1/responses', {
    preHandler: apiKeyAuth,
    handler: async (request: FastifyRequest, reply: FastifyReply) => {
      const body = request.body as OpenAIResponsesRequest;
      const stream = body.stream || false;

      const response = await handleResponses(body, stream);

      reply.code(response.status);
      for (const [key, value] of response.headers.entries()) {
        reply.header(key, value);
      }

      return reply.send(response.body);
    },
  });

  app.get('/v1/models', {
    preHandler: apiKeyAuth,
    handler: async (request: FastifyRequest, reply: FastifyReply) => {
      const models = await getModels();
      const enabledModels = models.filter(m => m.enabled !== false);

      return reply.send({
        object: 'list',
        data: enabledModels.map((m) => ({
          id: m.id,
          object: 'model',
          created: Math.floor(Date.now() / 1000),
          owned_by: 'openai',
        })),
      });
    },
  });

  app.post('/api/admin/auth/login', {
    handler: async (request: FastifyRequest, reply: FastifyReply) => {
      const { password } = request.body as { password?: string };
      const envConfig = getEnvConfig();

      if (password === envConfig.auth.adminPassword) {
        return reply.send({ token: password });
      } else {
        return reply.code(401).send({ error: 'Invalid password' });
      }
    },
  });

  app.get('/api/admin/accounts', {
    preHandler: adminAuth,
    handler: async (request: FastifyRequest, reply: FastifyReply) => {
      const accounts = await loadAccounts();
      const quotas = await loadQuotas();

      const merged = accounts.map((account) => {
        const quota = quotas.find((q) => q.accountId === account.id);
        return {
          id: account.id,
          customName: account.customName,
          email: account.email,
          enabled: account.enabled,
          concurrentLimit: account.concurrentLimit,
          maxErrorCount: account.maxErrorCount,
          createdAt: account.createdAt,
          isHealthy: quota?.isHealthy ?? true,
          errorCount: quota?.errorCount ?? 0,
          usageCount: quota?.usageCount ?? 0,
          lastError: quota?.lastError,
          lastErrorTime: quota?.lastErrorTime,
          quotaInfo: quota?.quotaInfo,
        };
      });

      return reply.send({ accounts: merged });
    },
  });

  app.post('/api/admin/accounts', {
    preHandler: adminAuth,
    handler: async (request: FastifyRequest, reply: FastifyReply) => {
      const { refreshToken, customName } = request.body as {
        refreshToken: string;
        customName?: string;
      };

      if (!refreshToken) {
        return reply.code(400).send({ error: 'refreshToken is required' });
      }

      const account = await addAccount(refreshToken, customName);
      return reply.send({ account });
    },
  });

  app.delete('/api/admin/accounts/:id', {
    preHandler: adminAuth,
    handler: async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as { id: string };
      await deleteAccount(id);
      return reply.send({ success: true });
    },
  });

  app.post('/api/admin/accounts/:id/toggle', {
    preHandler: adminAuth,
    handler: async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as { id: string };
      const { enabled } = request.body as { enabled: boolean };
      await toggleAccount(id, enabled);
      return reply.send({ success: true });
    },
  });

  app.post('/api/admin/accounts/:id/refresh-quota', {
    preHandler: adminAuth,
    handler: async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as { id: string };
      await refreshAccountQuota(id);
      return reply.send({ success: true });
    },
  });

  app.post('/api/admin/accounts/refresh-unhealthy-ids', {
    preHandler: adminAuth,
    handler: async (request: FastifyRequest, reply: FastifyReply) => {
      const count = await resetUnhealthyAccounts();
      return reply.send({ success: true, refreshed: count });
    },
  });

  app.delete('/api/admin/accounts/unhealthy', {
    preHandler: adminAuth,
    handler: async (request: FastifyRequest, reply: FastifyReply) => {
      const count = await deleteUnhealthyAccounts();
      return reply.send({ success: true, removed: count });
    },
  });

  app.get('/api/admin/models', {
    preHandler: adminAuth,
    handler: async (request: FastifyRequest, reply: FastifyReply) => {
      const models = await getModels();
      const usages = await loadModelUsage();
      const enrichedModels = models.map(m => {
        const usage = usages.find(u => u.modelId === m.id);
        return {
          ...m,
          requests: usage?.requests || 0,
          inputTokens: usage?.inputTokens || 0,
          outputTokens: usage?.outputTokens || 0,
        };
      });
      return reply.send({ models: enrichedModels });
    },
  });

  app.post('/api/admin/models/refresh', {
    preHandler: adminAuth,
    handler: async (request: FastifyRequest, reply: FastifyReply) => {
      const { accountId } = request.body as { accountId: string };

      if (!accountId) {
        return reply.code(400).send({ error: 'accountId is required' });
      }

      await updateModels(accountId);
      return reply.send({ success: true });
    },
  });

  app.post('/api/admin/models/:id/toggle', {
    preHandler: adminAuth,
    handler: async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as { id: string };
      const { enabled } = request.body as { enabled: boolean };
      await toggleModel(id, enabled);
      return reply.send({ success: true });
    },
  });

  app.get('/api/admin/settings', {
    preHandler: adminAuth,
    handler: async (request: FastifyRequest, reply: FastifyReply) => {
      const settings = await loadSettings();
      return reply.send({ settings });
    },
  });

  app.put('/api/admin/settings', {
    preHandler: adminAuth,
    handler: async (request: FastifyRequest, reply: FastifyReply) => {
      const partial = request.body as Partial<SystemSettings>;
      const updated = await updateSettings(partial);
      return reply.send({ settings: updated });
    },
  });

  app.get('/api/admin/logs', {
    preHandler: adminAuth,
    handler: async (request: FastifyRequest, reply: FastifyReply) => {

      return reply.send({ logs: [] });
    },
  });

  app.get('/api/admin/usage', {
    preHandler: adminAuth,
    handler: async (request: FastifyRequest, reply: FastifyReply) => {
      const accounts = await loadAccounts();
      const quotas = await loadQuotas();

      let totalRequests = 0;
      const breakdown: any[] = [];

      accounts.forEach(acc => {
        const quota = quotas.find(q => q.accountId === acc.id);
        const count = quota?.usageCount ?? 0;
        totalRequests += count;
        breakdown.push({
          type: acc.customName || acc.id,
          requests: count,
          inputTokens: quota?.inputTokens ?? 0,
          outputTokens: quota?.outputTokens ?? 0
        });
      });

      return reply.send({
        totalRequests,
        breakdown
      });
    },
  });

  app.get('/api/admin/usage/timeline', {
    preHandler: adminAuth,
    handler: async (request: FastifyRequest, reply: FastifyReply) => {

      return reply.send({
        labels: [],
        series: []
      });
    },
  });

  app.get('/api/admin/system', {
    preHandler: adminAuth,
    handler: async (request: FastifyRequest, reply: FastifyReply) => {
      const memTotal = Math.floor(os.totalmem() / 1024 / 1024);
      const memFree = Math.floor(os.freemem() / 1024 / 1024);
      const heap = process.memoryUsage();

      return reply.send({
        platform: os.platform(),
        arch: os.arch(),
        nodeVersion: process.version,
        uptime: Math.floor(process.uptime()),
        cpuCores: os.cpus().length,
        loadAvg: os.loadavg(),
        totalMemory: memTotal,
        freeMemory: memFree,
        memory: {
          heapTotal: Math.floor(heap.heapTotal / 1024 / 1024),
          heapUsed: Math.floor(heap.heapUsed / 1024 / 1024),
          rss: Math.floor(heap.rss / 1024 / 1024)
        }
      });
    },
  });

  app.get('/api/admin/service-mode', {
    preHandler: adminAuth,
    handler: async (request: FastifyRequest, reply: FastifyReply) => {
      return reply.send({
        mode: process.env.NODE_ENV || 'development',
        pm2: !!process.env.PM2_HOME
      });
    },
  });

  app.post('/api/admin/restart-service', {
    preHandler: adminAuth,
    handler: async (request: FastifyRequest, reply: FastifyReply) => {
      setTimeout(() => process.exit(0), 500);
      return reply.send({ message: 'Restarting service...' });
    },
  });

  app.get('/api/admin/providers', {
    preHandler: adminAuth,
    handler: async (request: FastifyRequest, reply: FastifyReply) => {
      return reply.send({
        providers: [{
          name: 'Codex',
          enabled: true
        }]
      });
    },
  });

  app.get('/api/admin/system/update/check', {
    preHandler: adminAuth,
    handler: async (request: FastifyRequest, reply: FastifyReply) => {
      return reply.send({
        currentVersion: '1.0.0',
        latestVersion: '1.0.0',
        updateAvailable: false
      });
    },
  });

  app.post('/api/admin/system/update/perform', {
    preHandler: adminAuth,
    handler: async (request: FastifyRequest, reply: FastifyReply) => {
      return reply.send({ message: 'System is already up to date' });
    },
  });

  app.get('/api/events', {
    handler: async (request: FastifyRequest, reply: FastifyReply) => {
      const { token } = request.query as { token?: string };
      const envConfig = getEnvConfig();

      if (token !== envConfig.auth.adminPassword) {
        return reply.code(401).send({ error: 'Unauthorized' });
      }

      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      });

      reply.raw.write(`data: ${JSON.stringify({ event: 'connected', timestamp: Date.now() })}\n\n`);

      const history = logStream.getRecent(100);
      for (const entry of history) {
        reply.raw.write(`data: ${JSON.stringify({ event: 'log', ...entry })}\n\n`);
      }

      const onLog = (entry: LogEvent) => {
        try {
          reply.raw.write(`data: ${JSON.stringify({ event: 'log', ...entry })}\n\n`);
        } catch {}
      };
      logStream.on('log', onLog);

      const heartbeat = setInterval(() => {
        try {
          reply.raw.write(`data: ${JSON.stringify({ event: 'heartbeat', timestamp: Date.now() })}\n\n`);
        } catch {}
      }, 30000);

      request.raw.on('close', () => {
        clearInterval(heartbeat);
        logStream.off('log', onLog);
      });
    },
  });

  app.get('/api/oauth/start', {
    handler: async (request: FastifyRequest, reply: FastifyReply) => {
      const { url, state } = await startAuth();
      return reply.send({ url, state });
    },
  });

  app.get('/api/oauth/callback', {
    handler: async (request: FastifyRequest, reply: FastifyReply) => {
      const { code, state } = request.query as { code: string; state: string };

      if (!code || !state) {
        return reply.code(400).send({ error: 'Missing code or state' });
      }

      try {
        const result = await exchangeCode(code, state);
        return reply.send({
          success: true,
          refreshToken: result.refreshToken,
        });
      } catch (error) {
        return reply.code(400).send({ error: (error as Error).message });
      }
    },
  });

  app.get('/health', {
    logLevel: 'silent',
    handler: async (request: FastifyRequest, reply: FastifyReply) => {
      return reply.send({ status: 'ok' });
    },
  });
}
