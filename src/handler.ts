import { request, streamRequest } from './http.js';
import { getAvailableAccount, getAccessToken, markAccountError, releaseSlot, incrementUsageCount } from './accounts.js';
import { incrementModelUsage } from './usage.js';
import { openaiToCodex, codexToOpenai, codexStreamToOpenai, getSessionCacheId, responsesToCodex } from './converter.js';
import type { OpenAIChatRequest, OpenAIChatResponse, OpenAIResponsesRequest, CodexRequest, CodexResponse } from './converter.js';
import { logger } from './logger.js';
import { logStream } from './logs.js';
import { getSetting } from './config.js';

interface RequestContext {
  accountId: string;
  model: string;
  stream: boolean;
  attempt: number;
}

type ReleaseSlot = () => void;

function once(fn: ReleaseSlot): ReleaseSlot {
  let called = false;
  return () => {
    if (called) return;
    called = true;
    fn();
  };
}

function releaseWhenStreamCloses(stream: ReadableStream<Uint8Array>, release: ReleaseSlot): ReadableStream<Uint8Array> {
  const reader = stream.getReader();

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          release();
          controller.close();
          return;
        }
        if (value) {
          controller.enqueue(value);
        }
      } catch (error) {
        release();
        controller.error(error);
      }
    },
    async cancel(reason) {
      try {
        await reader.cancel(reason);
      } finally {
        release();
      }
    },
  });
}

