---
name: postgres-schema-review
description:
  Review PostgreSQL schemas, constraints, indexes, migrations, and data
  integrity.
---

# PostgreSQL Schema Review

Review the schema as the durable enforcement layer for domain invariants.

## Review sequence

1. Identify entities, ownership, lifecycle, and the invariants the database must
   preserve.
2. Check types, nullability, defaults, checks, unique constraints, and foreign
   keys.
3. Match indexes to actual predicates, ordering, cardinality, and write cost.
4. Review migration locking, table rewrites, backfills, validation order, and
   rollback constraints.
5. Verify tenant predicates and destructive operations cannot cross their
   intended scope.
6. Confirm timestamps, generated values, and concurrent writes have one
   authoritative rule.

Base findings on a concrete integrity or operational failure. Distinguish
correctness constraints from performance indexes, and do not recommend redundant
indexes without a query shape.

Use the declared schema checklist for systematic coverage.
