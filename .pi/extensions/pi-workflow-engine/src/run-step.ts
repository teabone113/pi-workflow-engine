import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { realpath } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { isAbsolute, relative, resolve } from "node:path";
import { abortReason, throwIfAborted } from "./cancellation.ts";
import { canonicalizeIdentity } from "./identity-canonicalization.ts";
import type { WorkflowRunStepOptions, WorkflowRunStepResult } from "./types.ts";
import { isPathWithin } from "./tree-fingerprint.ts";

/** Each stream is retained from its beginning up to this many UTF-8 bytes. */
export const RUN_STEP_OUTPUT_LIMIT_BYTES = 50 * 1024;

export interface ResolvedRunStep {
  readonly command: string;
  readonly workspaceRoot: string;
  readonly cwd: string;
  readonly relativeCwd: string;
  readonly timeoutMs?: number;
  readonly env: Readonly<Record<string, string>>;
  readonly envKeys: readonly string[];
  readonly expectExitCode: number;
  readonly effect: "idempotent" | "manual";
  readonly callerKey?: string;
}

export class WorkflowManualEffectResumeError extends Error {
  override readonly name = "WorkflowManualEffectResumeError";
}

export function resolveRunStep(
  workspaceRoot: string,
  command: string,
  opts: WorkflowRunStepOptions,
): ResolvedRunStep {
  if (typeof command !== "string" || command.trim().length === 0) throw new Error("run() command must be a non-empty string");
  if (!opts || (opts.effect !== "idempotent" && opts.effect !== "manual")) {
    throw new Error('run() requires effect: "idempotent" or "manual"');
  }
  const cwdInput = opts.cwd ?? ".";
  if (typeof cwdInput !== "string" || cwdInput.length === 0 || isAbsolute(cwdInput)) {
    throw new Error("run() cwd must be a non-empty workspace-relative path");
  }
  const cwd = resolve(workspaceRoot, cwdInput);
  if (!isPathWithin(resolve(workspaceRoot), cwd)) throw new Error(`run() cwd resolves outside the workspace: ${cwdInput}`);
  const timeoutMs = normalizeTimeout(opts.timeoutMs);
  const expectExitCode = opts.expectExitCode ?? 0;
  if (!Number.isSafeInteger(expectExitCode)) throw new Error("run() expectExitCode must be an integer");
  const env = normalizeEnvironment(opts.env);
  const callerKey = opts.key?.trim();
  if (opts.key !== undefined && !callerKey) throw new Error("run() key must be non-empty when provided");
  return {
    command,
    workspaceRoot: resolve(workspaceRoot),
    cwd,
    relativeCwd: normalizeRelative(relative(resolve(workspaceRoot), cwd)),
    timeoutMs,
    env,
    envKeys: Object.keys(env).sort(),
    expectExitCode,
    effect: opts.effect,
    callerKey,
  };
}

export function runStepJournalKey(step: ResolvedRunStep): string {
  return `run:${sha256Canonical({
    command: step.command,
    cwd: step.relativeCwd,
    envKeys: step.envKeys,
    key: step.callerKey,
  })}`;
}

export function runStepIdentity(step: ResolvedRunStep): unknown {
  return {
    command: step.command,
    cwd: step.relativeCwd,
    envKeys: step.envKeys,
    envDigest: sha256Canonical(step.env),
    ...(step.timeoutMs === undefined ? {} : { timeoutMs: step.timeoutMs }),
    expectExitCode: step.expectExitCode,
    effect: step.effect,
    ...(step.callerKey === undefined ? {} : { key: step.callerKey }),
    outputLimitBytesPerStream: RUN_STEP_OUTPUT_LIMIT_BYTES,
  };
}

