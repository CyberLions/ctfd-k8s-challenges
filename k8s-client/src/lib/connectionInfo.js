import { getK8sClients, resourceName, getNamespace, getRootDomain } from "./k8s.js";

/**
 * Reconstruct connection_info from Kubernetes resources when the
 * ctfd-orchestrator/connection-info annotation is missing on the Deployment.
 *
 * For web challenges: reads the Ingress host and builds an https:// URL.
 * For tcp challenges: reads the Service NodePort and builds an `nc host port` string.
 *
 * @param {string} teamId
 * @param {string} challengeId
 * @returns {Promise<string>} connection string, or "" if not reconstructable
 */
export async function reconstructConnectionInfo(teamId, challengeId) {
  const { networkingV1, coreV1 } = getK8sClients();
  const name = resourceName(teamId, challengeId);
  const ns = getNamespace();

  // Try Ingress first (web challenges)
  try {
    const { body: ingress } = await networkingV1.readNamespacedIngress(name, ns);
    const host = ingress.spec?.rules?.[0]?.host;
    if (host) {
      const hasTls = ingress.spec?.tls && ingress.spec.tls.length > 0;
      const protocol = hasTls ? "https" : "http";
      return `${protocol}://${host}`;
    }
  } catch (e) {
    // No Ingress found — might be a TCP challenge
  }

  // Try Service (tcp challenges with NodePort)
  try {
    const { body: svc } = await coreV1.readNamespacedService(name, ns);
    if (svc.spec?.type === "NodePort") {
      const nodePort = svc.spec?.ports?.[0]?.nodePort;
      const tcpHost = process.env.TCP_HOST || process.env.ROOT_DOMAIN || getRootDomain();
      if (nodePort) {
        return `nc ${tcpHost} ${nodePort}`;
      }
    }
  } catch (e) {
    // No Service found
  }

  return "";
}

/**
 * Ensure a Deployment has the ctfd-orchestrator/connection-info annotation.
 * If not, reconstruct it and patch the Deployment (best-effort).
 *
 * @param {string} teamId
 * @param {string} challengeId
 * @param {string} currentAnnotation - existing annotation value (may be "")
 * @returns {Promise<string>} the connection_info string
 */
export async function ensureConnectionInfo(teamId, challengeId, currentAnnotation) {
  if (currentAnnotation) return currentAnnotation;

  const info = await reconstructConnectionInfo(teamId, challengeId);
  if (!info) return "";

  // Persist the reconstructed value as an annotation for future lookups
  try {
    const { appsV1 } = getK8sClients();
    const name = resourceName(teamId, challengeId);
    const ns = getNamespace();
    await appsV1.patchNamespacedDeployment(
      name, ns,
      { metadata: { annotations: { "ctfd-orchestrator/connection-info": info } } },
      undefined, undefined, undefined, undefined, undefined,
      { headers: { "Content-Type": "application/strategic-merge-patch+json" } }
    );
  } catch (e) {
    // Best effort — annotation may fail but we still return the info
  }

  return info;
}
