import type { FastifyRequest, FastifyReply } from 'fastify';
import { getEnvConfig, loadSettings } from './config.js';

export async function apiKeyAuth(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const settings = await loadSettings();
  const authHeader = request.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    reply.code(401).send({ error: 'Missing or invalid authorization header' });
    return;
  }

  const apiKey = authHeader.slice(7);
  if (!settings.apiKeys.includes(apiKey)) {
    reply.code(401).send({ error: 'Invalid API key' });
    return;
  }
}

export async function adminAuth(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const envConfig = getEnvConfig();
  const authHeader = request.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    reply.code(401).send({ error: 'Missing or invalid authorization header' });
    return;
  }

  const password = authHeader.slice(7);
  if (password !== envConfig.auth.adminPassword) {
    reply.code(401).send({ error: 'Invalid admin password' });
    return;
  }
}

export function errorHandler(error: Error, request: FastifyRequest, reply: FastifyReply): void {
  request.log.error(error);

  const statusCode = (error as any).statusCode || 500;
  const message = error.message || 'Internal server error';

  reply.code(statusCode).send({
    error: {
      message,
      type: 'error',
    },
  });
}
