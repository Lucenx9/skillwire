# Dockerfile hardening checklist

- Base image version or digest is intentional and reviewable.
- Final stage contains only runtime requirements.
- Dependency installation is reproducible.
- Secrets never enter layers, arguments, or image defaults.
- Build context excludes unnecessary and sensitive files.
- Runtime uses a dedicated non-root user.
- Writable paths and file ownership are minimal.
- Entrypoint and signal handling support safe shutdown.
