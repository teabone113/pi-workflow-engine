import { canonicalizeIdentity } from "./identity-canonicalization.ts";
import type {
  JournalLookupOptions,
  JournalRecordOptions,
  WorkflowJournal,
} from "./journal.ts";

export interface RecordedCallReservation {
  readonly kind: string;
  readonly key: string;
  readonly sequence: number;
}

export interface RecordedCallOptions<T> {
  /** Validate a cached value before accepting it. A false result executes the call live. */
  readonly validate?: (value: unknown) => boolean | Promise<boolean>;
  /** Run after a journal miss but before the live effect begins. */
  readonly beforeLive?: (reservation: RecordedCallReservation) => void | Promise<void>;
  /** Existing agent behavior logs journal failures and still returns its result. */
  readonly tolerateRecordFailure?: boolean;
  readonly onRecordFailure?: (message: string) => void;
}

export interface WorkflowRecorderOptions {
  readonly resumeEditedWorkflow?: boolean;
  readonly onSequence?: (sequence: number) => void;
}

/**
 * One run-wide allocator and journal facade for every replayable API call.
 * Reservations are synchronous, so sequence reflects authored invocation order rather
 * than completion order when calls fan out concurrently.
 */
export class WorkflowRecorder {
  private highest = 0;
  private readonly kindOrdinals = new Map<string, number>();

  constructor(
    private readonly journal: WorkflowJournal,
    private readonly options: WorkflowRecorderOptions = {},
  ) {}

  get isResuming(): boolean {
    return this.journal.isResuming === true;
  }

  get highestSequence(): number {
    return this.highest;
  }

  nextKindOrdinal(kind: string): number {
    const next = (this.kindOrdinals.get(kind) ?? 0) + 1;
    this.kindOrdinals.set(kind, next);
    return next;
  }

  reserve(kind: string, key: string): RecordedCallReservation {
    const sequence = ++this.highest;
    this.options.onSequence?.(sequence);
    return { kind, key, sequence };
  }

  async recorded<T>(
    kind: string,
    key: string,
    identity: unknown,
    fn: (reservation: RecordedCallReservation) => Promise<T> | T,
    options: RecordedCallOptions<T> = {},
  ): Promise<T> {
    const reservation = this.reserve(kind, key);
    const cached = this.lookup(reservation, identity);
    if (cached.hit && (!options.validate || await options.validate(cached.value))) {
      const value = cached.value as T;
      await this.record(reservation, value, identity, options);
      return value;
    }
    await options.beforeLive?.(reservation);
    const value = await fn(reservation);
    await this.record(reservation, value, identity, options);
    return value;
  }

  lookup(reservation: RecordedCallReservation, identity: unknown) {
    const lookupOptions: JournalLookupOptions = {
      kind: reservation.kind,
      sequence: reservation.sequence,
      allowWorkflowSourceMismatch: this.options.resumeEditedWorkflow,
      allowSequenceKeyFallback: this.options.resumeEditedWorkflow,
    };
    return this.journal.lookup(reservation.key, identity, lookupOptions);
  }

  async record<T>(
    reservation: RecordedCallReservation,
    result: T,
    identity: unknown,
    options: Pick<RecordedCallOptions<T>, "tolerateRecordFailure" | "onRecordFailure"> = {},
  ): Promise<void> {
    const recordOptions: JournalRecordOptions = {
      kind: reservation.kind,
      sequence: reservation.sequence,
    };
    const recorded = await this.journal.record(reservation.key, result, identity, recordOptions);
    if (recorded.ok) return;
    options.onRecordFailure?.(recorded.error);
    if (!options.tolerateRecordFailure) {
      throw new Error(`Workflow journal write failed: ${recorded.error}`);
    }
  }
}

const FALLBACK_RECORDERS = new WeakMap<WorkflowJournal, WorkflowRecorder>();

/** Test/programmatic contexts created before the recorder field existed share one allocator per journal. */
export function recorderForJournal(
  journal: WorkflowJournal,
  options: WorkflowRecorderOptions = {},
): WorkflowRecorder {
  const existing = FALLBACK_RECORDERS.get(journal);
  if (existing) return existing;
  const created = new WorkflowRecorder(journal, options);
  FALLBACK_RECORDERS.set(journal, created);
  return created;
}

export interface WorkflowRecordedIdentity {
  readonly contract: "workflow-api-v1";
  readonly workflow: unknown;
  readonly call: unknown;
}

export function workflowRecordedIdentity(workflow: unknown, call: unknown): WorkflowRecordedIdentity {
  return { contract: "workflow-api-v1", workflow, call };
}

export function recordedIdentityHash(value: unknown): string {
  const canonical = canonicalizeIdentity(value);
  if (canonical.kind === "unverifiable") {
    throw new Error(`Recorded call identity is not safe to hash: ${canonical.reason}`);
  }
  return canonical.value;
}
