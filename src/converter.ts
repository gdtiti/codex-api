import { randomUUID } from 'crypto';

export interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface OpenAIChatRequest {
  model: string;
  messages: OpenAIMessage[];
  stream?: boolean;
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  stop?: string | string[];
}

export interface OpenAIChatResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: {
      role: string;
      content: string;
    };
    finish_reason: string;
  }>;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export interface OpenAIResponsesRequest {
  model: string;
  input: Array<{
    type: 'message';
    role: 'user' | 'assistant';
    content: Array<{
      type: 'input_text' | 'output_text';
      text: string;
    }>;
  }>;
  instructions?: string;
  stream?: boolean;
  tools?: unknown[];
  tool_choice?: unknown;
  previous_response_id?: string;
  reasoning?: {
    effort?: string;
    summary?: string;
  };
}

export interface CodexRequest {
  model: string;
  instructions: string;
  input: Array<{
    type: 'message';
    role: string;
    content: Array<{
      type: string;
      text: string;
    }>;
  }>;
  stream: boolean;
  store: boolean;
  parallel_tool_calls: boolean;
  include?: string[];
  reasoning: {
    effort: string;
    summary: string;
  };
  prompt_cache_key: string;
  tools?: unknown[];
  tool_choice?: unknown;
  previous_response_id?: string;
}

export interface CodexResponse {
  id: string;
  type: string;
  output?: Array<{
    type: string;
    text?: string;
    content?: Array<{
      type: string;
      text?: string;
    }>;
  }>;
  usage?: {
    input_tokens: number;
    output_tokens: number;
  };
}

const conversationCache = new Map<string, { id: string; expire: number }>();

export function getSessionCacheId(model: string): string {
  const cacheKey = `${model}-default`;
  let cache = conversationCache.get(cacheKey);
  if (!cache || cache.expire < Date.now()) {
    cache = {
      id: randomUUID(),
      expire: Date.now() + 3600_000,
    };
    conversationCache.set(cacheKey, cache);
  }
  return cache.id;
}

export function openaiToCodex(request: OpenAIChatRequest): CodexRequest {
  const messages = request.messages || [];
  const systemMessages = messages.filter((m) => m.role === 'system');
  const nonSystemMessages = messages.filter((m) => m.role !== 'system');

  const instructions =
    systemMessages.map((m) => m.content).join('\n').trim() || 'You are a helpful assistant.';

  const input = nonSystemMessages.map((msg) => {
    const isAssistant = msg.role === 'assistant';
    return {
      type: 'message' as const,
      role: msg.role,
      content: [
        {
          type: isAssistant ? 'output_text' : 'input_text',
          text: msg.content,
        },
      ],
    };
  });

  const isFast = /-fast$/i.test(request.model);
  const upstreamModel = isFast ? request.model.replace(/-fast$/i, '') : request.model;

  return {
    model: upstreamModel,
    instructions,
    input,
    stream: true,
    store: false,
    parallel_tool_calls: true,
    include: ['reasoning.encrypted_content'],
    reasoning: {
      effort: isFast ? 'xhigh' : 'medium',
      summary: 'auto',
    },
    prompt_cache_key: getSessionCacheId(request.model),
  };
}

export function responsesToCodex(request: OpenAIResponsesRequest): CodexRequest {
  let input = request.input;

  if (typeof input === 'string') {
    input = [
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: input }],
      },
    ];
  }

  const isFast = /-fast$/i.test(request.model);
  const upstreamModel = isFast ? request.model.replace(/-fast$/i, '') : request.model;

  return {
    model: upstreamModel,
    instructions: request.instructions || 'You are a helpful assistant.',
    input: input as Array<{
      type: 'message';
      role: string;
      content: Array<{ type: string; text: string }>;
    }>,
    stream: true,
    store: false,
    parallel_tool_calls: true,
    include: ['reasoning.encrypted_content'],
    reasoning: {
      effort: request.reasoning?.effort || (isFast ? 'xhigh' : 'medium'),
      summary: request.reasoning?.summary || 'auto',
    },
    prompt_cache_key: getSessionCacheId(request.model),
    tools: request.tools,
    tool_choice: request.tool_choice,
    previous_response_id: request.previous_response_id,
  };
}

export function codexToOpenai(response: CodexResponse, model: string): OpenAIChatResponse {
  const message = response.output?.find((o: any) => o.type === 'message');
  const contentParts = message?.content || [];
  const content = contentParts
    .filter((c: any) => c.type === 'output_text' || c.type === 'text')
    .map((c: any) => c.text || '')
    .join('');

  return {
    id: `chatcmpl-${response.id}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content,
        },
        finish_reason: 'stop',
      },
    ],
    usage: {
      prompt_tokens: response.usage?.input_tokens || 0,
      completion_tokens: response.usage?.output_tokens || 0,
      total_tokens: (response.usage?.input_tokens || 0) + (response.usage?.output_tokens || 0),
    },
  };
}

export function codexStreamToOpenai(chunk: string, model: string): string {
  try {
    const data = JSON.parse(chunk);
    const type = data.type as string;

    if (type === 'response.output_text.delta') {
      const openaiChunk = {
        id: `chatcmpl-${Date.now()}`,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [
          {
            index: 0,
            delta: {
              content: data.delta,
            },
            finish_reason: null,
          },
        ],
      };
      return `data: ${JSON.stringify(openaiChunk)}\n\n`;
    }

    if (type === 'response.completed') {
      const openaiChunk = {
        id: `chatcmpl-${Date.now()}`,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [
          {
            index: 0,
            delta: {},
            finish_reason: 'stop',
          },
        ],
        usage: data.response?.usage,
      };
      return `data: ${JSON.stringify(openaiChunk)}\n\n`;
    }

    if (type === 'response.reasoning_summary_text.delta') {
      const openaiChunk = {
        id: `chatcmpl-${Date.now()}`,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [
          {
            index: 0,
            delta: {
              reasoning_content: data.delta,
            },
            finish_reason: null,
          },
        ],
      };
      return `data: ${JSON.stringify(openaiChunk)}\n\n`;
    }

    return '';
  } catch {
    return '';
  }
}
