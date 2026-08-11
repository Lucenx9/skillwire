---
name: dockerfile-hardening
description:
  Review container builds for minimal images, least privilege, reproducibility,
  and secret safety.
---

# Dockerfile Hardening

Review both the build graph and the runtime image as security boundaries.

## Review sequence

1. Identify required build tools, runtime files, network access, secrets, ports,
   and writable paths.
2. Pin the base image by an intentional version or digest and minimize the final
   stage.
3. Keep credentials out of layers, build arguments, environment defaults, and
   copied context.
4. Run the final process as a dedicated non-root user with narrowly owned files.
5. Remove package caches and build-only dependencies from the runtime image.
6. Check entrypoint, signal handling, health behavior, and deterministic
   dependency installation.

Do not treat image size alone as hardening. Explain each finding through a
concrete exposure such as credential persistence, excessive privilege, mutable
dependencies, or an unnecessary attack surface.

Use the declared checklist for a systematic pass.
