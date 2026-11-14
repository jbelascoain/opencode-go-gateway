# opencode-go-gateway

[![CI](https://github.com/jbelascoain/opencode-go-gateway/actions/workflows/ci.yml/badge.svg)](https://github.com/jbelascoain/opencode-go-gateway/actions/workflows/ci.yml)
[![Release](https://github.com/jbelascoain/opencode-go-gateway/actions/workflows/release.yml/badge.svg)](https://github.com/jbelascoain/opencode-go-gateway/actions/workflows/release.yml)
[![Docker Pulls](https://img.shields.io/docker/pulls/jbelascoain/opencode-go-gateway)](https://hub.docker.com/r/jbelascoain/opencode-go-gateway)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A tiny, dependency-free gateway that lets **any** OpenAI- or Anthropic-compatible
client use [OpenCode Go](https://opencode.ai/docs/console/go/).

It exists because OpenCode Go's endpoints require two things most clients do not
send:

- a stable `x-opencode-session` header, used for routing and prompt caching;
- a client-specific `User-Agent`, instead of a generic SDK or HTTP library name.

Without them you get:

```
Request is missing x-opencode-session and cannot be routed efficiently.
```

This gateway sits in front of those endpoints, adds both headers, keeps your
`oc_sk_...` key on the server, and exposes the familiar `/v1/...` routes. It is
about 300 lines of Node.js with **zero runtime dependencies**.

## Features

- **OpenAI, Anthropic and Responses routes** behind one base URL.
- **Real streaming**: Server-Sent Events are piped, never buffered.
- **Key isolation**: clients authenticate with a gateway token, never with your
  OpenCode key.
- **Transparent errors**: upstream status codes and bodies are passed through.
- **Tiny image**: `node:24-alpine`, runs as a non-root user, has a healthcheck.
- **No dependencies**: only the Node.js standard library.
- **Tested**: auth, header injection, streaming and limits are covered by
  `node --test` against a mock upstream.

## Endpoints

| Gateway route | Upstream | API shape |
| --- | --- | --- |
| `POST /v1/chat/completions` | `/inference/go/openai/v1/chat/completions` | OpenAI Chat Completions |
| `POST /v1/responses` | `/inference/go/openai/v1/responses` | OpenAI Responses |
| `POST /v1/messages` | `/inference/go/anthropic/v1/messages` | Anthropic Messages |
| `GET /v1/models` | `/inference/v1/models` | OpenAI model list |
| `GET /healthz` | - | liveness probe, always public |

## Quick start

### Docker

```bash
PROXY_TOKEN=$(openssl rand -hex 32)

docker run -d --name opencode-go-gateway \
  -p 127.0.0.1:4000:4000 \
  -e PROXY_TOKEN="$PROXY_TOKEN" \
  -e OPENCODE_API_KEY="oc_sk_..." \
  --restart unless-stopped \
  jbelascoain/opencode-go-gateway:latest

echo "$PROXY_TOKEN"   # save it: clients will need it
```

### Docker Compose

```bash
cp .env.example .env
# edit .env: PROXY_TOKEN and OPENCODE_API_KEY
# edit compose.yaml: set BIND_ADDR to your LAN IP to expose it
docker compose up -d
```

The compose file binds to `127.0.0.1` by default. Set `BIND_ADDR=192.168.1.10`
(or `0.0.0.0`) to let other machines on your network reach it.

### From source

```bash
npm start
```

## Configuration

| Variable | Default | Description |
| --- | --- | --- |
| `PROXY_TOKEN` | empty | Shared secret clients must present. **Recommended.** |
| `OPENCODE_API_KEY` | empty | Real `oc_sk_...` key used for upstream calls. Required when `PROXY_TOKEN` is set. |
| `HOST` | `0.0.0.0` | Listen address. |
| `PORT` | `4000` | Listen port. |
| `OPENCODE_SESSION` | `lan-gateway` | Value sent as `x-opencode-session` when the client does not send one. |
| `PROXY_UA` | `opencode-go-gateway/<version>` | Value sent as `user-agent`. |
| `CORS_ORIGIN` | empty | When set, enables CORS for that origin and answers preflight requests. |
| `UPSTREAM_BASE` | `https://opencode.ai` | Upstream origin. Mostly useful for tests. |
| `UPSTREAM_HEADERS_TIMEOUT_MS` | `60000` | Time allowed until upstream response headers arrive. |
| `MAX_BODY_BYTES` | `16777216` | Maximum request body size. |

Two credential modes:

1. **Gateway token (recommended).** Set `PROXY_TOKEN` and `OPENCODE_API_KEY`.
   Clients send the proxy token; the gateway swaps it for the real key.
2. **Bring your own key.** Leave `PROXY_TOKEN` empty. Clients send their own
   `oc_sk_...` key, and the gateway forwards it. Only safe on a trusted network.

## Using it

### curl

```bash
curl http://localhost:4000/v1/chat/completions \
  -H "Authorization: Bearer $PROXY_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "deepseek-v4.1-flash",
    "messages": [{ "role": "user", "content": "Say hi" }]
  }'
```

Anthropic-shaped models use the Messages route:

```bash
curl http://localhost:4000/v1/messages \
  -H "x-api-key: $PROXY_TOKEN" \
  -H "anthropic-version: 2023-06-01" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "qwen3.8-flash",
    "max_tokens": 64,
    "messages": [{ "role": "user", "content": "Say hi" }]
  }'
```

### n8n

- **OpenAI node**: Base URL `http://<gateway-host>:4000/v1`, API key = `PROXY_TOKEN`.
- **Anthropic node**: Base URL `http://<gateway-host>:4000/v1`, API key = `PROXY_TOKEN`.

### agentmemory

```env
OPENAI_API_KEY=<PROXY_TOKEN>
OPENAI_BASE_URL=http://<gateway-host>:4000/v1
OPENAI_MODEL=deepseek-v4.1-flash
EMBEDDING_PROVIDER=local
```

### OpenAI-compatible SDKs

```python
from openai import OpenAI

client = OpenAI(base_url="http://gateway:4000/v1", api_key="<PROXY_TOKEN>")
print(client.chat.completions.create(
    model="deepseek-v4.1-flash",
    messages=[{"role": "user", "content": "hi"}],
))
```

## Which model goes where

OpenCode publishes the API family per model. Using the wrong route returns a
model-not-found style error, not a 500.

| Model | Model ID | Route |
| --- | --- | --- |
| DeepSeek V4.1 Flash | `deepseek-v4.1-flash` | `/v1/chat/completions` |
| GLM-5.3-Flash | `glm-5.3-flash` | `/v1/chat/completions` |
| MiMo-V2.6-Flash | `mimo-v2.6-flash` | `/v1/chat/completions` |
| MiniMax M3.1 Flash | `minimax-m3.1-flash` | `/v1/chat/completions` |
| Claude Haiku 5.5 | `claude-haiku-5-5` | `/v1/messages` |
| Qwen3.8 Flash | `qwen3.8-flash` | `/v1/messages` |
| GPT-6 Luna | `gpt-6-luna` | `/v1/responses` |
| Grok 4.7 | `grok-4.7` | `/v1/responses` |

## Security

- The gateway holds your OpenCode key. Clients only ever see `PROXY_TOKEN`.
- Requests and headers are **not** logged; only method, path, status and duration.
- Bind to loopback unless you really need LAN access, and never expose it to the
  internet without a TLS reverse proxy in front.
- Rotate `PROXY_TOKEN` if it leaks. It is the only thing between the network and
  your quota.
- The container runs as the unprivileged `node` user with a read-only filesystem.

See [SECURITY.md](SECURITY.md) for the reporting process.

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `Request is missing x-opencode-session` | You are calling OpenCode directly, not through this gateway. | Point the client at this gateway. |
| `401 Invalid gateway token` | The client is not sending `PROXY_TOKEN`. | Send it as `Authorization: Bearer` or `x-api-key`. |
| `402`/`403` from upstream | The account has no balance, or the model is not covered by the Go plan. | Check the OpenCode console; free-tier models are rejected outside OpenCode. |
| Model not found | The model belongs to another API family. | Use the route from the table above. |
| Region error from a model | The Go workspace privacy settings block that region. | In OpenCode, open **Settings › Privacy** and allow the required region. |
| Streaming arrives all at once | A proxy in front is buffering. | Disable response buffering (`proxy_buffering off` in nginx). |

## Development

```bash
npm test                 # node --test, no dependencies
docker build -t opencode-go-gateway:dev .
docker run --rm -p 4000:4000 \
  -e PROXY_TOKEN=test -e OPENCODE_API_KEY=test \
  opencode-go-gateway:dev
```

The test suite starts a mock upstream, so it never calls OpenCode and never
needs a real key.

## Disclaimer

This is an unofficial community project. It is not affiliated with, endorsed by,
or supported by OpenCode or its maintainers. OpenCode Go usage remains subject to
OpenCode's own terms; this gateway only adds the session header their endpoints
ask for.

## License

[MIT](LICENSE)
