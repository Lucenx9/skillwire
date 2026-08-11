# PostgreSQL schema review checklist

- Column types and nullability match domain states.
- Checks, unique constraints, and foreign keys enforce invariants.
- Delete and update actions reflect ownership and lifecycle.
- Indexes correspond to measured predicates and ordering.
- Tenant keys lead every tenant-scoped query and uniqueness rule.
- Migrations account for locks, rewrites, backfills, and validation.
- Concurrent writes preserve counts, ordering, and uniqueness.
- Database-generated timestamps are used consistently.
