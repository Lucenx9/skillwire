# SkillWire

SkillWire is a remote MCP skill catalog. It combines ten curated first-party
skills with verified or curated public GitHub imports, loads exact immutable
instructions, reads declared textual resources progressively, and remembers
optional repository-scoped usage in PostgreSQL. Skill content is returned as
inert MCP response data; it is never installed, executed, or written into a
client repository.

## Architecture

```text
MCP client -> Hono Streamable HTTP -> unified catalog -> first-party releases
                                      |               -> imported PostgreSQL bundles
                                      +-> repository memory
Admin scheduler/CLI -> fixed-origin GitHub REST -> validation -> PostgreSQL
```

The service is one stateless TypeScript modular monolith. Catalog releases,
provenance, resource hashes, and the append-only advisory chain are
version-controlled. PostgreSQL is the sole authority for imported immutable
bundles, source state, accounts, API-key hashes, repository usage, outcomes, and
privacy-safe erasure audit events. There is no repository-memory cache, Redis,
queue, repository clone, content execution, or client-side skill installation.

## Local development

Requirements are Node.js 24, pnpm 11.21.0, and Docker with Compose.

```bash
corepack enable
corepack prepare pnpm@11.21.0 --activate
pnpm install --frozen-lockfile
pnpm format:check
pnpm lint
pnpm typecheck
pnpm build
pnpm test:unit
pnpm test:contract
pnpm test:evaluation
```

PostgreSQL-backed tests use `TEST_DATABASE_URL`. CI and `compose.test.yaml`
create disposable databases automatically.

## Start with Docker Compose

Copy the non-secret configuration and create local secret files:

```bash
cp .env.example .env
install -d -m 700 .secrets
openssl rand -hex 32 > .secrets/postgres-password
openssl rand -hex 32 > .secrets/api-key-pepper
: > .secrets/github-token
postgres_password="$(tr -d '\n' < .secrets/postgres-password)"
printf 'postgresql://skillwire:%s@postgres:5432/skillwire\n' "$postgres_password" \
  > .secrets/database-url
chmod 400 .secrets/postgres-password
chmod 444 .secrets/database-url .secrets/api-key-pepper .secrets/github-token
unset postgres_password
docker compose up --build --wait
curl --fail http://127.0.0.1:3000/health/live
curl --fail http://127.0.0.1:3000/health/ready
```

Compose starts PostgreSQL, waits for it to become healthy, runs migrations to
completion, and only then starts SkillWire. The application runs as UID/GID
10001 with a read-only root filesystem, dropped capabilities, and bounded
temporary storage.

Bootstrap an account and API key using the out-of-band CLI:

```bash
account_json="$(docker compose exec -T skillwire \
  node dist/src/authentication/admin-cli.js account:create)"
account_id="$(node -e \
  'process.stdout.write(JSON.parse(process.argv[1]).accountId)' "$account_json")"
key_id="$(node -e \
  'process.stdout.write(require("node:crypto").randomUUID())')"
private_directory="$(mktemp -d)"
mkfifo --mode=0600 "$private_directory/token"
docker compose run --rm --no-TTY --no-deps \
  --user "$(id -u):$(id -g)" \
  --entrypoint node \
  --volume "$private_directory:/run/skillwire-private:rw" \
  skillwire dist/src/authentication/admin-cli.js key:create \
  --account-id "$account_id" --key-id "$key_id" \
  --token-output /run/skillwire-private/token \
  > "$private_directory/metadata.json" &
admin_pid=$!
timeout 30s sh -c 'cat "$1" > "$2"' _ \
  "$private_directory/token" .secrets/api-key
wait "$admin_pid"
chmod 0600 .secrets/api-key
rm -f "$private_directory/token" "$private_directory/metadata.json"
rmdir "$private_directory"
unset account_json account_id key_id admin_pid private_directory
```

The key token crosses only the owner-only FIFO and is stored in
`.secrets/api-key` with mode `0600`; stdout contains non-secret metadata. The
database URL and pepper are read-only because Compose bind-mounts them into the
UID 10001 runtime; the enclosing `.secrets` directory remains mode `0700`. See
[API-key operations](docs/api-keys.md) for rotation and revocation.

## MCP client configuration

Configure a Streamable HTTP MCP server at `http://127.0.0.1:3000/mcp` and source
the bearer token from the client's secret mechanism. A representative
configuration is:

```json
{
  "mcpServers": {
    "skillwire": {
      "type": "streamable-http",
      "url": "http://127.0.0.1:3000/mcp",
      "headers": {
        "Authorization": "Bearer ${SKILLWIRE_API_KEY}"
      }
    }
  }
}
```

Environment interpolation depends on the MCP client; do not commit a literal
token.

## Autonomous activation guidance

SkillWire publishes one versioned, client-agnostic activation policy through the
standard MCP server instruction field. The same text is available through legacy
`initialize` and current `server/discover`. It advises an MCP-capable agent to
search once for a specialized task only when no applicable local or already
loaded skill exists. Greetings, trivial or unrelated work, repeated attempts,
and tasks already covered locally are non-triggers.

The instructed workflow is preview → one exact load → only the next useful
declared resource. Agent-initiated searches use `automatic`; `user-requested` is
reserved for explicit user intent. An empty result or any SkillWire failure ends
the attempt without retry, reformulation, polling, context escalation, another
candidate, or revision substitution, so normal agent work can continue.

