import { createHash } from "node:crypto";

export type ClientComponentClassification =
  | "absent"
  | "owned-equivalent"
  | "external-equivalent"
  | "same-name-conflict"
  | "ambiguous"
  | "duplicate"
  | "shadowed"
  | "managed"
  | "drifted-owned";

export type ClientComponentScope =
  "user" | "local" | "project" | "managed" | "plugin" | "effective";

export interface ClientComponentObservation {
  readonly name: string;
  readonly scope: ClientComponentScope;
  readonly effective: boolean;
  readonly managed: boolean;
  readonly identitySha256: string;
  readonly disabled?: boolean | undefined;
}

export interface ClassifyClientComponentOptions {
  readonly requiredName: string;
  readonly expectedIdentitySha256: string;
  readonly ownedIdentitySha256?: string | undefined;
  readonly observations: readonly ClientComponentObservation[];
}

export interface ClientComponentState {
  readonly classification: ClientComponentClassification;
  readonly observations: readonly ClientComponentObservation[];
  readonly mutationAllowed: boolean;
}

export type ClientPluginMutationComponent =
  "marketplace-install" | "plugin-install" | "plugin-enable";

export type ClientPluginMutationRunner = (
  component: ClientPluginMutationComponent,
  action: () => Promise<void>,
) => Promise<void>;

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string")
    return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("identity is not canonical");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    return `{${Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  }
  throw new Error("identity contains an unsupported value");
}

export function clientComponentIdentity(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function classifyClientComponent(
  options: ClassifyClientComponentOptions,
): ClientComponentState {
  if (!/^[0-9a-f]{64}$/.test(options.expectedIdentitySha256))
    throw new Error("expected client identity is invalid");
  if (
    options.ownedIdentitySha256 !== undefined &&
    !/^[0-9a-f]{64}$/.test(options.ownedIdentitySha256)
  ) {
    throw new Error("owned client identity is invalid");
  }
  const relevant = options.observations.filter(
    ({ name, identitySha256 }) =>
      name === options.requiredName ||
      identitySha256 === options.expectedIdentitySha256,
  );
  if (relevant.length === 0) {
    return {
      classification: "absent",
      observations: [],
      mutationAllowed: true,
    };
  }
  if (
    relevant.length > 1 &&
    (relevant.filter(({ effective }) => effective).length > 1 ||
      new Set(relevant.map(({ name }) => name)).size > 1)
  ) {
    return {
      classification: "duplicate",
      observations: relevant,
      mutationAllowed: false,
    };
  }
  if (relevant.some(({ managed }) => managed)) {
    return {
      classification: "managed",
      observations: relevant,
      mutationAllowed: false,
    };
  }
  const sameName = relevant.filter(({ name }) => name === options.requiredName);
  const effective = relevant.find((entry) => entry.effective);
  if (
    sameName.some(({ effective: isEffective }) => !isEffective) &&
    effective !== undefined
  ) {
    return {
      classification: "shadowed",
      observations: relevant,
      mutationAllowed: false,
    };
  }
  if (sameName.length === 0) {
    return {
      classification: "ambiguous",
      observations: relevant,
      mutationAllowed: false,
    };
  }
  const observed = effective ?? sameName[0];
  if (observed === undefined) {
    return {
      classification: "absent",
      observations: [],
      mutationAllowed: true,
    };
  }
  if (options.ownedIdentitySha256 !== undefined) {
    if (
      observed.identitySha256 === options.expectedIdentitySha256 &&
      observed.identitySha256 === options.ownedIdentitySha256
    ) {
      return {
        classification: "owned-equivalent",
        observations: relevant,
        mutationAllowed: false,
      };
    }
    return {
      classification: "drifted-owned",
      observations: relevant,
      mutationAllowed: false,
    };
  }
  if (
    observed.identitySha256 === options.expectedIdentitySha256 &&
    observed.disabled !== true
  ) {
    return {
      classification: "external-equivalent",
      observations: relevant,
      mutationAllowed: false,
    };
  }
  return {
    classification: "same-name-conflict",
    observations: relevant,
    mutationAllowed: false,
  };
}
