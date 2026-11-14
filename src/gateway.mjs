import http from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { Readable } from 'node:stream';

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

/**
 * OpenCode Go serves its models behind /inference/go/* and expects a stable
 * session id plus a client-specific user agent. This table maps the public,
 * OpenAI/Anthropic-shaped routes to the matching upstream paths.
 */
const ROUTES = Object.freeze([
  {
    method: 'POST',
    path: '/v1/chat/completions',
    upstreamPath: '/inference/go/openai/v1/chat/completions',
    api: 'openai',
  },
  {
    method: 'POST',
    path: '/v1/responses',
    upstreamPath: '/inference/go/openai/v1/responses',
    api: 'openai',
  },
  {
    method: 'POST',
    path: '/v1/messages',
    upstreamPath: '/inference/go/anthropic/v1/messages',
    api: 'anthropic',
  },
  {
    method: 'GET',
    path: '/v1/models',
    upstreamPath: '/inference/v1/models',
    api: 'openai',
  },
]);

const ERROR_TYPES = Object.freeze({
  400: 'invalid_request_error',
  401: 'authentication_error',
  403: 'permission_error',
  404: 'not_found_error',
  405: 'invalid_request_error',
  413: 'request_too_large',
  500: 'api_error',
  502: 'api_error',
});

class BodyTooLargeError extends Error {}

function constantTimeEqual(a, b) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function errorPayload(api, status, message) {
  const type = ERROR_TYPES[status] ?? 'proxy_error';
  if (api === 'anthropic') {
    return { type: 'error', error: { type, message } };
  }
  return { error: { message, type, code: type } };
}

function headerValue(req, name) {
  const value = req.headers[name];
  return typeof value === 'string' ? value : undefined;
}

function presentedCredential(req) {
  const authorization = headerValue(req, 'authorization');
  if (authorization && authorization.toLowerCase().startsWith('bearer ')) {
    return authorization.slice(7).trim();
  }
  return (headerValue(req, 'x-api-key') ?? '').trim();
}

/**
 * Build an HTTP server that forwards requests to OpenCode's Go endpoints.
 *
 * The server is not started here so tests can bind it to an ephemeral port.
 *
 * @param {object} [options]
 * @param {string} [options.token] Shared secret clients must present. Empty disables auth.
 * @param {string} [options.apiKey] Real OpenCode key. Empty lets clients bring their own.
 * @param {string} [options.upstreamBase] Upstream origin. Override for tests or a mock.
 * @param {string} [options.session] Value sent as x-opencode-session.
 * @param {string} [options.userAgent] Value sent as user-agent.
 * @param {string} [options.corsOrigin] When set, enables CORS for that origin.
 * @param {number} [options.maxBodyBytes] Request body limit.
 * @param {number} [options.upstreamHeadersTimeoutMs] Time allowed until upstream headers arrive.
 * @param {object} [options.logger] Console-like object. Pass null to silence.
 * @returns {import('node:http').Server}
 */
