# Dependency upgrade checklist

- Current and target versions and consumers are known.
- Authoritative release and migration notes were reviewed.
- Runtime, peer, API, and default changes are identified.
- Lockfile and build-tool effects are understood.
- Migration steps are small and independently verifiable.
- Tests cover changed behavior and compatibility boundaries.
- Data and configuration changes have a rollback story.
- Rollback triggers and post-upgrade observations are explicit.
