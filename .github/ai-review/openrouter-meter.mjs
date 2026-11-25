import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';

const UPSTREAM = 'https://openrouter.ai/api/v1';
export const MAX_TOKENS = 16_000;
const RETRY_DELAYS_MS = [5_000, 15_000, 30_000];
const CONFIG = JSON.parse(readFileSync(new URL('opencode/opencode.json', import.meta.url), 'utf8'));

/** The provider routing every request leaves with, whatever the client asked for: the one `opencode/opencode.json` sets. */
export const ROUTING = CONFIG.provider.openrouter.options.extraBody.provider;

/**
 * The provider tried first for a model, before the rest of `ROUTING.only`: the cheapest one that keeps the prompt cache
 * in OpenRouter's activity of 2026-10-08 (GLM 5.3 cost $0.19 per million prompt tokens on DeepInfra, $0.71 on
 * Fireworks, which a throughput sort picked).
 */
export const PREFERRED_PROVIDERS = {
  'deepseek/deepseek-v4.1-flash': ['together'],
  'z-ai/glm-5.3-flash': ['fireworks', 'together'],
  'z-ai/glm-5.3': ['deepinfra'],
};

/**
 * Whether OpenRouter refused the request for a reason that clears by itself: a rate limit, a provider error, or the
 * credits held by the requests already in flight (it reserves each request's prompt and `max_tokens` at its price).
 */
const transient = (status, text) =>
  status === 429 || status >= 500 || (status === 402 && /in-flight requests/i.test(text));

/**
 * The routing of one request: `ROUTING`, with the providers tried first, the model's preferred ones unless `order`
 * names others (a variant under evaluation). `ROUTING.only` still bounds them.
 */
export function routingFor(model, order = PREFERRED_PROVIDERS[model]) {
  return order ? { ...ROUTING, order } : ROUTING;
}

const readBody = async (request) => {
  let body = '';
  for await (const chunk of request) body += chunk;
  return body;
};

function record(call, text) {
  const json = text.startsWith('data:') ? text.slice(5).trim() : text.trim();
  if (!json.startsWith('{')) return;
  let payload;
  try {
    payload = JSON.parse(json);
  } catch {
    return;
  }
  call.provider = payload.provider ?? call.provider;
  call.finishReason = payload.choices?.[0]?.finish_reason ?? call.finishReason;
  const { usage } = payload;
  if (!usage) return;
  call.cost = usage.cost ?? call.cost;
  call.promptTokens = usage.prompt_tokens ?? call.promptTokens;
  call.completionTokens = usage.completion_tokens ?? call.completionTokens;
  call.cachedTokens = usage.prompt_tokens_details?.cached_tokens ?? call.cachedTokens;
}

/**
 * A local OpenRouter endpoint for opencode. Each chat completion leaves with the real key, `routingFor` its model and
 * `user` (which names the run in OpenRouter's activity and traces); its answer streams back unchanged, and `calls`
 * records what OpenRouter billed and which provider served it, from the usage sent with the answer. Any other path is
 * refused, so the agent's environment never holds the key. It listens on a loopback port, or on the Unix socket
 * `socket` for an agent whose network holds nothing else (`sandbox.mjs`).
 */
export async function startMeter({
  apiKey,
  user,
  fetch = globalThis.fetch,
  upstream = UPSTREAM,
  retryDelaysMs = RETRY_DELAYS_MS,
  socket = null,
  order = null,
}) {
  const calls = [];
  const server = createServer(async (request, response) => {
    if (request.method !== 'POST' || !request.url.endsWith('/chat/completions')) {
      response.writeHead(404).end();
      return;
    }
    const abort = new AbortController();
    response.on('close', () => abort.abort());
    const call = {
      model: null,
      provider: null,
      finishReason: null,
      cost: 0,
      promptTokens: 0,
      completionTokens: 0,
      cachedTokens: 0,
    };
    calls.push(call);
    try {
      const asked = JSON.parse(await readBody(request));
      const body = {
        ...asked,
        provider: routingFor(asked.model, order ?? undefined),
        max_tokens: Math.min(asked.max_tokens ?? MAX_TOKENS, MAX_TOKENS),
        usage: { include: true },
        ...(user && { user }),
      };
      call.model = body.model;
      const send = () =>
        fetch(`${upstream}/chat/completions`, {
          method: 'POST',
          headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
          body: JSON.stringify(body),
          signal: abort.signal,
        });
      let answer = await send();
      for (const delay of retryDelaysMs) {
        if (answer.ok) break;
        const text = await answer.text();
        if (!transient(answer.status, text)) {
          answer = new Response(text, { status: answer.status, headers: answer.headers });
          break;
        }
        call.retries = (call.retries ?? 0) + 1;
        await new Promise((resolve) => setTimeout(resolve, delay));
        answer = await send();
      }
      const streamed = answer.headers.get('content-type')?.includes('text/event-stream');
      response.writeHead(answer.status, { 'content-type': answer.headers.get('content-type') ?? 'application/json' });
      const decoder = new TextDecoder();
      let pending = '';
      for await (const chunk of answer.body ?? []) {
        response.write(chunk);
        pending += decoder.decode(chunk, { stream: true });
        if (!streamed) continue;
        const lines = pending.split('\n');
        pending = lines.pop();
        for (const line of lines) record(call, line);
      }
      record(call, pending);
      response.end();
    } catch (error) {
      call.error = error.message;
      if (!response.headersSent) response.writeHead(502, { 'content-type': 'application/json' });
      response.end(response.headersSent ? undefined : JSON.stringify({ error: { message: error.message } }));
    }
  });
  await new Promise((resolve) => (socket ? server.listen(socket, resolve) : server.listen(0, '127.0.0.1', resolve)));
  return {
    url: socket ? null : `http://127.0.0.1:${server.address().port}/api/v1`,
    socket,
    calls,
    close: () => {
      server.closeAllConnections();
      return new Promise((resolve) => server.close(resolve));
    },
  };
}

/**
 * What the recorded calls cost, which providers served them with the number of calls each, and how many answers the
 * provider cut at `max_tokens` (finish reason `length`).
 */
export function meterTotals(calls) {
  const providers = {};
  for (const call of calls) providers[call.provider ?? 'unknown'] = (providers[call.provider ?? 'unknown'] ?? 0) + 1;
  return {
    cost: calls.reduce((sum, call) => sum + call.cost, 0),
    calls: calls.length,
    providers,
    cut: calls.filter((call) => call.finishReason === 'length').length,
  };
}
