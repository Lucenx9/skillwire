# Stateless Streamable HTTP Contract

## Endpoint and Protocol

- MCP endpoint: `POST /mcp`
- Transport: MCP SDK v2 stateless Streamable HTTP through Hono
- No server session ID, resumability, SSE session store, or sticky-session requirement
- `GET /mcp` and `DELETE /mcp` are unsupported
- Each request creates an isolated MCP server/request context and closes it after the response

One or more identical service instances may share the authoritative PostgreSQL database. Each
instance has only a verified immutable catalog cache; repository memory always reaches PostgreSQL.

## Health and Readiness

- `GET /health/live` reports process liveness without catalog or tenant data.
- `GET /health/ready` succeeds only after configuration, migrations, catalog/release/advisory
  verification, PostgreSQL connectivity, and startup expired-audit cleanup succeed.
- After service or database downtime, readiness remains false until the same startup cleanup
  completes against the recovered authoritative database.
- Hourly cleanup failure makes readiness false and retries, while logical audit expiry remains
  enforced by every query.

Health endpoints expose no secrets, repository identifiers, catalog bodies, or failure internals.

## Required Headers and Limits

MCP requests require:

- `Authorization: Bearer <api-key>`
- `Content-Type: application/json`
- an allowed `Host`

The server applies the documented body, task, response, deadline, and rate limits before catalog
content or persistent memory is accessed. Proxy forwarding headers are trusted only from explicitly
configured proxies.

## Middleware Order

1. Request ID and deadline context.
2. Host/DNS-rebinding validation.
3. Body/content-type/size validation.
4. Bearer authentication and active-account lookup.
5. Per-key rate policy.
6. Strict MCP envelope/tool schema validation.
7. Tool execution through application use cases.
8. Safe error translation, redaction, and bounded structured audit event.

Authentication precedes argument-dependent lookup so unauthorized callers cannot distinguish
catalog, revision, resource, repository, or tenant existence.

## HTTP Behavior

| Condition | HTTP behavior |
|-----------|---------------|
| Valid MCP tool call | MCP response over HTTP 200. |
| Missing/invalid/revoked credential | Indistinguishable HTTP 401. |
| Invalid host | HTTP 403 without dispatch. |
| Unsupported method | HTTP 405. |
| Wrong content type or oversized body | HTTP 400/413 before dispatch. |
| Rate exceeded | HTTP 429 with bounded retry information. |
| Service not ready | HTTP 503 without protected details. |
| Valid authenticated tool-domain failure | HTTP 200 containing bounded MCP tool error. |

## Request and Commit Lifetime

- Client cancellation stops non-committed work where possible.
- A committed load usage upsert remains acknowledged state even if response delivery fails; retry
  applies the specified upsert/count behavior.
- `forget_repo_memory` is acknowledged only after the PostgreSQL delete/audit transaction commits.
- There is no repository-memory cache update or invalidation stage.
- Graceful shutdown stops accepting requests, drains in-flight work to a fixed deadline, stops the
  hourly cleanup scheduler, and closes the pool.

## Compatibility and Isolation Tests

Contract tests own HTTP method, header, envelope, status, and statelessness behavior. Integration
tests own readiness and PostgreSQL lifecycle. End-to-end tests own complete MCP journeys. Security
tests own host attacks, authentication ambiguity, rate abuse, SSRF-shaped fields, and cross-tenant
attempts. Shared request fixtures prevent duplicate matrices across these layers.
