import { createHash } from "node:crypto";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { WorkflowPauseError } from "./cancellation.ts";
import { canonicalizeIdentity } from "./identity-canonicalization.ts";
import type { RecordedCallReservation } from "./recorded.ts";
import type {
  WorkflowArtifact,
  WorkflowGateDecision,
  WorkflowGateOptions,
} from "./types.ts";
import { isWorkflowArtifact } from "./artifact.ts";

export const DEFAULT_GATE_CHOICES = ["approve", "reject"] as const;
const GATE_REVIEW_PREVIEW_ITEM_LIMIT = 16;
const GATE_REVIEW_PREVIEW_BYTES = 8 * 1024;
const GATE_ITEM_PREVIEW_BYTES = 1_500;

export interface PreparedWorkflowGate<C extends readonly string[] = readonly string[]> {
  readonly name: string;
  readonly namespace?: string;
  readonly reviewedDigest: string;
  readonly choices: C;
  readonly textPrompt?: string;
  readonly context?: string;
  readonly timeoutMs?: number;
  readonly review: readonly (WorkflowArtifact | string)[];
  readonly key: string;
  readonly identity: unknown;
}

export interface WorkflowGatePauseData {
  readonly kind: "gate";
  readonly reason: string;
  readonly name: string;
  readonly reviewedDigest: string;
  readonly sequence: number;
  readonly key: string;
  readonly identity: unknown;
  readonly choices: readonly string[];
  readonly textPrompt?: string;
}

export class WorkflowGatePauseError extends WorkflowPauseError {
  override readonly name = "WorkflowGatePauseError";

  constructor(
    readonly runId: string,
    readonly gate: WorkflowGatePauseData,
  ) {
    super(formatGatePauseMessage(runId, gate));
  }
}

export function prepareWorkflowGate<C extends readonly string[]>(
  namespace: string | undefined,
  name: string,
  opts: WorkflowGateOptions<C>,
): PreparedWorkflowGate<C> {
  const normalizedName = name.trim();
  if (!normalizedName || normalizedName.length > 128 || /[\r\n]/.test(normalizedName)) {
    throw new Error("gate() name must be a non-empty single-line string of at most 128 characters");
  }
  if (!opts || !Array.isArray(opts.review) || opts.review.length === 0) {
    throw new Error("gate() review must contain at least one artifact or text item");
  }
  const review = opts.review.map((item, index) => {
    if (typeof item === "string" || isWorkflowArtifact(item)) return item;
    throw new Error(`gate() review item ${index + 1} must be artifact metadata or text`);
  });
  const choices = normalizeChoices(opts.choices ?? DEFAULT_GATE_CHOICES) as unknown as C;
  const textPrompt = opts.text?.prompt.trim();
  if (opts.text !== undefined && (!textPrompt || textPrompt.length > 512)) {
    throw new Error("gate() text.prompt must be non-empty and at most 512 characters");
  }
  const context = opts.context?.trim();
  if (opts.context !== undefined && (!context || context.length > 4_096)) {
    throw new Error("gate() context must be non-empty and at most 4096 characters");
  }
  const timeoutMs = normalizeTimeout(opts.timeoutMs);
  const reviewedDigest = digestReview(review);
  const gateIdentity = {
    name: normalizedName,
    ...(namespace === undefined ? {} : { namespace }),
    reviewedDigest,
    choices,
    ...(textPrompt === undefined ? {} : { textPrompt }),
    ...(context === undefined ? {} : { contextDigest: sha256Canonical(context) }),
  };
  const key = `gate:${sha256Canonical({ name: normalizedName, namespace })}`;
  return {
    name: normalizedName,
    namespace,
    reviewedDigest,
    choices,
    textPrompt,
    context,
    timeoutMs,
    review,
    key,
    identity: gateIdentity,
  };
}

