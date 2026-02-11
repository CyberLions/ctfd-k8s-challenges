import { deployBody } from "../schemas.js";
import { getK8sClients, LABELS, labelSelector, resourceName, getNamespace } from "../lib/k8s.js";
import { buildDeployment, buildService, buildIngress } from "../lib/manifests.js";

const MAX_GLOBAL = parseInt(process.env.MAX_CONTAINERS_GLOBAL || "500", 10);
const MAX_PER_TEAM = parseInt(process.env.MAX_CONTAINERS_PER_TEAM || "10", 10);
const NAMESPACE = getNamespace();

function getCore() {
  return getK8sClients();
}

/** List deployments with managed_by=ctfd-orchestrator */
async function listManagedDeployments() {
  const { appsV1 } = getCore();
  const { body } = await appsV1.listNamespacedDeployment(
    NAMESPACE,
    undefined,
    undefined,
    undefined,
    undefined,
    `${LABELS.MANAGED_BY}=ctfd-orchestrator`
  );
  return body.items || [];
}

/** Count deployments for team_id (or globally) */
async function countDeployments(teamId = null) {
  const items = await listManagedDeployments();
  if (!teamId) return items.length;
  return items.filter((d) => d.metadata?.labels?.[LABELS.TEAM_ID] === String(teamId)).length;
}

/** Check if this team already has this challenge running */
async function hasDuplicate(teamId, challengeId) {
  const { appsV1 } = getCore();
  const name = resourceName(teamId, challengeId);
  try {
    await appsV1.readNamespacedDeployment(name, NAMESPACE);
    return true;
  } catch (e) {
    if (e.response?.statusCode === 404) return false;
    throw e;
  }
}

