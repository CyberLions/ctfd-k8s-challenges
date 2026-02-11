# CTFd Kubernetes Container Challenges Plugin

This CTFd plugin provides **two custom challenge types** for deploying container-based challenges on Kubernetes:

1. **`container`** - Static value container challenges
2. **`container-dynamic`** - Dynamic value container challenges (value decreases with solves)

## Features

- Deploy Docker containers on-demand for each team/user
- Support for HTTP/web and TCP challenges
- Configurable resource limits (CPU, memory)
- Automatic expiration and cleanup
- Separate challenge types for static and dynamic scoring
- Integration with on-prem Kubernetes orchestrator

## Challenge Types

### 1. Container (Static)

Static value container challenges where the point value remains constant.

**Fields:**
- Standard CTFd fields (name, category, description, value, etc.)
- `image`: Docker image to deploy
- `port`: Internal container port (default: 80)
- `connection_type`: "http" or "tcp"
- `memory_limit`: Memory limit (default: "256Mi")
- `cpu_limit`: CPU limit (optional)
- `timeout`: Instance timeout in seconds (default: 3600)

**Example (ctfcli):**
```yaml
name: "Web Challenge"
category: "Web"
description: "Hack this web app"
value: 500
type: "container"

extra:
  image: "registry.example.com/challenges/web:v1"
  port: 8080
  connection_type: "http"
  memory_limit: "512Mi"
  timeout: 3600

flags:
  - "CTF{flag}"
```

### 2. Container-Dynamic

Dynamic value container challenges where points decrease as more teams solve the challenge. Based on CTFd's built-in dynamic challenge logic.

**Fields:**
- Standard CTFd fields (name, category, description, etc.)
- `initial_value`: Starting point value
- `decay_function`: "linear" or "logarithmic"
- `decay`: Decay rate
  - **Linear**: points deducted per solve
  - **Logarithmic**: number of solves before reaching minimum
- `minimum_value`: Lowest possible value
- Container fields (same as static container)

**Decay Functions:**

**Linear:** `value = initial_value - (decay × solve_count)`
- Equal point deduction per solve

**Logarithmic:** `value = (((minimum - initial) / (decay²)) × (solve_count²)) + initial`
- Earlier solves lose less points; later solves lose more

**Example (ctfcli):**
```yaml
name: "Dynamic Web Challenge"
category: "Web"
description: "Hack this web app. Points decrease as more teams solve it."
type: "container-dynamic"

extra:
  image: "registry.example.com/challenges/web:v2"
  port: 8080
  connection_type: "http"
  memory_limit: "512Mi"
  timeout: 3600
  initial_value: 500
  decay_function: "logarithmic"
  decay: 20
  minimum_value: 50

flags:
  - "CTF{flag}"
```

## Architecture

This plugin works in conjunction with a Node.js orchestrator that manages Kubernetes deployments:

```
┌─────────┐         ┌──────────────┐         ┌────────────┐
│  CTFd   │ ◄─────► │ Orchestrator │ ◄─────► │ Kubernetes │
│ (Cloud) │   API   │  (On-prem)   │   API   │ (On-prem)  │
└─────────┘         └──────────────┘         └────────────┘
```

The orchestrator handles:
- Creating Kubernetes deployments, services, and ingresses
- Managing instance lifecycle and expiration
- Automatic cleanup of expired instances

See `k8s-client/` for orchestrator implementation.

## Installation

1. Copy this plugin directory to CTFd's plugins folder
2. Restart CTFd
3. Configure orchestrator URL and API key in admin panel: `/admin/plugins/k8s-challenges`

## Configuration

Navigate to **Admin Panel → Plugins → K8s Container Challenges** to configure:

- **Orchestrator URL**: URL of the Kubernetes orchestrator API
- **API Key**: Shared secret for authenticating with orchestrator

## User Experience

When a user views a container challenge:

1. **Start Instance** - Creates a new container deployment
2. Shows connection info (URL for HTTP, host:port for TCP)
3. Shows expiration timer
4. **Stop** - Manually terminates the instance
5. **Reset** - Restarts the container with fresh state

## Database Schema

### `container_challenges` table
- Extends `challenges` table
- Fields: `image`, `port`, `command`, `connection_type`, `cpu_limit`, `memory_limit`, `timeout`

### `container_dynamic_challenges` table
- Extends `challenges` table
- Fields: All container fields + `initial_value`, `decay_function`, `decay`, `minimum_value`

## API Endpoints

The plugin registers these endpoints:

- `POST /api/v1/container/start` - Start a container instance
- `GET /api/v1/container/status` - Check instance status
- `POST /api/v1/container/stop` - Stop a container instance
- `POST /api/v1/container/renew` - Renew/reset a container instance

All endpoints require authentication and use team/user ID for isolation.

## Development

The plugin follows CTFd's plugin architecture:

- `__init__.py` - Main plugin logic, challenge classes, API endpoints
- `models.py` - Database models for both challenge types
- `assets/` - HTML templates and JavaScript for admin and user interfaces
  - Static container: `create.html`, `update.html`, `view.html` + `.js`
  - Dynamic container: `create-dynamic.html`, `update-dynamic.html`, `view-dynamic.html` + `.js`

## Notes

- Flags are passed to containers as `FLAG` environment variable
- Instances are team/user-isolated (one instance per team/user per challenge)
- The orchestrator handles cleanup of expired instances automatically
- Both challenge types support the same container features (resources, timeouts, etc.)