export async function requestGateDecision<C extends readonly string[]>(
  host: Pick<ExtensionContext, "hasUI" | "ui" | "signal"> | undefined,
  gate: PreparedWorkflowGate<C>,
): Promise<WorkflowGateDecision<C[number]> | undefined> {
  if (!host?.hasUI) return undefined;
  const dialogController = gate.timeoutMs === undefined && !host.signal ? undefined : new AbortController();
  const onHostAbort = () => dialogController?.abort();
  host.signal?.addEventListener("abort", onHostAbort, { once: true });
  const timer = gate.timeoutMs === undefined
    ? undefined
    : setTimeout(() => dialogController?.abort(), gate.timeoutMs);
  try {
    const choice = await host.ui.select(
      gateDialogTitle(gate),
      [...gate.choices],
      dialogController ? { signal: dialogController.signal } : undefined,
    );
    if (choice === undefined || !gate.choices.includes(choice)) return undefined;
    let text: string | undefined;
    if (gate.textPrompt !== undefined) {
      text = await host.ui.input(
        gate.textPrompt,
        undefined,
        dialogController ? { signal: dialogController.signal } : undefined,
      );
      if (text === undefined) return undefined;
      validateDecisionText(text);
    }
    return {
      choice: choice as C[number],
      ...(text === undefined ? {} : { text }),
      reviewedDigest: gate.reviewedDigest,
      decidedAt: Date.now(),
      by: "ui",
    };
  } catch (error) {
    if (dialogController?.signal.aborted) return undefined;
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
    host.signal?.removeEventListener("abort", onHostAbort);
  }
}

export function gatePauseData(
  gate: PreparedWorkflowGate,
  reservation: RecordedCallReservation,
  recordedIdentity: unknown = gate.identity,
): WorkflowGatePauseData {
  return {
    kind: "gate",
    reason: `gate:${gate.name}`,
    name: gate.name,
    reviewedDigest: gate.reviewedDigest,
    sequence: reservation.sequence,
    key: reservation.key,
    identity: recordedIdentity,
    choices: [...gate.choices],
    textPrompt: gate.textPrompt,
  };
}

export function commandGateDecision(
  pause: WorkflowGatePauseData,
  choice: string,
  text: string | undefined,
): WorkflowGateDecision<string> {
  if (!pause.choices.includes(choice)) {
    throw new Error(`Invalid choice "${choice}" for gate ${pause.name}. Choices: ${pause.choices.join(", ")}`);
  }
  if (pause.textPrompt !== undefined && text === undefined) {
    throw new Error(`Gate ${pause.name} requires text after the choice: ${pause.textPrompt}`);
  }
  if (text !== undefined) validateDecisionText(text);
  return {
    choice,
    ...(text === undefined ? {} : { text }),
    reviewedDigest: pause.reviewedDigest,
    decidedAt: Date.now(),
    by: "command",
  };
}

export function isGateDecision<C extends readonly string[]>(
  value: unknown,
  gate: Pick<PreparedWorkflowGate<C>, "choices" | "reviewedDigest">,
): value is WorkflowGateDecision<C[number]> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const decision = value as Record<string, unknown>;
  return (
    typeof decision.choice === "string" && gate.choices.includes(decision.choice) &&
    (decision.text === undefined || (typeof decision.text === "string" && Buffer.byteLength(decision.text, "utf8") <= 4_096)) &&
    decision.reviewedDigest === gate.reviewedDigest &&
    typeof decision.decidedAt === "number" && Number.isFinite(decision.decidedAt) &&
    (decision.by === "ui" || decision.by === "command")
  );
}

export function isWorkflowGatePauseData(value: unknown): value is WorkflowGatePauseData {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const pause = value as Record<string, unknown>;
  return (
    pause.kind === "gate" &&
    typeof pause.reason === "string" &&
    typeof pause.name === "string" &&
    typeof pause.reviewedDigest === "string" && /^[0-9a-f]{64}$/.test(pause.reviewedDigest) &&
    Number.isSafeInteger(pause.sequence) && Number(pause.sequence) > 0 &&
    typeof pause.key === "string" &&
    "identity" in pause &&
    Array.isArray(pause.choices) && pause.choices.length >= 2 && pause.choices.every((choice) => typeof choice === "string") &&
    (pause.textPrompt === undefined || typeof pause.textPrompt === "string")
  );
}

