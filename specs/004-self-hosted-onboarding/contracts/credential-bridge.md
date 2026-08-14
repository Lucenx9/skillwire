# Contract: Local MCP Credential Bridge

## Purpose and boundary

The bridge is a local transport adapter. It lets a normal user-scoped Codex or Claude Code MCP entry obtain a persistent client-specific SkillWire credential without putting that credential in client configuration, process arguments, environment variables, shell startup files, plugins, or repositories.

It MUST NOT implement catalog discovery, ranking, activation policy, provenance, advisory logic, repository memory, source ingestion, retry policy, or any seventh tool. Those remain in the existing Streamable HTTP service.

## Invocation

```text
skillwire bridge --installation <uuid> --client codex|claude
```

The command is non-interactive. It accepts no raw bearer key, endpoint override, arbitrary URL, arbitrary credential path, debug body logging, or retry flag. It reads one owned versioned installation record from the normal XDG state root and resolves:

- the exact loopback MCP URL;
- the active release/contract identity;
- one client-specific credential reference and backend;
- startup and call deadlines.

The `installation` UUID and `client` selector are non-secret. All other arguments are rejected.

## Initialization sequence

For one process, the bridge MUST perform exactly this bounded sequence:

1. Validate the stable executable, owned installation record, active release, client integration, endpoint, and credential reference without following unowned links.
2. Resolve the credential once through the configured backend.
3. Validate the token shape without emitting it.
4. Open one MCP Streamable HTTP connection to the exact loopback endpoint with redirects disabled and `Authorization: Bearer <token>` constructed only in process memory.
5. Fetch/validate server instructions and `tools/list` against the release's exact six-tool contract.
6. Start the STDIO MCP server and expose the validated instructions/tools.
7. Forward client tool calls and safe MCP results until EOF, cancellation, deadline, or upstream failure.
8. Close both transports and overwrite credential buffers where the managed runtime permits.

The complete path from process start through state validation, credential lookup, upstream initialization, exact-contract validation, and STDIO readiness MUST either succeed or terminate within 10.0 seconds measured by a monotonic clock. Every internal deadline is smaller and their worst-case sum cannot exceed that end-to-end budget. The implementation uses one bounded attempt and no reconnect, poll, authentication prompt, endpoint fallback, alternate key, or second server.

The sole `src/onboarding/cli/main.ts` dispatcher routes `bridge` before administrative rendering. In bridge mode stdout contains only MCP STDIO bytes; administrative envelopes, previews, progress, and human messages cannot enter the stream. `SIGINT`/`SIGTERM` propagate through the shared cancellation signal and produce the bounded bridge cancellation behavior.

## Exposed MCP surface

Initialization and tool discovery MUST preserve the release-pinned server name/version/instructions and exactly these tool names:

```text
search_skills
load_skill
read_skill_resource
list_repo_memory
record_skill_outcome
forget_repo_memory
```

For every tool, the bridge preserves the upstream input schema, output schema, description, standard annotations, structured result, error status, and cancellation/deadline behavior. An upstream name/count/schema/metadata mismatch terminates initialization with `BRIDGE_TOOL_CONTRACT_MISMATCH`; the bridge never hides, invents, or adapts a tool contract.

The bridge does not cache catalog content or tool results. Client-bound instructions/resources remain transient MCP data and are never written locally.

## Secret Service backend

The supported primary executable is the verified absolute `/usr/bin/secret-tool`. It is invoked directly with `shell:false`, a sanitized environment, closed unrelated file descriptors, bounded pipes/output, and a deadline.

Lookup attributes are exactly:

```text
application=skillwire
schema=1
installation=<installation-uuid>
client=codex|claude
credential-ref=<credential-reference-uuid>
```

Attributes are non-secret and MUST NOT contain endpoint, account ID, username, path, key public ID, repository identity, or release input. Setup's store operation sends the token through stdin with no trailing newline. Bridge lookup reads bounded stdout privately, removes at most the helper's single terminal newline, validates one token, and never forwards helper stdout. Clear uses the complete owned attribute set so it cannot remove another client or installation item.

The collection may be locked or prompt outside the bridge. The bridge itself never opens an interactive prompt or repeatedly invokes the helper. Locked, unavailable, timed-out, missing, malformed, and clear-failed states are distinct findings.

## Restrictive-file backend

The fallback is permitted only when the installation record proves the user separately confirmed the exact risk/path. The canonical locator is:

```text
$XDG_DATA_HOME/skillwire/credentials/<installation-id>/<client>.key
```

with the normal XDG default when unset.

Every read validates:

