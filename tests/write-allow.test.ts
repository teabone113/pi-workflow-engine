import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "bun:test";
import {
  compileWriteAllow,
  createWriteAllowExtension,
  findBashWriteViolation,
  toolWriteViolation,
} from "../.pi/extensions/pi-workflow-engine/src/write-allow.ts";

async function withWorkspace(run: (cwd: string) => Promise<void>): Promise<void> {
  const cwd = await mkdtemp(join(tmpdir(), "pi-workflow-write-allow-"));
  try {
    await mkdir(join(cwd, "src"), { recursive: true });
    await run(cwd);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

test("writeAllow glob checks edit/write paths and rejects traversal, outside paths, and symlink escapes", async () => {
  await withWorkspace(async (cwd) => {
    const outside = await mkdtemp(join(tmpdir(), "pi-workflow-write-outside-"));
    try {
      await symlink(outside, join(cwd, "src", "escape"));
      const policy = compileWriteAllow(cwd, ["src/**/*.ts", "generated/**"]);
      assert.equal(await toolWriteViolation({ toolName: "write", input: { path: "src/main.ts" } }, policy), undefined);
      assert.equal(await toolWriteViolation({ toolName: "edit", input: { path: join(cwd, "src", "nested", "main.ts") } }, policy), undefined);
      assert.match((await toolWriteViolation({ toolName: "write", input: { path: "README.md" } }, policy))?.reason ?? "", /outside the write allowlist/);
      assert.match((await toolWriteViolation({ toolName: "write", input: { path: "src/../README.ts" } }, policy))?.reason ?? "", /'\.\.' segment/);
      assert.match((await toolWriteViolation({ toolName: "write", input: { path: join(outside, "file.ts") } }, policy))?.reason ?? "", /outside workspace/);
      assert.match((await toolWriteViolation({ toolName: "write", input: { path: "src/escape/file.ts" } }, policy))?.reason ?? "", /symbolic link outside workspace/);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});

test("bash mutation scanning covers redirects, wrappers, transfers, removal, sed, dd, git, xargs, and cd", async () => {
  await withWorkspace(async (cwd) => {
    const policy = compileWriteAllow(cwd, ["src/**"]);
    const refused = [
      "printf x > README.md",
      "printf x | sudo tee README.md",
      "cp src/main.ts README.md",
      "mv src/main.ts README.md",
      "rm README.md",
      "install src/main.ts README.md",
      "sed -i s/a/b/ README.md",
      "dd if=src/main.ts of=README.md",
      "git clean -fd",
      "git checkout -- README.md",
      "printf README.md | xargs rm",
      "cd src && printf x > ../README.md",
    ];
    for (const command of refused) {
      assert.ok(await findBashWriteViolation(command, policy), `expected refusal for: ${command}`);
    }
    const allowed = [
      "printf x > src/out.ts",
      "printf x | tee src/out.ts",
      "cp README.md src/copied.ts",
      "sed -i s/a/b/ src/main.ts",
      "cd src && printf x > nested.ts",
      "git rm -- src/main.ts",
      "printf read-only",
    ];
    for (const command of allowed) {
      assert.equal(await findBashWriteViolation(command, policy), undefined, `expected allow for: ${command}`);
    }
  });
});

test("writeAllow extension blocks tool calls with a visible reason and progress log", async () => {
  await withWorkspace(async (cwd) => {
    let hook: ((event: { toolName: string; input: unknown }) => Promise<unknown>) | undefined;
    const logs: string[] = [];
    const extension = createWriteAllowExtension({
      workspaceRoot: cwd,
      patterns: ["src/**"],
      label: "writer",
      log: (message) => logs.push(message),
    });
    if (typeof extension === "function") throw new Error("expected named inline extension");
    extension.factory({
      on(event: string, handler: (event: { toolName: string; input: unknown }) => Promise<unknown>) {
        if (event === "tool_call") hook = handler;
      },
    } as never);
    assert.ok(hook);
    const blocked = await hook!({ toolName: "edit", input: { path: "README.md" } }) as { block: boolean; reason: string };
    assert.equal(blocked.block, true);
    assert.match(blocked.reason, /Tool refused/);
    assert.match(logs[0] ?? "", /tool refused/i);
    assert.equal(await hook!({ toolName: "edit", input: { path: "src/main.ts" } }), undefined);
  });
});
