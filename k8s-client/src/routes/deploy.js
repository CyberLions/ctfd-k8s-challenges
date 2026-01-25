import { deployBody } from "../schemas.js";
import { getK8sClients, LABELS, labelSelector, resourceName, getNamespace } from "../lib/k8s.js";
import { buildDeployment, buildService, buildIngress } from "../lib/manifests.js";

const MAX_GLOBAL = parseInt(process.env.MAX_CONTAINERS_GLOBAL || "500", 10);
const MAX_PER_TEAM = parseInt(process.env.MAX_CONTAINERS_PER_TEAM || "10", 10);
const NAMESPACE = getNamespace();

function getCore() {
  return getK8sClients();
}

/** List deployments with managed_by=ctfd-orchestrator */
async function listManagedDeployments() {
  const { appsV1 } = getCore();
  const { body } = await appsV1.listNamespacedDeployment(
    NAMESPACE,
    undefined,
    undefined,
    undefined,
    undefined,
    `${LABELS.MANAGED_BY}=ctfd-orchestrator`
  );
  return body.items || [];
}

/** Count deployments for team_id (or globally) */
async function countDeployments(teamId = null) {
  const items = await listManagedDeployments();
  if (!teamId) return items.length;
  return items.filter((d) => d.metadata?.labels?.[LABELS.TEAM_ID] === String(teamId)).length;
}

/** Check if this team already has this challenge running */
async function hasDuplicate(teamId, challengeId) {
  const { appsV1 } = getCore();
  const name = resourceName(teamId, challengeId);
  try {
    await appsV1.readNamespacedDeployment(name, NAMESPACE);
    return true;
  } catch (e) {
    if (e.response?.statusCode === 404) return false;
    throw e;
  }
}

export async function deploy(fastify, opts) {
  const { appsV1, coreV1, networkingV1 } = getCore();

  fastify.post("/deploy", async (request, reply) => {
    const parse = deployBody.safeParse(request.body);
    if (!parse.success) {
      return reply.code(400).send({ error: "Validation failed", details: parse.error.flatten() });
    }
    const d = parse.data;

    const globalCount = await countDeployments();
    if (globalCount >= MAX_GLOBAL) {
      return reply.code(429).send({ error: "Cluster at global container cap", max: MAX_GLOBAL });
    }

    const teamCount = await countDeployments(d.team_id);
    if (teamCount >= MAX_PER_TEAM) {
      return reply.code(429).send({ error: "Team at container cap", max: MAX_PER_TEAM });
    }

    if (await hasDuplicate(d.team_id, d.challenge_id)) {
      return reply.code(409).send({ error: "Instance already running for this team and challenge" });
    }

    const expiresAt = Math.floor(Date.now() / 1000) + d.duration;
    const name = resourceName(d.team_id, d.challenge_id);

    const deployment = buildDeployment({
      teamId: d.team_id,
      challengeId: d.challenge_id,
      image: d.image,
      internalPort: d.internal_port,
      expiresAt,
      memoryLimit: d.memory_limit,
      cpuLimit: d.cpu_limit,
      envVars: d.env_vars,
      type: d.type,
    });

    const service = buildService({
      teamId: d.team_id,
      challengeId: d.challenge_id,
      port: d.internal_port,
      type: d.type,
      expiresAt,
    });

    const protocol = process.env.TLS_ENABLED === "false" ? "http" : "https";
    const root = process.env.ROOT_DOMAIN || "sillyctf.psuccso.org";
    let connectionInfo;

    if (d.type === "web") {
      const ingress = buildIngress({
        teamId: d.team_id,
        challengeId: d.challenge_id,
        port: d.internal_port,
        expiresAt,
      });
      const host = ingress.spec.rules[0].host;
      connectionInfo = `${protocol}://${host}`;

      try {
        await appsV1.createNamespacedDeployment(NAMESPACE, deployment);
        await coreV1.createNamespacedService(NAMESPACE, service);
        await networkingV1.createNamespacedIngress(NAMESPACE, ingress);
      } catch (e) {
        await Promise.allSettled([
          appsV1.deleteNamespacedDeployment(name, NAMESPACE).catch(() => {}),
          coreV1.deleteNamespacedService(name, NAMESPACE).catch(() => {}),
          networkingV1.deleteNamespacedIngress(name, NAMESPACE).catch(() => {}),
        ]);
        return reply.code(500).send({ error: "Failed to create resources", message: e.message });
      }
    } else {
      // tcp: Service is NodePort
      try {
        await appsV1.createNamespacedDeployment(NAMESPACE, deployment);
        const svcRes = await coreV1.createNamespacedService(NAMESPACE, service);
        const nodePort = svcRes.body.spec?.ports?.[0]?.nodePort;
        const tcpHost = process.env.TCP_HOST || process.env.ROOT_DOMAIN || root;
        connectionInfo = nodePort ? `nc ${tcpHost} ${nodePort}` : `nc ${tcpHost} <nodeport>`;
      } catch (e) {
        await Promise.allSettled([
          appsV1.deleteNamespacedDeployment(name, NAMESPACE).catch(() => {}),
          coreV1.deleteNamespacedService(name, NAMESPACE).catch(() => {}),
        ]);
        return reply.code(500).send({ error: "Failed to create resources", message: e.message });
      }
    }

    return reply.send({
      status: "created",
      connection_info: connectionInfo,
      expires_at: expiresAt,
    });
  });
}
