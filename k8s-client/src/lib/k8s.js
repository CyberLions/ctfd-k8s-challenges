import * as k8s from "@kubernetes/client-node";

/** @type {k8s.CoreV1Api} */
let coreV1;
/** @type {k8s.AppsV1Api} */
let appsV1;
/** @type {k8s.NetworkingV1Api} */
let networkingV1;

function getKubeConfig() {
  const kc = new k8s.KubeConfig();
  if (process.env.KUBERNETES_SERVICE_HOST) {
    kc.loadFromCluster();
  } else {
    kc.loadFromDefault();
  }
  return kc;
}

export function getK8sClients() {
  if (!coreV1) {
    const kc = getKubeConfig();
    coreV1 = kc.makeApiClient(k8s.CoreV1Api);
    appsV1 = kc.makeApiClient(k8s.AppsV1Api);
    networkingV1 = kc.makeApiClient(k8s.NetworkingV1Api);
  }
  return { coreV1, appsV1, networkingV1 };
}

export const LABELS = {
  MANAGED_BY: "ctfd-orchestrator",
  TEAM_ID: "team_id",
  CHALLENGE_ID: "challenge_id",
  EXPIRES_AT: "expires_at",
};

export function labelSelector(teamId, challengeId) {
  return `${LABELS.MANAGED_BY}=ctfd-orchestrator,${LABELS.TEAM_ID}=${teamId},${LABELS.CHALLENGE_ID}=${challengeId}`;
}

export function baseLabels(teamId, challengeId, expiresAt) {
  return {
    [LABELS.MANAGED_BY]: "ctfd-orchestrator",
    [LABELS.TEAM_ID]: String(teamId),
    [LABELS.CHALLENGE_ID]: String(challengeId),
    [LABELS.EXPIRES_AT]: String(expiresAt),
  };
}

export function resourceName(teamId, challengeId) {
  const safe = (s) => String(s).toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "") || "x";
  return `chal-${safe(teamId)}-${safe(challengeId)}`;
}

export function getNamespace() {
  return process.env.CHALLENGE_NAMESPACE || "ctfd-challenges";
}

export function getRootDomain() {
  return process.env.ROOT_DOMAIN || "sillyctf.psuccso.org";
}
