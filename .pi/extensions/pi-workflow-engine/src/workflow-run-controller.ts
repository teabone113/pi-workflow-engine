import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { BackgroundWorkflowCoordinator } from "./background-workflows.ts";
import { backgroundUnavailableResult, startBackgroundWorkflowTool } from "./background-workflow-tool.ts";
import {
  createMemoryBackedJournal,
  loadJournalEntries,
  validateWorkflowRunId,
  workflowJournalPath,
  type JournalEntryV2,
} from "./journal.ts";
import { resolveWorkflowRunOptions, type ResolvedWorkflowRunOptions } from "./options.ts";
import type { LoadedWorkflow } from "./types.ts";
import {
  availableWorkflowRunActions,
  canRelaunchWorkflowRun,
  formatWorkflowRunDetails,
  formatWorkflowRunHistory,
  formatWorkflowRunSummary,
  isWorkflowRunLifecycleAction,
  parseWorkflowRunsCommand,
  retainedWorkflowRunOutcome,
  WORKFLOW_RUN_ACTIONS,
  WORKFLOW_RUN_HISTORY_LIMIT,
  type WorkflowRunLifecycleAction,
} from "./workflow-run-history.ts";
import { transitionWorkflowRun, type WorkflowRunRecord } from "./workflow-run-record.ts";
import { ProjectWorkflowRunStore, type WorkflowRunStore } from "./workflow-run-store.ts";
import { unknownErrorMessage } from "./unknown-error.ts";
import { emptyWorkflowUsageTotals } from "./usage.ts";
import { commandGateDecision } from "./gate.ts";
import {
  WorkflowUsageLimitScheduler,
  type WorkflowUsageLimitSchedulerClock,
} from "./workflow-usage-limit-scheduler.ts";
import { WorkflowInspector } from "./ui/workflow-inspector.ts";
import { WORKFLOW_VIEWER_OVERLAY_OPTIONS } from "./ui/workflow-viewer-layout.ts";
import { completeCurrentArgument, splitArgumentPrefix } from "./command-completions.ts";

type WorkflowRunCompletionContext = Pick<ExtensionContext, "cwd" | "sessionManager">;

interface WorkflowRunControllerDependencies {
  readonly resolveWorkflow: (name: string) => Promise<LoadedWorkflow | undefined>;
  readonly execute: (
    ctx: ExtensionContext,
    name: string,
    workflow: LoadedWorkflow,
    options: ResolvedWorkflowRunOptions,
  ) => Promise<void>;
  readonly storeForCwd?: (cwd: string) => WorkflowRunStore;
  readonly schedulerClock?: WorkflowUsageLimitSchedulerClock;
  readonly log?: (message: string) => void;
}

export class WorkflowRunController {
  private readonly storeForCwd: (cwd: string) => WorkflowRunStore;
  private readonly usageLimitScheduler: WorkflowUsageLimitScheduler;
  private readonly log: (message: string) => void;
  private completionContext: WorkflowRunCompletionContext | undefined;

  constructor(
    private readonly background: BackgroundWorkflowCoordinator,
    private readonly dependencies: WorkflowRunControllerDependencies,
  ) {
    this.storeForCwd = dependencies.storeForCwd ?? ((cwd) => new ProjectWorkflowRunStore(cwd));
    this.log = dependencies.log ?? ((message) => process.stderr.write(`${message}\n`));
    this.usageLimitScheduler = new WorkflowUsageLimitScheduler(
      (ctx, runId, attempt) => this.autoResume(ctx, runId, attempt),
      dependencies.schedulerClock,
      dependencies.log,
    );
  }

  async runSettled(ctx: ExtensionContext, runId: string): Promise<void> {
    const record = await this.loadRecord(ctx.cwd, runId);
    if (record && canRelaunchWorkflowRun(record)) this.usageLimitScheduler.arm(ctx, record);
  }