export async function executeRunStep(
  step: ResolvedRunStep,
  signal?: AbortSignal,
): Promise<WorkflowRunStepResult> {
  throwIfAborted(signal);
  const [canonicalWorkspace, canonicalCwd] = await Promise.all([
    realpath(step.workspaceRoot),
    realpath(step.cwd),
  ]);
  if (!isPathWithin(canonicalWorkspace, canonicalCwd)) {
    throw new Error(`run() cwd resolves through a symbolic link outside the workspace: ${step.relativeCwd}`);
  }
  const started = performance.now();
  const stdout = new BoundedOutput(RUN_STEP_OUTPUT_LIMIT_BYTES);
  const stderr = new BoundedOutput(RUN_STEP_OUTPUT_LIMIT_BYTES);
  const child = spawn(step.command, {
    cwd: step.cwd,
    env: { ...process.env, ...step.env },
    shell: true,
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });
  child.stdout.on("data", (chunk: Buffer | string) => stdout.add(chunk));
  child.stderr.on("data", (chunk: Buffer | string) => stderr.add(chunk));

  let timedOut = false;
  let aborted = false;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let forceKill: ReturnType<typeof setTimeout> | undefined;
  const terminate = () => {
    try {
      if (process.platform !== "win32" && child.pid !== undefined) process.kill(-child.pid, "SIGTERM");
      else child.kill("SIGTERM");
    } catch {
      child.kill("SIGTERM");
    }
    forceKill = setTimeout(() => {
      try {
        if (process.platform !== "win32" && child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }, 1_000);
    forceKill.unref?.();
  };
  const onAbort = () => {
    aborted = true;
    terminate();
  };
  if (signal) signal.addEventListener("abort", onAbort, { once: true });
  if (step.timeoutMs !== undefined) {
    timeout = setTimeout(() => {
      timedOut = true;
      terminate();
    }, step.timeoutMs);
    timeout.unref?.();
  }

  try {
    const exit = await new Promise<{ readonly code: number | null }>((resolveExit, reject) => {
      child.once("error", reject);
      child.once("close", (code) => resolveExit({ code }));
    });
    if (aborted) throw abortReason(signal);
    const durationMs = Math.max(0, Math.round(performance.now() - started));
    return {
      ok: !timedOut && exit.code === step.expectExitCode,
      exitCode: exit.code,
      stdout: stdout.text(),
      stderr: stderr.text(),
      durationMs,
      timedOut,
    };
  } finally {
    if (timeout) clearTimeout(timeout);
    if (forceKill) clearTimeout(forceKill);
    signal?.removeEventListener("abort", onAbort);
  }
}

export function isRunStepResult(value: unknown): value is WorkflowRunStepResult {
  if (typeof value !== "object" || value === null) return false;
  const result = value as Record<string, unknown>;
  return (
    typeof result.ok === "boolean" &&
    (result.exitCode === null || Number.isSafeInteger(result.exitCode)) &&
    typeof result.stdout === "string" &&
    Buffer.byteLength(result.stdout) <= RUN_STEP_OUTPUT_LIMIT_BYTES + 3 &&
    typeof result.stderr === "string" &&
    Buffer.byteLength(result.stderr) <= RUN_STEP_OUTPUT_LIMIT_BYTES + 3 &&
    typeof result.durationMs === "number" && Number.isFinite(result.durationMs) && result.durationMs >= 0 &&
    typeof result.timedOut === "boolean"
  );
}

class BoundedOutput {
  private readonly chunks: Buffer[] = [];
  private bytes = 0;

  constructor(private readonly limit: number) {}

  add(chunk: Buffer | string): void {
    if (this.bytes >= this.limit) return;
    const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    const retained = buffer.subarray(0, this.limit - this.bytes);
    if (retained.length > 0) this.chunks.push(Buffer.from(retained));
    this.bytes += retained.length;
  }

  text(): string {
    return Buffer.concat(this.chunks).toString("utf8");
  }
}

function normalizeTimeout(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value < 1 || value > 86_400_000) {
    throw new Error("run() timeoutMs must be an integer between 1 and 86400000");
  }
  return value;
}

function normalizeEnvironment(value: Readonly<Record<string, string>> | undefined): Readonly<Record<string, string>> {
  if (value === undefined) return {};
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("run() env must be an object");
  const result: Record<string, string> = {};
  for (const key of Object.keys(value).sort()) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor) || typeof descriptor.value !== "string") {
      throw new Error(`run() env value for ${key} must be a string`);
    }
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error(`run() env key is invalid: ${key}`);
    result[key] = descriptor.value;
  }
  return result;
}

function sha256Canonical(value: unknown): string {
  const canonical = canonicalizeIdentity(value);
  if (canonical.kind === "unverifiable") throw new Error(`run() identity could not be recorded: ${canonical.reason}`);
  return createHash("sha256").update(canonical.value).digest("hex");
}

function normalizeRelative(path: string): string {
  if (path === "") return ".";
  return path.replaceAll("\\", "/");
}
