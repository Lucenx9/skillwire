# Stateless Streamable HTTP Contract

## Protocol and Endpoint

- MCP TypeScript SDK v2 stable line.
- Target MCP protocol revision: `2026-07-28`.
- Endpoint: `POST /mcp`.
- Transport: stateless Streamable HTTP in JSON response mode.
- `Mcp-Session-Id` is never issued, required, stored, or echoed.
- Stateful/legacy session GET and DELETE calls return HTTP 405.
- Unsupported protocol revisions receive the SDK's unsupported-version response; the service does
  not silently downgrade to a stateful contract.

The implementation uses the SDK's per-request server factory/handler. Each request receives a new
MCP server context with the same immutable tool registrations and shared application dependencies;
it is closed in `finally`. No principal, transport, request, or notification state survives the
request.

## Required Request Headers

| Header | Requirement |
|--------|-------------|
| `Authorization` | `Bearer <SkillWire API key>`; required for `/mcp`. |
| `Content-Type` | JSON content type accepted by MCP Streamable HTTP. |
| `Accept` | MCP v2-compatible JSON response media types. |
| `MCP-Protocol-Version` | Must negotiate the supported current protocol behavior. |
| `Host` | Must match the deployment allowlist enforced by the Hono MCP adapter. |

CORS is disabled. Browser access and credentialed cross-origin requests are out of scope.

## Middleware Order

1. Host-header/DNS-rebinding validation from `@modelcontextprotocol/hono`.
2. Request ID and fixed 10-second deadline.
3. Content type and 64 KiB body-stream limit.
4. Bearer API-key parsing, database digest verification, expiry/revocation/account check.
5. Per-key rate limit.
6. MCP protocol and strict Zod tool validation.
7. Tool use case.
8. Safe error mapping and structured audit completion event.

Authentication runs before tool arguments enter application use cases. No middleware logs the raw
request, authorization header, parsed body, or tool output.

## HTTP Status Behavior

| Status | Use |
|--------|-----|
| 200/202 | MCP transport success/notification acknowledgement as defined by SDK v2. |
| 400 | Malformed transport request that cannot be represented as a tool call. |
| 401 | Missing, malformed, invalid, expired, or revoked bearer key; includes `WWW-Authenticate: Bearer`. |
| 405 | Unsupported method, including stateful GET/DELETE. |
| 413 | Request exceeds 64 KiB before tool execution. |
| 415 | Unsupported content type. |
| 429 | Per-key quota exceeded; includes bounded `Retry-After`. |
| 500 | Transport-level unexpected failure with generic JSON-RPC internal error and request ID. |

Once a tool call is accepted by the transport, expected application failures use MCP tool error
results rather than ad hoc HTTP statuses.

## Hono and MCP SDK Wiring

- `createMcpHonoApp` creates the Hono app and enforces explicit allowed hosts when the container
  binds to `0.0.0.0`.
- The SDK v2 stateless handler factory creates an `McpServer` with only the `tools` capability.
- Tool adapters close over immutable application use cases, not request principals. The principal is
  retrieved from typed Hono request context for each call.
- Successful handlers return text plus `structuredContent` validated by the corresponding output
  Zod schema.
- `/health/live` and `/health/ready` are minimal unauthenticated operational endpoints outside MCP;
  they expose no catalog, account, key, repository, build-path, or error details.

## Request Lifetime

- A request receives one request ID, one immutable principal, and one deadline.
- Database and provider operations receive the remaining deadline and abort on expiration.
- Client disconnect closes the request's MCP context and prevents further persistence work when
  cancellation is still possible.
- Repository usage is acknowledged only after its transaction commits.
- Graceful shutdown stops new requests, drains in-flight requests up to the platform grace period,
  closes the PostgreSQL pool, and flushes logs.

## Rate Limit Semantics

- Key: public API-key UUID, never secret or repository hash.
- Policy: 120 accepted requests per rolling minute with burst capacity 30.
- State: bounded process-local entries with idle expiry.
- Missing/invalid keys are protected by a separate bounded IP-level failure limiter at the HTTP edge;
  IP values are not persisted in repository memory.
- The single-instance MVP makes the per-process quota authoritative. Horizontal/global quotas are a
  separate specification.

## Compatibility Tests

- Official SDK v2 client can initialize, list exactly six tools, and call each over POST.
- No response contains `Mcp-Session-Id`.
- Concurrent calls under two bearer keys never share principal or tool state.
- GET/DELETE and unsupported protocol versions fail as documented.
- Host, auth, body-size, content-type, and rate-limit failures occur before use-case invocation.
