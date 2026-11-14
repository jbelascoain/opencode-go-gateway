#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { createGateway } from './gateway.mjs';

const pkg = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
);

const env = process.env;
const port = Number(env.PORT ?? 4000);
const host = env.HOST ?? '0.0.0.0';
const token = env.PROXY_TOKEN ?? '';
const apiKey = env.OPENCODE_API_KEY ?? '';

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error(`Invalid PORT: ${env.PORT}`);
  process.exit(1);
}

if (token && !apiKey) {
  console.error(
    'OPENCODE_API_KEY is required when PROXY_TOKEN is set. Set both, or neither to let clients bring their own key.',
  );
  process.exit(1);
}

const maxBodyBytes = Number(env.MAX_BODY_BYTES ?? 16 * 1024 * 1024);
const upstreamHeadersTimeoutMs = Number(env.UPSTREAM_HEADERS_TIMEOUT_MS ?? 60_000);

const server = createGateway({
  token,
  apiKey,
  upstreamBase: env.UPSTREAM_BASE ?? 'https://opencode.ai',
  session: env.OPENCODE_SESSION ?? 'lan-gateway',
  userAgent: env.PROXY_UA ?? `${pkg.name}/${pkg.version}`,
  corsOrigin: env.CORS_ORIGIN ?? '',
  maxBodyBytes: Number.isFinite(maxBodyBytes) ? maxBodyBytes : 16 * 1024 * 1024,
  upstreamHeadersTimeoutMs: Number.isFinite(upstreamHeadersTimeoutMs)
    ? upstreamHeadersTimeoutMs
    : 60_000,
});

server.listen(port, host, () => {
  console.log(`opencode-go-gateway ${pkg.version} listening on http://${host}:${port}`);
  console.log('  POST /v1/chat/completions  -> OpenCode Go (OpenAI chat completions)');
  console.log('  POST /v1/responses         -> OpenCode Go (OpenAI responses)');
  console.log('  POST /v1/messages          -> OpenCode Go (Anthropic messages)');
  console.log('  GET  /v1/models            -> OpenCode model catalog');
  console.log('  GET  /healthz              -> liveness probe');

  if (!token) {
    console.warn(
      'WARNING: PROXY_TOKEN is empty. Anything that can reach this port can spend your OpenCode quota.',
    );
  }
  if (!apiKey) {
    console.warn(
      'WARNING: OPENCODE_API_KEY is empty. Clients must send their own OpenCode key.',
    );
  }
});

let shuttingDown = false;

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Received ${signal}, shutting down.`);

  server.close(() => process.exit(0));
  server.closeIdleConnections?.();

  setTimeout(() => {
    server.closeAllConnections?.();
    process.exit(1);
  }, 10_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
