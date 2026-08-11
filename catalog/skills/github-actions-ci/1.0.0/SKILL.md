---
name: github-actions-ci
description:
  Design maintainable GitHub Actions validation and delivery workflows.
---

# GitHub Actions CI

Design workflows so required evidence is reproducible, least-privileged, and
easy to diagnose.

## Design sequence

1. Map each required quality gate to one job with a clear owner and failure
   signal.
2. Pin actions and runtime versions, and use the repository lockfile for
   dependency installation.
3. Grant the workflow and each job only the permissions they require.
4. Keep untrusted pull-request data away from secrets and privileged execution
   contexts.
5. Make caching an optimization that cannot replace validation or alter
   correctness.
6. Preserve useful logs and artifacts without leaking tokens, source secrets, or
   protected outputs.

Prefer explicit jobs over dense conditional scripts. Separate publication from
required validation, and ensure retries cannot overwrite immutable releases or
conceal a failed gate.

Use the declared CI checklist for a complete review.
