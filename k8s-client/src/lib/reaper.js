import { getK8sClients, LABELS, getNamespace } from "./k8s.js";

const NAMESPACE = getNamespace();
const INTERVAL_MS = parseInt(process.env.REAPER_INTERVAL_MS || "60000", 10);

export function startReaper() {
  const { appsV1, coreV1, networkingV1 } = getK8sClients();
  const now = () => Math.floor(Date.now() / 1000);

  async function reap() {
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

        console.log(`[Reaper] Instance expired, deleting: ${name} (expired at ${exp})`);

        const results = await Promise.allSettled([
          appsV1.deleteNamespacedDeployment(name, NAMESPACE),
          coreV1.deleteNamespacedService(name, NAMESPACE),
          networkingV1.deleteNamespacedIngress(name, NAMESPACE),
        ]);

        const resourceTypes = ["Deployment", "Service", "Ingress"];
        results.forEach((r, i) => {
          if (r.status === "fulfilled") {
            console.log(`[Reaper]   ${resourceTypes[i]} deleted: ${name}`);
          } else {
            const code = r.reason?.response?.statusCode;
            if (code === 404) {
              console.log(`[Reaper]   ${resourceTypes[i]} already gone: ${name}`);
            } else {
              console.error(`[Reaper]   Failed to delete ${resourceTypes[i]}: ${name}`, r.reason?.message || r.reason);
            }
          }
        });
      }
    } catch (e) {
      console.error("[Reaper] error:", e?.message || e);
    }
  }

  // Run immediately on startup, then on interval
  reap();
  setInterval(reap, INTERVAL_MS);

  console.log(`[Reaper] started, interval: ${INTERVAL_MS}ms, namespace: ${NAMESPACE}`);
}
