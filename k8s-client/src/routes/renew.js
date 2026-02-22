import { renewBody } from "../schemas.js";
import { getK8sClients, LABELS, resourceName, getNamespace } from "../lib/k8s.js";
import { ensureConnectionInfo } from "../lib/connectionInfo.js";

const NAMESPACE = getNamespace();

export async function renew(fastify, opts) {
  const { appsV1 } = getK8sClients();

  fastify.post("/renew", {
    schema: {
      description: "Extend the expiration time and optionally restart an existing challenge instance",
      tags: ["Challenge Lifecycle"],
      body: {
        type: "object",
        description:
          "Request body used to extend and optionally restart an existing challenge instance for a given team and challenge.",
        required: ["team_id", "challenge_id"],
        properties: {
          team_id: {
            type: "string",
            description: "Team/user identifier whose instance should be renewed.",
            examples: ["team_123"],
          },
          challenge_id: {
            type: "string",
            description: "Challenge identifier whose instance should be renewed.",
            examples: ["42"],
          },
          duration: {
            type: "integer",
            minimum: 1,
            description:
              "Optional duration in seconds to add from the time of the renew request. Defaults to 3600 seconds when omitted.",
            examples: [1800],
          },
          restart: {
            type: "boolean",
            default: false,
            description:
              "When true, forces a rolling restart of the Deployment after extending the expiry by toggling the `kubectl.kubernetes.io/restartedAt` annotation.",
            examples: [false],
          },
        },
      },
      response: {
        200: {
          description: "Challenge instance successfully renewed",
          type: "object",
          properties: {
            status: {
              type: "string",
              description: "High‑level result of the renew operation. Always `renewed` on success.",
              examples: ["renewed"],
            },
            expires_at: {
              type: "integer",
              description:
                "New Unix timestamp (seconds since epoch) when the instance is scheduled to be reaped.",
              examples: [1739283000],
            },
            success: { type: "boolean" },
            connection_info: { type: "string" },
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
        404: {
          description: "Not found - no deployment exists for this team_id and challenge_id",
          type: "object",
          properties: {
            error: { type: "string" },
          },
        },
        500: {
          description: "Internal server error - failed to update Kubernetes deployment",
          type: "object",
          properties: {
            error: { type: "string" },
            message: { type: "string" },
          },
        },
      },
    },
  }, async (request, reply) => {
    const parse = renewBody.safeParse(request.body);
    if (!parse.success) {
      console.error("Renew validation failed:", {
        body: request.body,
        errors: parse.error.flatten(),
      });
      return reply.code(400).send({ error: "Validation failed", details: parse.error.flatten() });
    }
    const { team_id, challenge_id, duration, restart } = parse.data;
    const name = resourceName(team_id, challenge_id);

    let deployment;
    try {
      const res = await appsV1.readNamespacedDeployment(name, NAMESPACE);
      deployment = res.body;
    } catch (e) {
      if (e.response?.statusCode === 404) {
        console.warn("Renew rejected - deployment not found:", {
          team_id,
          challenge_id,
          name,
          namespace: NAMESPACE,
        });
        return reply.code(404).send({ error: "Deployment not found", success: false });
      }
      
      console.error("Failed to read deployment for renewal:", {
        error: e.message,
        statusCode: e.response?.statusCode,
        body: e.response?.body,
        namespace: NAMESPACE,
        name,
        team_id,
        challenge_id,
      });
      
      const k8sError = e.response?.body?.message || e.message;
      return reply.code(500).send({ 
        error: "Failed to read deployment", 
        message: k8sError,
        success: false,
        details: e.response?.body || undefined,
      });
    }

    const ext = duration || 3600;
    const newExpiresAt = Math.floor(Date.now() / 1000) + ext;

    const labels = { ...(deployment.metadata?.labels || {}), [LABELS.EXPIRES_AT]: String(newExpiresAt) };
    try {
      await appsV1.patchNamespacedDeployment(
        name, 
        NAMESPACE, 
        { metadata: { labels } },
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        { headers: { "Content-Type": "application/strategic-merge-patch+json" } }
      );
    } catch (e) {
      console.error("Failed to update deployment labels:", {
        error: e.message,
        statusCode: e.response?.statusCode,
        body: e.response?.body,
        namespace: NAMESPACE,
        resourceName: name,
        team_id,
        challenge_id,
        attempted_expires_at: newExpiresAt,
      });
      
      const k8sError = e.response?.body?.message || e.message;
      return reply.code(500).send({ 
        error: "Failed to update deployment", 
        message: k8sError,
        success: false,
        details: e.response?.body || undefined,
      });
    }

    if (restart) {
      const anno = { ...(deployment.spec?.template?.metadata?.annotations || {}), "kubectl.kubernetes.io/restartedAt": new Date().toISOString() };
      try {
        await appsV1.patchNamespacedDeployment(
          name, 
          NAMESPACE, 
          { spec: { template: { metadata: { annotations: anno } } } },
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          { headers: { "Content-Type": "application/strategic-merge-patch+json" } }
        );
        console.log("Deployment restarted successfully:", { team_id, challenge_id, name });
      } catch (err) {
        console.warn("Failed to restart deployment (non-fatal):", {
          error: err.message,
          team_id,
          challenge_id,
          name,
        });
        // best-effort restart
      }
    }

    const rawAnnotation = deployment.metadata?.annotations?.["ctfd-orchestrator/connection-info"] || "";
    const connectionInfo = await ensureConnectionInfo(team_id, challenge_id, rawAnnotation);

    console.log("Renew successful:", {
      team_id,
      challenge_id,
      new_expires_at: newExpiresAt,
      restart_requested: restart,
      connection_info: connectionInfo,
    });

    return reply.send({
      status: "renewed",
      expires_at: newExpiresAt,
      success: true,
      connection_info: connectionInfo,
    });
  });
}
