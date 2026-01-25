import { terminateBody } from "../schemas.js";
import { getK8sClients, resourceName, getNamespace } from "../lib/k8s.js";

const NAMESPACE = getNamespace();

export async function terminate(fastify, opts) {
  const { appsV1, coreV1, networkingV1 } = getK8sClients();

  fastify.post("/terminate", async (request, reply) => {
    const parse = terminateBody.safeParse(request.body);
    if (!parse.success) {
      return reply.code(400).send({ error: "Validation failed", details: parse.error.flatten() });
    }
    const { team_id, challenge_id } = parse.data;
    const name = resourceName(team_id, challenge_id);

    const results = await Promise.allSettled([
      appsV1.deleteNamespacedDeployment(name, NAMESPACE),
      coreV1.deleteNamespacedService(name, NAMESPACE),
      networkingV1.deleteNamespacedIngress(name, NAMESPACE),
    ]);

    const notFound = results.every((r) => r.status === "rejected" && r.reason?.response?.statusCode === 404);
    if (notFound) {
      return reply.send({ status: "terminated", message: "Resources were already gone or not found" });
    }

    return reply.send({ status: "terminated" });
  });
}
