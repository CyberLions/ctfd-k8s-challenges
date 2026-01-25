import { getK8sClients, LABELS, getNamespace } from "./k8s.js";

const NAMESPACE = getNamespace();
const INTERVAL_MS = parseInt(process.env.REAPER_INTERVAL_MS || "60000", 10);

export function startReaper() {
  const { appsV1, coreV1, networkingV1 } = getK8sClients();
  const now = () => Math.floor(Date.now() / 1000);

  setInterval(async () => {
    try {
      const { body } = await appsV1.listNamespacedDeployment(
        NAMESPACE,
        undefined,
        undefined,
        undefined,
        undefined,
        `${LABELS.MANAGED_BY}=ctfd-orchestrator`
      );
      const items = body.items || [];

      for (const dep of items) {
        const exp = dep.metadata?.labels?.[LABELS.EXPIRES_AT];
        if (!exp) continue;
        const t = parseInt(exp, 10);
        if (Number.isNaN(t) || now() <= t) continue;

        const name = dep.metadata?.name;
        if (!name) continue;

        await Promise.allSettled([
          appsV1.deleteNamespacedDeployment(name, NAMESPACE),
          coreV1.deleteNamespacedService(name, NAMESPACE),
          networkingV1.deleteNamespacedIngress(name, NAMESPACE),
        ]);
      }
    } catch (e) {
      console.error("[Reaper] error:", e?.message || e);
    }
  }, INTERVAL_MS);
}
