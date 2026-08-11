---
name: node-api-design
description:
  Design and review clear, compatible, secure Node.js service interfaces.
---

# Node API Design

Design the interface around stable resources and observable client behavior.

## Design sequence

1. Define the caller, resource, operation, and authorization boundary.
2. Choose method and status semantics that remain correct under retries.
3. Specify strict request and response schemas, including bounds and
   unknown-field handling.
4. Separate authentication failures, validation failures, domain conflicts, and
   transient service failures.
5. Make pagination, idempotency, concurrency, and version compatibility explicit
   where applicable.
6. Confirm logs and errors do not expose credentials, internal paths, or
   protected records.

Prefer a smaller coherent interface over convenience endpoints with overlapping
behavior. Describe compatibility consequences before renaming fields, changing
defaults, or narrowing accepted values.

Use the declared API review checklist for a complete boundary pass.
