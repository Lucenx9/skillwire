# SkillWire

SkillWire is a remote MCP skill catalog. It discovers ten curated skills, loads
exact immutable instructions, reads declared textual resources progressively,
and remembers optional repository-scoped usage in PostgreSQL. Skill content is
returned as inert MCP response data; it is never installed, executed, or written
into a client repository.

## Architecture

```text
MCP client -> Hono Streamable HTTP -> application use cases -> immutable catalog
                                      |                     -> verified catalog cache
                                      +-> authoritative PostgreSQL repository memory
```

The service is one stateless TypeScript modular monolith. Catalog releases,
provenance, resource hashes, and the append-only advisory chain are
version-controlled. PostgreSQL is the sole authority for accounts, API-key
hashes, repository usage, outcomes, and privacy-safe erasure audit events. There
is no repository-memory cache, Redis, queue, external catalog ingestion, or
client-side skill installation.

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
postgres_password="$(tr -d '\n' < .secrets/postgres-password)"
printf 'postgresql://skillwire:%s@postgres:5432/skillwire\n' "$postgres_password" \
  > .secrets/database-url
chmod 400 .secrets/postgres-password
chmod 444 .secrets/database-url .secrets/api-key-pepper
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
docker compose exec -T skillwire \
  node dist/src/authentication/admin-cli.js account:create
docker compose exec -T skillwire \
  node dist/src/authentication/admin-cli.js key:create --account-id '<account-uuid>'
```

The key token is emitted once. Store it in a secret manager or
`.secrets/api-key` with mode `0600`. The database URL and pepper are read-only
because Compose bind-mounts them into the UID 10001 runtime; the enclosing
`.secrets` directory remains mode `0700`. See
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

Replaces the current outcome with `useful`, `neutral`, or `unsuccessful`.

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
- Authentication and repository-memory state are checked directly in PostgreSQL
  on every request.
- Published trust is immutable; current availability/revocation is derived from
  a verified, release-anchored advisory chain.
- Runtime schemas accept no caller URL, repository source, executable extension,
  or client path.
- Resource paths, text encoding, media types, sizes, and hashes are validated
  before response.
- Structured security logs redact credentials, repository hashes, queries,
  content, and paths.
- `forget_repo_memory` covers authoritative live PostgreSQL rows. Backup, WAL,
  snapshot, and media retention remain operator responsibilities.

See [privacy boundaries](docs/privacy.md),
[catalog publication](docs/catalog-publication.md), and
[operations](docs/operations.md).

## Why there is no local installation

SkillWire is a retrieval service, not a package installer. MCP responses are
transient data for the caller. The service has no client-path argument,
filesystem transport, package-manager hook, or tool that can materialize catalog
content in a repository or user directory. This preserves client state and keeps
every loaded revision tied to its server-verified provenance and hashes.
