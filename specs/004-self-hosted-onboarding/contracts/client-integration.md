# Contract: Native Codex and Claude Code Integration

## Common guarantees

For each selected client, onboarding targets the normal user profile used by the ordinary executable. It does not set an alternate client home, create a wrapper client command, edit a repository, copy authentication, install catalog skills, or hand-edit a vendor configuration format while a supported lifecycle command exists.

The owned MCP registration launches only:

```text
<absolute-owned-skillwire-executable> bridge \
  --installation <installation-uuid> \
  --client codex|claude
```

The command and arguments contain no endpoint credential, environment-variable reference, raw key, arbitrary path, or shell fragment. The endpoint and credential reference come from owned installation state. Both clients use the logical MCP name `skillwire`.

The activation plugin is separate from the MCP registration. It contains only bounded Feature 003 selection guidance. Plugin removal cannot remove an independent MCP registration, and MCP removal cannot remove the plugin.

## Reconciliation algorithm

Before mutation, the client adapter MUST use vendor read/list commands and read-only file identities to construct the effective state across user, local/project, plugin, and managed scopes.

Classify every relevant MCP, marketplace, and plugin component:

| Class | Definition | Action |
|-------|------------|--------|
| `absent` | No effective same-name or equivalent component. | Eligible for a new independently journaled owned add. |
| `owned-equivalent` | Ownership record and current normalized identity both match. | Reuse; no write. |
| `external-equivalent` | Pre-existing, not owned, exact effective behavior/identity passes deterministic validation. | Record dependency only; never rewrite/remove. |
| `same-name-conflict` | `skillwire` name but command/args/source/version/endpoint differs. | Block only that client pending external resolution. |
| `equivalent-alternate-name` | Same or apparently equivalent bridge/service behavior under another name. | Ambiguous: block only that client pending external resolution; the required logical name is not satisfied. |
| `duplicate` | More than one effective SkillWire component. | Block; do not choose or delete automatically. |
| `shadowed` | Higher-precedence local/project entry makes a user entry ineffective. | Block successful integration; never write the repository layer. |
| `managed` | Policy-controlled or read-only state governs the relevant name/plugin. | Reuse only if equivalent and permitted; otherwise report policy conflict without mutation. |
| `drifted-owned` | Ownership exists but current identity differs. | Repair preview only; never remove/overwrite until ownership is unambiguous. |

For every non-equivalent or ambiguous result, the redacted result identifies the affected client, logical component, observed non-secret scope/identity, and that the user or policy administrator must resolve it outside SkillWire. Setup, repair, upgrade, client uninstall, default uninstall, and purge never adopt, rename, overwrite, disable, or remove the conflicting state. The client transaction remains non-success while a healthy service and any other verified client remain committed and usable.

All mutations use `shell:false`, an absolute certified client executable, a sanitized environment, bounded stdout/stderr, deadlines, and no secrets. Capture a protected snapshot and before identity first. After the vendor command, validate the exact expected SkillWire delta plus preserved unrelated semantic state. If unrelated state changed concurrently, stop; do not restore a stale full snapshot over it.

## Codex contract

### Certification

Initial release target: Codex CLI `0.147.0`. Later versions are supported only after the same executable command shape, profile preservation, plugin lifecycle, bridge, fail-open, and verification suite passes.

The normal MCP configuration is the user's Codex `config.toml`; Codex CLI, local desktop, and IDE share it for the same host. Current plugin support is certified for Codex CLI and local desktop. The IDE shares MCP configuration but current vendor documentation does not promise plugin support, so IDE evidence covers MCP access and not an autonomous-plugin claim.

### Read/preflight commands

```text
codex --version
codex mcp list --json
codex mcp get skillwire --json
codex plugin marketplace list --json
codex plugin list --marketplace skillwire --available --json
codex plugin list --marketplace skillwire --json
```

`mcp get` may fail when absent and is interpreted categorically. Onboarding MUST NOT call `mcp add` if any same-name entry exists: certified probing shows a repeated same-name add can replace the prior entry.

### Forward mutations

```text
codex mcp add skillwire -- \
  <absolute-owned-skillwire-executable> bridge \
  --installation <installation-uuid> --client codex

codex plugin marketplace add <verified-release-local-codex-marketplace>
codex plugin add skillwire-autonomous-activation@skillwire --json
```

The MCP entry MUST remain enabled and optional. Onboarding never sets `mcp_servers.skillwire.required=true`; absence of `required` uses Codex's fail-open default. It also sets no secret `env`, forwarded `env_vars`, URL, bearer-token environment variable, static header, or project `cwd`.

The release-local plugin:

- preserves the identity `skillwire-autonomous-activation` with a new immutable version;
- preserves Feature 003's exact three-file package contract, including the bounded activation `SKILL.md`, presentation/invocation metadata, and credential-free SkillWire dependency declaration;
- contains no `.mcp.json`, script, hook, executable, catalog entry, remote skill/resource, credential, repository data, or second dependency;
- relies on the independently registered logical `skillwire` MCP server;
- is installed only by the Codex plugin manager from a manifest-pinned local marketplace.

The platform release manifest must bind the exact path, byte size, and SHA-256 of Feature 003's `distribution/codex-marketplace/release-integrity.json`. Publication re-runs that integrity gate and every unchanged Feature 003 package/evaluation contract; Feature 004 adds no substituted package or weakened expectation.

The dependency declaration is preserved package metadata, not proof of the effective connection. After every plugin install, upgrade, repair, or removal, verification MUST inspect the actual manager/profile state and prove that the one effective `skillwire` entry remains the preflighted STDIO bridge command with unchanged ownership, endpoint selection, and credential reference. The Feature 003 harness's synthesized effective inventory is insufficient for this gate.