  async sessionStarted(ctx: ExtensionContext): Promise<void> {
    this.completionContext = { cwd: ctx.cwd, sessionManager: ctx.sessionManager };
    this.usageLimitScheduler.activateSession(ctx);
    try {
      for (const record of await this.storeForCwd(ctx.cwd).list()) {
        if (canRelaunchWorkflowRun(record)) this.usageLimitScheduler.arm(ctx, record);
      }
    } catch (error) {
      this.log(`[workflow] provider-limit recovery could not load run history: ${unknownErrorMessage(error)}`);
    }
  }

  sessionShutdown(ctx: Pick<ExtensionContext, "sessionManager">): void {
    this.usageLimitScheduler.cancelSession(ctx);
    this.completionContext = undefined;
  }

  async handleCommand(args: string, ctx: ExtensionCommandContext): Promise<void> {
    const command = parseWorkflowRunsCommand(args);
    if (command.kind === "error") {
      ctx.ui.notify(command.message, "warning");
      return;
    }
    if (command.kind === "action") {
      await this.perform(command.action, command.runId, ctx);
      return;
    }
    if (!ctx.hasUI) {
      const records = await this.listRecent(ctx.cwd);
      ctx.ui.notify(formatWorkflowRunHistory(records, this.background.activeRunIds(ctx)), "info");
      return;
    }
    await this.openRunSelector(ctx);
  }

  async resumeCommand(args: string, ctx: ExtensionCommandContext): Promise<void> {
    const parts = args.trim().split(/\s+/).filter(Boolean);
    const runId = parts.shift();
    const allowedFlags = new Set(["--resume-edited", "--resume-rerun-effects"]);
    if (!runId || parts.some((part) => !allowedFlags.has(part))) {
      ctx.ui.notify("Usage: /workflow:resume <run-id> [--resume-edited] [--resume-rerun-effects]", "warning");
      return;
    }
    const record = await this.loadRecord(ctx.cwd, runId);
    if (!record) {
      ctx.ui.notify(`Workflow run ${runId} was not found.`, "warning");
      return;
    }
    if (record.state !== "paused" || !canRelaunchWorkflowRun(record)) {
      ctx.ui.notify(`Workflow run ${runId} is not a resumable paused registered workflow.`, "warning");
      return;
    }
    try {
      const message = await this.relaunch(ctx, record, "resume", {
        resumeEditedWorkflow: parts.includes("--resume-edited") ? true : undefined,
        resumeRerunEffects: parts.includes("--resume-rerun-effects") ? true : undefined,
      });
      ctx.ui.notify(message, "info");
    } catch (error) {
      ctx.ui.notify(`Workflow resume failed: ${unknownErrorMessage(error)}`, "error");
    }
  }

  async answerCommand(args: string, ctx: ExtensionCommandContext): Promise<void> {
    const match = /^(\S+)\s+(\S+)(?:\s+([\s\S]*))?$/.exec(args.trim());
    if (!match) {
      ctx.ui.notify("Usage: /workflow:answer <run-id> <choice> [text]", "warning");
      return;
    }
    const [, runId, choice, text] = match;
    const record = await this.loadRecord(ctx.cwd, runId!);
    if (record?.state !== "paused" || !record.gate) {
      ctx.ui.notify(`Workflow run ${runId} is not paused at an owner gate.`, "warning");
      return;
    }
    let recorded = false;
    try {
      const decision = commandGateDecision(record.gate, choice!, text);
      await this.recordGateAnswer(ctx.cwd, record, decision);
      recorded = true;
      const message = await this.relaunch(ctx, record, "resume");
      ctx.ui.notify(`Gate "${record.gate.name}" decision "${decision.choice}" recorded for review digest ${decision.reviewedDigest}. ${message}`, "info");
    } catch (error) {
      ctx.ui.notify(
        recorded
          ? `Gate decision was recorded, but workflow resume failed: ${unknownErrorMessage(error)}`
          : `Workflow answer failed: ${unknownErrorMessage(error)}`,
        "error",
      );
    }
  }

