import { z } from "zod";

export const deployBody = z.object({
  challenge_id: z.string().min(1, "challenge_id is required"),
  team_id: z.string().min(1, "team_id is required"),
  image: z.string().min(1, "image is required"),
  type: z.enum(["web", "tcp"]),
  duration: z.number().int().positive(),
  internal_port: z.number().int().positive().default(80),
  memory_limit: z.string().default("128Mi"),
  cpu_limit: z.string().optional(),
  env_vars: z.record(z.string()).optional().default({}),
});

export const terminateBody = z.object({
  team_id: z.string().min(1, "team_id is required"),
  challenge_id: z.string().min(1, "challenge_id is required"),
});

export const renewBody = z.object({
  team_id: z.string().min(1, "team_id is required"),
  challenge_id: z.string().min(1, "challenge_id is required"),
  duration: z.number().int().positive().optional(),
  restart: z.boolean().optional().default(false),
});

export const statusQuery = z.object({
  team_id: z.string().min(1, "team_id is required"),
  challenge_id: z.string().min(1, "challenge_id is required"),
});