export async function handleChatCompletion(
  body: OpenAIChatRequest,
  stream: boolean
): Promise<Response> {
  const account = await getAvailableAccount();
  if (!account) {
    return new Response(JSON.stringify({ error: 'No available accounts' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const release = once(() => releaseSlot(account.id));
  let releaseOnReturn = true;

  try {
    const ctx: RequestContext = {
      accountId: account.id,
      model: body.model,
      stream,
      attempt: 0,
    };

    logStream.push('info', `Chat 请求 → ${body.model}`, { type: 'chat', model: body.model, stream, account: account.id });

    if (stream) {
      const response = await handleStreamRequest(body, ctx, release);
      releaseOnReturn = false;
      return response;
    } else {
      return await handleUnaryRequest(body, ctx);
    }
  } finally {
    if (releaseOnReturn) {
      release();
    }
  }
}

export async function handleResponses(
  body: OpenAIResponsesRequest,
  stream: boolean
): Promise<Response> {
  const account = await getAvailableAccount();
  if (!account) {
    return new Response(JSON.stringify({ error: 'No available accounts' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const release = once(() => releaseSlot(account.id));
  let releaseOnReturn = true;

  try {
    const ctx: RequestContext = {
      accountId: account.id,
      model: body.model,
      stream,
      attempt: 0,
    };

    logStream.push('info', `Responses 请求 → ${body.model}`, { type: 'responses', model: body.model, stream, account: account.id });

    if (stream) {
      const response = await handleResponsesStream(body, ctx, release);
      releaseOnReturn = false;
      return response;
    } else {
      return await handleResponsesUnary(body, ctx);
    }
  } finally {
    if (releaseOnReturn) {
      release();
    }
  }
}

async function buildCodexHeaders(accessToken: string, model: string, stream: boolean): Promise<Record<string, string>> {
  const cacheId = getSessionCacheId(model);
  const apiConfig = await getSetting('api');
  const version = apiConfig.clientVersion || '0.125.0';
  const headers: Record<string, string> = {
    'version': version,
    'x-codex-beta-features': 'powershell_utf8',
    'x-oai-web-search-eligible': 'true',
    'authorization': `Bearer ${accessToken}`,
    'content-type': 'application/json',
    'user-agent': `codex_cli_rs/${version} (Windows 10.0.26100; x86_64) WindowsTerminal`,
    'originator': 'codex_cli_rs',
    'host': 'chatgpt.com',
    'Connection': 'Keep-Alive',
    'accept': stream ? 'text/event-stream' : 'application/json',
    'Conversation_id': cacheId,
    'Session_id': cacheId,
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

  return headers;
}

async function handleUnaryRequest(
  body: OpenAIChatRequest,
  ctx: RequestContext
): Promise<Response> {
  const accessToken = await getAccessToken(ctx.accountId);
  const codexRequest = openaiToCodex(body);
  const apiConfig = await getSetting('api');

  const response = await request(`${apiConfig.codexBaseUrl}/responses`, {
    method: 'POST',
    headers: await buildCodexHeaders(accessToken, ctx.model, true),
    body: codexRequest,
  });

  if (!response.ok) {
    const text = await response.text();
    await markAccountError(ctx.accountId, `HTTP ${response.status}: ${text}`);

    return new Response(JSON.stringify({ error: text }), {
      status: response.status,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const text = await response.text();
  const lines = text.split('\n');
  let accumulatedContent = '';
  for (const line of lines) {
    if (!line.startsWith('data: ')) continue;
    const data = line.slice(6).trim();
    if (!data || data === '[DONE]') continue;
    try {
      const parsed = JSON.parse(data);
      if (parsed.type === 'response.output_text.delta' && parsed.delta) {
        accumulatedContent += parsed.delta;
      }
      if (parsed.type === 'response.completed' && parsed.response) {
        const openaiResponse = codexToOpenai(parsed.response, ctx.model);
        if (accumulatedContent) {
          openaiResponse.choices[0].message.content = accumulatedContent;
        }
        const pTokens = openaiResponse.usage?.prompt_tokens || 0;
        const cTokens = openaiResponse.usage?.completion_tokens || 0;
        incrementUsageCount(ctx.accountId, pTokens, cTokens).catch(e => logger.error(`Failed to count usage: ${e}`));
        incrementModelUsage(body.model, pTokens, cTokens).catch(e => logger.error(`Failed to count model usage: ${e}`));
        return new Response(JSON.stringify(openaiResponse), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
    } catch {}
  }

  return new Response(JSON.stringify({ error: 'No completed response found in Codex output' }), {
    status: 500,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function handleStreamRequest(
  body: OpenAIChatRequest,
  ctx: RequestContext,
  release: ReleaseSlot
): Promise<Response> {
  const accessToken = await getAccessToken(ctx.accountId);
  const codexRequest = openaiToCodex(body);
  const apiConfig = await getSetting('api');

  try {
    const stream = await streamRequest(`${apiConfig.codexBaseUrl}/responses`, {
      method: 'POST',
      headers: await buildCodexHeaders(accessToken, ctx.model, true),
      body: codexRequest,
    });

    const transformedStream = stream.pipeThrough(new TransformStream({
      transform(chunk, controller) {
        const text = new TextDecoder().decode(chunk);
        const lines = text.split('\n');

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const data = line.slice(6);
            if (data === '[DONE]') {
              controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
              continue;
            }

            try {
              const parsed = JSON.parse(data);
              if (parsed.type === 'response.completed' && parsed.response?.usage) {
                const u = parsed.response.usage;
                incrementUsageCount(ctx.accountId, u.input_tokens || 0, u.output_tokens || 0)
                  .catch(e => logger.error(`Failed to count usage: ${e}`));
                incrementModelUsage(ctx.model, u.input_tokens || 0, u.output_tokens || 0)
                  .catch(e => logger.error(`Failed to count model usage: ${e}`));
              }
            } catch {}

            const converted = codexStreamToOpenai(data, ctx.model);
            if (converted) {
              controller.enqueue(new TextEncoder().encode(converted));
            }
          }
        }
      },
    }));

    return new Response(releaseWhenStreamCloses(transformedStream, release), {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      },
    });
  } catch (error) {
    await markAccountError(ctx.accountId, (error as Error).message);
    throw error;
  }
}

async function handleResponsesUnary(
  body: OpenAIResponsesRequest,
  ctx: RequestContext
): Promise<Response> {
  const accessToken = await getAccessToken(ctx.accountId);
  const codexRequest = responsesToCodex(body);
  const apiConfig = await getSetting('api');

  const response = await request(`${apiConfig.codexBaseUrl}/responses`, {
    method: 'POST',
    headers: await buildCodexHeaders(accessToken, ctx.model, true),
    body: codexRequest,
  });

  if (!response.ok) {
    const text = await response.text();
    await markAccountError(ctx.accountId, `HTTP ${response.status}: ${text}`);

    return new Response(JSON.stringify({ error: text }), {
      status: response.status,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const text = await response.text();
  const lines = text.split('\n');
  for (const line of lines) {
    if (!line.startsWith('data: ')) continue;
    const data = line.slice(6).trim();
    if (!data || data === '[DONE]') continue;
    try {
      const parsed = JSON.parse(data);
      if (parsed.type === 'response.completed' && parsed.response) {

        const u = parsed.response.usage || {};
        incrementUsageCount(ctx.accountId, u.input_tokens || 0, u.output_tokens || 0)
          .catch(e => logger.error(`Failed to count usage: ${e}`));
        incrementModelUsage(ctx.model, u.input_tokens || 0, u.output_tokens || 0)
          .catch(e => logger.error(`Failed to count model usage: ${e}`));
        return new Response(JSON.stringify(parsed.response), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
    } catch {}
  }

  return new Response(JSON.stringify({ error: 'No completed response found in Codex output' }), {
    status: 500,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function handleResponsesStream(
  body: OpenAIResponsesRequest,
  ctx: RequestContext,
  release: ReleaseSlot
): Promise<Response> {
  const accessToken = await getAccessToken(ctx.accountId);
  const codexRequest = responsesToCodex(body);
  const apiConfig = await getSetting('api');

  try {
    const stream = await streamRequest(`${apiConfig.codexBaseUrl}/responses`, {
      method: 'POST',
      headers: await buildCodexHeaders(accessToken, ctx.model, true),
      body: codexRequest,
    });

    const transformedStream = stream.pipeThrough(new TransformStream({
      transform(chunk, controller) {
        const text = new TextDecoder().decode(chunk);
        controller.enqueue(chunk);

        const lines = text.split('\n');
        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const data = line.slice(6);
            if (data === '[DONE]') continue;
            try {
              const parsed = JSON.parse(data);
              if (parsed.type === 'response.completed' && parsed.response?.usage) {
                const u = parsed.response.usage;
                incrementUsageCount(ctx.accountId, u.input_tokens || 0, u.output_tokens || 0)
                  .catch(e => logger.error(`Failed to count usage: ${e}`));
                incrementModelUsage(ctx.model, u.input_tokens || 0, u.output_tokens || 0)
                  .catch(e => logger.error(`Failed to count model usage: ${e}`));
              }
            } catch {}
          }
        }
      }
    }));

    return new Response(releaseWhenStreamCloses(transformedStream, release), {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      },
    });
  } catch (error) {
    await markAccountError(ctx.accountId, (error as Error).message);
    throw error;
  }
}
