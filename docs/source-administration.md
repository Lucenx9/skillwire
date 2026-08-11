# GitHub source administration

GitHub ingestion is an out-of-band administrator function. Agent-facing MCP
tools accept no repository URL, owner, repository, branch, tag, or commit input.
Only public `github.com` repositories are supported, and all reads are
internally constructed requests to `https://api.github.com` with redirects
rejected.

Set `DATABASE_URL`, `SKILLWIRE_ADMIN_ACTOR_ID`, and a least-privilege
`SKILLWIRE_GITHUB_TOKEN`, then register a repository once:

```bash
pnpm source:admin source:add --owner mattpocock --repository skills
pnpm source:admin source:list
pnpm source:admin source:sync --source-id '<source-uuid>'
```

Discovery and policy actions are also repository/candidate scoped; there is no
individual-skill add command:

```bash
pnpm source:admin discover
pnpm source:admin source:list --state quarantined --limit 100
pnpm source:admin verify --candidate-id '<candidate-uuid>'
pnpm source:admin quarantine --candidate-id '<candidate-uuid>' \
  --reason-code ADMIN_QUARANTINE
pnpm source:admin curate --candidate-id '<candidate-uuid>'
```

`verified` means automated schema, path, text, size, license, provenance,
dependency, pinning, and integrity checks passed. It is not a semantic safety
endorsement. `curated` requires an explicit administrator transition.

## Scheduled operation

`SKILLWIRE_GITHUB_INGESTION_ENABLED=false` is the default. When enabled, a token
is required through `SKILLWIRE_GITHUB_TOKEN` or `SKILLWIRE_GITHUB_TOKEN_FILE`.
The scheduler uses PostgreSQL leases and the bounded cadence/request/result/page
controls documented in `.env.example`. It never runs in an MCP request and is
not part of readiness, so GitHub outages do not block cached exact loads.

Every sync resolves the default branch once and then reads only exact commit,
tree, and blob objects. New content produces a new immutable revision; unchanged
content is reused. Confirmed upstream removal appends an unavailable advisory
and retains prior verified content. Revoked revisions remain non-disclosing.

The required suite replays recorded fixtures with zero network. The optional
manual check is:

```bash
GITHUB_TOKEN='<least-privilege-token>' pnpm smoke:github-live
```

It reads only `mattpocock/skills` at `84fdeffd12f2ee307994d1eb6feb48173b6e0502`
and never rewrites fixtures.
