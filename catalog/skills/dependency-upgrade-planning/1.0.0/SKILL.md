---
name: dependency-upgrade-planning
description:
  Plan dependency upgrades with compatibility research, migration steps, tests,
  and rollback.
---

# Dependency Upgrade Planning

Treat an upgrade as a behavior and operational change, not a version-number
edit.

## Planning sequence

1. Record the current and target versions, direct and transitive consumers, and
   reason for upgrading.
2. Read authoritative release notes, migration guides, compatibility tables, and
   security notices.
3. Identify changed APIs, runtime requirements, defaults, peer dependencies, and
   removed behavior.
4. Break the migration into reversible steps with focused validation after each
   boundary.
5. Define unit, contract, integration, build, and operational checks
   proportional to the change.
6. State rollback triggers and verify that data or configuration changes remain
   reversible.

Separate confirmed upstream changes from local assumptions. Avoid opportunistic
dependency churn, and do not combine unrelated upgrades when doing so would
obscure diagnosis or rollback.

Use the declared checklist to review the plan.
