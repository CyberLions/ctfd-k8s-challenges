# Proxy config for CTFd Orchestrator URL

k8s-client (orchestrator) runs **on‑prem only** and is not exposed to the internet. CTFd (cloud) is configured with an **Orchestrator URL** that points at your **existing proxy**. The proxy must:

1. **Forward** to the internal orchestrator (e.g. `rack-proxy.pritunl` or in-cluster `k8s-client:3000`).
2. **Set the Host header** to that internal target when proxying (`proxy_set_header Host $proxy_host` in nginx, or equivalent), so the backend sees the correct Host.

In CTFd admin: set **Orchestrator URL** to the public URL of this proxy (e.g. `https://your-orchestrator.example.com`), and **API Key** to match k8s-client’s `X_API_KEY`.

- **nginx**: `nginx.conf.example` — `proxy_set_header Host $proxy_host`.
- **Caddy**: `Caddyfile.example` — `header_up Host <upstream_hostport>` so the upstream receives the right Host.