These instructions and tool annotations are advisory metadata. An MCP server
cannot force an arbitrary harness to read them or invoke its tools. Clients that
ignore the guidance retain the same six authenticated operations and degrade
without blocking ordinary work. SkillWire returns inert untrusted content, never
installs it, never writes the client tree, and cannot inspect local skill
inventory. Local precedence and per-task call bounds are therefore measured
harness behaviors; server enforcement remains authentication, tenant isolation,
eligibility, positive relevance, exact verified loading, provenance, advisory,
integrity, resource, rate-limit, and memory scope validation.

Codex users may optionally install the experimental
`skillwire-autonomous-activation@skillwire` plugin from a configured SkillWire
marketplace. The plugin contains only bounded activation guidance, one
credential-free SkillWire MCP dependency declaration, version metadata, and
uninstall metadata. It contains no remote skill content, executable code, API
key, bearer token, account data, or repository hash. Install, upgrade, verify,
and remove it only through the Codex plugin manager; SkillWire application code
never writes Codex-managed directories or a client repository.

In the pinned 15-case release-candidate pilot, the plugin cohort produced exact
`search_skills` -> `load_skill` traces in all seven completed automatic cases;
the eighth selected automatic case timed out and remains incomplete. The
observer also recorded unnecessary resource reads, so the evidence validator
keeps `claimEligibility.eligible=false`. The adapter is therefore experimental,
and SkillWire makes no definitive autonomous-activation claim. Explicit use of
the six MCP operations remains available without the plugin.

## Six MCP tools

Every input object is strict. Repository hashes are opaque client-generated
SHA-256 values encoded as exactly 64 lowercase hexadecimal characters.

```json
{
  "name": "search_skills",
  "arguments": { "task": "Review TypeScript type safety", "limit": 3 }
}
```

Returns previews only—never instruction or resource bodies.

Imported user-only skills require explicit intent:

```json
{
  "name": "search_skills",
  "arguments": {
    "task": "ask matt",
    "invocationContext": "user-requested",
    "limit": 3
  }
}
```

Missing `invocationContext` means `automatic`; an exact-name query does not
change that default. Imported previews include source owner/repository, pinned
commit, original path, SPDX license/attribution, classification, and invocation
mode, but no instruction, resource, or license body.

```json
{
  "name": "load_skill",
  "arguments": {
    "skillId": "typescript-code-review",
    "revision": "1.0.0",
    "repositoryHash": "<64-lowercase-hex>"
  }
}
```

Returns exact instructions, immutable provenance, trust fields, bundle hash, and
the complete resource manifest. Supplying a repository hash records usage;
omitting it writes no memory.

```json
{
  "name": "read_skill_resource",
  "arguments": {
    "skillId": "typescript-code-review",
    "revision": "1.0.0",
    "path": "references/review-checklist.md"
  }
}
```

Returns exactly one declared, hash-verified textual resource.

```json
{
  "name": "list_repo_memory",
  "arguments": { "repositoryHash": "<64-lowercase-hex>" }
}
```

Returns the authenticated account's bounded usage list directly from PostgreSQL.

```json
{
  "name": "record_skill_outcome",
  "arguments": {
    "repositoryHash": "<64-lowercase-hex>",
    "skillId": "typescript-code-review",
    "revision": "1.0.0",
    "outcome": "useful"
  }
}
```

Replaces the current outcome with `useful`, `neutral`, or `unsuccessful`. Record
`useful` only after the exact SkillWire load is attributable and completed-task
evidence or explicit user feedback exists.

```json
{
  "name": "forget_repo_memory",
  "arguments": { "repositoryHash": "<64-lowercase-hex>" }
}
```

Transactionally deletes the live repository-memory scope and returns the same
`{"forgotten":true}` shape whether data previously existed.

## Complete smoke journey

```bash
repository_hash="$(printf 'example/repository' | sha256sum | cut -d' ' -f1)"
pnpm smoke:mcp --endpoint http://127.0.0.1:3000/mcp \
  --api-key-file .secrets/api-key \
  --task 'Review TypeScript type safety and narrowing' \
  --repository-hash "$repository_hash" \
  --verify-memory
unset repository_hash
```

The script performs search → load → resource in three calls, then optionally
verifies the recorded repository memory. It prints identities and hashes, not
skill bodies or secrets, and writes nothing to the client tree.

## Security model

- API keys are high-entropy bearer tokens; PostgreSQL stores only keyed digests.
- API-key and repository-memory state are authoritative in PostgreSQL. A cheap
  global token bucket may reject excess syntactically valid bearer attempts
  before authentication; accepted attempts are checked directly in PostgreSQL.
- Published trust is immutable; current availability/revocation is derived from
  a verified, release-anchored advisory chain.
- Runtime schemas accept no caller URL, repository source, executable extension,
  or client path.
- Agent requests never discover, synchronize, clone, or directly read GitHub;
  exact imported revisions are served from verified PostgreSQL bundles.
- Resource paths, text encoding, media types, sizes, and hashes are validated
  before response.
- Structured security logs redact credentials, repository hashes, queries,
  content, and paths.
- `forget_repo_memory` covers authoritative live PostgreSQL rows. Backup, WAL,
  snapshot, and media retention remain operator responsibilities.

See [source administration](docs/source-administration.md),
[privacy boundaries](docs/privacy.md),
[catalog publication](docs/catalog-publication.md), and
[operations](docs/operations.md). The deterministic and manual activation
evaluation boundaries are documented in
[autonomous activation evaluation](docs/autonomous-activation-evaluation.md).

## Why there is no local installation

SkillWire is a retrieval service, not a package installer. MCP responses are
transient data for the caller. The service has no client-path argument,
filesystem transport, package-manager hook, or tool that can materialize catalog
content in a repository or user directory. This preserves client state and keeps
every loaded revision tied to its server-verified provenance and hashes.
