import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdtemp,
  open,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, relative, resolve, sep } from "node:path";

import {
  ReleaseManifestSchema,
  TrustPolicySchema,
  type ReleaseManifest,
} from "../../domain/release-manifest.js";
import { deriveReleaseComponents } from "../../domain/release-components.js";
import { runCommand } from "../process/command-runner.js";
import { openOwnedFileNoFollow } from "./safe-paths.js";

export const PINNED_INITIAL_TRUST_POLICY_SHA256 =
  "0bdb9eb5a6a2d93068225bebafe445cc0835623991a37a817d7c1093d11c70bb";

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function readBoundedRegular(
  path: string,
  maximumBytes: number,
): Promise<Buffer> {
  const handle = await open(
    resolve(path),
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    const before = await handle.stat({ bigint: true });
    if (
      !before.isFile() ||
      before.nlink !== 1n ||
      before.size > BigInt(maximumBytes)
    ) {
      throw new Error("Release verification input is unsafe or too large");
    }
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs
    ) {
      throw new Error("Release verification input changed while reading");
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

async function readBoundedOwnedRegular(
  path: string,
  root: string,
  maximumBytes: number,
): Promise<Buffer> {
  const handle = await openOwnedFileNoFollow(path, root);
  try {
    const before = await handle.stat({ bigint: true });
    if (before.size > BigInt(maximumBytes)) {
      throw new Error("Protected release verification input is too large");
    }
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs
    ) {
      throw new Error(
        "Protected release verification input changed while reading",
      );
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

async function hashBoundedRegular(
  path: string,
  maximumBytes: number,
): Promise<{ readonly size: number; readonly sha256: string }> {
  const handle = await open(
    resolve(path),
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    const before = await handle.stat({ bigint: true });
    if (
      !before.isFile() ||
      before.nlink !== 1n ||
      before.size > BigInt(maximumBytes)
    ) {
      throw new Error("Release verification input is unsafe or too large");
    }
    const digest = createHash("sha256");
    for await (const chunk of handle.createReadStream({
      autoClose: false,
    }) as AsyncIterable<Buffer>) {
      digest.update(chunk);
    }
    const after = await handle.stat({ bigint: true });
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs
    ) {
      throw new Error("Release verification input changed while hashing");
    }
    return { size: Number(before.size), sha256: digest.digest("hex") };
  } finally {
    await handle.close();
  }
}

function canonical(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string")
    return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw new Error("Manifest contains an invalid number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
      .join(",")}}`;
  }
  throw new Error("Manifest contains an unsupported JSON value");
}

function exactReleaseRef(refPattern: string, releaseVersion: string): string {
  if ((refPattern.match(/\*/g) ?? []).length !== 1) {
    throw new Error(
      "Signer tag pattern must contain exactly one release placeholder",
    );
  }
  return refPattern.replace("*", releaseVersion);
}

function signerIdentity(signer: {
  readonly issuer: string;
  readonly repository: string;
  readonly workflow: string;
  readonly refPattern: string;
}): string {
  return `${signer.issuer}|${signer.repository}|${signer.workflow}|${signer.refPattern}`;
}

function nonemptyBase64(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value.length < 4 ||
    value.length > 4 * 1024 * 1024 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      value,
    )
  ) {
    return false;
  }
  return Buffer.from(value, "base64").byteLength > 0;
}

function validateBundleEvidence(bundle: Record<string, unknown>): void {
  if (bundle["mediaType"] !== "application/vnd.dev.sigstore.bundle.v0.3+json") {
    throw new Error("Sigstore Bundle v0.3 is required");
  }
  const verification = bundle["verificationMaterial"] as
    | {
        certificate?: { rawBytes?: unknown };
        x509CertificateChain?: { certificates?: { rawBytes?: unknown }[] };
        tlogEntries?: {
          logIndex?: unknown;
          integratedTime?: unknown;
          logId?: { keyId?: unknown };
          inclusionPromise?: { signedEntryTimestamp?: unknown };
          inclusionProof?: {
            rootHash?: unknown;
            checkpoint?: { envelope?: unknown };
          };
        }[];
      }
    | undefined;
  const certificates =
    verification?.x509CertificateChain?.certificates ??
    (verification?.certificate === undefined ? [] : [verification.certificate]);
  if (!certificates.some(({ rawBytes }) => nonemptyBase64(rawBytes))) {
    throw new Error("Bundle signing certificate is missing");
  }
  if (
    verification?.tlogEntries === undefined ||
    verification.tlogEntries.length < 1
  ) {
    throw new Error("Transparency proof is missing");
  }
  for (const entry of verification.tlogEntries) {
    if (
      typeof entry.logIndex !== "string" ||
      !/^[0-9]+$/.test(entry.logIndex) ||
      typeof entry.integratedTime !== "string" ||
      !/^[0-9]+$/.test(entry.integratedTime) ||
      !nonemptyBase64(entry.logId?.keyId)
    ) {
      throw new Error(
        "Transparency entry identity or integrated timestamp is invalid",
      );
    }
    const promise = nonemptyBase64(
      entry.inclusionPromise?.signedEntryTimestamp,
    );
    const inclusionProof = entry.inclusionProof;
    const proof =
      inclusionProof !== undefined &&
      nonemptyBase64(inclusionProof.rootHash) &&
      typeof inclusionProof.checkpoint?.envelope === "string" &&
      inclusionProof.checkpoint.envelope.length > 0;
    if (!promise && !proof) {
      throw new Error("Transparency entry has no offline inclusion evidence");
    }
  }
  const signature = bundle["messageSignature"] as
    { signature?: unknown } | undefined;
  if (!nonemptyBase64(signature?.signature)) {
    throw new Error("Bundle message signature is missing");
  }
}

async function actualPayload(
  root: string,
  expected: ReleaseManifest["payload"],
): Promise<ReleaseManifest["payload"]> {
  const result: ReleaseManifest["payload"][number][] = [];
  const expectedByPath = new Map(expected.map((entry) => [entry.path, entry]));
  async function visit(directory: string): Promise<void> {
    for (const name of (await readdir(directory)).toSorted()) {
      const path = join(directory, name);
      const stats = await lstat(path);
      if (stats.isDirectory() && !stats.isSymbolicLink()) {
        await visit(path);
        continue;
      }
      if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1)
        throw new Error("Release payload contains an unsafe file");
      if (result.length >= 4096)
        throw new Error("Release payload has too many files");
      const relativePath = relative(root, path).split(sep).join("/");
      const expectedEntry = expectedByPath.get(relativePath);
      if (expectedEntry?.size !== stats.size) {
        throw new Error(
          "Release payload contains an undeclared or wrong-sized file",
        );
      }
      const identity = await hashBoundedRegular(path, 1024 ** 3);
      result.push({
        path: relativePath,
        size: identity.size,
        sha256: identity.sha256,
        mode: (stats.mode & 0o777).toString(8).padStart(4, "0") as
          "0600" | "0644" | "0700" | "0755",
      });
    }
  }
  await visit(root);
  return result;
}

export interface VerifyReleaseOptions {
  readonly manifestPath: string;
  readonly bundlePath: string;
  readonly bundlePaths?: readonly string[] | undefined;
  readonly archive: string;
  readonly payload: string;
  readonly policyPath: string;
  readonly trustedRootPath: string;
  readonly cosign: string;
  readonly architecture: "amd64" | "arm64";
  readonly currentReleaseSequence: number;
  readonly currentTrustSequence: number;
  readonly currentPolicyPath?: string | undefined;
  readonly currentPolicyRoot?: string | undefined;
  readonly pinnedInitialPolicySha256?: string | undefined;
  readonly now?: Date | undefined;
  readonly signal?: AbortSignal | undefined;
}

export type VerifyReleaseEnvelopeOptions = Omit<
  VerifyReleaseOptions,
  "payload"
>;

export interface VerifiedRelease {
  readonly releaseVersion: string;
  readonly releaseSequence: number;
  readonly trustPolicySequence: number;
  readonly manifestSha256: string;
  readonly archiveSha256: string;
  readonly cosignArguments: readonly string[];
  readonly cosignInvocations: readonly (readonly string[])[];
}

export interface VerifiedReleaseEnvelope extends VerifiedRelease {
  readonly manifest: ReleaseManifest;
}

export async function verifySignedReleaseEnvelope(
  options: VerifyReleaseEnvelopeOptions,
): Promise<VerifiedReleaseEnvelope> {
  const manifestBytes = await readBoundedRegular(
    options.manifestPath,
    4 * 1024 * 1024,
  );
  if (
    manifestBytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])) ||
    manifestBytes.at(-1) === 0x0a
  ) {
    throw new Error("Release manifest is not canonical external JSON");
  }
  const manifestValue = JSON.parse(manifestBytes.toString("utf8")) as unknown;
  if (canonical(manifestValue) !== manifestBytes.toString("utf8"))
    throw new Error("Release manifest is not canonical JSON");
  const manifest = ReleaseManifestSchema.parse(manifestValue);
  const policyBytes = await readBoundedRegular(options.policyPath, 1024 * 1024);
  if (
    policyBytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])) ||
    policyBytes.at(-1) === 0x0a
  ) {
    throw new Error("Trust policy is not canonical external JSON");
  }
  const policyValue = JSON.parse(policyBytes.toString("utf8")) as unknown;
  if (canonical(policyValue) !== policyBytes.toString("utf8")) {
    throw new Error("Trust policy is not canonical JSON");
  }
  const policy = TrustPolicySchema.parse(policyValue);
  const policySha256 = sha256(policyBytes);
  if (
    basename(options.policyPath) !== manifest.trustPolicy.path ||
    policyBytes.byteLength !== manifest.trustPolicy.size ||
    policySha256 !== manifest.trustPolicy.sha256
  ) {
    throw new Error("Signed manifest trust policy identity mismatch");
  }
  if (manifest.architecture !== options.architecture)
    throw new Error("Release architecture does not match host");
  if (manifest.releaseSequence < options.currentReleaseSequence)
    throw new Error("Release sequence downgrade is forbidden");
  if (manifest.releaseSequence < policy.minimumReleaseSequence)
    throw new Error("Release is below the trust policy minimum sequence");
  if (
    policy.sequence < options.currentTrustSequence ||
    manifest.trustPolicySequence !== policy.sequence
  ) {
    throw new Error("Trust policy sequence downgrade or mismatch");
  }
  let authorizingPolicy = policy;
  let verificationSigners = policy.signers.filter(
    (signer) =>
      !policy.deniedSigners.includes(signer.signerId) &&
      !policy.deniedSigners.includes(signerIdentity(signer)),
  );
  let requiredSignerCount = policy.overlap.requiredSignerCount;
  if (options.currentTrustSequence === 0) {
    const pinned =
      options.pinnedInitialPolicySha256 ?? PINNED_INITIAL_TRUST_POLICY_SHA256;
    if (policy.sequence !== 1 || policySha256 !== pinned) {
      throw new Error("Initial trust policy does not match the pinned policy");
    }
  } else {
    if (
      options.currentPolicyPath === undefined ||
      options.currentPolicyRoot === undefined
    )
      throw new Error("Active installed trust policy is required");
    const currentPolicyBytes = await readBoundedOwnedRegular(
      options.currentPolicyPath,
      options.currentPolicyRoot,
      1024 * 1024,
    );
    const currentValue = JSON.parse(
      currentPolicyBytes.toString("utf8"),
    ) as unknown;
    if (canonical(currentValue) !== currentPolicyBytes.toString("utf8"))
      throw new Error("Active installed trust policy is not canonical JSON");
    const currentPolicy = TrustPolicySchema.parse(currentValue);
    if (currentPolicy.sequence !== options.currentTrustSequence)
      throw new Error("Active trust policy sequence is inconsistent");
    authorizingPolicy = currentPolicy;
    if (policy.sequence === currentPolicy.sequence) {
      if (policySha256 !== sha256(currentPolicyBytes))
        throw new Error(
          "Equal-sequence trust policy equivocation is forbidden",
        );
      verificationSigners = currentPolicy.signers.filter(
        (signer) =>
          !currentPolicy.deniedSigners.includes(signer.signerId) &&
          !currentPolicy.deniedSigners.includes(signerIdentity(signer)),
      );
      requiredSignerCount = currentPolicy.overlap.requiredSignerCount;
    } else {
      if (
        policy.sequence !== currentPolicy.sequence + 1 ||
        policy.overlap.previousSequence !== currentPolicy.sequence
      ) {
        throw new Error("Unknown skipped trust policy sequence");
      }
      if (
        canonical(policy.trustedRoot) !==
          canonical(currentPolicy.trustedRoot) ||
        canonical(policy.cosign) !== canonical(currentPolicy.cosign)
      ) {
        throw new Error(
          "Trust root or verifier rotation requires out-of-band bootstrap",
        );
      }
      const activeSigners = currentPolicy.signers.filter(
        (signer) =>
          !currentPolicy.deniedSigners.includes(signer.signerId) &&
          !currentPolicy.deniedSigners.includes(signerIdentity(signer)),
      );
      if (activeSigners.length < currentPolicy.overlap.requiredSignerCount)
        throw new Error(
          "No complete active signer quorum survives; out-of-band trust bootstrap is required",
        );
      const candidateSigners = policy.signers.filter(
        (signer) =>
          !policy.deniedSigners.includes(signer.signerId) &&
          !policy.deniedSigners.includes(signerIdentity(signer)),
      );
      for (const currentSigner of activeSigners) {
        const candidateSigner = candidateSigners.find(
          ({ signerId }) => signerId === currentSigner.signerId,
        );
        if (
          candidateSigner !== undefined &&
          signerIdentity(candidateSigner) !== signerIdentity(currentSigner)
        ) {
          throw new Error(
            "A signer identifier cannot change cryptographic identity during rotation",
          );
        }
      }
      verificationSigners = manifest.signatureBundles.map(({ signerId }) => {
        const signer =
          activeSigners.find((candidate) => candidate.signerId === signerId) ??
          candidateSigners.find((candidate) => candidate.signerId === signerId);
        if (signer === undefined)
          throw new Error("Trust rotation bundle has an unknown signer");
        return signer;
      });
      const activeQuorum = new Set(
        verificationSigners
          .filter((verifiedSigner) =>
            activeSigners.some(
              (activeSigner) =>
                signerIdentity(activeSigner) === signerIdentity(verifiedSigner),
            ),
          )
          .map(signerIdentity),
      );
      if (activeQuorum.size < currentPolicy.overlap.requiredSignerCount) {
        throw new Error(
          "Trust policy rotation requires the complete current active signer quorum",
        );
      }
      requiredSignerCount = Math.max(
        currentPolicy.overlap.requiredSignerCount,
        policy.overlap.requiredSignerCount,
      );
    }
  }
  const now = (options.now ?? new Date()).getTime();
  if (
    now < Date.parse(authorizingPolicy.validFrom) ||
    now >= Date.parse(authorizingPolicy.validUntil)
  ) {
    throw new Error("Authorizing trust policy is outside its validity window");
  }
  if (manifest.releaseSequence < authorizingPolicy.minimumReleaseSequence) {
    throw new Error("Release is below the authorizing policy minimum sequence");
  }
  if (
    now < Date.parse(policy.validFrom) ||
    now >= Date.parse(policy.validUntil)
  )
    throw new Error("Trust policy is outside its validity window");
  const manifestSha256 = sha256(manifestBytes);
  if (authorizingPolicy.deniedManifestDigests.includes(manifestSha256))
    throw new Error("Release manifest digest is revoked");
  const survivingSigners = policy.signers.filter(
    (signer) =>
      !policy.deniedSigners.includes(signer.signerId) &&
      !policy.deniedSigners.includes(signerIdentity(signer)),
  );
  if (survivingSigners.length < policy.overlap.requiredSignerCount) {
    throw new Error(
      "No sufficient trusted signer survives; out-of-band trust bootstrap is required",
    );
  }

  if (basename(options.trustedRootPath) !== policy.trustedRoot.path)
    throw new Error("TrustedRoot identity mismatch");
  const trustedRootBytes = await readBoundedRegular(
    options.trustedRootPath,
    4 * 1024 * 1024,
  );
  if (sha256(trustedRootBytes) !== policy.trustedRoot.sha256)
    throw new Error("TrustedRoot digest mismatch");
  const cosignBytes = await readBoundedRegular(
    options.cosign,
    256 * 1024 * 1024,
  );
  if (sha256(cosignBytes) !== policy.cosign.binaries[options.architecture])
    throw new Error("Cosign binary digest mismatch");
  const archiveIdentity = await hashBoundedRegular(
    options.archive,
    16 * 1024 ** 3,
  );
  if (
    basename(options.archive) !== manifest.archive.path ||
    archiveIdentity.size !== manifest.archive.size ||
    archiveIdentity.sha256 !== manifest.archive.sha256
  ) {
    throw new Error("Release archive identity mismatch");
  }
  const bundlePaths = options.bundlePaths ?? [options.bundlePath];
  if (
    manifest.signatureBundles.length !== bundlePaths.length ||
    bundlePaths.length !== policy.overlap.requiredSignerCount ||
    verificationSigners.length < requiredSignerCount ||
    bundlePaths.length !== requiredSignerCount ||
    new Set(bundlePaths.map((path) => resolve(path))).size !==
      bundlePaths.length
  ) {
    throw new Error(
      "Signer overlap requires one distinct bundle per required signer",
    );
  }
  bundlePaths.forEach((path, index) => {
    const declaration = manifest.signatureBundles[index];
    const signer = verificationSigners[index];
    if (
      declaration === undefined ||
      signer === undefined ||
      basename(path) !== declaration.path ||
      declaration.signerId !== signer.signerId
    ) {
      throw new Error("Signed signature bundle identity mismatch");
    }
  });
  const cosignInvocations: string[][] = [];
  const bundleDigests = new Set<string>();
  const verificationRoot = await mkdtemp(
    resolve(tmpdir(), "skillwire-offline-verify-"),
  );
  try {
    const pinnedCosign = resolve(verificationRoot, "cosign");
    const pinnedRoot = resolve(verificationRoot, "trusted-root.json");
    const pinnedManifest = resolve(verificationRoot, "release.json");
    await Promise.all([
      writeFile(pinnedCosign, cosignBytes, { mode: 0o700, flag: "wx" }),
      writeFile(pinnedRoot, trustedRootBytes, { mode: 0o600, flag: "wx" }),
      writeFile(pinnedManifest, manifestBytes, { mode: 0o600, flag: "wx" }),
    ]);
    await chmod(pinnedCosign, 0o700);
    for (const [index, bundlePath] of bundlePaths.entries()) {
      const bundleBytes = await readBoundedRegular(
        bundlePath,
        16 * 1024 * 1024,
      );
      const bundleDigest = sha256(bundleBytes);
      if (bundleDigests.has(bundleDigest))
        throw new Error(
          "Signer overlap bundles must be cryptographically distinct",
        );
      bundleDigests.add(bundleDigest);
      const bundle = JSON.parse(bundleBytes.toString("utf8")) as Record<
        string,
        unknown
      >;
      validateBundleEvidence(bundle);
      const verification = bundle["verificationMaterial"] as
        { tlogEntries?: unknown[] } | undefined;
      if (
        verification?.tlogEntries === undefined ||
        verification.tlogEntries.length < 1
      )
        throw new Error("Transparency proof is missing");
      const signature = bundle["messageSignature"] as
        { messageDigest?: { algorithm?: string; digest?: string } } | undefined;
      const expectedBundleDigest = Buffer.from(manifestSha256, "hex").toString(
        "base64",
      );
      if (
        signature?.messageDigest?.algorithm !== "SHA2_256" ||
        signature.messageDigest.digest !== expectedBundleDigest
      ) {
        throw new Error("Bundle manifest digest mismatch");
      }
      const signer = verificationSigners[index];
      if (signer === undefined)
        throw new Error("Trust policy has no signer for the required bundle");
      const identityKey = signerIdentity(signer);
      if (
        authorizingPolicy.deniedSigners.includes(signer.signerId) ||
        authorizingPolicy.deniedSigners.includes(identityKey)
      ) {
        throw new Error("Release signer is revoked");
      }
      const ref = exactReleaseRef(signer.refPattern, manifest.releaseVersion);
      const identity = `https://github.com/${signer.repository}/${signer.workflow}@${ref}`;
      const pinnedBundle = resolve(
        verificationRoot,
        `bundle-${String(index)}.json`,
      );
      await writeFile(pinnedBundle, bundleBytes, { mode: 0o600, flag: "wx" });
      const cosignArguments = [
        "verify-blob",
        "--offline",
        "--new-bundle-format",
        "--timeout",
        "30s",
        "--bundle",
        pinnedBundle,
        "--trusted-root",
        pinnedRoot,
        "--certificate-identity",
        identity,
        "--certificate-oidc-issuer",
        signer.issuer,
        "--certificate-github-workflow-repository",
        signer.repository,
        "--certificate-github-workflow-ref",
        ref,
        "--certificate-github-workflow-sha",
        manifest.sourceCommit,
        pinnedManifest,
      ];
      await runCommand({
        executable: pinnedCosign,
        args: cosignArguments,
        environment: {
          PATH: "/usr/bin:/bin",
          HOME: "/nonexistent",
          LANG: "C.UTF-8",
          NO_PROXY: "*",
        },
        deadlineMilliseconds: 35_000,
        maximumOutputBytes: 64 * 1024,
        signal: options.signal,
      });
      cosignInvocations.push(cosignArguments);
    }
  } finally {
    await rm(verificationRoot, { recursive: true, force: true });
  }
  const cosignArguments = cosignInvocations[0];
  if (cosignArguments === undefined)
    throw new Error("No release signer was verified");
  return {
    releaseVersion: manifest.releaseVersion,
    releaseSequence: manifest.releaseSequence,
    trustPolicySequence: policy.sequence,
    manifestSha256,
    archiveSha256: manifest.archive.sha256,
    cosignArguments,
    cosignInvocations,
    manifest,
  };
}

export async function verifyManifestPayload(
  manifest: ReleaseManifest,
  payload: string,
): Promise<void> {
  const inventory = await actualPayload(resolve(payload), manifest.payload);
  if (canonical(inventory) !== canonical(manifest.payload)) {
    throw new Error("Release payload inventory mismatch");
  }
  if (
    canonical(deriveReleaseComponents(inventory)) !==
    canonical(manifest.components)
  ) {
    throw new Error(
      "Release component bindings do not match the payload inventory",
    );
  }
  const featureEntry = manifest.payload.find(
    ({ path }) => path === manifest.feature003Integrity.path,
  );
  if (
    featureEntry?.size !== manifest.feature003Integrity.size ||
    featureEntry.sha256 !== manifest.feature003Integrity.sha256
  ) {
    throw new Error("Feature 003 integrity identity mismatch");
  }
}

export async function verifySelfHostedRelease(
  options: VerifyReleaseOptions,
): Promise<VerifiedReleaseEnvelope> {
  const { payload, ...envelopeOptions } = options;
  const envelope = await verifySignedReleaseEnvelope(envelopeOptions);
  await verifyManifestPayload(envelope.manifest, payload);
  return envelope;
}