  async inspectStoredRun(ctx: ExtensionContext, runId: string): Promise<boolean> {
    const record = await this.loadRecord(ctx.cwd, runId);
    if (!record) return false;
    await this.inspect(record, ctx);
    return true;
  }

  private async openRunSelector(ctx: ExtensionCommandContext): Promise<void> {
    while (true) {
      const records = await this.listRecent(ctx.cwd);
      const active = this.background.activeRunIds(ctx);
      if (records.length === 0) {
        ctx.ui.notify(formatWorkflowRunHistory(records, active), "info");
        return;
      }
      const options = records.map((record) =>
        formatWorkflowRunSummary(record, active.has(record.runId))
      );
      const selected = await ctx.ui.select("Workflow Runs", options);
      if (!selected) return;
      const selectedIndex = options.indexOf(selected);
      const selectedRecord = records[selectedIndex];
      const record = selectedRecord && await this.loadRecord(ctx.cwd, selectedRecord.runId);
      if (!record) {
        ctx.ui.notify("The selected workflow run is no longer available.", "warning");
        continue;
      }
      const actions = availableWorkflowRunActions(record, active.has(record.runId));
      const selectedAction = await ctx.ui.select(
        `${record.workflow.name} · ${record.runId}`,
        [...actions],
      );
      const action = actions.find((candidate) => candidate === selectedAction);
      if (!action) continue;
      if (action === "inspect") await this.inspect(record, ctx);
      else await this.perform(action, record.runId, ctx);
    }
  }

  private async inspect(record: WorkflowRunRecord, ctx: ExtensionContext): Promise<void> {
    if (!ctx.hasUI || ctx.mode !== "tui") {
      ctx.ui.notify(
        formatWorkflowRunDetails(record, this.background.activeRunIds(ctx).has(record.runId)),
        "info",
      );
      return;
    }
    await ctx.ui.custom<void>(
      (tui, theme, _keybindings, done) => new WorkflowInspector(
        () => record.progress,
        tui,
        theme,
        () => done(undefined),
        { label: `${record.state.toUpperCase()} outcome`, text: retainedWorkflowRunOutcome(record) },
      ),
      WORKFLOW_VIEWER_OVERLAY_OPTIONS,
    );
  }

  private async perform(
    action: WorkflowRunLifecycleAction,
    runId: string,
    ctx: ExtensionContext,
  ): Promise<void> {
    const record = await this.loadRecord(ctx.cwd, runId);
    if (!record) {
      ctx.ui.notify(`Workflow run ${runId} was not found.`, "warning");
      return;
    }
    if (action === "inspect") {
      await this.inspect(record, ctx);
      return;
    }
    const available = availableWorkflowRunActions(
      record,
      this.background.activeRunIds(ctx).has(record.runId),
    );
    if (!available.includes(action)) {
      ctx.ui.notify(`Action ${action} is not available for ${record.state} run ${runId}.`, "warning");
      return;
    }

    try {
      if (action === "stop") {
        if (record.state === "paused") {
          this.usageLimitScheduler.cancel(runId);
          const stopped = transitionWorkflowRun(record, {
            state: "stopped",
            progress: record.progress,
            usage: record.usage ?? record.progress.usage ?? {
              agents: [],
              totals: emptyWorkflowUsageTotals(),
              assistantMessages: 0,
            },
            error: new Error("Workflow stopped by user."),
          });
          await this.storeForCwd(ctx.cwd).save(stopped);
          await this.background.durableRunSettled(ctx, runId);
          ctx.ui.notify(`Workflow run ${runId} is now stopped.`, "info");
          return;
        }
        const stopped = await this.background.stop(ctx, runId);
        ctx.ui.notify(`Workflow run ${runId} is now ${stopped.state}.`, "info");
        return;
      }
      this.usageLimitScheduler.cancel(runId);
      const message = await this.relaunch(ctx, record, action);
      ctx.ui.notify(message, "info");
    } catch (error) {
      ctx.ui.notify(`Workflow ${action} failed: ${unknownErrorMessage(error)}`, "error");
    }
  }

