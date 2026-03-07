---
description: "REST API design patterns, versioning, error handling, and documentation"
---
# API Design Skill

## When to use
Designing REST APIs, GraphQL schemas, or any HTTP endpoints.

## REST Conventions
- `GET /users` — List users
- `GET /users/:id` — Get user by ID
- `POST /users` — Create user
- `PUT /users/:id` — Replace user
- `PATCH /users/:id` — Update user fields
- `DELETE /users/:id` — Delete user

## Status Codes
- `200` OK — Success
- `201` Created — Resource created
- `204` No Content — Success, no body
- `400` Bad Request — Invalid input
- `401` Unauthorized — No/invalid auth
- `403` Forbidden — Auth OK but no permission
- `404` Not Found — Resource doesn't exist
- `409` Conflict — Duplicate/conflict
- `422` Unprocessable — Validation failed
- `429` Too Many Requests — Rate limited
- `500` Internal Error — Server bug

## Response Format
```json
{
  "data": { ... },
  "meta": { "page": 1, "total": 42 },
  "errors": [{ "code": "VALIDATION", "message": "Email required", "field": "email" }]
}
```

## Best Practices
- Version your API: `/api/v1/users`
- Use pagination: `?page=1&limit=20`
- Filter: `?status=active&role=admin`
- Sort: `?sort=-created_at` (prefix `-` for descending)
- Rate limit all endpoints
- Validate all inputs with schemas (Zod, Joi)
- Use CORS properly
- Document with OpenAPI/Swagger
