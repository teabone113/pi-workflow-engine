import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rm, stat, appendFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { AgentOptions } from "./types.ts";
import type { WorktreeBaseline } from "./worktree.ts";
import { canonicalizeIdentity } from "./identity-canonicalization.ts";
import { WorkflowAbortError } from "./cancellation.ts";
import { unknownErrorMessage } from "./unknown-error.ts";
import {
  isAgentResumeContext,
  resumeContextMismatchReason,
  type AgentResumeContext,
  type ResumeContextComparisonOptions,
} from "./resume-context.ts";

export const WORKFLOW_RUNS_DIR = join(".pi", ".workflow-runs");
export const WORKFLOW_JOURNAL_KEEP = 50;

export interface JournalEntryV2 {
  readonly version: 2;
  /** Entries written before the generic recorded-call journal omit kind and are agents. */
  readonly kind?: string;
  /** New entries carry invocation-order sequence; legacy v2 entries replay by key for compatibility. */
  readonly sequence?: number;
  readonly key: string;
  readonly result: unknown;
  readonly identity: unknown;
}

/** Alias retained for source compatibility with callers that distinguish legacy v2 input. */
export type LegacyJournalEntryV2 = JournalEntryV2;

/** Parsed only so resume can explain why an older entry is not replayed. */
export interface LegacyJournalEntryV1 {
  readonly version?: 1;
  readonly key: string;
  readonly value: unknown;
  readonly context?: unknown;
}

export type JournalEntry = JournalEntryV2 | LegacyJournalEntryV1;

export type JournalLookup = { readonly hit: true; readonly value: unknown } | { readonly hit: false; readonly reason?: string };
export type JournalRecordResult = { readonly ok: true } | { readonly ok: false; readonly error: string };

export interface JournalLookupOptions extends ResumeContextComparisonOptions {
  readonly kind?: string;
  readonly sequence?: number;
  /** Edited-workflow resume falls back to key lookup when invocation order changed. */
  readonly allowSequenceKeyFallback?: boolean;
}

export interface JournalRecordOptions {
  readonly kind?: string;
  readonly sequence?: number;
}

export type AgentJournalKeyCapture =
  | { readonly kind: "verified"; readonly key: string }
  | { readonly kind: "unverifiable"; readonly reason: string };

export interface WorkflowJournal {
  readonly isResuming?: boolean;
  lookup(key: string, identity: unknown, options?: JournalLookupOptions): JournalLookup;
  record(key: string, result: unknown, identity: unknown, options?: JournalRecordOptions): Promise<JournalRecordResult>;
}

export class WorkflowJournalLoadError extends Error {
  override readonly name = "WorkflowJournalLoadError";
}

export class WorkflowJournalSequenceError extends WorkflowAbortError {
  override readonly name = "WorkflowJournalSequenceError";
}

export function createWorkflowRunId(): string {
  return randomUUID();
}

export function workflowJournalPath(cwd: string, runId: string): string {
  return join(cwd, WORKFLOW_RUNS_DIR, `${validateWorkflowRunId(runId)}.jsonl`);
}

export function agentJournalKey(prompt: string, opts: AgentOptions = {}, worktreeBaseline?: WorktreeBaseline): string {
  const capture = captureAgentJournalKey(prompt, opts, worktreeBaseline);
  return capture.kind === "verified" ? capture.key : `agent:unverifiable:${randomUUID()}`;
}

export function hashAgentCall(prompt: string, opts: AgentOptions = {}, worktreeBaseline?: WorktreeBaseline): string {
  const capture = captureAgentCallHash(prompt, opts, worktreeBaseline);
  return capture.kind === "verified"
    ? capture.hash
    : createHash("sha256").update(`unverifiable:${randomUUID()}`).digest("hex");
}