  private async relaunch(
    ctx: ExtensionContext,
    record: WorkflowRunRecord,
    action: "resume" | "restart",
    overrides: { readonly resumeEditedWorkflow?: boolean; readonly resumeRerunEffects?: boolean } = {},
  ): Promise<string> {
    const unavailable = backgroundUnavailableResult(ctx.mode);
    if (unavailable) {
      const first = unavailable.content[0];
      throw new Error(first?.type === "text" ? first.text : "background workflows are unavailable");
    }
    const workflow = await this.dependencies.resolveWorkflow(record.workflow.name);
    if (!workflow) throw new Error(`registered workflow ${record.workflow.name} is unavailable`);
    if (workflow.source.kind !== "file") {
      throw new Error(`registered workflow ${record.workflow.name} no longer has verifiable file provenance`);
    }
    if (
      action === "resume"
      && workflow.source.fingerprint !== record.workflow.sourceFingerprint
      && !(overrides.resumeEditedWorkflow ?? record.options.resumeEditedWorkflow)
    ) {
      throw new Error("workflow source changed, so journal replay cannot resume safely");
    }
    const options = resolveWorkflowRunOptions({
      inspect: false,
      perf: record.options.perf,
      concurrency: record.options.concurrency,
      parallelSubmissionLimit: record.options.parallelSubmissionLimit ?? undefined,
      maxAgents: record.options.maxAgents,
      agentTimeoutMs: record.options.agentTimeoutMs,
      agentRetries: record.options.agentRetries,
      autoResumeOnUsageLimit: record.options.autoResumeOnUsageLimit,
      usageLimitMaxAttempts: record.options.usageLimitMaxAttempts,
      usageLimitMaxDelayMs: record.options.usageLimitMaxDelayMs,
      usageLimitAttempt: action === "resume"
        ? (record.state === "paused" ? record.pause?.attempt : undefined) ?? record.options.usageLimitAttempt
        : 0,
      budget: record.options.budget ?? undefined,
      resultViewer: "skip",
      resumeFromRunId: action === "resume" ? record.runId : undefined,
      resumeEditedWorkflow: action === "resume"
        ? overrides.resumeEditedWorkflow ?? record.options.resumeEditedWorkflow
        : false,
      resumeRerunEffects: action === "resume"
        ? overrides.resumeRerunEffects ?? record.options.resumeRerunEffects
        : false,
    });
    const result = await startBackgroundWorkflowTool({
      coordinator: this.background,
      ctx,
      name: workflow.meta.name,
      options,
      execute: (backgroundCtx, backgroundOptions) =>
        this.dependencies.execute(backgroundCtx, workflow.meta.name, workflow, backgroundOptions),
    });
    const first = result.content[0];
    const message = first?.type === "text" ? first.text : `Workflow ${action} started.`;
    if (typeof result.details.error === "string") throw new Error(message);
    return message;
  }

  private async recordGateAnswer(
    cwd: string,
    record: Extract<WorkflowRunRecord, { readonly state: "paused" }>,
    decision: ReturnType<typeof commandGateDecision>,
  ): Promise<void> {
    const gate = record.gate;
    if (!gate) throw new Error(`Workflow run ${record.runId} has no pending gate.`);
    const path = workflowJournalPath(cwd, record.runId);
    const entries = await loadJournalEntries(path, { required: true });
    const existing = entries.filter((entry): entry is JournalEntryV2 =>
      entry.version === 2 &&
      (entry.kind ?? "agent") === "gate" &&
      entry.sequence === gate.sequence &&
      entry.key === gate.key
    );
    if (existing.length > 0) {
      const same = existing.some((entry) => {
        if (typeof entry.result !== "object" || entry.result === null) return false;
        const prior = entry.result as Record<string, unknown>;
        return prior.choice === decision.choice && prior.text === decision.text && prior.reviewedDigest === decision.reviewedDigest;
      });
      if (same) return;
      throw new Error(`Gate ${gate.name} already has a different recorded decision.`);
    }
    const journal = createMemoryBackedJournal([], path, false);
    const recorded = await journal.record(gate.key, decision, gate.identity, {
      kind: "gate",
      sequence: gate.sequence,
    });
    if (!recorded.ok) throw new Error(`Could not record gate decision: ${recorded.error}`);
  }

