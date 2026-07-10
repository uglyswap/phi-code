---
description: "CI/CD pipelines, deployment, monitoring, and infrastructure"
---
# DevOps Skill

## When to use
Docker, CI/CD, deployment, monitoring, infrastructure tasks.

## Docker
- Always use multi-stage builds for production
- Pin image versions (never use `latest` in production)
- Use `.dockerignore` to reduce context
- Health checks: `HEALTHCHECK CMD curl -f http://localhost:PORT/health`
- Non-root user: `USER node` or `USER 1000`
- Use named volumes for persistence
- Compose: separate dev and prod configs

## CI/CD
- GitHub Actions: `.github/workflows/`
- Pipeline: lint → test → build → deploy
- Cache dependencies between runs
- Use environment secrets, never hardcode
- Branch protection rules on main

## Monitoring
- Health endpoint: `GET /health` → `{ status: "ok", uptime: ... }`
- Structured logging (JSON)
- Error tracking (Sentry, etc.)
- Resource monitoring (CPU, memory, disk)

## Troubleshooting
```bash
docker compose logs -f <service>   # Live logs
docker stats                        # Resource usage
docker system df                    # Disk usage
docker exec -it <container> sh      # Shell access
ss -tlnp                            # Open ports
journalctl -u <service> -f          # Systemd logs
```
