# Security Policy

## Supported versions

Only the latest released tag receives fixes. Images are published from tags as
semantic-version tags on Docker Hub (`1`, `1.0`, `1.0.x`, `latest`).

## Reporting a vulnerability

Please do **not** open a public issue for a vulnerability. Use GitHub's private
vulnerability reporting:

<https://github.com/jbelascoain/opencode-go-gateway/security/advisories/new>

Include the version, a minimal reproduction, and the impact you expect. You can
expect an initial reply within a few days.

## Scope and threat model

This gateway is designed for a trusted local network. It is a credential broker:
it holds an OpenCode API key and exposes it indirectly through a shared token.

Known limitations, by design:

- The gateway token is a bearer credential. Anyone who can read it can spend the
  configured OpenCode quota.
- Traffic is plain HTTP unless you put a TLS reverse proxy in front. The token
  travels in clear text otherwise.
- There is no per-client rate limiting or quota accounting.
- Request bodies and headers are not logged, but upstream response bodies are
  streamed straight back to the caller.

Hardening recommendations:

- Set `PROXY_TOKEN` and keep it out of version control.
- Bind to `127.0.0.1` unless LAN access is required; if it is, bind to the LAN
  address and restrict the port in your firewall.
- Never publish port `4000` to the internet without TLS and authentication in
  front.
- Rotate the token and the OpenCode key if either may have leaked.
- Keep the image updated; Dependabot tracks the base image.
