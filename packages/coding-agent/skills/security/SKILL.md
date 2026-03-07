---
description: "Security auditing, vulnerability scanning, and hardening"
---
# Security Skill

## When to use
Code review for security, implementing auth, handling sensitive data.

## OWASP Top 10 Checks
1. **Injection** — Parameterized queries, never string concatenation for SQL
2. **Broken Auth** — Strong passwords, MFA, secure session management
3. **Sensitive Data** — Encrypt at rest and in transit, never log secrets
4. **XXE** — Disable external entity processing in XML parsers
5. **Broken Access Control** — Check permissions on every request
6. **Misconfig** — No default credentials, disable debug in production
7. **XSS** — Sanitize output, use CSP headers
8. **Insecure Deserialization** — Validate before deserializing
9. **Known Vulnerabilities** — Keep dependencies updated
10. **Insufficient Logging** — Log security events, monitor anomalies

## Secrets Management
- NEVER commit secrets to git
- Use environment variables or secret managers
- Rotate keys regularly
- Use `.env` files locally, secrets manager in production
- Add `.env` to `.gitignore`

## Auth Patterns
```typescript
// Hash passwords (never store plain text)
const hash = await bcrypt.hash(password, 12);

// JWT with short expiry
const token = jwt.sign({ userId }, SECRET, { expiresIn: "15m" });

// Always validate input
const schema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
});
```

## Headers
```
Strict-Transport-Security: max-age=31536000; includeSubDomains
Content-Security-Policy: default-src 'self'
X-Content-Type-Options: nosniff
X-Frame-Options: DENY
```
