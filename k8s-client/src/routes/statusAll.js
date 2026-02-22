import { statusAllQuery } from "../schemas.js";
import { getK8sClients, LABELS, getNamespace } from "../lib/k8s.js";
import { ensureConnectionInfo } from "../lib/connectionInfo.js";

const NAMESPACE = getNamespace();

export async function statusAll(fastify, opts) {
  const { appsV1, coreV1 } = getK8sClients();

  fastify.get("/status/all", {
    schema: {
      description: "List all running challenge instances for a given team/user",
      tags: ["Challenge Lifecycle"],
      querystring: {
        type: "object",
        required: ["team_id"],
        properties: {
          team_id: {
            type: "string",
            description: "Team/user identifier to list instances for.",
            examples: ["team_123"],
          },
        },
      },
      response: {
        200: {
          description: "Map of challenge_id to instance info",
          type: "object",
          properties: {
            success: { type: "boolean" },
            instances: {
              type: "object",
              additionalProperties: {
                type: "object",
                properties: {
                  status: { type: "string" },
                  connection_info: { type: "string" },
                  expires_at: { type: "integer", nullable: true },
                },
              },
            },
          },
        },
      },
    },
  }, async (request, reply) => {
    const parse = statusAllQuery.safeParse(request.query);
    if (!parse.success) {
      return reply.code(400).send({ error: "Validation failed", details: parse.error.flatten() });
    }
    const { team_id } = parse.data;

    const selector = `${LABELS.MANAGED_BY}=ctfd-orchestrator,${LABELS.TEAM_ID}=${team_id}`;

    try {
      const [depRes, podRes] = await Promise.all([
        appsV1.listNamespacedDeployment(NAMESPACE, undefined, undefined, undefined, undefined, selector),
        coreV1.listNamespacedPod(NAMESPACE, undefined, undefined, undefined, undefined, selector),
      ]);

      const deployments = depRes.body.items || [];
      const pods = podRes.body.items || [];

      // Build pod status by challenge_id
      const podStatusMap = {};
      for (const pod of pods) {
        const chalId = pod.metadata?.labels?.[LABELS.CHALLENGE_ID];
        if (!chalId) continue;
        const phase = pod.status?.phase || "";
        const ready = pod.status?.containerStatuses?.[0]?.ready;
        if (phase === "Running" && ready) podStatusMap[chalId] = "Running";
        else if (phase === "Succeeded" || phase === "Failed") podStatusMap[chalId] = "Terminated";
        else if (!podStatusMap[chalId]) podStatusMap[chalId] = "Pending";
      }

      // Build instances map keyed by challenge_id
      const instances = {};
      const infoPromises = [];

      for (const dep of deployments) {
        const chalId = dep.metadata?.labels?.[LABELS.CHALLENGE_ID];
        if (!chalId) continue;

        const rawAnnotation = dep.metadata?.annotations?.["ctfd-orchestrator/connection-info"] || "";
        const expiresAtStr = dep.metadata?.labels?.[LABELS.EXPIRES_AT] || "";
        const expiresAt = expiresAtStr ? parseInt(expiresAtStr, 10) : null;
        const status = podStatusMap[chalId] || "Pending";

        // Queue up connection_info resolution (may need reconstruction)
        infoPromises.push(
          ensureConnectionInfo(team_id, chalId, rawAnnotation)
            .then((info) => {
              instances[chalId] = { status, connection_info: info, expires_at: expiresAt };
            })
            .catch(() => {
              instances[chalId] = { status, connection_info: "", expires_at: expiresAt };
            })
        );
      }

      await Promise.all(infoPromises);
      return reply.send({ success: true, instances });
    } catch (e) {
      console.error("Failed to list team instances:", {
        error: e.message,
        team_id,
        namespace: NAMESPACE,
      });
      return reply.code(500).send({
        error: "Failed to list instances",
        message: e.response?.body?.message || e.message,
        success: false,
      });
    }
  });
}
