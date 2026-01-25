import { statusQuery } from "../schemas.js";
import { getK8sClients, LABELS, resourceName, getNamespace } from "../lib/k8s.js";

const NAMESPACE = getNamespace();

export async function status(fastify, opts) {
  const { appsV1, coreV1 } = getK8sClients();

  fastify.get("/status", async (request, reply) => {
    const parse = statusQuery.safeParse(request.query);
    if (!parse.success) {
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
        return reply.send({ status: "Terminated" });
      }
      return reply.code(500).send({ error: "Failed to get status", message: e.message });
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

    return reply.send({ status: podStatus });
  });
}
