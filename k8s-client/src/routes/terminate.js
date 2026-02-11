import { terminateBody } from "../schemas.js";
import { getK8sClients, resourceName, getNamespace } from "../lib/k8s.js";

const NAMESPACE = getNamespace();

export async function terminate(fastify, opts) {
  const { appsV1, coreV1, networkingV1 } = getK8sClients();

  fastify.post("/terminate", {
    schema: {
      description: "Terminate and remove all resources for a specific challenge instance",
      tags: ["Challenge Lifecycle"],
      body: {
        type: "object",
        description:
          "Request body used to explicitly tear down all Kubernetes resources related to a specific team/challenge instance.",
        required: ["team_id", "challenge_id"],
        properties: {
          team_id: {
            type: "string",
            description: "Team/user identifier whose instance should be terminated.",
            examples: ["team_123"],
          },
          challenge_id: {
            type: "string",
            description: "Challenge identifier whose instance should be terminated.",
            examples: ["42"],
          },
        },
      },
      response: {
        200: {
          description: "Challenge instance successfully terminated",
          type: "object",
          properties: {
            status: {
              type: "string",
              description: "High‑level result of the terminate operation. Always `terminated` on success.",
              examples: ["terminated"],
            },
            message: {
              type: "string",
              description:
                "Optional human‑readable message. For example, may state that resources were already gone when the request was made.",
              examples: ["Resources were already gone or not found"],
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
      },
    },
  }, async (request, reply) => {
    const parse = terminateBody.safeParse(request.body);
    if (!parse.success) {
      console.error("Terminate validation failed:", {
        body: request.body,
        errors: parse.error.flatten(),
      });
      return reply.code(400).send({ error: "Validation failed", details: parse.error.flatten() });
    }
    const { team_id, challenge_id } = parse.data;
    const name = resourceName(team_id, challenge_id);

    const results = await Promise.allSettled([
      appsV1.deleteNamespacedDeployment(name, NAMESPACE),
      coreV1.deleteNamespacedService(name, NAMESPACE),
      networkingV1.deleteNamespacedIngress(name, NAMESPACE),
    ]);

    // Log any deletion errors (non-404)
    results.forEach((result, idx) => {
      const resourceTypes = ['Deployment', 'Service', 'Ingress'];
      if (result.status === "rejected" && result.reason?.response?.statusCode !== 404) {
        console.error(`Failed to delete ${resourceTypes[idx]}:`, {
          error: result.reason?.message,
          statusCode: result.reason?.response?.statusCode,
          body: result.reason?.response?.body,
          team_id,
          challenge_id,
          name,
        });
      }
    });

    const notFound = results.every((r) => r.status === "rejected" && r.reason?.response?.statusCode === 404);
    if (notFound) {
      console.log("Terminate - resources already gone:", {
        team_id,
        challenge_id,
        name,
      });
      return reply.send({ status: "terminated", message: "Resources were already gone or not found", success: true });
    }

    console.log("Terminate successful:", {
      team_id,
      challenge_id,
      name,
      deletedResources: results.filter(r => r.status === "fulfilled").length,
    });

    return reply.send({ status: "terminated", success: true });
  });
}
