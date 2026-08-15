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
is `distribution/self-hosted/trusted-root.v1.json`. Its media type must be
exactly `application/vnd.dev.sigstore.trustedroot+json;version=0.1`, the only
value accepted by the Cosign 3.1.3 / sigstore-go 1.2.2 loader. Do not substitute
the unsupported `application/vnd.dev.sigstore.trustedroot.v0.2+json` value.

## 2. Verify the signed external manifest offline

For release `VERSION` and architecture `ARCH`, place these files together:

```text
skillwire-VERSION-linux-ARCH.tar.zst
skillwire-VERSION-linux-ARCH.release.json
skillwire-VERSION-linux-ARCH.release.sigstore.json
skillwire-trust-policy-v1.json
```

These are the four normal sibling assets: archive, canonical manifest, one
Sigstore bundle, and versioned trust policy. Do not accept a checksum pasted in
release prose or a manifest embedded only inside the archive. A policy-rotation
release is the sole exception: when the currently trusted policy requires an
overlap quorum of two, a second sibling bundle named
`skillwire-VERSION-linux-ARCH.release.SIGNER.sigstore.json` is mandatory. The
manifest names both signer IDs and both exact bundle paths; an extra bundle is
never accepted by convention alone.

The manifest names bundle files and signer IDs but never contains bundle bytes,
media types, or digests. Each bundle signs the exact canonical manifest bytes;
including its own digest in that manifest would be circular. Cosign, the exact
certificate claims, and the manifest message digest bind the external bundle.

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

The version and source commit are fields of the canonical manifest. The only
accepted tag is the annotated `self-hosted-vVERSION` tag; recursively peel it,
require the result to equal the manifest source commit, and require that commit
to be reachable from protected `main` before using it in the command. Never add
an insecure SCT/transparency bypass or a regular-expression identity.
Verification must finish without a network lookup.

## 3. Verify archive identity before extraction

Run the release verifier from a trusted source checkout, still with outbound
networking blocked:

```sh
pnpm verify:self-hosted \
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

## 4. Extract and start without widening trust

The verifier rejects absolute paths, `..`, duplicate or unlisted payload bytes,
links, devices, FIFOs, sockets, unsafe modes, mutable image references, unsafe
Compose privileges, catalog/advisory drift, and client-package drift before the
launcher is trusted. Extract only the already verified archive into a new
owner-only directory; never extract over an existing installation. Pin the
opened archive inode, recheck the signed manifest's size and SHA-256 through
that descriptor, and extract through the same descriptor so a pathname
substitution cannot change the bytes between verification and extraction:

```sh
umask 077
install -d -m 0700 /absolute/private/skillwire-VERSION-linux-ARCH
exec 3< skillwire-VERSION-linux-ARCH.tar.zst
test "$(stat -Lc %s /proc/self/fd/3)" = \
  "$(jq -r '.archive.size' skillwire-VERSION-linux-ARCH.release.json)"
test "$(sha256sum /proc/self/fd/3 | awk '{print $1}')" = \
  "$(jq -r '.archive.sha256' skillwire-VERSION-linux-ARCH.release.json)"
tar --use-compress-program=/usr/bin/zstd \
  --no-same-owner --no-same-permissions \
  -xf /proc/self/fd/3 \
  -C /absolute/private/skillwire-VERSION-linux-ARCH
exec 3<&-
```

Run the bundled launcher from that exact directory and confirm the SHA-256
preview. Do not pipe network output to a shell, do not use `curl | sh`, and do
not substitute an unpacked file from another candidate.

## 5. Trust refresh, rotation, and revocation

An active policy may be replaced only by a higher policy sequence whose
transition is signed by the complete current quorum and the required distinct
new quorum. The accepted installation state records the highest policy and
release sequences. A lower sequence, an equal sequence with different bytes, a
denied signer or manifest, an expired validity window, a missing overlap bundle,
or a policy that lowers the minimum accepted release is a hard stop.

Refresh the trusted root only from Sigstore's signed TUF metadata, compare its
media type and SHA-256 to the candidate policy, then repeat offline
verification. Revocation is deny-first: once a signer or manifest digest is
denied, neither a cached bundle nor an older policy can restore it. Keep the
preceding accepted policy and its audit identity for recovery; never edit it in
place.
