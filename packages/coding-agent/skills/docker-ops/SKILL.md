---
description: "Docker containers, Compose, images, and orchestration"
---
# Docker Operations Skill

## When to use
Writing Dockerfiles, docker-compose configs, debugging containers.

## Dockerfile Best Practices
```dockerfile
# Multi-stage build
FROM node:22-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY . .
RUN npm run build

FROM node:22-alpine
WORKDIR /app
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
USER node
EXPOSE 3000
HEALTHCHECK CMD wget -qO- http://localhost:3000/health || exit 1
CMD ["node", "dist/index.js"]
```

## Docker Compose
```yaml
services:
  app:
    build: .
    ports: ["3000:3000"]
    environment:
      - NODE_ENV=production
    volumes:
      - app-data:/app/data
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://localhost:3000/health"]
      interval: 30s
      timeout: 10s
      retries: 3

volumes:
  app-data:
```

## Debugging
```bash
docker compose logs -f <service>     # Follow logs
docker compose exec <svc> sh         # Shell into container
docker compose ps                     # Status
docker compose restart <service>      # Restart
docker system prune -af               # Clean everything
docker volume ls                      # List volumes
```