  private async autoResume(ctx: ExtensionContext, runId: string, attempt: number): Promise<void> {
    const record = await this.loadRecord(ctx.cwd, runId);
    if (
      record?.state !== "paused"
      || record.pause?.kind !== "provider_usage_limit"
      || !record.pause.autoResume
      || record.pause.attempt !== attempt
      || !canRelaunchWorkflowRun(record)
    ) {
      return;
    }
    const message = await this.relaunch(ctx, record, "resume");
    ctx.ui.notify(message, "info");
  }

  private async loadRecord(cwd: string, runId: string): Promise<WorkflowRunRecord | undefined> {
    try {
      validateWorkflowRunId(runId);
    } catch {
      return undefined;
    }
    return await this.storeForCwd(cwd).load(runId);
  }

  private async listRecent(cwd: string): Promise<WorkflowRunRecord[]> {
    const records = await this.storeForCwd(cwd).list();
    return records
      .sort((left, right) => right.createdAt - left.createdAt)
      .slice(0, WORKFLOW_RUN_HISTORY_LIMIT);
  }

  async argumentCompletions(argumentPrefix: string): Promise<AutocompleteItem[] | null> {
    const ctx = this.completionContext;
    const parts = splitArgumentPrefix(argumentPrefix);
    if (parts.completed.length === 0) {
      return completeCurrentArgument(argumentPrefix, WORKFLOW_RUN_ACTIONS);
    }
    if (parts.completed.length !== 1 || !ctx) return null;
    const action = parts.completed[0];
    if (!action || !isWorkflowRunLifecycleAction(action)) return null;
    const records = await this.listRecent(ctx.cwd);
    const active = this.background.activeRunIds(ctx);
    return completeCurrentArgument(
      argumentPrefix,
      records
        .filter((record) => availableWorkflowRunActions(record, active.has(record.runId)).includes(action))
        .map((record) => ({
          value: record.runId,
          description: `${record.state} · ${record.workflow.name}`,
        })),
    );
  }

  async inspectorArgumentCompletions(argumentPrefix: string): Promise<AutocompleteItem[] | null> {
    const ctx = this.completionContext;
    const parts = splitArgumentPrefix(argumentPrefix);
    if (parts.completed.length > 0) return null;
    const records = ctx ? await this.listRecent(ctx.cwd) : [];
    return completeCurrentArgument(argumentPrefix, [
      { value: "last", description: "Inspect the current or most recent in-session workflow" },
      ...records.map((record) => ({
        value: record.runId,
        description: `${record.state} · ${record.workflow.name}`,
      })),
    ]);
  }
}

export function registerWorkflowRunCommand(
  pi: Pick<ExtensionAPI, "registerCommand">,
  controller: WorkflowRunController,
): void {
  pi.registerCommand("workflow:runs", {
    description: "List, inspect, stop, resume, or restart durable workflow runs",
    getArgumentCompletions: (argumentPrefix) => controller.argumentCompletions(argumentPrefix),
    handler: (args, ctx) => controller.handleCommand(args, ctx),
  });
  pi.registerCommand("workflow:resume", {
    description: "Resume a paused durable workflow run from its journal",
    handler: (args, ctx) => controller.resumeCommand(args, ctx),
  });
  pi.registerCommand("workflow:answer", {
    description: "Answer an owner gate and resume its durable workflow run",
    handler: (args, ctx) => controller.answerCommand(args, ctx),
  });
}
