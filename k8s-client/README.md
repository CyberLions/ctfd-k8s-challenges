# CTFd K8s Orchestrator

Stateless Node.js API that bridges CTFd (control plane) and on‑prem Kubernetes (data plane) for container challenges.

## Run

```bash
npm install
npm start
```

For local dev with Minikube/Kind:

1. Create namespace: `kubectl create namespace ctfd-challenges`
2. Set `X_API_KEY` (optional; if unset, key check is skipped).
3. Set `CHALLENGE_NAMESPACE=ctfd-challenges` (default).

See `.env.example` for all options.

**On‑prem only:** k8s-client is not exposed to the internet. It only needs access to the Kubernetes API (in‑cluster when `KUBERNETES_SERVICE_HOST` is set, or kubeconfig). CTFd (cloud) talks to the orchestrator via your **existing proxy**: the proxy must forward to the internal k8s-client and set the `Host` header to that target. See `proxy-config/`.

## API (requires `X-API-KEY` when `X_API_KEY` is set)

- `POST /api/v1/deploy` – create deployment + service + (for web) ingress
- `GET /api/v1/status?team_id=&challenge_id=`
- `POST /api/v1/terminate` – delete deployment, service, ingress
- `POST /api/v1/renew` – update `expires_at` and optionally restart

Swagger UI: `/docs`.

## Reaper

Every 60s (or `REAPER_INTERVAL_MS`), deployments with `expires_at` in the past are removed with their service and ingress.

## Labels

Deployments use: `managed_by=ctfd-orchestrator`, `team_id`, `challenge_id`, `expires_at`.
