import { posix } from "node:path";

import type {
  ExternalCatalogStore,
  PublishedExternalSnapshot,
  SourceRegistration,
} from "../ports/external-catalog-store.js";
import type {
  GitHubSourceProvider,
  OperationContext,
} from "../ports/github-source-provider.js";
import { sha256Hex } from "../../domain/catalog/canonical-revision.js";
import { createExternalSkillRevision } from "../../domain/external-catalog/canonical-revision-v2.js";
import type {
  ExternalDependencyInput,
  ExternalResourceInput,
  GitTreeEntry,
  ImportedSkillInput,
} from "../../domain/external-catalog/types.js";
import { ExternalRevisionPublisher } from "../../ingestion/external-revision-publisher.js";
import { parseClaudePluginManifest } from "../../ingestion/parsing/claude-plugin-manifest.js";
import { parseSkillDocument } from "../../ingestion/parsing/frontmatter.js";
import { extractTextualResourceReferences } from "../../ingestion/parsing/markdown-resources.js";

function requiredBlob(
  tree: readonly GitTreeEntry[],
  path: string,
): GitTreeEntry {
  const entry = tree.find((candidate) => candidate.path === path);
  if (
    entry?.type !== "blob" ||
    entry.mode !== "100644" ||
    entry.size === undefined
  ) {
    throw new Error("OBJECT_UNSUPPORTED");
  }
  return entry;
}

function decodeText(bytes: Uint8Array): string {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (text.includes("\u0000")) throw new Error("RESOURCE_NON_TEXT");
  return text.replaceAll("\r\n", "\n").normalize("NFC");
}

function publicSkillId(
  repositoryId: number,
  name: string,
  skillPath: string,
): string {
  return `gh-${String(repositoryId)}-${name}-${sha256Hex(skillPath).slice(0, 8)}`.slice(
    0,
    80,
  );
}

export class SourceSynchronizationService {
  readonly #publisher: ExternalRevisionPublisher;

  constructor(
    private readonly provider: GitHubSourceProvider,
    private readonly store: ExternalCatalogStore,
  ) {
    this.#publisher = new ExternalRevisionPublisher(store);
  }

  async sync(
    sourceId: string,
    context?: OperationContext,
  ): Promise<PublishedExternalSnapshot> {
    const source = (await this.store.listSources(context)).find(
      (candidate) => candidate.sourceId === sourceId,
    );
    if (source === undefined) throw new Error("SOURCE_NOT_FOUND");
    return this.#syncSource(source, context);
  }

  async #syncSource(
    source: SourceRegistration,
    context?: OperationContext,
  ): Promise<PublishedExternalSnapshot> {
    const snapshot = await this.provider.readDefaultSnapshot(
      source.repository,
      context,
    );
    const manifestEntry = requiredBlob(
      snapshot.tree,
      ".claude-plugin/plugin.json",
    );
    const manifest = parseClaudePluginManifest(
      await this.provider.readBlob(
        source.repository,
        manifestEntry.sha,
        manifestEntry.size ?? 0,
        context,
      ),
    );
    const licenseEntry = requiredBlob(snapshot.tree, "LICENSE");
    const licenseText = decodeText(
      await this.provider.readBlob(
        source.repository,
        licenseEntry.sha,
        licenseEntry.size ?? 0,
        context,
      ),
    );
    if (manifest.license !== "MIT" || !/MIT License/i.test(licenseText)) {
      throw new Error("LICENSE_CONFLICT");
    }

    const parsed = await Promise.all(
      manifest.skillRoots.map(async (root) => {
        const skillPath = posix.join(root, "SKILL.md");
        const entry = requiredBlob(snapshot.tree, skillPath);
        const document = parseSkillDocument(
          await this.provider.readBlob(
            source.repository,
            entry.sha,
            entry.size ?? 0,
            context,
          ),
        );
        return { root, skillPath, document };
      }),
    );
    const names = new Set(parsed.map(({ document }) => document.name));
    if (names.size !== parsed.length)
      throw new Error("SKILL_DUPLICATE_IDENTITY");

    const revisions = await Promise.all(
      parsed.map(async ({ skillPath, document }) => {
        const references = extractTextualResourceReferences(
          document.instructions,
          skillPath,
        );
        const resources: ExternalResourceInput[] = [];
        for (const reference of references) {
          const entry = requiredBlob(snapshot.tree, reference.repositoryPath);
          resources.push({
            path: reference.manifestPath,
            mediaType: reference.mediaType,
            content: decodeText(
              await this.provider.readBlob(
                source.repository,
                entry.sha,
                entry.size ?? 0,
                context,
              ),
            ),
          });
        }
        const dependencies: ExternalDependencyInput[] =
          document.dependencyEvidence.filter(
            ({ skillName }) =>
              names.has(skillName) && skillName !== document.name,
          );
        const skill: ImportedSkillInput = {
          name: document.name,
          description: document.description,
          skillPath,
          instructions: document.instructions,
          invocationMode: document.invocationMode,
          resources,
          dependencies,
        };
        return createExternalSkillRevision({
          skillId: publicSkillId(
            source.repository.repositoryId,
            document.name,
            skillPath,
          ),
          provenance: {
            provider: "github",
            repositoryId: source.repository.repositoryId,
            owner: source.repository.owner,
            repository: source.repository.repository,
            commitSha: snapshot.commitSha,
            skillPath,
            sourceOwner: manifest.author,
            spdxLicenseId: manifest.license,
            licenseText,
          },
          skill,
        });
      }),
    );
    return this.#publisher.publish(
      {
        sourceId: source.sourceId,
        commitSha: snapshot.commitSha,
        treeSha: snapshot.treeSha,
        manifestVersion: manifest.version,
        revisions,
      },
      context,
    );
  }
}
