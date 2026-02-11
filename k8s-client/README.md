# CTFd K8s Orchestrator

Stateless Node.js API that bridges CTFd (control plane) and on‑prem Kubernetes (data plane) for container challenges.

## Quick Start

```bash
npm install
cp .env.example .env
# Edit .env with your configuration
npm start
```

For local dev with Minikube/Kind:

1. Create namespace: `kubectl create namespace ctfd-challenges`
2. Set `X_API_KEY` in `.env` (must match CTFd configuration)
3. Set `CHALLENGE_NAMESPACE=ctfd-challenges` (default)
4. Configure TLS certificate secret if using HTTPS

See `.env.example` for all configuration options.

**On‑prem deployment:** k8s-client is not exposed to the internet. It only needs access to the Kubernetes API (in‑cluster when `KUBERNETES_SERVICE_HOST` is set, or kubeconfig). CTFd (cloud) talks to the orchestrator via your **existing proxy**: the proxy must forward to the internal k8s-client and set the `Host` header to that target. See `proxy-config/` for examples.

## How the orchestrator talks to Kubernetes

The orchestrator uses the official **[@kubernetes/client-node](https://github.com/kubernetes-client/javascript)** library. Connection is chosen automatically:

| Condition | Behavior |
|-----------|----------|
| **`KUBERNETES_SERVICE_HOST` is set** | **In-cluster config**: uses the pod’s service account (token + CA from `/var/run/secrets/kubernetes.io/serviceaccount/`). Use this when the orchestrator runs as a Deployment inside the same cluster. |
| **Otherwise** | **Kubeconfig**: uses the default config (e.g. `~/.kube/config` or `KUBECONFIG`). Use this when running on your laptop, in CI, or on a VM that has `kubectl` access. |

So you **do not** need to run the orchestrator inside the cluster to talk to Kubernetes. As long as it can reach the API (and your kubeconfig has valid credentials), it will work.

## Local testing

You can run and test the orchestrator **locally** against any cluster you can reach with `kubectl`:

1. **Have a cluster**  
   e.g. Minikube, Kind, Docker Desktop Kubernetes, or a remote cluster.

2. **Ensure `kubectl` works**  
   ```bash
   kubectl cluster-info
   kubectl get nodes
   ```

3. **Create the challenge namespace**  
   ```bash
   kubectl create namespace ctfd-challenges
   ```

4. **Run the orchestrator** (same machine or any machine with that kubeconfig)  
   ```bash
   cd k8s-client
   cp .env.example .env
   # Edit .env: X_API_KEY, CHALLENGE_NAMESPACE=ctfd-challenges
   npm install && npm start
   ```

5. **Point kubeconfig at the cluster**  
   - Local cluster: no change if `KUBECONFIG` or `~/.kube/config` already targets it.  
   - Remote cluster: copy the kubeconfig or set `KUBECONFIG=/path/to/config`.

6. **Call the API** (e.g. deploy a challenge)  
   ```bash
   curl -X POST http://localhost:3000/api/v1/deploy \
     -H "Content-Type: application/json" \
     -H "X-API-KEY: your-secret-key-here" \
     -d '{"challenge_id":"1","team_id":"1","image":"nginx:alpine","type":"web","prefix":"test","domain_suffix":".test.local","internal_port":80,"duration":3600,"max_containers_global":10,"max_containers_per_team":2}'
   ```

So: **run it locally with kubeconfig** for development and testing; **run it in-cluster** (e.g. as a Deployment) in production so `KUBERNETES_SERVICE_HOST` is set and it uses the in-cluster config.

## Configuration Architecture

Configuration is split between two layers:

### Infrastructure Layer (Orchestrator `.env`)

These are set once in the orchestrator's environment and control how it interacts with Kubernetes:

- `X_API_KEY` - Authentication key (must match CTFd)
- `CHALLENGE_NAMESPACE` - Kubernetes namespace
- `INGRESS_CLASS` - Ingress controller class
- `TLS_ENABLED` - Enable HTTPS support
- `TLS_CERT_SECRET` - TLS certificate secret name
- `REAPER_INTERVAL_MS` - Cleanup interval

### Challenge Layer (CTFd Admin Panel)

These are configured in CTFd at `/admin/plugins/k8s-challenges` and passed via API:

- **Domain Suffix** - Base domain for web challenges (e.g., `.sillyctf-challenges.psuccso.org`)
- **TCP Port Range** - Port range for TCP challenges (e.g., `30000-32767`)
- **Max Containers Global** - Total container limit across all teams
- **Max Containers Per Team** - Per-team/user container limit
- **Challenge Prefix** - Subdomain prefix (set per HTTP challenge)

This design allows CTFd admins to manage challenge-specific settings without needing access to the orchestrator infrastructure.

## API Endpoints

All endpoints require `X-API-KEY` header when `X_API_KEY` is configured in `.env`.

### POST /api/v1/deploy

Create a new challenge instance (deployment + service + ingress for web challenges).

**Request body:**
```json
{
  "challenge_id": "1",
  "team_id": "team_123",
  "image": "nginx:latest",
  "type": "web",
  "prefix": "web-intro",
  "domain_suffix": ".sillyctf-challenges.psuccso.org",
  "internal_port": 80,
  "duration": 3600,
  "memory_limit": "256Mi",
  "cpu_limit": "500m",
  "env_vars": {"FLAG": "flag{...}"},
  "max_containers_global": 100,
  "max_containers_per_team": 5
}
```

**For TCP challenges:**
- Set `type: "tcp"`
- Include `tcp_port_range: "30000-32767"`
- Omit `prefix` and `domain_suffix`

**Response:**
```json
{
  "success": true,
  "connection_string": "https://web-intro-a1b2c3.sillyctf-challenges.psuccso.org",
  "expires_at": "2026-02-11T10:30:00Z"
}
```

### GET /api/v1/status

Check status of a team's challenge instance.

**Query parameters:**
- `team_id` - Team/user identifier
- `challenge_id` - Challenge identifier

**Response:**
```json
{
  "running": true,
  "connection_string": "https://web-intro-a1b2c3.sillyctf-challenges.psuccso.org",
  "expires_at": "2026-02-11T10:30:00Z"
}
```

### POST /api/v1/terminate

Stop and remove a challenge instance.

**Request body:**
```json
{
  "team_id": "team_123",
  "challenge_id": "1"
}
```

### POST /api/v1/renew

Extend the lifetime of an existing instance.

**Request body:**
```json
{
  "team_id": "team_123",
  "challenge_id": "1",
  "duration": 3600,
  "restart": false
}
```

## Web Challenge Routing

HTTP/web challenges are automatically assigned subdomains:

```
{prefix}-{random-id}.{domain-suffix}
```

Example: `web-intro-a1b2c3.sillyctf-challenges.psuccso.org`

Where:
- `prefix` - Set by admin when creating the challenge (e.g., "web-intro")
- `random-id` - 6-character unique identifier generated by orchestrator
- `domain-suffix` - Configured in CTFd settings (e.g., ".sillyctf-challenges.psuccso.org")

### TLS/HTTPS Setup

1. Create a wildcard certificate for your domain (e.g., `*.sillyctf-challenges.psuccso.org`)
2. Store it as a Kubernetes secret in the challenge namespace:
   ```bash
   kubectl create secret tls wildcard-tls-cert \
     --cert=path/to/tls.crt \
     --key=path/to/tls.key \
     -n ctfd-challenges
   ```
3. Set `TLS_CERT_SECRET=wildcard-tls-cert` in `.env`

## TCP Challenge Routing

TCP challenges are assigned random ports from the configured range:

```
nc your-domain.com 31234
```

The orchestrator tracks used ports and ensures no collisions.

## Reaper

Every 60s (or `REAPER_INTERVAL_MS`), the orchestrator scans for deployments where `expires_at` has passed and automatically removes them along with their associated services and ingresses.

## Labels

All created Kubernetes resources use these labels:
- `managed_by=ctfd-orchestrator` - Identifies resources managed by this orchestrator
- `team_id` - Team/user identifier
- `challenge_id` - Challenge identifier  
- `expires_at` - ISO timestamp when instance should be reaped

## API Documentation

Comprehensive interactive API documentation is available at `/docs` when the server is running.

The Swagger UI provides:
- **Detailed field descriptions** for every request parameter and response field
- **Type information** including constraints (min/max values, enums, required fields)
- **Example values** for all fields
- **Try it out** functionality to test endpoints directly from the browser
- **Complete error response documentation** for all status codes

Each endpoint includes:
- Full description of its purpose
- Complete request body/query parameter schemas with validation rules
- Response schemas for all HTTP status codes (200, 400, 404, 409, 429, 500)
- Examples showing expected data formats
