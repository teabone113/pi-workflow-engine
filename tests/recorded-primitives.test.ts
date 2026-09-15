import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "bun:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { runWorkflow } from "../.pi/extensions/pi-workflow-engine/src/engine.ts";
import { WorkflowGatePauseError } from "../.pi/extensions/pi-workflow-engine/src/gate.ts";
import { WorkflowJournalSequenceError, loadJournalEntries, workflowJournalPath } from "../.pi/extensions/pi-workflow-engine/src/journal.ts";
import { WorkflowManualEffectResumeError } from "../.pi/extensions/pi-workflow-engine/src/run-step.ts";
import { ProjectWorkflowRunStore } from "../.pi/extensions/pi-workflow-engine/src/workflow-run-store.ts";
import type { LoadedWorkflow, WorkflowGateDecision } from "../.pi/extensions/pi-workflow-engine/src/types.ts";

function context(cwd: string, input: {
  readonly hasUI?: boolean;
  readonly select?: (title: string, choices: string[]) => Promise<string | undefined>;
  readonly input?: (title: string) => Promise<string | undefined>;
} = {}): ExtensionContext {
  return {
    cwd,
    mode: input.hasUI ? "rpc" : "print",
    hasUI: input.hasUI ?? false,
    model: undefined,
    modelRegistry: { find: () => undefined },
    signal: undefined,
    isIdle: () => true,
    sessionManager: {
      getSessionId: () => "recorded-primitives",
      getSessionFile: () => undefined,
      getEntries: () => [],
      getBranch: () => [],
    },
    ui: {
      select: input.select ?? (async () => undefined),
      input: input.input ?? (async () => undefined),
      notify() {},
      setWidget() {},
      setStatus() {},
      theme: { fg: (_name: string, value: string) => value, bold: (value: string) => value },
    },
  } as unknown as ExtensionContext;
}

function workflow(name: string, run: LoadedWorkflow["default"]): LoadedWorkflow {
  return {
    meta: { name, description: name },
    default: run,
    source: { kind: "fingerprint", fingerprint: `${name}-source` },
  };
}

