import Fastify from "fastify";
import fastifySwagger from "@fastify/swagger";
import fastifySwaggerUi from "@fastify/swagger-ui";
import { deploy } from "./routes/deploy.js";
import { status } from "./routes/status.js";
import { terminate } from "./routes/terminate.js";
import { renew } from "./routes/renew.js";
import { startReaper } from "./lib/reaper.js";

const API_KEY = process.env.X_API_KEY || process.env.API_KEY || "";
const PORT = parseInt(process.env.PORT || "3000", 10);

async function apiKeyHook(request, reply) {
  const key = request.headers["x-api-key"];
  if (!API_KEY) return;
  if (key !== API_KEY) {
    return reply.code(401).send({ error: "Invalid or missing X-API-KEY" });
  }
}

async function build() {
  const fastify = Fastify({ logger: true });

  await fastify.register(fastifySwagger, {
    openapi: {
      openapi: "3.1.0",
      info: { title: "CTFd K8s Orchestrator", version: "1.0.0", description: "On-prem worker bridging CTFd and Kubernetes for container challenges." },
      servers: [{ url: "/api/v1", description: "API v1" }],
      components: {
        securitySchemes: { ApiKeyAuth: { type: "apiKey", in: "header", name: "X-API-KEY" } },
        schemas: {
          DeployBody: {
            type: "object",
            required: ["challenge_id", "team_id", "image", "type", "duration"],
            properties: {
              challenge_id: { type: "string" },
              team_id: { type: "string" },
              image: { type: "string" },
              type: { enum: ["web", "tcp"] },
              duration: { type: "integer" },
              internal_port: { type: "integer", default: 80 },
              memory_limit: { type: "string", default: "128Mi" },
              cpu_limit: { type: "string" },
              env_vars: { type: "object", additionalProperties: { type: "string" } },
            },
          },
          DeployResponse: { type: "object", properties: { status: { type: "string" }, connection_info: { type: "string" }, expires_at: { type: "integer" } } },
        },
      },
      security: API_KEY ? [{ ApiKeyAuth: [] }] : [],
    },
  });

  await fastify.register(fastifySwaggerUi, { routePrefix: "/docs", uiConfig: { docExpansion: "list" } });

  fastify.register(async (scoped) => {
    scoped.addHook("preHandler", apiKeyHook);
    scoped.register(deploy, { prefix: "/api/v1" });
    scoped.register(status, { prefix: "/api/v1" });
    scoped.register(terminate, { prefix: "/api/v1" });
    scoped.register(renew, { prefix: "/api/v1" });
  });

  fastify.get("/health", async () => ({ ok: true }));

  return fastify;
}

async function main() {
  const app = await build();
  startReaper();

  const port = PORT;
  await app.listen({ port, host: "0.0.0.0" });
  console.log(`Orchestrator listening on :${port}, Swagger UI at /docs`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
