import { renewBody } from "../schemas.js";
import { getK8sClients, LABELS, resourceName, getNamespace } from "../lib/k8s.js";

const NAMESPACE = getNamespace();

export async function renew(fastify, opts) {
  const { appsV1 } = getK8sClients();

  fastify.post("/renew", async (request, reply) => {
    const parse = renewBody.safeParse(request.body);
    if (!parse.success) {
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
        return reply.code(404).send({ error: "Deployment not found" });
      }
      return reply.code(500).send({ error: "Failed to read deployment", message: e.message });
    }

    const ext = duration || 3600;
    const newExpiresAt = Math.floor(Date.now() / 1000) + ext;

    const labels = { ...(deployment.metadata?.labels || {}), [LABELS.EXPIRES_AT]: String(newExpiresAt) };
    try {
      await appsV1.patchNamespacedDeployment(name, NAMESPACE, { metadata: { labels } });
    } catch (e) {
      return reply.code(500).send({ error: "Failed to update deployment", message: e.message });
    }

    if (restart) {
      const anno = { ...(deployment.spec?.template?.metadata?.annotations || {}), "kubectl.kubernetes.io/restartedAt": new Date().toISOString() };
      try {
        await appsV1.patchNamespacedDeployment(name, NAMESPACE, { spec: { template: { metadata: { annotations: anno } } } });
      } catch (err) {
        // best-effort restart
      }
    }

    return reply.send({ status: "renewed", expires_at: newExpiresAt });
  });
}