test("recorded workflow primitives replay values, commands, and artifacts in strict sequence", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-workflow-recorded-"));
  const countPath = join(cwd, "count.txt");
  const mod = workflow("recorded-all", async (api) => ({
    now: await api.now(),
    random: await api.random(),
    uuid: await api.uuid(),
    command: await api.run("printf x >> count.txt; printf stdout; printf stderr >&2", { effect: "idempotent" }),
    artifact: await api.artifact("report.json", { ok: true, nested: [1, 2] }),
  }));
  try {
    const first = await runWorkflow(context(cwd), mod, "", { runId: "recorded-first" });
    const second = await runWorkflow(context(cwd), mod, "", {
      runId: "recorded-second",
      resumeFromRunId: "recorded-first",
    });
    const firstResult = first as Record<string, unknown>;
    const secondResult = second as Record<string, unknown>;
    assert.deepEqual(
      { now: secondResult.now, random: secondResult.random, uuid: secondResult.uuid, command: secondResult.command },
      { now: firstResult.now, random: firstResult.random, uuid: firstResult.uuid, command: firstResult.command },
    );
    assert.notEqual(
      (secondResult.artifact as { path: string }).path,
      (firstResult.artifact as { path: string }).path,
      "each resumed run materializes its own artifact",
    );
    assert.equal(await readFile(countPath, "utf8"), "x");

    const entries = await loadJournalEntries(workflowJournalPath(cwd, "recorded-first"));
    assert.deepEqual(entries.map((entry) => entry.version === 2 ? [entry.sequence, entry.kind] : []), [
      [1, "now"],
      [2, "random"],
      [3, "uuid"],
      [4, "run"],
      [5, "artifact"],
    ]);
    const record = await new ProjectWorkflowRunStore(cwd).load("recorded-second");
    assert.equal(record?.highestSequence, 5);
    assert.equal(record?.currentPhase, "Workflow");

    const artifact = (first as { artifact: { path: string } }).artifact;
    await writeFile(join(cwd, artifact.path), "tampered\n", "utf8");
    await assert.rejects(
      runWorkflow(context(cwd), mod, "", { runId: "recorded-tampered", resumeFromRunId: "recorded-first" }),
      /failed integrity validation/,
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("artifact names cannot traverse outside the durable run directory", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-workflow-artifact-path-"));
  const mod = workflow("artifact-path", async (api) => await api.artifact("../escape.txt", "no"));
  try {
    await assert.rejects(runWorkflow(context(cwd), mod, "", { runId: "artifact-path" }), /single non-empty file name/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("run steps honor environment, expected exits, timeouts, and bounded output", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-workflow-run-step-"));
  const mod = workflow("run-options", async (api) => ({
    env: await api.run('printf "$RECORDED_VALUE"', { effect: "idempotent", env: { RECORDED_VALUE: "present" } }),
    expected: await api.run("exit 3", { effect: "idempotent", expectExitCode: 3 }),
    timeout: await api.run("sleep 5", { effect: "idempotent", timeoutMs: 20 }),
    bounded: await api.run("head -c 60000 /dev/zero | tr '\\0' x", { effect: "idempotent" }),
  }));
  try {
    const result = await runWorkflow(context(cwd), mod, "", { runId: "run-options" }) as Record<string, { ok: boolean; stdout: string; timedOut: boolean }>;
    assert.equal(result.env?.stdout, "present");
    assert.equal(result.expected?.ok, true);
    assert.equal(result.timeout?.timedOut, true);
    assert.equal(Buffer.byteLength(result.bounded?.stdout ?? ""), 50 * 1024);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("strict resume fails on recorded sequence divergence while edited resume falls back by key", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-workflow-sequence-"));
  const mod = workflow("sequence", async (api) => {
    await api.now();
    return api.args === "uuid" ? await api.uuid() : await api.random();
  });
  try {
    await runWorkflow(context(cwd), mod, "uuid", { runId: "sequence-first" });
    await assert.rejects(
      runWorkflow(context(cwd), mod, "random", { runId: "sequence-strict", resumeFromRunId: "sequence-first" }),
      (error) => error instanceof WorkflowJournalSequenceError && /sequence 2/.test(error.message) && /expected random key/.test(error.message) && /found uuid key/.test(error.message),
    );
    const edited = await runWorkflow(context(cwd), mod, "random", {
      runId: "sequence-edited",
      resumeFromRunId: "sequence-first",
      resumeEditedWorkflow: true,
    });
    assert.equal(typeof edited, "number");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("a missing manual-effect run step refuses resume unless explicitly authorized", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-workflow-manual-effect-"));
  const effectPath = join(cwd, "manual.txt");
  const mod = workflow("manual-effect", async (api) => {
    await api.now();
    if (api.args === "effect") {
      return await api.run("printf effect >> manual.txt", { effect: "manual" });
    }
    return "seed";
  });
  try {
    await runWorkflow(context(cwd), mod, "seed", { runId: "manual-first" });
    await assert.rejects(
      runWorkflow(context(cwd), mod, "effect", { runId: "manual-refused", resumeFromRunId: "manual-first" }),
      WorkflowManualEffectResumeError,
    );
    await assert.rejects(readFile(effectPath, "utf8"));

    const result = await runWorkflow(context(cwd), mod, "effect", {
      runId: "manual-authorized",
      resumeFromRunId: "manual-first",
      resumeRerunEffects: true,
    });
    assert.equal(typeof result, "object");
    assert.equal(await readFile(effectPath, "utf8"), "effect");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("gate decisions are digest-bound, replayed, and cancellation pauses without approval", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-workflow-gate-"));
  let selects = 0;
  let lastDialog = "";
  const approving = context(cwd, {
    hasUI: true,
    select: async (title, choices) => {
      selects++;
      lastDialog = title;
      return choices[0];
    },
  });
  const mod = workflow("gate-live", async (api) => await api.gate("testbenches", {
    review: [api.args],
    context: "Review generated tests.",
  }));
  try {
    const first = await runWorkflow(approving, mod, "same review", { runId: "gate-first" }) as WorkflowGateDecision;
    const replay = await runWorkflow(approving, mod, "same review", {
      runId: "gate-replay",
      resumeFromRunId: "gate-first",
    }) as WorkflowGateDecision;
    assert.deepEqual(replay, first);
    assert.equal(selects, 1, "replayed gate must not ask again");
    assert.match(lastDialog, /Review generated tests\./);
    assert.match(lastDialog, /same review/);

    const changed = await runWorkflow(approving, mod, "changed review", {
      runId: "gate-changed",
      resumeFromRunId: "gate-first",
      resumeEditedWorkflow: true,
    }) as WorkflowGateDecision;
    assert.notEqual(changed.reviewedDigest, first.reviewedDigest);
    assert.equal(selects, 2, "changed review digest asks again");

    await assert.rejects(
      runWorkflow(context(cwd), mod, "headless review", { runId: "gate-paused" }),
      WorkflowGatePauseError,
    );
    const paused = await new ProjectWorkflowRunStore(cwd).load("gate-paused");
    assert.equal(paused?.state, "paused");
    assert.equal(paused?.state === "paused" ? paused.reason : undefined, "gate:testbenches");
    assert.equal(paused?.state === "paused" ? paused.gate?.name : undefined, "testbenches");
    assert.match(paused?.state === "paused" ? paused.message : "", /\/workflow:answer gate-paused/);
    const persistedPause = await readFile(join(cwd, ".pi", ".workflow-runs", "gate-paused.run.json"), "utf8");
    assert.doesNotMatch(persistedPause, /Review generated tests\./, "gate context is displayed live but not persisted");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