export function createGateway({
  token = '',
  apiKey = '',
  upstreamBase = 'https://opencode.ai',
  session = 'lan-gateway',
  userAgent = 'opencode-go-gateway',
  corsOrigin = '',
  maxBodyBytes = 16 * 1024 * 1024,
  upstreamHeadersTimeoutMs = 60_000,
  logger = console,
} = {}) {
  const base = upstreamBase.replace(/\/+$/, '');

  const log = (level, message, fields = {}) => {
    if (!logger || typeof logger[level] !== 'function') return;
    logger[level](JSON.stringify({ level, message, ...fields }));
  };

  const sendJson = (res, status, payload) => {
    const body = Buffer.from(JSON.stringify(payload));
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': body.length,
      'cache-control': 'no-store',
    });
    res.end(body);
  };

  const readBody = async (req) => {
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > maxBodyBytes) {
        // Keep draining so the client can still read the 413 response,
        // but release anything buffered so far.
        tooLarge = true;
        chunks.length = 0;
        continue;
      }
      chunks.push(chunk);
    }
    if (tooLarge) throw new BodyTooLargeError();
    return chunks.length ? Buffer.concat(chunks) : undefined;
  };

  const server = http.createServer(async (req, res) => {
    const startedAt = process.hrtime.bigint();
    const requestId = randomUUID();
    res.setHeader('x-request-id', requestId);

    if (corsOrigin) {
      res.setHeader('access-control-allow-origin', corsOrigin);
      res.setHeader(
        'access-control-allow-headers',
        'authorization,content-type,x-api-key,anthropic-version,x-opencode-session',
      );
      res.setHeader('access-control-allow-methods', 'GET,POST,OPTIONS');
      res.setHeader('access-control-expose-headers', 'x-request-id');
      res.setHeader('vary', 'origin');
    }

    res.on('finish', () => {
      log('info', 'request', {
        requestId,
        method: req.method,
        path: req.url,
        status: res.statusCode,
        durationMs: Math.round(Number(process.hrtime.bigint() - startedAt) / 1e5) / 10,
      });
    });

    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;

    if (pathname === '/healthz') {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        return sendJson(res, 405, { error: { message: 'Method not allowed', type: 'proxy_error' } });
      }
      return sendJson(res, 200, { ok: true, uptimeSeconds: Math.round(process.uptime()) });
    }

    if (corsOrigin && req.method === 'OPTIONS') {
      res.writeHead(204);
      return res.end();
    }

    const route = ROUTES.find((candidate) => candidate.path === pathname);
    if (!route) {
      return sendJson(res, 404, {
        error: { message: `Unknown route: ${pathname}`, type: 'proxy_error', code: 'not_found' },
      });
    }

    if (req.method !== route.method) {
      res.setHeader('allow', route.method);
      return sendJson(res, 405, errorPayload(route.api, 405, `Use ${route.method} for ${route.path}.`));
    }

    const presented = presentedCredential(req);
    if (token && !constantTimeEqual(presented, token)) {
      return sendJson(res, 401, errorPayload(route.api, 401, 'Invalid gateway token.'));
    }

    if (token && !apiKey) {
      return sendJson(
        res,
        500,
        errorPayload(
          route.api,
          500,
          'Gateway misconfigured: PROXY_TOKEN is set but OPENCODE_API_KEY is empty.',
        ),
      );
    }

    const upstreamKey = apiKey || presented;
    if (!upstreamKey) {
      return sendJson(res, 401, errorPayload(route.api, 401, 'No upstream API key provided.'));
    }

    let body;
    if (route.method === 'POST') {
      try {
        body = await readBody(req);
      } catch (error) {
        if (error instanceof BodyTooLargeError) {
          return sendJson(
            res,
            413,
            errorPayload(route.api, 413, `Request body exceeds ${maxBodyBytes} bytes.`),
          );
        }
        return sendJson(res, 400, errorPayload(route.api, 400, 'Could not read request body.'));
      }
    }

    const headers = {
      'content-type': headerValue(req, 'content-type') ?? 'application/json',
      accept: headerValue(req, 'accept') ?? 'application/json',
      'user-agent': userAgent,
      'x-opencode-session': headerValue(req, 'x-opencode-session') ?? session,
    };

    if (route.api === 'openai') {
      headers.authorization = `Bearer ${upstreamKey}`;
    } else {
      headers['x-api-key'] = upstreamKey;
      headers['anthropic-version'] = headerValue(req, 'anthropic-version') ?? '2023-06-01';
    }

    const controller = new AbortController();
    const onClientClose = () => {
      if (!res.writableEnded) controller.abort();
    };
    res.on('close', onClientClose);

    let headersTimer;
    let upstream;
    try {
      if (upstreamHeadersTimeoutMs > 0) {
        headersTimer = setTimeout(
          () => controller.abort(),
          upstreamHeadersTimeoutMs,
        );
        headersTimer.unref?.();
      }

      upstream = await fetch(base + route.upstreamPath, {
        method: route.method,
        headers,
        body: route.method === 'POST' ? body : undefined,
        signal: controller.signal,
        redirect: 'manual',
      });
    } catch (error) {
      if (headersTimer) clearTimeout(headersTimer);
      res.off('close', onClientClose);
      if (res.writableEnded) return undefined;
      const timedOut = controller.signal.aborted;
      const message = timedOut
        ? 'Upstream did not respond in time.'
        : `Upstream request failed: ${error?.message ?? 'unknown error'}`;
      log('error', 'upstream_failed', { requestId, path: pathname, message });
      return sendJson(res, 502, errorPayload(route.api, 502, message));
    }
    if (headersTimer) clearTimeout(headersTimer);

    const responseHeaders = {};
    for (const [name, value] of upstream.headers) {
      if (HOP_BY_HOP.has(name)) continue;
      if (name === 'content-length' || name === 'content-encoding') continue;
      if (name === 'set-cookie' || name === 'x-request-id') continue;
      responseHeaders[name] = value;
    }

    res.writeHead(upstream.status, responseHeaders);

    if (!upstream.body) {
      res.end();
      return undefined;
    }

    const stream = Readable.fromWeb(upstream.body);
    stream.on('error', (error) => {
      log('error', 'stream_failed', { requestId, message: error?.message ?? 'stream error' });
      res.destroy(error);
    });
    stream.pipe(res);
    return undefined;
  });

  server.headersTimeout = 65_000;
  server.requestTimeout = 0;
  server.keepAliveTimeout = 65_000;

  return server;
}
