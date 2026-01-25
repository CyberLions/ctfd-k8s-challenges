# Node.js dev environment for k8s-client
FROM node:20-bookworm

RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /workspace

EXPOSE 3000
# Kept running for devcontainer; overrideCommand runs the IDE
CMD ["sleep", "infinity"]
