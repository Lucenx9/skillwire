import { resolve, sep } from "node:path";

const SAFE_RESOURCE_PATH = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/;

export function assertSafeResourcePath(resourcePath: string): void {
  if (
    resourcePath.length === 0 ||
    resourcePath.length > 240 ||
    !SAFE_RESOURCE_PATH.test(resourcePath) ||
    resourcePath
      .split("/")
      .some((segment) => segment === "." || segment === "..")
  ) {
    throw new Error("Resource path is not a safe relative path");
  }
}

export function resolveResourcePath(
  root: string,
  resourcePath: string,
): string {
  assertSafeResourcePath(resourcePath);
  const absoluteRoot = resolve(root);
  const absolutePath = resolve(root, resourcePath);
  if (!absolutePath.startsWith(`${absoluteRoot}${sep}`)) {
    throw new Error("Resource path escapes its revision root");
  }
  return absolutePath;
}
