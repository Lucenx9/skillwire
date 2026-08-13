# SkillWire self-hosted bootstrap

Use these instructions only with the four sibling assets for one published
platform. Do not extract or execute the archive until the external manifest has
been verified. The installer supports Linux `amd64` and `arm64` only.

## 1. Establish the verifier independently

Obtain Cosign **3.1.3** from the official `sigstore/cosign` v3.1.3 release.
Verify it using Sigstore's official TUF `artifact.pub` procedure and release
bundle, then compare the binary to the platform digest pinned by
`skillwire-trust-policy-v1.json`:

```text
amd64  4629c757b7618056f8ddd7e2625ae9fdd94c0372a65049520bc7d9df9efc7f71
arm64  c5d324e091826b0d7a78eb16fef316450b4eb9aaec045611c08ba06f5e73220a
```

Do not use `latest`, `curl | sh`, an unverified package manager, or a Cosign
binary shipped only inside the candidate archive. Obtain the current Sigstore
production `trusted_root.json` through its signed TUF repository and verify its
SHA-256 against the trust policy. The first source-pinned root in this release
is `distribution/self-hosted/trusted-root.v1.json`.

## 2. Verify the signed external manifest offline

For release `VERSION` and architecture `ARCH`, place these files together:

```text
skillwire-VERSION-linux-ARCH.tar.zst
skillwire-VERSION-linux-ARCH.release.json
skillwire-VERSION-linux-ARCH.release.sigstore.json
skillwire-trust-policy-v1.json
```

Disconnect outbound networking (or run inside an already network-isolated
namespace) and invoke the independently verified Cosign directly:

```sh
cosign verify-blob \
  --offline \
  --new-bundle-format \
  --timeout 30s \
  --bundle skillwire-VERSION-linux-ARCH.release.sigstore.json \
  --trusted-root trusted-root.v1.json \
  --certificate-identity \
    https://github.com/Lucenx9/skillwire/.github/workflows/self-hosted-release.yml@refs/tags/self-hosted-vVERSION \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  --certificate-github-workflow-repository Lucenx9/skillwire \
  --certificate-github-workflow-ref refs/tags/self-hosted-vVERSION \
  --certificate-github-workflow-sha EXACT_40_HEX_SOURCE_COMMIT \
  skillwire-VERSION-linux-ARCH.release.json
```

The version and source commit are fields of the canonical manifest; compare them
to the protected tag independently before using them in the command. Never add
an insecure SCT/transparency bypass or a regular-expression identity.
Verification must finish without a network lookup.

## 3. Verify archive identity before extraction

Run the release verifier from a trusted source checkout, still with outbound
networking blocked:

```sh
pnpm exec tsx scripts/verify-self-hosted-release.ts \
  --manifest skillwire-VERSION-linux-ARCH.release.json \
  --bundle skillwire-VERSION-linux-ARCH.release.sigstore.json \
  --archive skillwire-VERSION-linux-ARCH.tar.zst \
  --policy skillwire-trust-policy-v1.json \
  --trusted-root trusted-root.v1.json \
  --cosign /absolute/path/to/verified/cosign \
  --architecture ARCH
```

This independently repeats canonical-manifest, policy, signer, Bundle v0.3,
archive name/size/digest, safe archive inventory, extracted payload,
Compose/image, migrations, catalog/advisory, client adapters, and Feature 003
integrity checks. It extracts only into a disposable private directory and
removes that directory afterward.

Only after this command reports `"verified":true` may the release directory's
`bin/skillwire` be invoked. Generate and confirm the exact setup preview before
the first installation mutation. If the policy is stale, revoked, unknown, or
has no surviving trusted signer, stop and obtain a separately authenticated
policy/root update; the bootstrap never silently refreshes trust material.
