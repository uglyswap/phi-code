# Database Skill

## When to use
SQL queries, schema design, migrations, query optimization.

## Schema Design
- Use UUIDs for public-facing IDs, integers for internal
- Always add `created_at` and `updated_at` timestamps
- Use `NOT NULL` by default, allow NULL only when needed
- Index foreign keys and frequently queried columns
- Use enums or lookup tables for fixed sets of values

## PostgreSQL
```sql
-- Create table with best practices
CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email VARCHAR(255) UNIQUE NOT NULL,
  name VARCHAR(255) NOT NULL,
  role VARCHAR(50) NOT NULL DEFAULT 'user',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for common queries
CREATE INDEX idx_users_email ON users(email);
CREATE INDEX idx_users_role ON users(role);

-- Trigger for updated_at
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER users_updated_at
  BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
```

## Query Optimization
- Use `EXPLAIN ANALYZE` to understand query plans
- Index columns used in WHERE, JOIN, ORDER BY
- Avoid `SELECT *` — select only needed columns
- Use pagination (LIMIT/OFFSET or cursor-based)
- Use `pg_trgm` for fuzzy text search
- Use connection pooling (PgBouncer)

## Migrations
- Always write both up and down migrations
- Never modify a deployed migration — create a new one
- Test migrations on a copy of production data
- Backup before running migrations in production
