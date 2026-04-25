import { logger } from './logger.js';
import { createSession, type Session as WreqSession } from 'wreq-js';

const sessions = new Map<string, WreqSession>();

async function getSession(): Promise<WreqSession> {
  const key = 'default';
  const existing = sessions.get(key);
  if (existing) return existing;

  const created = await createSession({
    browser: 'chrome_130',
  });
  sessions.set(key, created);
  return created;
}

interface RequestOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
  timeout?: number;
}

export async function request(url: string, options: RequestOptions = {}): Promise<Response> {
  const { method = 'GET', headers = {}, body, timeout = 30000 } = options;

  const session = await getSession();

  try {
    const init: any = {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...headers,
      },
      timeout,
    };

    if (body !== undefined) {
      init.body = typeof body === 'string' ? body : JSON.stringify(body);
    }

    const response = await session.fetch(url, init);

    return response as unknown as Response;
  } catch (error) {
    throw error;
  }
}

export async function streamRequest(
  url: string,
  options: RequestOptions = {}
): Promise<ReadableStream<Uint8Array>> {
  const response = await request(url, options);

  if (!response.ok) {
    let text = '';
    try {
      text = await response.text();
    } catch {}
    throw new Error(`HTTP ${response.status}: ${text}`);
  }

  if (!response.body) {
    throw new Error('Response body is null');
  }

  return new ReadableStream({
    async start(controller) {
      try {
        for await (const chunk of response.body as any) {
          controller.enqueue(chunk);
        }
        controller.close();
      } catch (err) {
        controller.error(err);
      }
    }
  });
}