/** Capture a replay key without allowing hostile or oversized schemas to escape as exceptions. */
export function captureAgentJournalKey(
  prompt: string,
  opts: AgentOptions = {},
  worktreeBaseline?: WorktreeBaseline,
): AgentJournalKeyCapture {
  const behavior = captureAgentCallHash(prompt, opts, worktreeBaseline);
  if (behavior.kind === "unverifiable") return behavior;
  let cacheKey: string | undefined;
  try {
    cacheKey = opts.cacheKey?.trim();
  } catch {
    return { kind: "unverifiable", reason: "agent cache key could not be inspected" };
  }
  if (!cacheKey) return { kind: "verified", key: `agent:${behavior.hash}` };
  const cacheKeyHash = createHash("sha256").update(cacheKey).digest("hex");
  return { kind: "verified", key: `agent:${cacheKeyHash}:${behavior.hash}` };
}

type AgentCallHashCapture =
  | { readonly kind: "verified"; readonly hash: string }
  | { readonly kind: "unverifiable"; readonly reason: string };

function captureAgentCallHash(
  prompt: string,
  opts: AgentOptions,
  worktreeBaseline: WorktreeBaseline | undefined,
): AgentCallHashCapture {
  try {
    const behavior = {
      prompt,
      opts: {
        thinkingLevel: opts.thinkingLevel,
        tools: opts.tools,
        toolHints: opts.toolHints,
        requireToolHints: opts.requireToolHints === true ? true : undefined,
        skills: opts.skills,
        schema: opts.schema,
        isolation: opts.isolation,
        writeAllow: opts.writeAllow,
        worktreeBaseline: worktreeBaseline
          ? {
              ref: worktreeBaseline.ref,
              patchFingerprint: createHash("sha256").update(worktreeBaseline.patch ?? "").digest("hex"),
            }
          : undefined,
      },
    };
    const canonical = canonicalizeIdentity(behavior);
    return canonical.kind === "verified"
      ? { kind: "verified", hash: createHash("sha256").update(canonical.value).digest("hex") }
      : canonical;
  } catch {
    return { kind: "unverifiable", reason: "agent replay inputs could not be inspected" };
  }
}

export async function loadJournalEntries(path: string, options: { readonly required?: boolean } = {}): Promise<JournalEntry[]> {
  let content: string;
  try {
    content = await readFile(path, "utf8");
  } catch (error) {
    if (options.required) {
      throw new WorkflowJournalLoadError(`Could not load workflow resume journal at ${path}: ${unknownErrorMessage(error)}`);
    }
    return [];
  }

  const entries: JournalEntry[] = [];
  let lineNumber = 0;
  for (const line of content.split(/\r?\n/)) {
    lineNumber += 1;
    if (line.trim() === "") continue;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (isJournalEntry(parsed)) {
        entries.push(parsed);
        continue;
      }
      if (options.required) {
        throw new WorkflowJournalLoadError(`Workflow resume journal at ${path}:${lineNumber} has an incompatible entry format.`);
      }
    } catch (error) {
      if (options.required) {
        if (error instanceof WorkflowJournalLoadError) throw error;
        throw new WorkflowJournalLoadError(`Workflow resume journal at ${path}:${lineNumber} is not valid JSON.`);
      }
    }
  }
  return entries;
}

export async function createWorkflowJournal(options: {
  readonly resumePath?: string;
  readonly writePath: string;
}): Promise<WorkflowJournal> {
  const priorEntries = options.resumePath ? await loadJournalEntries(options.resumePath, { required: true }) : [];
  await mkdir(dirname(options.writePath), { recursive: true });
  await appendFile(options.writePath, "", "utf8");
  return createMemoryBackedJournal(priorEntries, options.writePath, options.resumePath !== undefined);
}

