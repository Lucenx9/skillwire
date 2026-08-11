# GitHub Actions CI checklist

- Required behaviors map to named jobs and commands.
- Actions, runtimes, and package-manager versions are pinned.
- Lockfile installation is frozen and reproducible.
- Workflow and job permissions follow least privilege.
- Fork and pull-request events cannot access privileged secrets.
- Cache misses change speed only, not correctness.
- Publication is separate from required validation.
- Logs and artifacts exclude credentials and sensitive outputs.
