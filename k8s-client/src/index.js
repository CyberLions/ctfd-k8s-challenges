import "dotenv/config";
import Fastify from "fastify";
import fastifySwagger from "@fastify/swagger";
import fastifySwaggerUi from "@fastify/swagger-ui";
import { deploy } from "./routes/deploy.js";
import { status } from "./routes/status.js";
import { terminate } from "./routes/terminate.js";
import { renew } from "./routes/renew.js";
import { startReaper } from "./lib/reaper.js";

const API_KEY = process.env.X_API_KEY || process.env.API_KEY || "";
const PORT = parseInt(process.env.PORT || "3000", 10);

async function apiKeyHook(request, reply) {
  // Skip auth check only if API_KEY is not configured or using default placeholder
  if (!API_KEY || API_KEY === "your-secret-key-here") {
    return;
  }
  
  const key = request.headers["x-api-key"];
  if (!key || key !== API_KEY) {
    return reply.code(401).send({ error: "Invalid or missing X-API-KEY" });
  }
}

async function build() {
  const fastify = Fastify({ 
    logger: {
      level: 'info',
      serializers: {
        req(request) {
          return {
            method: request.method,
            url: request.url,
            headers: request.headers,
            body: request.body,
          };
        },
        res(response) {
          return {
            statusCode: response.statusCode,
          };
        },
      },
    },
  });

  await fastify.register(fastifySwagger, {
    openapi: {
      openapi: "3.1.0",
      info: {
        title: "CTFd K8s Orchestrator",
        version: "1.0.0",
        description:
          "On‑prem orchestrator that receives deployment requests from CTFd and manages ephemeral challenge containers in Kubernetes.",
      },
      servers: [{ url: "/api/v1", description: "API v1" }],
      components: {
        securitySchemes: {
          ApiKeyAuth: {
            type: "apiKey",
            in: "header",
            name: "X-API-KEY",
            description:
              "Shared secret between CTFd and this orchestrator. When configured, all API calls must include this header.",
          },
        },
        schemas: {
          DeployBody: {
            type: "object",
            description:
              "Request payload sent by the CTFd plugin to start a new challenge instance for a specific team/user.",
            required: ["challenge_id", "team_id", "image", "type", "duration"],
            properties: {
              challenge_id: {
                type: "string",
                description:
                  "Unique identifier for the challenge in CTFd. Used only for naming/labels and to ensure a single running instance per (team_id, challenge_id) pair.",
                example: "42",
              },
              team_id: {
                type: "string",
                description:
                  "Identifier for the team or user in CTFd. All Kubernetes resources are labeled with this value.",
                example: "team_123",
              },
              image: {
                type: "string",
                description:
                  "Container image (including tag) that will be pulled by the cluster. Must be reachable from all Kubernetes nodes.",
                example: "registry.example.com/ctfd/web-intro:latest",
              },
              type: {
                type: "string",
                enum: ["web", "tcp"],
                description:
                  "Challenge transport type. `web` creates a ClusterIP Service + Ingress and returns an HTTPS URL. `tcp` creates a NodePort Service and returns an `nc host port` connection string.",
                example: "web",
              },
              duration: {
                type: "integer",
                format: "int64",
                minimum: 1,
                description:
                  "Lifetime of the instance in seconds from the time of the request. After this time the reaper will automatically terminate the resources.",
                example: 3600,
              },
              internal_port: {
                type: "integer",
                format: "int32",
                default: 80,
                description:
                  "TCP port inside the container where the challenge process listens. This is mapped by the Service (and Ingress for web challenges).",
                example: 80,
              },
              memory_limit: {
                type: "string",
                default: "128Mi",
                description:
                  "Kubernetes memory limit and (by default) request for the container, expressed in Kubernetes quantity syntax (e.g. `128Mi`, `512Mi`).",
                example: "256Mi",
              },
              cpu_limit: {
                type: "string",
                nullable: true,
                description:
                  "Optional CPU limit for the container, expressed in Kubernetes quantity syntax (e.g. `500m`, `1`). If omitted, no explicit CPU limit is set.",
                example: "500m",
              },
              env_vars: {
                type: "object",
                description:
                  "Optional map of environment variables to inject into the challenge container. Values are stored as plain strings.",
                additionalProperties: {
                  type: "string",
                  description: "Environment variable value as a string.",
                },
                example: {
                  FLAG: "flag{example}",
                  CONFIG_PATH: "/app/config.yml",
                },
              },
            },
          },
          DeployResponse: {
            type: "object",
            description:
              "Response returned when a deployment has been successfully created or an error occurred during provisioning.",
            properties: {
              status: {
                type: "string",
                description: "High‑level status of the operation. For successful creates this will be `created`.",
                example: "created",
              },
              connection_info: {
                type: "string",
                description:
                  "Connection string that players should use to reach the challenge. For web challenges this is an https:// URL; for TCP challenges this is an `nc host port` command.",
                example: "https://team-123-42.challs.example.org",
              },
              expires_at: {
                type: "integer",
                format: "int64",
                description:
                  "Unix timestamp (seconds since epoch) when the challenge instance is scheduled to expire and be reaped.",
                example: 1739279400,
              },
              error: {
                type: "string",
                description:
                  "Error message when the deployment failed or a limit was hit. Not present on successful responses.",
                example: "Cluster at global container cap",
              },
              max: {
                type: "integer",
                description:
                  "Limit value associated with an error (for example, when a global or per‑team container cap is exceeded).",
                example: 10,
              },
            },
          },
          StatusQuery: {
            type: "object",
            description:
              "Query parameters used to check the status of an existing challenge instance for a given team and challenge.",
            required: ["team_id", "challenge_id"],
            properties: {
              team_id: {
                type: "string",
                description: "Team/user identifier used when the instance was deployed.",
                example: "team_123",
              },
              challenge_id: {
                type: "string",
                description: "Challenge identifier used when the instance was deployed.",
                example: "42",
              },
            },
          },
          StatusResponse: {
            type: "object",
            description:
              "High‑level status of the underlying Kubernetes workload for this team and challenge combination.",
            properties: {
              status: {
                type: "string",
                description:
                  "Computed status of the pod backing this challenge instance. Possible values: `Pending`, `Running`, `Terminated`.",
                example: "Running",
              },
            },
          },
          TerminateBody: {
            type: "object",
            description:
              "Request body used to explicitly tear down all Kubernetes resources related to a specific team/challenge instance.",
            required: ["team_id", "challenge_id"],
            properties: {
              team_id: {
                type: "string",
                description: "Team/user identifier whose instance should be terminated.",
                example: "team_123",
              },
              challenge_id: {
                type: "string",
                description: "Challenge identifier whose instance should be terminated.",
                example: "42",
              },
            },
          },
          TerminateResponse: {
            type: "object",
            description:
              "Response returned after issuing deletes for the Deployment, Service and Ingress (if present).",
            properties: {
              status: {
                type: "string",
                description: "High‑level result of the terminate operation. Always `terminated` on success.",
                example: "terminated",
              },
              message: {
                type: "string",
                description:
                  "Optional human‑readable message. For example, may state that resources were already gone when the request was made.",
                example: "Resources were already gone or not found",
              },
            },
          },
          RenewBody: {
            type: "object",
            description:
              "Request body used to extend and optionally restart an existing challenge instance for a given team and challenge.",
            required: ["team_id", "challenge_id"],
            properties: {
              team_id: {
                type: "string",
                description: "Team/user identifier whose instance should be renewed.",
                example: "team_123",
              },
              challenge_id: {
                type: "string",
                description: "Challenge identifier whose instance should be renewed.",
                example: "42",
              },
              duration: {
                type: "integer",
                format: "int64",
                minimum: 1,
                description:
                  "Optional duration in seconds to add from the time of the renew request. Defaults to 3600 seconds when omitted.",
                example: 1800,
              },
              restart: {
                type: "boolean",
                default: false,
                description:
                  "When true, forces a rolling restart of the Deployment after extending the expiry by toggling the `kubectl.kubernetes.io/restartedAt` annotation.",
                example: false,
              },
            },
          },
          RenewResponse: {
            type: "object",
            description:
              "Response returned when the expiry of an existing challenge instance has been successfully extended.",
            properties: {
              status: {
                type: "string",
                description: "High‑level result of the renew operation. Always `renewed` on success.",
                example: "renewed",
              },
              expires_at: {
                type: "integer",
                format: "int64",
                description:
                  "New Unix timestamp (seconds since epoch) when the instance is scheduled to be reaped.",
                example: 1739283000,
              },
            },
          },
          ErrorResponse: {
            type: "object",
            description:
              "Standard error envelope used by this API. Many endpoints also include an additional `details` field for validation errors.",
            properties: {
              error: {
                type: "string",
                description: "Short machine‑readable error message.",
                example: "Validation failed",
              },
              message: {
                type: "string",
                description: "Optional human‑readable description of what went wrong.",
                example: "Failed to create resources",
              },
              max: {
                type: "integer",
                description:
                  "Optional limit value associated with some quota‑related errors (e.g. max containers per team).",
                example: 5,
              },
              details: {
                description:
                  "Optional validation error payload returned by Zod when request body/query validation fails.",
              },
            },
          },
        },
      },
      security: API_KEY ? [{ ApiKeyAuth: [] }] : [],
    },
  });

  await fastify.register(fastifySwaggerUi, { routePrefix: "/docs", uiConfig: { docExpansion: "list" } });

  // Global error handler
  fastify.setErrorHandler((error, request, reply) => {
    const errorDetails = {
      timestamp: new Date().toISOString(),
      method: request.method,
      url: request.url,
      body: request.body,
      query: request.query,
      error: error.message,
      stack: error.stack,
      statusCode: error.statusCode || 500,
    };

    console.error("❌ Unhandled error:", errorDetails);

    reply.status(error.statusCode || 500).send({
      error: error.message || "Internal server error",
      success: false,
      timestamp: errorDetails.timestamp,
    });
  });

  // Request logging hook
  fastify.addHook('onRequest', async (request, reply) => {
    console.log("📥 Incoming request:", {
      method: request.method,
      url: request.url,
      body: request.body,
      query: request.query,
      headers: {
        'content-type': request.headers['content-type'],
        'x-api-key': request.headers['x-api-key'] ? '[REDACTED]' : undefined,
      },
    });
  });

  // Response logging hook
  fastify.addHook('onResponse', async (request, reply) => {
    console.log("📤 Response sent:", {
      method: request.method,
      url: request.url,
      statusCode: reply.statusCode,
      responseTime: `${reply.elapsedTime}ms`,
    });
  });

  fastify.register(async (scoped) => {
    scoped.addHook("preHandler", apiKeyHook);
    scoped.register(deploy, { prefix: "/api/v1" });
    scoped.register(status, { prefix: "/api/v1" });
    scoped.register(terminate, { prefix: "/api/v1" });
    scoped.register(renew, { prefix: "/api/v1" });
  });

  fastify.get("/health", async () => ({ ok: true }));

  return fastify;
}

