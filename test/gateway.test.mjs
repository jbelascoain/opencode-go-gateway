import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createGateway } from '../src/gateway.mjs';

const silence = { info() {}, warn() {}, error() {} };
const received = [];

let mock;
let gateway;
let mockPort;
let gatewayPort;

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise((resolve) => {
    server.close(resolve);
    server.closeIdleConnections?.();
    server.closeAllConnections?.();
  });
}

before(async () => {
  mock = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString('utf8');
    const body = raw ? JSON.parse(raw) : null;
    received.push({ method: req.method, url: req.url, headers: req.headers, body });

    if (req.url === '/inference/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'deepseek-v4.1-flash' }] }));
      return;
    }

    if (body?.model === 'fail') {
      res.writeHead(402, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'insufficient balance' } }));
      return;
    }

    if (body?.stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: one\n\n');
      await new Promise((resolve) => setTimeout(resolve, 25));
      res.write('data: two\n\n');
      res.end();
      return;
    }

    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, path: req.url }));
  });

  mockPort = await listen(mock);

  gateway = createGateway({
    token: 'gw-token',
    apiKey: 'sk-upstream',
    upstreamBase: `http://127.0.0.1:${mockPort}`,
    session: 'sess-123',
    userAgent: 'ua-test',
    logger: silence,
  });
  gatewayPort = await listen(gateway);
});

after(async () => {
  await close(gateway);
  await close(mock);
});

function call(path, { token = 'gw-token', method = 'POST', body, headers = {} } = {}) {
  return fetch(`http://127.0.0.1:${gatewayPort}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

test('healthz is public and returns a request id', async () => {
  const res = await fetch(`http://127.0.0.1:${gatewayPort}/healthz`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('x-request-id') ?? '', /^[0-9a-f-]{36}$/);
  assert.equal((await res.json()).ok, true);
});

test('unknown routes return 404', async () => {
  const res = await call('/nope');
  assert.equal(res.status, 404);
});

test('wrong method returns 405 with allow header', async () => {
  const res = await call('/v1/chat/completions', { method: 'GET', token: '' });
  assert.equal(res.status, 405);
  assert.equal(res.headers.get('allow'), 'POST');
});

test('missing gateway token returns 401', async () => {
  const res = await call('/v1/chat/completions', { token: '', body: {} });
  assert.equal(res.status, 401);
});

test('wrong gateway token returns 401', async () => {
  const res = await call('/v1/chat/completions', { token: 'nope', body: {} });
  assert.equal(res.status, 401);
});

test('openai route injects session, user agent and upstream key', async () => {
  const res = await call('/v1/chat/completions', {
    body: { model: 'deepseek-v4.1-flash', messages: [{ role: 'user', content: 'hi' }] },
  });
  assert.equal(res.status, 200);

  const entry = received.at(-1);
  assert.equal(entry.url, '/inference/go/openai/v1/chat/completions');
  assert.equal(entry.headers['x-opencode-session'], 'sess-123');
  assert.equal(entry.headers['user-agent'], 'ua-test');
  assert.equal(entry.headers.authorization, 'Bearer sk-upstream');
  assert.notEqual(entry.headers.authorization, 'Bearer gw-token');
  assert.equal(entry.body.model, 'deepseek-v4.1-flash');
});

test('anthropic route uses x-api-key and anthropic-version', async () => {
  const res = await call('/v1/messages', {
    body: { model: 'qwen3.8-flash', messages: [{ role: 'user', content: 'hi' }] },
  });
  assert.equal(res.status, 200);

  const entry = received.at(-1);
  assert.equal(entry.url, '/inference/go/anthropic/v1/messages');
  assert.equal(entry.headers['x-api-key'], 'sk-upstream');
  assert.equal(entry.headers['anthropic-version'], '2023-06-01');
  assert.equal(entry.headers.authorization, undefined);
});

test('models route forwards GET without a body', async () => {
  const res = await call('/v1/models', { method: 'GET' });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.data[0].id, 'deepseek-v4.1-flash');

  const entry = received.at(-1);
  assert.equal(entry.method, 'GET');
  assert.equal(entry.body, null);
});

test('streams SSE chunks instead of buffering', async () => {
  const res = await call('/v1/chat/completions', {
    body: { model: 'any', stream: true, messages: [] },
  });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /text\/event-stream/);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const first = decoder.decode((await reader.read()).value);
  assert.match(first, /data: one/);
  assert.doesNotMatch(first, /data: two/);

  let rest = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    rest += decoder.decode(value);
  }
  assert.match(rest, /data: two/);
});

test('passes upstream error status and payload through', async () => {
  const res = await call('/v1/chat/completions', { body: { model: 'fail' } });
  assert.equal(res.status, 402);
  const body = await res.json();
  assert.equal(body.error.message, 'insufficient balance');
});

test('without a gateway token the client key is forwarded upstream', async (t) => {
  const openGateway = createGateway({
    apiKey: '',
    upstreamBase: `http://127.0.0.1:${mockPort}`,
    logger: silence,
  });
  t.after(() => close(openGateway));
  const port = await listen(openGateway);

  const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': 'client-key' },
    body: JSON.stringify({ model: 'qwen3.8-flash', messages: [] }),
  });
  assert.equal(res.status, 200);
  assert.equal(received.at(-1).headers['x-api-key'], 'client-key');

  const unauthenticated = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'qwen3.8-flash', messages: [] }),
  });
  assert.equal(unauthenticated.status, 401);
});

test('token without upstream key fails loudly', async (t) => {
  const broken = createGateway({
    token: 'only-token',
    apiKey: '',
    upstreamBase: `http://127.0.0.1:${mockPort}`,
    logger: silence,
  });
  t.after(() => close(broken));
  const port = await listen(broken);

  const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer only-token' },
    body: JSON.stringify({ model: 'x', messages: [] }),
  });
  assert.equal(res.status, 500);
});

test('rejects bodies over the limit', async (t) => {
  const small = createGateway({
    apiKey: 'sk-upstream',
    upstreamBase: `http://127.0.0.1:${mockPort}`,
    maxBodyBytes: 32,
    logger: silence,
  });
  t.after(() => close(small));
  const port = await listen(small);

  const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'x', padding: 'a'.repeat(256) }),
  });
  assert.equal(res.status, 413);
});
