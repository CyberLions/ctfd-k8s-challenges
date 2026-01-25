# Hybrid CTF Container Platform

Control plane (CTFd in the cloud) + data plane (Kubernetes on‑prem) with a stateless Node.js orchestrator and a CTFd plugin.

## Components

| Part | Path | Role |
|------|------|------|
| **Orchestrator** | `k8s-client/` | Node.js (Fastify) API: deploy, status, terminate, renew; Reaper; Swagger at `/docs` |
| **Plugin** | `ctfd-plugin/` | CTFd challenge type `container`, admin config, API bridge to orchestrator |

## Quick start

### 1. On‑prem (or Minikube/Kind)

```bash
kubectl create namespace ctfd-challenges
cd k8s-client && npm install && npm start
```

Set env (see `k8s-client/.env.example`): `CHALLENGE_NAMESPACE`, `ROOT_DOMAIN`, `X_API_KEY` (optional).

### 2. CTFd

- Mount `ctfd-plugin` into `CTFd/plugins/k8s-challenges`, install deps from `ctfd-plugin/requirements.txt`.
- Admin → Plugins → **K8s Container Challenges**: set **Orchestrator URL** and **API Key** (match `X-API-KEY`).
- Create a challenge with type **container**; set image, port, connection type, limits, timeout.

### 3. ctfcli

Use `type: "container"` and `extra` as in `ctfd-plugin/example-challenge.yml`.

## Config (from the spec)

| What | Where |
|------|------|
| Orchestrator URL / API key | CTFd Admin → K8s Container Challenges |
| Max containers (global / per team) | Node: `MAX_CONTAINERS_GLOBAL`, `MAX_CONTAINERS_PER_TEAM` |
| Root domain, Ingress | Node: `ROOT_DOMAIN`, `INGRESS_CLASS`, `TLS_ENABLED` |
| Image, port, limits, timeout | Per challenge in CTFd or `challenge.yml` `extra` |

## API (orchestrator)

- `POST /api/v1/deploy` — create Deployment + Service + (web) Ingress
- `GET /api/v1/status?team_id=&challenge_id=`
- `POST /api/v1/terminate` — delete resources
- `POST /api/v1/renew` — extend `expires_at`, optional restart

All under `/api/v1` require header `X-API-KEY` when `X_API_KEY` is set. The Reaper deletes expired deployments (labels: `managed_by=ctfd-orchestrator`, `team_id`, `challenge_id`, `expires_at`).
