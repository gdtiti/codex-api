import Fastify from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import { join } from 'path';
import { registerRoutes } from './routes.js';
import { errorHandler } from './middleware.js';
import { logger } from './logger.js';

export async function createServer() {
  const app = Fastify({
    logger: logger as any,
    disableRequestLogging: process.env.NODE_ENV === 'production',
  });

  await app.register(cors, {
    origin: true,
    credentials: true,
  });

  await app.register(fastifyStatic, {
    root: join(process.cwd(), 'static'),
    prefix: '/',
  });

  registerRoutes(app);

  app.setErrorHandler(errorHandler);

  return app;
}