export function formatGatePauseMessage(runId: string, gate: Pick<WorkflowGatePauseData, "name" | "reviewedDigest" | "choices" | "textPrompt" | "sequence">): string {
  const text = gate.textPrompt ? ` Text is required: ${gate.textPrompt}` : "";
  return `Workflow paused at owner gate "${gate.name}" at recorded sequence ${gate.sequence} (review digest ${gate.reviewedDigest}). Waiting for one of: ${gate.choices.join(", ")}.${text} Answer with: /workflow:answer ${runId} <choice>${gate.textPrompt ? " <text>" : " [text]"}`;
}

function digestReview(review: readonly (WorkflowArtifact | string)[]): string {
  return sha256Canonical(review.map((item) => typeof item === "string"
    ? { type: "text", text: item }
    : { type: "artifact", name: item.name, sha256: item.sha256, bytes: item.bytes }));
}

function gateDialogTitle(gate: PreparedWorkflowGate): string {
  const lines = [`Owner gate: ${gate.name}`];
  if (gate.context) lines.push("", gate.context);
  lines.push("", `Review digest: ${gate.reviewedDigest}`, "", "Review:");
  let bytes = Buffer.byteLength(lines.join("\n"));
  for (const item of gate.review.slice(0, GATE_REVIEW_PREVIEW_ITEM_LIMIT)) {
    const preview = typeof item === "string"
      ? boundedText(item, GATE_ITEM_PREVIEW_BYTES)
      : `${item.name}: ${item.path} (${item.bytes} bytes, sha256 ${item.sha256})`;
    const next = `- ${preview}`;
    if (bytes + Buffer.byteLength(next) > GATE_REVIEW_PREVIEW_BYTES) {
      lines.push("- … review preview truncated …");
      break;
    }
    lines.push(next);
    bytes += Buffer.byteLength(next);
  }
  if (gate.review.length > GATE_REVIEW_PREVIEW_ITEM_LIMIT) {
    lines.push(`- … ${gate.review.length - GATE_REVIEW_PREVIEW_ITEM_LIMIT} more item(s) …`);
  }
  if (gate.textPrompt) lines.push("", `After choosing, enter: ${gate.textPrompt}`);
  lines.push("", "Choose explicitly; Escape pauses without deciding.");
  return lines.join("\n");
}

function normalizeChoices(value: readonly string[]): readonly string[] {
  if (!Array.isArray(value) || value.length < 2 || value.length > 20) {
    throw new Error("gate() choices must contain between 2 and 20 values");
  }
  const choices = value.map((choice) => {
    if (typeof choice !== "string" || !/^[^\s\r\n]{1,64}$/.test(choice)) {
      throw new Error("gate() choices must be non-empty single-token strings of at most 64 characters");
    }
    return choice;
  });
  if (new Set(choices).size !== choices.length) throw new Error("gate() choices must be unique");
  return choices;
}

function validateDecisionText(value: string): void {
  if (Buffer.byteLength(value, "utf8") > 4_096) {
    throw new Error("gate() decision text must be at most 4096 UTF-8 bytes");
  }
}

function normalizeTimeout(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value < 1 || value > 86_400_000) {
    throw new Error("gate() timeoutMs must be an integer between 1 and 86400000");
  }
  return value;
}

function sha256Canonical(value: unknown): string {
  const canonical = canonicalizeIdentity(value);
  if (canonical.kind === "unverifiable") throw new Error(`gate() review could not be canonicalized: ${canonical.reason}`);
  return createHash("sha256").update(canonical.value).digest("hex");
}

function boundedText(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value) <= maxBytes) return value;
  let end = Math.min(value.length, maxBytes);
  while (end > 0 && Buffer.byteLength(value.slice(0, end)) > maxBytes - 3) end--;
  return `${value.slice(0, end)}…`;
}