export function createMemoryBackedJournal(
  priorEntries: readonly JournalEntry[] = [],
  writePath?: string,
  isResuming = priorEntries.length > 0,
): WorkflowJournal {
  const priorByKey = new Map<string, JournalEntry[]>();
  const priorBySequence = new Map<number, JournalEntryV2[]>();
  for (const entry of priorEntries) {
    const entries = priorByKey.get(entry.key) ?? [];
    entries.push(entry);
    priorByKey.set(entry.key, entries);
    if (entry.version === 2 && entry.sequence !== undefined) {
      const sequenced = priorBySequence.get(entry.sequence) ?? [];
      sequenced.push(entry);
      priorBySequence.set(entry.sequence, sequenced);
    }
  }

  let appendQueue = Promise.resolve<JournalRecordResult>({ ok: true });
  return {
    isResuming,
    lookup(key, identity, options = {}) {
      const kind = options.kind ?? "agent";
      const sequence = options.sequence;
      if (sequence !== undefined) {
        const atSequence = priorBySequence.get(sequence);
        if (atSequence && atSequence.length > 0) {
          const exact = atSequence.filter((entry) => journalEntryKind(entry) === kind && entry.key === key);
          if (exact.length === 0 && !options.allowSequenceKeyFallback) {
            const found = atSequence[0]!;
            throw new WorkflowJournalSequenceError(
              `Workflow resume diverged at recorded sequence ${sequence}: expected ${kind} key "${key}", found ${journalEntryKind(found)} key "${found.key}". Re-run with --resume-edited to allow key-only lookup.`,
            );
          }
          if (exact.length > 0) {
            const sequenceMatch = lookupMatchingEntries(exact, kind, identity, options);
            if (sequenceMatch.hit || !options.allowSequenceKeyFallback) return sequenceMatch;
            return lookupMatchingEntries(priorByKey.get(key) ?? [], kind, identity, options);
          }
        }
        const keyed = priorByKey.get(key) ?? [];
        const legacyUnsequenced = keyed.filter((entry) => entry.version !== 2 || entry.sequence === undefined);
        if (options.allowSequenceKeyFallback || priorBySequence.size === 0 || legacyUnsequenced.length > 0) {
          return lookupMatchingEntries(options.allowSequenceKeyFallback || priorBySequence.size === 0 ? keyed : legacyUnsequenced, kind, identity, options);
        }
        // A missing sequence represents an interrupted or newly introduced call and runs live.
        return { hit: false };
      }
      return lookupMatchingEntries(priorByKey.get(key) ?? [], kind, identity, options);
    },
    async record(key, result, identity, options = {}) {
      const entry: JournalEntryV2 = {
        version: 2,
        kind: options.kind ?? "agent",
        sequence: options.sequence,
        key,
        result,
        identity,
      };
      if (!writePath) return { ok: true };
      const append = async (): Promise<JournalRecordResult> => {
        try {
          await mkdir(dirname(writePath), { recursive: true });
          await appendFile(writePath, `${JSON.stringify(entry)}\n`, "utf8");
          return { ok: true };
        } catch (error) {
          return { ok: false, error: unknownErrorMessage(error) };
        }
      };
      appendQueue = appendQueue.then(append, append);
      return await appendQueue;
    },
  };
}

function lookupMatchingEntries(
  entries: readonly JournalEntry[],
  kind: string,
  identity: unknown,
  options: JournalLookupOptions,
): JournalLookup {
  if (entries.length === 0) return { hit: false };
  const current = entries.filter(
    (entry): entry is JournalEntryV2 => entry.version === 2 && journalEntryKind(entry) === kind,
  );
  if (current.length === 0) {
    return {
      hit: false,
      reason: entries.some((entry) => entry.version === 2)
        ? `journal entries belong to a different recorded call kind`
        : "journal entry predates replay contract v2",
    };
  }

  const matches = current.filter((entry) => recordedIdentityMismatchReason(entry.identity, identity, kind, options) === undefined);
  if (matches.length === 1) return { hit: true, value: matches[0]!.result };
  if (matches.length > 1) return { hit: false, reason: `multiple cached entries match this ${kind} call` };
  return { hit: false, reason: recordedIdentityMismatchReason(current[0]!.identity, identity, kind, options) };
}