### Inverse mutations

```text
codex plugin remove skillwire-autonomous-activation@skillwire --json
codex plugin marketplace remove skillwire --json
codex mcp remove skillwire
```

Each inverse command is allowed only for the matching owned component. Marketplace removal occurs only if SkillWire owns it and no retained/external plugin uses it. Default uninstall leaves all external-equivalent state untouched.

## Claude Code contract

### Certification

Initial release target: Claude Code `2.1.229`. Claude Code `2.0.13` is not supported by Feature 004 setup because executable probing shows it lacks the non-interactive plugin install/enable/disable/update/uninstall lifecycle required for safe automation. This remains within the specification's “2.0.13 or later explicitly certified” range. Later versions require recertification.

Normal user-scoped MCP state is stored by Claude in `~/.claude.json`; user plugin preferences and plugin data remain under the normal Claude profile. Onboarding never sets `CLAUDE_CONFIG_DIR` and never writes `.mcp.json` or `.claude` in a repository.

### Read/preflight commands

```text
claude --version
claude mcp list
claude mcp get skillwire
claude plugin marketplace list --json
claude plugin list --available --json
claude plugin list --json
claude plugin details skillwire-autonomous-activation@skillwire
```

Preflight also detects local/project MCP entries that shadow user scope and managed settings/plugins that cannot be modified. User scope is always explicit because Claude's MCP add default is local scope.

### Forward mutations

```text
claude mcp add --transport stdio --scope user skillwire -- \
  <absolute-owned-skillwire-executable> bridge \
  --installation <installation-uuid> --client claude

claude plugin marketplace add \
  --scope user <verified-release-local-claude-marketplace>
claude plugin install \
  skillwire-autonomous-activation@skillwire --scope user
claude plugin enable \
  skillwire-autonomous-activation@skillwire --scope user
```

The Claude plugin contains one instruction-only activation skill adapted from Feature 003. It contains no `.mcp.json`, MCP declaration, hook, command, agent executable, package dependency, credential, endpoint, catalog content, or remote skill content. Keeping MCP separate prevents endpoint deduplication/precedence and uninstall ownership ambiguity.

### Upgrade and inverse mutations

```text
claude plugin update \
  skillwire-autonomous-activation@skillwire --scope user
claude plugin disable \
  skillwire-autonomous-activation@skillwire --scope user
claude plugin uninstall \
  skillwire-autonomous-activation@skillwire --scope user
claude plugin marketplace remove skillwire --scope user
claude mcp remove skillwire --scope user
```

No unscoped remove/uninstall is permitted. Marketplace removal occurs last among Claude plugin operations and only for a matching owned user declaration with no remaining dependency.

## Independent client transaction

For one absent client integration the journaled sequence is:

```text
preflight/snapshot
  -> create distinct API key through private channel
  -> persist credential
  -> add user MCP entry
  -> install/enable activation plugin
  -> fresh deterministic verification
  -> commit ownership and client state
```

Compensation runs in reverse and only for steps created by this transaction. A failure after key creation clears the created credential and revokes the created key. A failed Codex transaction never removes verified Claude state, and vice versa. If compensation cannot prove a safe inverse due to concurrent drift, the result is recovery-required rather than a destructive restore.

## Deterministic verification

For each client, setup MUST:

1. Start a fresh ordinary vendor CLI process with the normal user profile and verify the effective `skillwire` user registration plus activation plugin identity/version.
2. Read back the exact registered command using the vendor management interface; reject a different command, args, scope, disabled state, duplicate, shadow, or unexpected environment/header configuration.
3. Launch that exact registered STDIO bridge command with the verification MCP client and require authenticated initialization plus exactly the six names/schemas/descriptions/annotations/instructions bound by the release.
4. Call `search_skills` with a frozen first-party smoke task, select the returned immutable preview, call `load_skill` with that exact `skillId` and revision, and make only the fixture-required declared resource read.
5. Verify revision hash, published provenance, resource manifest/integrity when read, and current advisory status.
6. Re-run the fresh vendor profile inventory and prove exactly one effective registration/plugin plus preserved unrelated state.

This is deterministic protocol/profile evidence; it does not depend on spontaneous model selection. A separate fresh ordinary model session runs the specialized synthetic automatic-activation diagnostic and records attributable calls. `not-invoked` is a diagnostic result, not an install failure. Explicit user-requested and automatic evidence remain separate.

## Fail-open requirements

With the service stopped, endpoint unreachable, key missing/locked/rejected, upstream incompatible, tool contract wrong, or bridge timed out:

- a fresh ordinary client starts and can complete unrelated local work;
- Codex has no `required=true` setting;
- Claude reports a failed optional MCP connection rather than terminating;
- the bridge performs one attempt, no reconnect/retry, and no repeated prompt;
- the activation adapter stops after Feature 003's bounded attempt;
- unrelated MCP servers, plugins, skills, hooks, authentication, settings, histories, and repositories remain usable and unchanged.

## Preservation evidence

Disposable profiles seed arbitrary unrelated settings, comments where supported, login sentinels, plugins, skills, hooks, histories, and MCP entries. Install, repeat setup, repair, upgrade, client uninstall, default uninstall, and failed/interrupted variants compare:

- exact bytes for untouched files and Codex regions the certified manager preserves;
- semantic JSON identity for Claude files the manager reformats;
- exact unrelated inventory and auth sentinels;
- zero repository/profile-layer writes outside the supported user manager delta;
- zero duplicate SkillWire names/endpoints/plugins/marketplaces;
- the actual Codex `skillwire` manager/profile entry remains the exact preflighted STDIO bridge registration across plugin lifecycle operations;
- zero canary secret bytes in every captured artifact.
