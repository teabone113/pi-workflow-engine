import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { WORKFLOW_RUNS_DIR, validateWorkflowRunId } from "./journal.ts";
import type { WorkflowArtifact, WorkflowArtifactOptions } from "./types.ts";
import { isPathWithin } from "./tree-fingerprint.ts";

export class WorkflowArtifactIntegrityError extends Error {
  override readonly name = "WorkflowArtifactIntegrityError";
}

export interface PreparedWorkflowArtifact {
  readonly name: string;
  readonly bytes: Buffer;
  readonly sha256: string;
  readonly callerKey?: string;
}

export function prepareWorkflowArtifact(
  name: string,
  content: unknown,
  opts: WorkflowArtifactOptions = {},
): PreparedWorkflowArtifact {
  const normalizedName = validateArtifactName(name);
  const callerKey = opts.key?.trim();
  if (opts.key !== undefined && !callerKey) throw new Error("artifact() key must be non-empty when provided");
  const bytes = typeof content === "string"
    ? Buffer.from(content, "utf8")
    : Buffer.from(`${JSON.stringify(captureJsonValue(content, new WeakSet<object>(), 0), null, 2)}\n`, "utf8");
  return {
    name: normalizedName,
    bytes,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    callerKey,
  };
}

export function artifactJournalKey(artifact: PreparedWorkflowArtifact): string {
  const hash = createHash("sha256")
    .update(JSON.stringify({ name: artifact.name, key: artifact.callerKey }))
    .digest("hex");
  return `artifact:${hash}`;
}

export function artifactIdentity(artifact: PreparedWorkflowArtifact): unknown {
  return {
    name: artifact.name,
    contentType: "utf8",
    sha256: artifact.sha256,
    bytes: artifact.bytes.length,
    ...(artifact.callerKey === undefined ? {} : { key: artifact.callerKey }),
  };
}

export async function storeWorkflowArtifact(
  workspaceRoot: string,
  runId: string,
  artifact: PreparedWorkflowArtifact,
): Promise<WorkflowArtifact> {
  const safeRunId = validateWorkflowRunId(runId);
  const artifactDir = join(workspaceRoot, WORKFLOW_RUNS_DIR, safeRunId, "artifacts");
  const filename = `${artifact.sha256.slice(0, 16)}-${artifact.name}`;
  const absolutePath = join(artifactDir, filename);
  const temporaryPath = `${absolutePath}.${process.pid}.${randomUUID()}.tmp`;
  const canonicalWorkspace = await realpath(resolve(workspaceRoot));
  const existingArtifactAncestor = await resolveExistingAncestor(artifactDir);
  if (!isPathWithin(canonicalWorkspace, existingArtifactAncestor)) {
    throw new Error("artifact() storage resolves through a symbolic link outside the workspace");
  }
  await mkdir(dirname(absolutePath), { recursive: true });
  const canonicalArtifactDir = await realpath(artifactDir);
  if (!isPathWithin(canonicalWorkspace, canonicalArtifactDir)) {
    throw new Error("artifact() storage resolves outside the workspace");
  }
  try {
    await writeFile(temporaryPath, artifact.bytes, { mode: 0o600 });
    await rename(temporaryPath, absolutePath);
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
  return {
    name: artifact.name,
    path: normalizeRelative(relative(workspaceRoot, absolutePath)),
    sha256: artifact.sha256,
    bytes: artifact.bytes.length,
  };
}

export async function validateWorkflowArtifact(
  workspaceRoot: string,
  value: unknown,
): Promise<boolean> {
  if (!isWorkflowArtifact(value)) return false;
  if (isAbsolute(value.path)) return false;
  const absolute = resolve(workspaceRoot, value.path);
  const artifactsRoot = resolve(workspaceRoot, WORKFLOW_RUNS_DIR);
  if (!isPathWithin(artifactsRoot, absolute)) return false;
  try {
    const info = await lstat(absolute);
    if (!info.isFile() || info.isSymbolicLink()) return false;
    const canonicalWorkspace = await realpath(resolve(workspaceRoot));
    const canonicalArtifactsRoot = await realpath(artifactsRoot);
    const canonicalPath = await realpath(absolute);
    if (!isPathWithin(canonicalWorkspace, canonicalArtifactsRoot) || !isPathWithin(canonicalArtifactsRoot, canonicalPath)) return false;
    const bytes = await readFile(canonicalPath);
    return bytes.length === value.bytes && createHash("sha256").update(bytes).digest("hex") === value.sha256;
  } catch {
    return false;
  }
}

export function isWorkflowArtifact(value: unknown): value is WorkflowArtifact {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const artifact = value as Record<string, unknown>;
  return (
    typeof artifact.name === "string" &&
    typeof artifact.path === "string" &&
    typeof artifact.sha256 === "string" && /^[0-9a-f]{64}$/.test(artifact.sha256) &&
    Number.isSafeInteger(artifact.bytes) && Number(artifact.bytes) >= 0
  );
}

function validateArtifactName(value: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 255 ||
    value === "." ||
    value === ".." ||
    value.includes("/") ||
    value.includes("\\") ||
    value.includes("\0")
  ) {
    throw new Error("artifact() name must be a single non-empty file name without path separators");
  }
  return value;
}

function captureJsonValue(value: unknown, active: WeakSet<object>, depth: number): unknown {
  if (depth > 64) throw new Error("artifact() JSON exceeded 64 levels");
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("artifact() JSON contains a non-finite number");
    return value;
  }
  if (typeof value !== "object") throw new Error(`artifact() JSON contains unsupported ${typeof value} data`);
  if (active.has(value)) throw new Error("artifact() JSON contains a cycle");
  active.add(value);
  try {
    const prototype = Object.getPrototypeOf(value);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Array.isArray(value)) {
      if (prototype !== Array.prototype) throw new Error("artifact() JSON array has a custom prototype");
      return value.map((_item, index) => {
        const descriptor = descriptors[String(index)];
        if (!descriptor || !("value" in descriptor)) throw new Error("artifact() JSON arrays must not contain holes or accessors");
        return captureJsonValue(descriptor.value, active, depth + 1);
      });
    }
    if (prototype !== Object.prototype && prototype !== null) throw new Error("artifact() JSON object has a custom prototype");
    const output: Record<string, unknown> = {};
    for (const key of Object.keys(descriptors).sort()) {
      const descriptor = descriptors[key]!;
      if (!descriptor.enumerable) continue;
      if (!("value" in descriptor)) throw new Error(`artifact() JSON property ${key} is an accessor`);
      if (descriptor.value === undefined) throw new Error(`artifact() JSON property ${key} is undefined`);
      output[key] = captureJsonValue(descriptor.value, active, depth + 1);
    }
    return output;
  } finally {
    active.delete(value);
  }
}

async function resolveExistingAncestor(path: string): Promise<string> {
  let current = resolve(path);
  while (true) {
    try {
      await lstat(current);
      return await realpath(current);
    } catch (error) {
      if (!isMissingPathError(error)) throw error;
      const parent = dirname(current);
      if (parent === current) throw error;
      current = parent;
    }
  }
}

function isMissingPathError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function normalizeRelative(path: string): string {
  return path.replaceAll("\\", "/");
}
