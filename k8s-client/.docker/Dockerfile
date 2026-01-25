# Production Dockerfile for Node.js server (k8s-client)
# Build: docker build -f .docker/Dockerfile -t k8s-client:latest ./k8s-client

FROM node:20-alpine AS base
RUN apk add --no-cache dumb-init

# ---- Dependencies ----
FROM base AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev

# ---- Production ----
FROM base AS runner
WORKDIR /app
ENV NODE_ENV=production

RUN addgroup -g 1001 -S nodejs && adduser -S nodejs -u 1001

COPY --from=deps /app/node_modules ./node_modules
COPY --chown=nodejs:nodejs . .

USER nodejs
EXPOSE 3000

# Uses "npm start" from package.json; ensure "start" script exists
CMD ["dumb-init", "npm", "start"]
