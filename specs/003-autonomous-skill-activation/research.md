# Research: Autonomous Skill Activation

**Researched**: 2026-08-12
**Protocol baseline**: MCP `2026-07-28` (current) with `2025-11-25` compatibility
**SDK baseline**: `@modelcontextprotocol/server` and `@modelcontextprotocol/client` `2.0.0`, already pinned by this repository

**Codex baseline**: Codex CLI/plugin manager `0.147.0`; official implementation inspected at `openai/codex` commit `2230d64464488d8847197722fdca09d90095c705`

## Primary Sources

- [MCP 2026-07-28 discovery](https://modelcontextprotocol.io/specification/2026-07-28/server/discover)
- [MCP 2026-07-28 tools](https://modelcontextprotocol.io/specification/2026-07-28/server/tools)
- [MCP 2026-07-28 resources](https://modelcontextprotocol.io/specification/2026-07-28/server/resources)
- [MCP 2026-07-28 changes](https://modelcontextprotocol.io/specification/2026-07-28/changelog)
- [MCP 2025-11-25 lifecycle](https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle)
- [MCP 2025-11-25 schema: `InitializeResult.instructions` and tool metadata](https://modelcontextprotocol.io/specification/2025-11-25/schema)
- [MCP TypeScript SDK v2 protocol versions](https://ts.sdk.modelcontextprotocol.io/v2/protocol-versions)
- [MCP TypeScript SDK v2 2026-07-28 support](https://ts.sdk.modelcontextprotocol.io/v2/migration/support-2026-07-28)
- [MCP TypeScript SDK v2 client instructions access](https://ts.sdk.modelcontextprotocol.io/v2/clients/connect)
- [MCP TypeScript SDK v2 API](https://ts.sdk.modelcontextprotocol.io/v2/api/%40modelcontextprotocol/server/)
- [MCP TypeScript SDK `server@2.0.0` release](https://github.com/modelcontextprotocol/typescript-sdk/releases/tag/%40modelcontextprotocol%2Fserver%402.0.0)
- [MCP TypeScript SDK `ServerOptions.instructions` source](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/packages/server/src/server/server.ts)
- [MCP TypeScript SDK `McpServer.registerTool` source](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/packages/server/src/server/mcp.ts)
- [OpenAI Codex plugins](https://developers.openai.com/codex/plugins)
- [OpenAI package and distribute plugins](https://developers.openai.com/plugins/build/plugins)
- [OpenAI build skills](https://developers.openai.com/codex/skills)
- [OpenAI connect skills to MCP tools](https://developers.openai.com/plugins/build/skills)
- [OpenAI Codex MCP configuration](https://developers.openai.com/codex/mcp)
- [OpenAI plugin submission validation reference](https://developers.openai.com/plugins/deploy/submission-errors)
- [Official Codex plugin CLI implementation](https://github.com/openai/codex/blob/2230d64464488d8847197722fdca09d90095c705/codex-rs/cli/src/plugin_cmd.rs)
- [Official Codex marketplace CLI implementation](https://github.com/openai/codex/blob/2230d64464488d8847197722fdca09d90095c705/codex-rs/cli/src/marketplace_cmd.rs)
- [Official Codex plugin manager](https://github.com/openai/codex/blob/2230d64464488d8847197722fdca09d90095c705/codex-rs/core-plugins/src/manager.rs)
- [Official Codex marketplace loader](https://github.com/openai/codex/blob/2230d64464488d8847197722fdca09d90095c705/codex-rs/core-plugins/src/loader.rs)
- [Official Codex MCP skill-dependency behavior](https://github.com/openai/codex/blob/2230d64464488d8847197722fdca09d90095c705/codex-rs/core/src/mcp_skill_dependencies.rs)

## Decision 1: Publish one policy through the standard server instruction field in both protocol eras

**Decision**: Define one centralized, versioned activation-policy constant and pass its text as `ServerOptions.instructions` when constructing `McpServer`. Keep the existing `createMcpHandler(..., { legacy: "stateless" })` hosting shape. The same policy must therefore appear in the legacy `initialize` result and in the modern `server/discover` result. Tests must cover both representations and refer to them collectively as the server instruction field; where a test is specifically about wire behavior, it must say `initialize` or `server/discover` explicitly.

**Rationale**: MCP `2025-11-25` defines optional `InitializeResult.instructions` as guidance that may be added to an LLM system prompt. MCP `2026-07-28` removed the initialization handshake, requires servers to implement `server/discover`, and defines `DiscoverResult.instructions` as optional natural-language guidance for LLMs. The official TypeScript SDK v2 deliberately supports both eras. Its `ServerOptions.instructions` is emitted from the same stored value by both its legacy initialize handler and modern discovery handler. The repository already uses `@modelcontextprotocol/server@2.0.0` and the dual-era `createMcpHandler`, so constructor configuration is the smallest standards-compliant change and avoids a transport migration.

**Alternatives considered**:

- Treat only `initialize` as current MCP behavior: rejected because the current `2026-07-28` protocol removed that handshake.
- Move only to `server/discover`: rejected because existing MCP clients may continue to use the 2025-era initialize flow and SDK v2 supports both without duplicating application logic.
- Add a prompt, tool, resource, activation file, or client configuration: rejected because those are different control surfaces, would expand the six-operation contract or client boundary, and are unnecessary.

## Decision 2: Retain server instructions as advisory baseline and treat the server-only Codex hypothesis as falsified

**Decision**: Keep the centralized instruction and tool metadata because they are the most portable standards-compliant baseline. State explicitly that SkillWire guarantees only publication plus server behavior after a call. Preserve `evaluation/evidence/003/candidate-v1.json` unchanged: Codex CLI `0.147.0`, `gpt-5.6-sol`, and `xhigh` correctly received the policy but made `0/7` spontaneous SkillWire activations. This falsifies the tested server-only autonomous-activation hypothesis and justifies one optional thin Codex adapter; it does not invalidate the server metadata or explicit operation.

**Rationale**: The legacy specification calls server instructions a hint and says a client *may* add them to the system prompt. Modern `server/discover` is itself optional for clients. The tools specification says tools are designed to be model-controlled, while explicitly leaving interaction behavior to each implementation. Tool descriptions and annotations are also hints, not executable policy. Therefore spontaneous invocation, task-intent tracking, local-skill equivalence, and loop prevention are model/harness behaviors that can be requested and measured but cannot be forced by this server.

**Alternatives considered**:

- Claim that MCP instructions force automatic calls: rejected as contrary to the specification.
- Reject ordinary client operations unless the client proves it followed the workflow: rejected because the server does not receive the complete user task or reliable local-skill inventory, would block normal work, and would create a non-standard client protocol.
- Remove the server policy now that Codex needs an adapter: rejected because the policy remains useful to conforming harnesses and preserves client-agnostic explicit operation.
- Generalize immediately to multiple harness adapters: rejected because only Codex has validated negative evidence and the smallest measurable intervention is one separate adapter.

## Decision 3: Keep the activation policy concise, centralized, versioned, and independently testable

**Decision**: Store policy version and policy text in one server-side module. Keep the full text at or below 1,200 Unicode characters. Make the first 512 Unicode characters a complete decision capsule covering: specialized-task trigger, local/already-loaded guidance precedence, one automatic search, `automatic` invocation context, principal non-triggers, minimal non-sensitive query, and inert/no-install behavior. Put cross-tool ordering and global constraints in this policy; keep operation-specific details in the relevant tool description. Test exact text, version, length, prefix behavior, required concepts, and absence of client-specific names or paths.

**Rationale**: The SDK guidance describes server instructions as the place for cross-tool relationships, workflow patterns, and constraints, while advising against duplicating tool descriptions. A single exported policy prevents initialize/discover drift, makes the 512-character truncation property deterministic, and permits intentional review whenever the version changes.

**Alternatives considered**:

- Duplicate prose in the server factory and six registrations: rejected because it creates drift and makes changes hard to review.
- Put the whole workflow in `search_skills.description`: rejected because clients may use server instructions independently of individual tool metadata and the description should remain operation-specific.
- Generate policy text dynamically by client, tenant, or catalog: rejected because the behavior should be stable, cacheable, privacy-safe, and easy to test.

## Decision 4: Encode bounded automatic activation as guidance and deterministic result bounds, not session state

**Decision**: The instruction policy must define one activation attempt per unchanged task intent: at most one `search_skills` call, one exact `load_skill` call, and only specifically useful declared resources, with no duplicate resource path, retry, polling, query reformulation, alternate revision, or second candidate. A materially new user objective or later explicit user request can begin a new attempt. Preserve the existing schema limits and relevance filtering as server-enforceable bounds. Do not add a session/task ledger solely to police agent call counts.

**Rationale**: In modern MCP, requests are stateless and any cross-call state is explicit. The server does not possess a canonical task-intent identifier or the harness context required to distinguish retry, rephrasing, and a genuinely new objective. Adding hidden connection state would be unreliable across protocol eras and horizontally scaled instances. The server can deterministically cap response size, exclude ineligible entries, require exact identities for loading, enforce declared resource access, and return safe errors; the harness/model must apply the one-attempt rule.

**Alternatives considered**:

- Add per-connection counters: rejected because current MCP is stateless, the current HTTP handler builds per-request servers, and connection identity is not task identity.
- Add a task-intent identifier to existing tool inputs: rejected because operation contracts may not change.
- Automatically reformulate or retry weak searches: rejected because it increases latency, disclosure, and loop risk and conflicts with fail-open behavior.

## Decision 5: Preserve the current positive-relevance gate and invocation-mode filter

**Decision**: Preserve task relevance as the first sort key, repository memory only as a tie-breaker after relevance, deterministic skill identity as the final tie-breaker, and strict removal of non-positive eligible matches before limiting results. For `automatic` context, remove all user-only entries before ranking. Permit `user-requested` context only when explicit intent is present in the active user request; server-side filtering enforces the supplied context, while instructions and descriptions govern when an agent may supply it. Freeze expected matches against a fixed catalog and add threshold-boundary cases so any future scoring change is intentional.

**Rationale**: The current ranker already filters on `score > 0`, orders by relevance before memory, and returns an empty list when no eligible item has positive lexical relevance. The current search use case defaults omitted context to `automatic` and filters user-only entries before ranking. This is the smallest change: activation quality is improved at the model selection surface without destabilizing the established ranking and isolation semantics.

**Alternatives considered**:

- Return a best-effort result when every score is zero: rejected because it creates unrelated activation.
- Let memory overcome zero task relevance: rejected because it would make history stronger than the active task.
- Infer explicit user intent on the server from the task string: rejected because the server sees only a caller-authored summary, not authoritative conversation context, and such inference could bypass user-requested isolation.
- Add embeddings or a learned threshold: rejected as unnecessary scope expansion for the initial activation improvement.

## Decision 6: Refine descriptions and add accurate standard annotations without treating them as policy enforcement

**Decision**: Update only descriptions where they improve selection and ordering. Each description should be concise but state its trigger, key non-trigger or predecessor, bounded workflow role, and privacy/side-effect boundary. Use only standard annotations and assert them through `tools/list` tests:

| Operation | Required standard annotations | Description emphasis |
|-----------|-------------------------------|----------------------|
| `search_skills` | `readOnlyHint: true`, `destructiveHint: false`, `openWorldHint: false` | Specialized task only; `automatic` unless explicit user opt-in; minimal non-sensitive summary; once; previews only |
| `load_skill` | `readOnlyHint: false`, `destructiveHint: false`, `idempotentHint: false`, `openWorldHint: false` | After one relevant preview; exact revision only; returns inert instructions and manifest; optional opaque hash may increment server-side usage |
| `read_skill_resource` | `readOnlyHint: true`, `destructiveHint: false`, `openWorldHint: false` | Only after verified exact load; one declared useful safe path; no bulk or duplicate reads |
| `list_repo_memory` | `readOnlyHint: true`, `destructiveHint: false`, `openWorldHint: false` | Optional opaque repository hash only; not a discovery prerequisite |
| `record_skill_outcome` | `readOnlyHint: false`, `destructiveHint: true`, `idempotentHint: true`, `openWorldHint: false` | Existing attributable load record only; positive only after completed-task evidence or explicit feedback |
| `forget_repo_memory` | `readOnlyHint: false`, `destructiveHint: true`, `idempotentHint: true`, `openWorldHint: false` | Explicit request to delete one account-scoped opaque-hash namespace; unrelated to activation |

`openWorldHint: false` is appropriate for agent-facing operations because they use the already curated SkillWire catalog and account-scoped memory and must not perform live GitHub retrieval. Annotations describe server-side effects; they do not imply a client filesystem write. If an operation's verified implementation semantics differ, choose the conservative standard hint rather than a favorable but inaccurate value.

**Rationale**: MCP exposes tool `description` to help LLMs understand available tools. Its standard annotations are `readOnlyHint`, `destructiveHint`, `idempotentHint`, and `openWorldHint`; the specification says every annotation is an untrusted hint. Defaults are conservative, so explicit accurate annotations improve client presentation without introducing a custom metadata dialect. The SDK `registerTool(name, config, handler)` directly accepts `description` and `annotations` and returns them through `tools/list`.

**Alternatives considered**:

- Invent activation-specific annotations: rejected because they are non-standard and arbitrary clients cannot be expected to interpret them.
- Mark `load_skill` or the other repository-memory tools read-only because they do not write the client: rejected because annotations describe the tool's environment, which includes the optional usage increment and other server-side memory changes.
- Mark `record_skill_outcome` non-destructive: rejected as potentially misleading because it replaces an existing outcome.
- Repeat the full server policy in every description: rejected because it increases prompt cost and drift.

## Decision 7: Keep progressive skill material delivery on the existing exact-revision tools

**Decision**: Preserve `search_skills` preview -> `load_skill` exact revision -> optional `read_skill_resource` for one declared path. Do not register new generic MCP resources or change the six operation contracts. Treat a successful `load_skill` result containing exact revision, content hash, provenance, and advisory status as the only SkillWire-delivery attribution event. Local skill names or contents, search previews, and unverified attempted loads are never attributable SkillWire loads.

**Rationale**: MCP resources are application-controlled; the host decides how and whether to attach them. The current SkillWire contract already provides verified, tenant-scoped, exact-revision resource access through `read_skill_resource`, and the feature explicitly requires observable calls to that operation. Recasting content as a new MCP resource surface would not make a model read it, would broaden the contract, and could weaken the existing provenance and safe-path boundary.

**Alternatives considered**:

- Embed every resource in `load_skill`: rejected because it defeats progressive disclosure and increases latency/context usage.
- Add `resources/list` and `resources/read` as a parallel public surface: rejected because this feature forbids new operation contracts and parallel paths complicate attribution and authorization.
- Treat a search preview or matching local skill name as a load: rejected because neither proves exact content, integrity, provenance, or advisory state.

## Decision 8: Make memory attribution a consequence of verified load, never activation speculation

**Decision**: Keep repository memory optional. Only `load_skill`, after all exact-revision availability, advisory, provenance, and integrity checks succeed, may record usage when the existing opaque repository hash is supplied. `record_skill_outcome` may replace an outcome only for that existing authenticated account/repository/revision record. Searches, local-skill use, failed loads, resource reads, and inferred model intent must not create memory. A positive outcome additionally requires completed-task evidence or explicit user feedback; this evidence rule is conveyed to the harness and verified in tool guidance, while the existing-record check remains server-enforced.

**Rationale**: This preserves a reliable attribution chain and prevents local or merely suggested guidance from contaminating ranking memory. It also separates two different guarantees: the server can enforce that a record exists from a prior verified load, but it cannot independently observe whether an external agent task completed successfully unless the caller supplies trustworthy evidence or feedback under the existing contract.

**Alternatives considered**:

- Record usage during search: rejected because previews are not used guidance.
- Record usage during resource reads: rejected because it duplicates the preceding load and excludes skills whose main instructions were sufficient.
- Infer positive outcomes from successful tool responses: rejected because transport success is not task success.
- Add raw repository paths, prompts, or source context as attribution: rejected by the opaque-hash privacy boundary.

## Decision 9: Fail open once and preserve all existing server-side security boundaries

**Decision**: If instructions are unavailable or ignored, SkillWire is unreachable, authentication fails, rate limiting occurs, search returns no relevant result, exact loading fails, or a resource fails, the automatic path stops without retry or context escalation and normal agent work continues. It must not fall back to anonymous access, switch `automatic` to `user-requested`, load a different candidate/revision, or create outcome/memory records for the failure. Surface a concise limitation only when it materially affects the requested result or the user explicitly asked for the remote guidance. Preserve authentication, tenant scope, rate limits, deadlines, input/output validation, provenance, advisory checks, integrity checks, safe resource paths, and inert return data. Agent-facing operations must continue to use only the already curated catalog and must make zero GitHub calls and zero client-tree writes.

**Rationale**: MCP recommends server input validation, access control, rate limiting, output sanitization, and client timeouts. It distinguishes tool execution errors, which clients should show models for possible correction, from protocol errors. For this feature, however, automatic correction must be bounded more tightly than the protocol permits: a readable error does not authorize a retry. A remote server has no legitimate client filesystem capability in this design, and retrieved instructions remain untrusted data rather than executable server behavior.

**Alternatives considered**:

- Retry on rate limits or transient failure: rejected because it adds unpredictable latency and can loop.
- Query GitHub on a catalog miss: rejected because discovery/ingestion remains an operator path and agent-facing privacy and availability must not depend on GitHub.
- Execute remote skill commands server-side or install them client-side: rejected because SkillWire is a retrieval-only service and the content is inert, untrusted guidance.
- Block the user's task when activation fails: rejected because remote guidance is optional augmentation.

## Decision 10: Split deterministic protocol/package gates from paired model-dependent activation evidence

**Decision**: Required offline CI must exercise a real MCP client, registered server transport, static adapter validator, and the Codex plugin manager against frozen local fixtures, with no model call, Codex account, live SkillWire dependency, credential, or GitHub API call. It must include:

1. A legacy-era connection that asserts `client.getInstructions()` equals the centralized policy and validates the instruction prefix and version.
2. A modern-era connection through `createMcpHandler` with version negotiation enabled that asserts the same text in discovery. The SDK documents that in-memory transport is legacy-only; modern coverage should drive the handler through a custom in-process `fetch`, not a mocked `DiscoverResult`.
3. `tools/list` assertions for all six exact descriptions, standard annotations, names, and unchanged input/output schemas.
4. Transport-level calls over frozen data that visibly record `search_skills` -> selected exact `load_skill` -> optional declared `read_skill_resource`, along with negative traces for automatic/user-requested filtering, zero relevance, no second load, failure handling, memory attribution, and no resource read when primary instructions suffice.
5. A fresh temporary client-tree before/after digest and an outbound-network guard that fails any agent-facing GitHub attempt.
6. Exact adapter/marketplace schema, inventory, secret, integrity, and semantic-consistency validation.
7. Disposable-profile plugin-manager lifecycle tests for marketplace add/list/upgrade/remove and plugin add/list/remove, with a temporary repository digest and failure rollback assertions.
8. Complete existing Feature 001 and Feature 002 regression suites.

The deterministic sequence proves the wire surface, package shape, manager lifecycle, and server-controlled invariants, not spontaneous model choice. A separate paired manual release evaluation selects the same non-overlap cases from the frozen corpus for otherwise identical server-only and server-plus-adapter sessions, records actual MCP traces, and reports spontaneous search, correct selection, progressive loading, unnecessary activation, and user-requested isolation. The five predeclared local-overlap cases retain deterministic coverage and may be measured only in a separately reported run against a version-recorded, pre-existing controlled local inventory that SkillWire neither installs nor modifies. These measurements remain non-blocking, but no autonomous Codex claim is permitted until the adapter cohort reaches 80% on at least 25 relevant clean prompts.

**Rationale**: The official SDK exposes `getInstructions()`, `listTools()`, and real client/server test paths. It specifically documents direct `createMcpHandler.fetch` testing for the modern era because `InMemoryTransport.createLinkedPair()` exercises only the legacy era. Deterministic tests can prove everything SkillWire controls; only a real model/harness run can prove that advisory metadata caused spontaneous invocation. Keeping the gates separate avoids false claims and credential-dependent CI.

**Alternatives considered**:

- Mock initialization/discovery and call use cases directly: rejected because that does not prove the actual MCP metadata or registered call path.
- Infer activation from a final answer: rejected because the answer may have used local knowledge or a local skill.
- Put live Codex runs in required CI: rejected because model behavior and credentials are non-deterministic external dependencies.
- Use a locally installed matching skill in clean-path evaluation: rejected because it confounds server-driven activation; local overlap has its own predeclared and separately reported subset.

## Decision 11: Use the smallest official Codex plugin package

**Decision**: Package exactly three files:

```text
.codex-plugin/plugin.json
skills/autonomous-skill-activation/SKILL.md
skills/autonomous-skill-activation/agents/openai.yaml
```

The manifest names `skillwire-autonomous-activation`, starts at semantic version `0.1.0`, and points `skills` to `./skills/`. `SKILL.md` contains one narrowly triggered activation workflow. `agents/openai.yaml` contains minimal interface labels, `policy.products: [CODEX]`, `allow_implicit_invocation: true`, and one MCP dependency. No `.mcp.json`, `.app.json`, hook, script, reference, asset, binary, package-manager file, or remote skill payload is included.

**Rationale**: Official Codex skills use their description for implicit selection and use `agents/openai.yaml` for invocation policy and MCP dependencies. A plugin is the supported installable distribution unit. Skill-level dependency metadata is sufficient and avoids declaring the same remote server a second time in `.mcp.json`. The combined names remain below current validator limits, paths are relative, and every package file has a direct purpose.

**Alternatives considered**:

- User-level standalone skill installation: rejected because the chosen supported distribution/lifecycle is a versioned plugin from a configured marketplace.
- Bundled `.mcp.json`: rejected because it is larger, can create duplicate/deconfliction complexity, and is unnecessary when the skill declares the dependency.
- Session-start hook or launcher: rejected because it is executable, UI/launcher-specific, and wider than activation guidance.

## Decision 12: Declare one credential-free MCP dependency and leave authentication to Codex

**Decision**: Declare one dependency with exact documented fields: `type: "mcp"`, `value: "skillwire"`, a concise description, `transport: "streamable_http"`, and the canonical release HTTPS MCP URL. The package validator rejects URL credentials, queries, fragments, tenant identifiers, placeholders, and non-HTTPS production values. It also rejects bearer/API key fields because the official skill dependency schema does not define them.

**Rationale**: OpenAI documentation says a skill dependency makes the tool available but does not replace workflow instructions. Credential handling belongs to the Codex MCP connection/auth flow. Existing SkillWire bearer deployments can be preconfigured through the supported Codex manager using a protected environment-variable reference; OAuth-capable deployments use Codex's stored OAuth flow. The package never sees a credential value. Paired evaluation preconfigures the same authenticated endpoint in both cohorts.

**Alternatives considered**:

- Embed an API key or bearer token: rejected as unsafe and unsupported.
- Put a tenant endpoint or repository hash in plugin metadata: rejected because the plugin is universal and privacy-safe.
- Make MCP required for Codex startup: rejected because activation must fail open and never block normal work.

## Decision 13: Use a dedicated Git-backed marketplace with immutable plugin source identity

**Decision**: Publish one entry in a marketplace named `skillwire`. The entry uses `source: "git-subdir"`, a credential-free HTTPS Git URL, `./`-prefixed package path, exact 40-character plugin commit `sha`, `installation: "AVAILABLE"`, `authentication: "ON_USE"`, and `category: "Developer Tools"`. Keep the marketplace catalog in a dedicated distribution repository. Store only a release input copy under `distribution/codex-marketplace/`; do not create root or client-repository `.agents/plugins` files.

**Rationale**: Official Codex supports configured Git marketplaces and exact-SHA plugin sources. Separating the marketplace commit from the plugin source commit avoids self-reference and makes promotion reproducible. `AVAILABLE` preserves explicit opt-in; `ON_USE` prevents adapter installation from requiring a credential it does not carry. A static JSON catalog is not a marketplace service or UI.

**Alternatives considered**:

- Repo marketplace in every client repository: rejected because repository-scoped activation files are forbidden.
- Mutable branch-only plugin source: rejected because it weakens reproducibility and rollback evidence.
- NPM package: rejected because it adds a registry and package-manager dependency without improving the three-file artifact.

## Decision 14: Delegate lifecycle entirely to Codex's plugin manager

**Decision**: Configure with `codex plugin marketplace add`, install with `codex plugin add`, verify through `codex plugin list --json` plus effective skill/MCP inventory, refresh with `codex plugin marketplace upgrade`, and uninstall with `codex plugin remove`. There is no official plugin `verify`, plugin `upgrade`, or manifest uninstall field, so do not invent one. The official uninstall identity is `skillwire-autonomous-activation@skillwire`. Remove the marketplace separately only when no other entry needs it.

**Rationale**: Codex stages plugin installs in its own cache, owns enablement/configuration, refreshes installed entries after marketplace upgrade, and removes cache/config on uninstall. SkillWire application code therefore has no reason or authority to write Codex-managed directories. A new session is required before installed skill behavior is evaluated.

**Alternatives considered**:

- Custom shell installer/uninstaller: rejected because it expands privilege and secret/file risk.
- Direct cache or `config.toml` edits: rejected because they bypass the manager and violate ownership boundaries.
- Roll back by restoring an old cache: rejected because old installed versions are not a supported rollback channel; publish last-known-good content under a higher version or uninstall.

## Decision 15: Make MCP absence and conflicts safe and observable

**Decision**: If Codex finds an equivalent transport/canonical-URL connection, reuse it. If the dependency is absent, Codex may offer to add it; decline or failure leaves normal work available. If the logical name is occupied by a different endpoint, do not overwrite it. If the endpoint is unavailable, unauthenticated, incompatible, timed out, or rate-limited, stop after the first automatic attempt. Verification records only categorical dependency state and winning source, never endpoint credentials or headers.

**Rationale**: Official Codex dependency resolution and MCP catalog precedence protect existing user configuration. The adapter cannot reliably repair connection/auth state without becoming an installer. Explicit preconfigured MCP access remains available with or without the plugin.

**Alternatives considered**:

- Silently replace a conflicting user connection: rejected as unsafe.
- Retry installation or tool calls until available: rejected for latency, disclosure, and loop safety.
- Disable the plugin package when MCP is absent: rejected because installation and connection state are separate, and failure must not block the host.

## Decision 16: Preserve v1 evidence and add a paired envelope

**Decision**: Keep `manual-evidence.schema.json` and `candidate-v1.json` valid and byte-stable. Add `paired-adapter-evidence.schema.json` as an envelope that binds the historical baseline path/hash/condition and contains two fresh v1-compatible runs: server instructions only and server instructions plus adapter. First-class experiment controls record the exact SkillWire commit, Codex CLI/model/reasoning, server policy, corpus/catalog/protocol/evaluator, clean-profile procedure, endpoint URL hash, authentication mechanism, and selected case IDs. The validator rejects unmatched case sets or differences in those controls, prompt bytes, or server configuration; the adapter/plugin inventory is the sole experimental variable. Recompute both runs' metrics and claim eligibility from actual traces. Do not infer activation from skill invocation or prose.

**Rationale**: The historical baseline is evidence, not a mutable benchmark label. An envelope preserves that truth while requiring a genuinely matched contemporary comparison and avoiding a breaking rewrite of the existing evidence validator. The same 75-case corpus remains the source of prompt/category expectations.

**Alternatives considered**:

- Overwrite `candidate-v1.json`: rejected because it destroys the falsifying evidence.
- Change the old schema so the baseline no longer validates: rejected because evidence formats should remain reproducible.
- Count an adapter skill invocation as success: rejected because only actual `search_skills -> exact load_skill` proves SkillWire delivery.

## Resulting Guarantee Boundary

| Concern | SkillWire can enforce deterministically | Harness/model remains advisory or measured |
|---------|-----------------------------------------|-------------------------------------------|
| Instruction publication | One versioned text in legacy initialize and modern discover responses | Whether instructions are fetched, placed in context, retained, or obeyed |
| Search eligibility | `automatic` excludes user-only entries; supplied context is validated | Whether explicit user intent exists before selecting `user-requested` |
| Relevance | Positive eligible matches only; relevance precedes memory; deterministic ordering | Whether and how the initial minimal task summary is composed |
| Workflow integrity | Exact revision, provenance/advisory/integrity checks, declared safe resources, attributable memory | One search/load per task intent, local-skill precedence, progressive need judgment, no model retry |
| Failure safety | Authentication, tenancy, limits, safe errors, no agent-facing GitHub access, no client filesystem capability | Stop automatic attempts and continue the user's normal work |
| Evaluation | Frozen schemas, expected catalog identities, actual transport calls, regression tests | Spontaneous activation and unnecessary-activation rates in named harness/model versions |
| Adapter package | Exact file allowlist, schema, policy, dependency, hashes, manager lifecycle, and no secret/repository writes | Whether Codex implicitly selects the activation skill for a prompt |
| Dependency resolution | Valid metadata, manager state, existing-connection preservation, safe server errors | User acceptance of connection setup and external credential availability |

No plan or release claim may cross this boundary by saying the MCP server forces an arbitrary harness to invoke its tools.
