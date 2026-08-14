import assert from "node:assert/strict";
import test from "node:test";
import { Context } from "@deepseek-ai/cordis";
import { SANDBOX_UNAVAILABLE } from "@deepseek-ai/dsh-sandbox";
import { LocalSubprocessRuntime } from "@deepseek-ai/dsh-subprocess-local";
import { GitBashExecutor } from "../lib/index.js";

function createExecutor() {
  const ctx = new Context();
  ctx.provide("sandboxPolicy", {
    defaultMode: "danger-full-access",
    workspaceRoot: process.cwd(),
    resolve: () => ({
      mode: "danger-full-access",
      workspaceRoot: process.cwd(),
    }),
    overrideOf: () => undefined,
  });
  new LocalSubprocessRuntime(ctx);
  const executor = new GitBashExecutor(ctx, {
    timeoutMs: 10_000,
    maxTimeoutMs: 10_000,
    maxOutputBytes: 64_000,
    maxSpillBytes: 1024 * 1024,
    graceMs: 1_000,
  });
  return { ctx, executor };
}

test("runs foreground commands through the DSH subprocess seam", async () => {
  const { ctx, executor } = createExecutor();
  try {
    const result = await executor.run(executor.resolve({
      command: "printf '%s|%s|%s' \"$BASH_VERSION\" \"$MSYSTEM\" \"$BASH\"",
    }));

    assert.equal(result.exitCode, 0, result.stderr.text);
    assert.equal(result.signal, null);
    assert.equal(result.timedOut, false);
    assert.equal(result.aborted, false);
    assert.deepEqual(result.sandbox, {
      mode: "danger-full-access",
      denied: false,
    });
    assert.match(result.stdout.text, /^\d+\.\d+.*\|MINGW(?:32|64)\|.*\/bash$/);
  } finally {
    await ctx.fiber.dispose();
  }
});

test("runs background commands through Git Bash", async () => {
  const { ctx, executor } = createExecutor();
  try {
    const process = executor.start(executor.resolve({
      command: "printf '%s' \"$MSYSTEM\"",
    }));
    await process.done;
    const output = process.readOutput();

    assert.equal(process.status, "completed");
    assert.equal(process.exitCode, 0);
    assert.equal(process.signal, null);
    assert.match(output.delta, /^MINGW(?:32|64)$/);
  } finally {
    await ctx.fiber.dispose();
  }
});

test("fails closed before spawning under the Windows restricted-token sandbox", async () => {
  const ctx = new Context();
  ctx.provide("sandboxPolicy", {
    defaultMode: "workspace-write",
    workspaceRoot: process.cwd(),
    resolve: () => ({
      mode: "workspace-write",
      workspaceRoot: process.cwd(),
    }),
    overrideOf: () => undefined,
  });
  new LocalSubprocessRuntime(ctx);
  const executor = new GitBashExecutor(ctx, {
    timeoutMs: 10_000,
    maxTimeoutMs: 10_000,
    maxOutputBytes: 64_000,
    maxSpillBytes: 1024 * 1024,
    graceMs: 1_000,
  });

  try {
    const spec = executor.resolve({ command: "printf should-not-run" });
    await assert.rejects(
      executor.run(spec),
      (error) => {
        assert.equal(error?.code, SANDBOX_UNAVAILABLE);
        assert.match(error.message, /MSYS2 runtime requires a shared file mapping/);
        return true;
      },
    );
    assert.throws(
      () => executor.start(spec),
      (error) => {
        assert.equal(error?.code, SANDBOX_UNAVAILABLE);
        return true;
      },
    );
  } finally {
    await ctx.fiber.dispose();
  }
});