function recordedIdentityMismatchReason(
  stored: unknown,
  current: unknown,
  kind: string,
  options: JournalLookupOptions,
): string | undefined {
  if (kind === "agent") {
    if (!isAgentResumeContext(stored) || !isAgentResumeContext(current)) {
      return "journal entry predates effective replay identity";
    }
    return resumeContextMismatchReason(stored, current, options);
  }

  const normalizedStored = normalizeWorkflowSourceForEditedResume(stored, current, options);
  const left = canonicalizeIdentity(normalizedStored);
  const right = canonicalizeIdentity(current);
  if (left.kind === "unverifiable" || right.kind === "unverifiable") {
    return "recorded call identity could not be verified";
  }
  return left.value === right.value ? undefined : "recorded call identity changed";
}

function normalizeWorkflowSourceForEditedResume(
  stored: unknown,
  current: unknown,
  options: JournalLookupOptions,
): unknown {
  if (!options.allowWorkflowSourceMismatch || !isRecord(stored) || !isRecord(current)) return stored;
  if (stored.contract !== "workflow-api-v1" || current.contract !== "workflow-api-v1") return stored;
  if (!isRecord(stored.workflow) || !isRecord(current.workflow)) return stored;
  if (stored.workflow.kind !== "verified" || current.workflow.kind !== "verified") return stored;
  if (typeof current.workflow.sourceFingerprint !== "string") return stored;
  return {
    ...stored,
    workflow: { ...stored.workflow, sourceFingerprint: current.workflow.sourceFingerprint },
  };
}

function journalEntryKind(entry: JournalEntryV2): string {
  return entry.kind ?? "agent";
}

export async function pruneWorkflowJournals(cwd: string, keep = WORKFLOW_JOURNAL_KEEP): Promise<void> {
  const dir = join(cwd, WORKFLOW_RUNS_DIR);
  let files: string[];
  try {
    files = await readdir(dir);
  } catch {
    return;
  }

  const candidates = await Promise.all(
    files
      .filter((file) => file.endsWith(".jsonl"))
      .map(async (file) => {
        const path = join(dir, file);
        try {
          const info = await stat(path);
          return { path, mtimeMs: info.mtimeMs };
        } catch {
          return undefined;
        }
      }),
  );

  const stale = candidates
    .filter((entry): entry is { readonly path: string; readonly mtimeMs: number } => entry !== undefined)
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(Math.max(0, keep));

  await Promise.all(stale.map((entry) => rm(entry.path, { force: true }).catch(() => undefined)));
}

export function validateWorkflowRunId(runId: string): string {
  const trimmed = runId.trim();
  if (!/^[A-Za-z0-9_.-]+$/.test(trimmed)) {
    throw new Error("Workflow run id must contain only letters, numbers, dots, underscores, or hyphens.");
  }
  return trimmed;
}

function isJournalEntry(value: unknown): value is JournalEntry {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as {
    readonly version?: unknown;
    readonly kind?: unknown;
    readonly sequence?: unknown;
    readonly key?: unknown;
    readonly result?: unknown;
    readonly identity?: unknown;
    readonly value?: unknown;
    readonly context?: unknown;
  };
  if (entry.version === 2) {
    return (
      typeof entry.key === "string" &&
      "result" in entry &&
      "identity" in entry &&
      (entry.kind === undefined || (typeof entry.kind === "string" && entry.kind.length > 0)) &&
      (entry.sequence === undefined || (Number.isSafeInteger(entry.sequence) && Number(entry.sequence) > 0))
    );
  }
  return (
    (entry.version === undefined || entry.version === 1) &&
    typeof entry.key === "string" &&
    "value" in entry &&
    (entry.context === undefined || isLegacyAgentResumeContext(entry.context))
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isLegacyAgentResumeContext(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const context = value as { readonly repository?: unknown; readonly workflow?: unknown; readonly model?: unknown };
  return "repository" in context && "workflow" in context && "model" in context;
}
