import { statusQuery } from "../schemas.js";
import { getK8sClients, LABELS, resourceName, getNamespace } from "../lib/k8s.js";

const NAMESPACE = getNamespace();

export async function status(fastify, opts) {
  const { appsV1, coreV1 } = getK8sClients();

  fastify.get("/status", {
    schema: {
      description: "Check the runtime status of an existing challenge instance",
      tags: ["Challenge Lifecycle"],
      querystring: {
        type: "object",
        required: ["team_id", "challenge_id"],
        properties: {
          team_id: {
            type: "string",
            description: "Team/user identifier used when the instance was deployed.",
            examples: ["team_123"],
          },
          challenge_id: {
            type: "string",
            description: "Challenge identifier used when the instance was deployed.",
            examples: ["42"],
          },
        },
      },
      response: {
        200: {
          description: "Status retrieved successfully",
          type: "object",
          properties: {
            status: {
              type: "string",
              description:
                "Computed status of the pod backing this challenge instance. Possible values: `Pending`, `Running`, `Terminated`.",
              examples: ["Running"],
            },
          },
        },
        400: {
          description: "Validation failed - missing required query parameters",
          type: "object",
          properties: {
            error: { type: "string" },
            details: { type: "object" },
          },
        },
        500: {
          description: "Internal server error - failed to query Kubernetes",
          type: "object",
          properties: {
            error: { type: "string" },
            message: { type: "string" },
          },
        },
      },
    },
  }, async (request, reply) => {
    const parse = statusQuery.safeParse(request.query);
    if (!parse.success) {
      console.error("Status validation failed:", {
        query: request.query,
        errors: parse.error.flatten(),
      });
      return reply.code(400).send({ error: "Validation failed", details: parse.error.flatten() });
    }
    const { team_id, challenge_id } = parse.data;

    const name = resourceName(team_id, challenge_id);
    let deployment;
    try {
      const res = await appsV1.readNamespacedDeployment(name, NAMESPACE);
      deployment = res.body;
    } catch (e) {
      if (e.response?.statusCode === 404) {
        console.log("Status check - deployment not found (terminated):", {
          team_id,
          challenge_id,
          name,
        });
        return reply.send({ status: "Terminated", success: true });
      }
      
      console.error("Failed to get deployment status:", {
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
        error: "Failed to get status", 
        message: k8sError,
        success: false,
        details: e.response?.body || undefined,
      });
    }

    const selector = `${LABELS.TEAM_ID}=${team_id},${LABELS.CHALLENGE_ID}=${challenge_id}`;
    const { body: podList } = await coreV1.listNamespacedPod(NAMESPACE, undefined, undefined, undefined, undefined, selector);
    const pod = podList.items?.[0];

    let podStatus = "Pending";
    if (pod) {
      const phase = pod.status?.phase || "";
      const ready = pod.status?.containerStatuses?.[0]?.ready;
      if (phase === "Running" && ready) podStatus = "Running";
      else if (phase === "Succeeded" || phase === "Failed") podStatus = "Terminated";
      else podStatus = "Pending";
    }

    console.log("Status check successful:", {
      team_id,
      challenge_id,
      status: podStatus,
    });

    return reply.send({ status: podStatus, success: true });
  });
}
