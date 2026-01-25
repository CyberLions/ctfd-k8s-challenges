import { baseLabels, resourceName, getNamespace, getRootDomain } from "./k8s.js";

/**
 * @param {Object} opts
 * @param {string} opts.teamId
 * @param {string} opts.challengeId
 * @param {string} opts.image
 * @param {number} opts.internalPort
 * @param {number} opts.expiresAt
 * @param {string} [opts.memoryLimit]
 * @param {string} [opts.cpuLimit]
 * @param {Record<string,string>} [opts.envVars]
 * @param {"web"|"tcp"} opts.type
 */
export function buildDeployment(opts) {
  const name = resourceName(opts.teamId, opts.challengeId);
  const ns = getNamespace();
  const labels = baseLabels(opts.teamId, opts.challengeId, opts.expiresAt);

  const env = Object.entries(opts.envVars || {}).map(([k, v]) => ({
    name: k,
    value: String(v),
  }));

  const resources = {};
  if (opts.memoryLimit) resources.limits = { memory: opts.memoryLimit };
  if (opts.cpuLimit) {
    resources.limits = resources.limits || {};
    resources.limits.cpu = opts.cpuLimit;
  }
  if (opts.memoryLimit) resources.requests = resources.requests || {};
  if (opts.memoryLimit) resources.requests.memory = opts.memoryLimit;

  return {
    apiVersion: "apps/v1",
    kind: "Deployment",
    metadata: {
      name,
      namespace: ns,
      labels: { ...labels },
    },
    spec: {
      replicas: 1,
      selector: { matchLabels: { ...labels } },
      template: {
        metadata: { labels: { ...labels } },
        spec: {
          containers: [
            {
              name: "challenge",
              image: opts.image,
              ports: [{ containerPort: opts.internalPort, name: "http" }],
              env,
              resources: Object.keys(resources).length ? resources : undefined,
            },
          ],
          restartPolicy: "Always",
        },
      },
    },
  };
}

/**
 * @param {Object} opts
 * @param {string} opts.teamId
 * @param {string} opts.challengeId
 * @param {number} opts.port
 * @param {"web"|"tcp"} opts.type
 * @param {number} [opts.expiresAt]
 */
export function buildService(opts) {
  const name = resourceName(opts.teamId, opts.challengeId);
  const ns = getNamespace();
  const labels = baseLabels(opts.teamId, opts.challengeId, String(opts.expiresAt || 0));

  return {
    apiVersion: "v1",
    kind: "Service",
    metadata: {
      name,
      namespace: ns,
      labels: { ...labels },
    },
    spec: {
      type: opts.type === "tcp" ? "NodePort" : "ClusterIP",
      selector: { team_id: String(opts.teamId), challenge_id: String(opts.challengeId) },
      ports: [{ port: opts.port, targetPort: opts.port, name: "http", protocol: "TCP" }],
    },
  };
}

/**
 * @param {Object} opts
 * @param {string} opts.teamId
 * @param {string} opts.challengeId
 * @param {number} opts.port
 * @param {number} [opts.expiresAt]
 */
export function buildIngress(opts) {
  const name = resourceName(opts.teamId, opts.challengeId);
  const ns = getNamespace();
  const root = getRootDomain();
  const host = `${opts.teamId}-${opts.challengeId}.${root}`.toLowerCase().replace(/[^a-z0-9.-]/g, "-");
  const labels = baseLabels(opts.teamId, opts.challengeId, String(opts.expiresAt || 0));

  return {
    apiVersion: "networking.k8s.io/v1",
    kind: "Ingress",
    metadata: {
      name,
      namespace: ns,
      labels: { ...labels },
      annotations: {
        "nginx.ingress.kubernetes.io/proxy-body-size": "0",
        "nginx.ingress.kubernetes.io/proxy-read-timeout": "3600",
        "nginx.ingress.kubernetes.io/proxy-send-timeout": "3600",
      },
    },
    spec: {
      ingressClassName: process.env.INGRESS_CLASS || "nginx",
      rules: [
        {
          host,
          http: {
            paths: [
              {
                path: "/",
                pathType: "Prefix",
                backend: {
                  service: { name: resourceName(opts.teamId, opts.challengeId), port: { number: opts.port } },
                },
              },
            ],
          },
        },
      ],
      ...(process.env.TLS_ENABLED !== "false" && {
        tls: [{ hosts: [host], secretName: null }],
      }),
    },
  };
}