export async function deploy(fastify, opts) {
  const { appsV1, coreV1, networkingV1 } = getCore();

  fastify.post("/deploy", {
    schema: {
      description: "Deploy a new challenge instance for a specific team/user",
      tags: ["Challenge Lifecycle"],
      body: {
        type: "object",
        description:
          "Request payload sent by the CTFd plugin to start a new challenge instance for a specific team/user.",
        required: ["challenge_id", "team_id", "image", "type", "duration"],
        properties: {
          challenge_id: {
            type: "string",
            description:
              "Unique identifier for the challenge in CTFd. Used only for naming/labels and to ensure a single running instance per (team_id, challenge_id) pair.",
            examples: ["42"],
          },
          team_id: {
            type: "string",
            description:
              "Identifier for the team or user in CTFd. All Kubernetes resources are labeled with this value.",
            examples: ["team_123"],
          },
          image: {
            type: "string",
            description:
              "Container image (including tag) that will be pulled by the cluster. Must be reachable from all Kubernetes nodes.",
            examples: ["registry.example.com/ctfd/web-intro:latest"],
          },
          type: {
            type: "string",
            enum: ["web", "tcp"],
            description:
              "Challenge transport type. `web` creates a ClusterIP Service + Ingress and returns an HTTPS URL. `tcp` creates a NodePort Service and returns an `nc host port` connection string.",
            examples: ["web"],
          },
          duration: {
            type: "integer",
            minimum: 1,
            description:
              "Lifetime of the instance in seconds from the time of the request. After this time the reaper will automatically terminate the resources.",
            examples: [3600],
          },
          internal_port: {
            type: "integer",
            default: 80,
            description:
              "TCP port inside the container where the challenge process listens. This is mapped by the Service (and Ingress for web challenges).",
            examples: [80],
          },
          memory_limit: {
            type: "string",
            default: "128Mi",
            description:
              "Kubernetes memory limit and (by default) request for the container, expressed in Kubernetes quantity syntax (e.g. `128Mi`, `512Mi`).",
            examples: ["256Mi"],
          },
          cpu_limit: {
            type: "string",
            nullable: true,
            description:
              "Optional CPU limit for the container, expressed in Kubernetes quantity syntax (e.g. `500m`, `1`). If omitted, no explicit CPU limit is set.",
            examples: ["500m"],
          },
          env_vars: {
            type: "object",
            description:
              "Optional map of environment variables to inject into the challenge container. Values are stored as plain strings.",
            additionalProperties: { type: "string" },
            examples: [{ FLAG: "flag{example}", CONFIG_PATH: "/app/config.yml" }],
          },
        },
      },
      response: {
        200: {
          description: "Challenge instance successfully created",
          type: "object",
          properties: {
            status: {
              type: "string",
              description: "High‑level status of the operation. For successful creates this will be `created`.",
              examples: ["created"],
            },
            connection_info: {
              type: "string",
              description:
                "Connection string that players should use to reach the challenge. For web challenges this is an https:// URL; for TCP challenges this is an `nc host port` command.",
              examples: ["https://team-123-42.challs.example.org"],
            },
            expires_at: {
              type: "integer",
              description:
                "Unix timestamp (seconds since epoch) when the challenge instance is scheduled to expire and be reaped.",
              examples: [1739279400],
            },
          },
        },
        400: {
          description: "Validation failed - missing or invalid fields in request body",
          type: "object",
          properties: {
            error: { type: "string" },
            details: { type: "object" },
          },
        },
        409: {
          description: "Conflict - an instance is already running for this team_id and challenge_id pair",
          type: "object",
          properties: {
            error: { type: "string" },
          },
        },
        429: {
          description: "Rate limit exceeded - global or per-team container cap reached",
          type: "object",
          properties: {
            error: { type: "string" },
            max: { type: "integer" },
          },
        },
        500: {
          description: "Internal server error - failed to create Kubernetes resources",
          type: "object",
          properties: {
            error: { type: "string" },
            message: { type: "string" },
          },
        },
      },
    },
  }, async (request, reply) => {
    const parse = deployBody.safeParse(request.body);
    if (!parse.success) {
      console.error("Deploy validation failed:", {
        body: request.body,
        errors: parse.error.flatten(),
        issues: parse.error.issues,
      });
      return reply.code(400).send({ error: "Validation failed", details: parse.error.flatten() });
    }
    const d = parse.data;

    const globalCount = await countDeployments();
    if (globalCount >= MAX_GLOBAL) {
      console.warn("Deploy rejected - global container cap reached:", {
        current: globalCount,
        max: MAX_GLOBAL,
        team_id: d.team_id,
        challenge_id: d.challenge_id,
      });
      return reply.code(429).send({ error: "Cluster at global container cap", max: MAX_GLOBAL });
    }

    const teamCount = await countDeployments(d.team_id);
    if (teamCount >= MAX_PER_TEAM) {
      console.warn("Deploy rejected - team container cap reached:", {
        team_id: d.team_id,
        current: teamCount,
        max: MAX_PER_TEAM,
      });
      return reply.code(429).send({ error: "Team at container cap", max: MAX_PER_TEAM });
    }

    if (await hasDuplicate(d.team_id, d.challenge_id)) {
      console.warn("Deploy rejected - instance already exists:", {
        team_id: d.team_id,
        challenge_id: d.challenge_id,
      });
      return reply.code(409).send({ error: "Instance already running for this team and challenge" });
    }

    const expiresAt = Math.floor(Date.now() / 1000) + d.duration;
    const name = resourceName(d.team_id, d.challenge_id);

    const deployment = buildDeployment({
      teamId: d.team_id,
      challengeId: d.challenge_id,
      image: d.image,
      internalPort: d.internal_port,
      expiresAt,
      memoryLimit: d.memory_limit,
      cpuLimit: d.cpu_limit,
      envVars: d.env_vars,
      type: d.type,
    });

    const service = buildService({
      teamId: d.team_id,
      challengeId: d.challenge_id,
      port: d.internal_port,
      type: d.type,
      expiresAt,
    });

    const protocol = process.env.TLS_ENABLED === "false" ? "http" : "https";
    const root = process.env.ROOT_DOMAIN || "sillyctf.psuccso.org";
    let connectionInfo;

    if (d.type === "web") {
      const ingress = buildIngress({
        teamId: d.team_id,
        challengeId: d.challenge_id,
        port: d.internal_port,
        expiresAt,
      });
      const host = ingress.spec.rules[0].host;
      connectionInfo = `${protocol}://${host}`;

      try {
        await appsV1.createNamespacedDeployment(NAMESPACE, deployment);
        await coreV1.createNamespacedService(NAMESPACE, service);
        await networkingV1.createNamespacedIngress(NAMESPACE, ingress);
      } catch (e) {
        // Log detailed error for debugging
        console.error("Failed to create Kubernetes resources:", {
          error: e.message,
          statusCode: e.response?.statusCode,
          body: e.response?.body,
          namespace: NAMESPACE,
          resourceName: name,
        });
        
        // Cleanup any partially created resources
        await Promise.allSettled([
          appsV1.deleteNamespacedDeployment(name, NAMESPACE).catch(() => {}),
          coreV1.deleteNamespacedService(name, NAMESPACE).catch(() => {}),
          networkingV1.deleteNamespacedIngress(name, NAMESPACE).catch(() => {}),
        ]);
        
        // Return detailed error to client
        const k8sError = e.response?.body?.message || e.message;
        return reply.code(500).send({ 
          error: "Failed to create resources", 
          message: k8sError,
          details: e.response?.body || undefined 
        });
      }
    } else {
      // tcp: Service is NodePort
      try {
        await appsV1.createNamespacedDeployment(NAMESPACE, deployment);
        const svcRes = await coreV1.createNamespacedService(NAMESPACE, service);
        const nodePort = svcRes.body.spec?.ports?.[0]?.nodePort;
        const tcpHost = process.env.TCP_HOST || process.env.ROOT_DOMAIN || root;
        connectionInfo = nodePort ? `nc ${tcpHost} ${nodePort}` : `nc ${tcpHost} <nodeport>`;
      } catch (e) {
        // Log detailed error for debugging
        console.error("Failed to create Kubernetes resources:", {
          error: e.message,
          statusCode: e.response?.statusCode,
          body: e.response?.body,
          namespace: NAMESPACE,
          resourceName: name,
        });
        
        // Cleanup any partially created resources
        await Promise.allSettled([
          appsV1.deleteNamespacedDeployment(name, NAMESPACE).catch(() => {}),
          coreV1.deleteNamespacedService(name, NAMESPACE).catch(() => {}),
        ]);
        
        // Return detailed error to client
        const k8sError = e.response?.body?.message || e.message;
        return reply.code(500).send({ 
          error: "Failed to create resources", 
          message: k8sError,
          details: e.response?.body || undefined 
        });
      }
    }

    console.log("Deploy successful:", {
      team_id: d.team_id,
      challenge_id: d.challenge_id,
      type: d.type,
      image: d.image,
      connection_info: connectionInfo,
      expires_at: expiresAt,
    });

    return reply.send({
      status: "created",
      connection_info: connectionInfo,
      expires_at: expiresAt,
    });
  });
}