- absolute normalized XDG root and path containment;
- no traversal and no symlink in an owned ancestor or final component;
- every owned parent is a directory owned by the invoking UID with mode `0700`;
- final object is a regular file, invoking-UID-owned, mode exactly `0600`, link count one;
- open uses no-follow semantics followed by `fstat` identity revalidation;
- bounded file size and exactly one valid SkillWire token with no extra bytes.

Creation uses exclusive mode `0600`; replacement uses a same-directory exclusive staged file, file sync, atomic rename, and directory sync. Any failed invariant is terminal; the bridge does not chmod/chown/repair during client startup.

## Upstream HTTP rules

- Scheme is `http` and host is an exact loopback address approved by the release (`127.0.0.1` by default).
- Port/path equal the installed endpoint; query, fragment, user info, wildcard hosts, DNS names, Unix-to-remote tunnels, and redirects are rejected.
- TLS/OAuth/proxy discovery are outside MVP.
- Headers contain only MCP-required values plus the bearer authorization. No credential is placed in URL, query, logs, metrics, User-Agent, or error bodies.
- Authentication, initialization, and tool calls have bounded deadlines. Activation-level retries remain zero.

## Failure contract

Before successful STDIO initialization, the bridge exits non-zero promptly with one bounded stderr line containing only a stable code and safe summary. After initialization, it returns one safe MCP transport/tool error if possible and then closes; it does not loop.

| Code | Meaning |
|------|---------|
| `BRIDGE_STATE_INVALID` | Installation/release/client state missing, unowned, malformed, or drifted. |
| `BRIDGE_ENDPOINT_INVALID` | Endpoint is not the exact installed loopback endpoint. |
| `BRIDGE_CREDENTIAL_MISSING` | Owned reference has no resolvable token. |
| `BRIDGE_CREDENTIAL_LOCKED` | Secret Service item/collection requires unavailable interaction. |
| `BRIDGE_CREDENTIAL_BACKEND_UNAVAILABLE` | Selected helper/service/file cannot be used safely. |
| `BRIDGE_CREDENTIAL_INVALID` | Resolved bytes do not match one valid token. |
| `BRIDGE_UPSTREAM_UNREACHABLE` | Local service cannot be reached before deadline. |
| `BRIDGE_AUTH_REJECTED` | Upstream rejected the client-specific key. |
| `BRIDGE_TOOL_CONTRACT_MISMATCH` | Discovery differs from the exact six-tool release contract. |
| `BRIDGE_UPSTREAM_INCOMPATIBLE` | MCP negotiation/instructions are incompatible. |
| `BRIDGE_TIMEOUT` | One bounded operation exceeded its deadline. |
| `BRIDGE_CANCELLED` | Parent closed/cancelled the connection. |

No error contains the key, account/key ID, authorization/header value, upstream response body, prompt/response, repository hash, or unrelated path/configuration. Because both client registrations are optional, a bridge failure must leave the ordinary client usable and must not trigger repeated credential prompts.

## Key creation handoff

The bridge never creates service keys. Onboarding obtains a new token from the one-shot authentication administrator through a private FIFO/file descriptor below a validated runtime directory. The admin container uses no Docker log driver; stdout carries only non-secret account/key metadata. The parent stores the token in the selected backend before client configuration and revokes it if persistence or that client's transaction fails.

## Verification requirements

- Unit tests use a fake `secret-tool` and prove store input is stdin-only, lookup output is never inherited, `shell:false`, bounded output, no retry, and per-client attributes.
- A Linux integration job runs `/usr/bin/secret-tool` against a real isolated D-Bus/Secret Service implementation and covers available, locked, unavailable, cleared, and fresh-session states. The session-restart fixture destroys the bus, keyring daemon, runtime directory, bridge, and client process, retains only persistent XDG state, then launches a new session; a consent-gated supported-host reboot smoke complements this deterministic proxy.
- Security tests scan argv, environment, `/proc`, Docker logs, terminal capture, configs, journals, snapshots, backups, reports, and repository diffs for generated canaries.
- Contract tests connect a real MCP client through STDIO to a real local Streamable HTTP server and compare exact instructions, six tools, schemas, annotations, results, errors, and trace order.
- Dispatcher/timing tests invoke the compiled executable, prove bridge byte purity and signal propagation, and measure the complete process-to-readiness/failure path against the deterministic 10.0-second gate.
- Failure tests cover missing/locked/unavailable key, bad permissions/links, stopped endpoint, 401, timeout, schema/tool drift, cancellation, logout/reboot, and fresh terminal/IDE/local desktop launches.