async function main() {
  const app = await build();
  
  // Check Kubernetes connection at startup
  try {
    const { getK8sClients, getNamespace } = await import("./lib/k8s.js");
    const { coreV1 } = getK8sClients();
    const namespace = getNamespace();
    
    // Try to get the namespace to verify connectivity
    try {
      await coreV1.readNamespace(namespace);
      console.log(`✓ Connected to Kubernetes, using namespace: ${namespace}`);
    } catch (e) {
      if (e.response?.statusCode === 404) {
        console.warn(`⚠️  WARNING: Namespace '${namespace}' does not exist!`);
        console.warn(`   Create it with: kubectl create namespace ${namespace}`);
      } else {
        console.error(`✗ Failed to connect to Kubernetes API:`, e.message);
        if (e.response?.body) {
          console.error(`  Details:`, e.response.body);
        }
        console.error(`  Make sure kubeconfig is properly configured or running in-cluster`);
      }
    }
  } catch (e) {
    console.error("✗ Failed to initialize Kubernetes client:", e.message);
  }
  
  startReaper();

  const port = PORT;
  await app.listen({ port, host: "0.0.0.0" });
  console.log(`Orchestrator listening on :${port}, Swagger UI at /docs`);
  
  if (!API_KEY || API_KEY === "your-secret-key-here") {
    console.warn("⚠️  WARNING: X_API_KEY not configured or using default value - authentication is disabled!");
    console.warn("⚠️  Set X_API_KEY in .env to enable authentication");
  } else {
    console.log("✓ Authentication enabled via X-API-KEY header");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
