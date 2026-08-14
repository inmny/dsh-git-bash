import assert from "node:assert/strict";
import { existsSync, rmSync } from "node:fs";
import test from "node:test";
import { Context } from "@deepseek-ai/cordis";
import { LocalSandboxProvider } from "@deepseek-ai/dsh-sandbox-local";
import { LocalSubprocessRuntime } from "@deepseek-ai/dsh-subprocess-local";
import { GitBashExecutor } from "../lib/index.js";

const CAN_RUN_NATIVE_GUARD = process.platform === "win32" && process.arch === "x64";

function createExecutor(mode = "danger-full-access") {
  const ctx = new Context();
  const workspaceRoot = process.cwd();
  ctx.provide("sandboxPolicy", {
    defaultMode: mode,
    workspaceRoot,
    resolve: () => ({ mode, workspaceRoot }),
    overrideOf: () => undefined,
  });
  new LocalSubprocessRuntime(ctx);
  new LocalSandboxProvider(ctx, {
    runnerCommand: [],
    runnerFailureSignatures: [],
    probeTimeoutMs: 10_000,
  });
  const executor = new GitBashExecutor(ctx, {
    timeoutMs: 15_000,
    maxTimeoutMs: 15_000,
    maxOutputBytes: 64_000,
    maxSpillBytes: 1024 * 1024,
    graceMs: 1_000,
  });
  return { ctx, executor };
}

async function dispose(ctx) {
  await ctx.fiber.dispose();
}

test("runs foreground commands directly in danger-full-access", async () => {
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
    await dispose(ctx);
  }
});

test("runs background commands directly through Git Bash", async () => {
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
    await dispose(ctx);
  }
});

test("runs Git Bash and nested MSYS children under read-only", { skip: !CAN_RUN_NATIVE_GUARD }, async () => {
  const { ctx, executor } = createExecutor("read-only");
  try {
    const result = await executor.run(executor.resolve({
      command: "printf 'root|'; bash --noprofile --norc -c 'printf nested'; printf '|'; git --version",
    }));

    assert.equal(result.exitCode, 0, result.stderr.text);
    assert.match(result.stdout.text, /^root\|nested\|git version /);
    assert.deepEqual(result.sandbox, {
      mode: "read-only",
      denied: false,
      enforcement: "partial",
    });
  } finally {
    await dispose(ctx);
  }
});

test("read-only denies workspace writes", { skip: !CAN_RUN_NATIVE_GUARD }, async () => {
  const probe = ".dsh-git-bash-read-only-probe.txt";
  rmSync(probe, { force: true });
  const { ctx, executor } = createExecutor("read-only");
  try {
    const result = await executor.run(executor.resolve({
      command: "printf blocked > " + probe,
    }));

    assert.notEqual(result.exitCode, 0);
    assert.match(result.stderr.text, /permission denied/i);
    assert.equal(existsSync(probe), false);
    assert.deepEqual(result.sandbox, {
      mode: "read-only",
      denied: true,
      enforcement: "partial",
    });
  } finally {
    rmSync(probe, { force: true });
    await dispose(ctx);
  }
});

test("workspace-write allows workspace writes and denies sibling writes", { skip: !CAN_RUN_NATIVE_GUARD }, async () => {
  const inside = ".dsh-git-bash-workspace-probe.txt";
  const outside = "../.dsh-git-bash-outside-probe.txt";
  rmSync(inside, { force: true });
  rmSync(outside, { force: true });
  const { ctx, executor } = createExecutor("workspace-write");
  try {
    const allowed = await executor.run(executor.resolve({
      command: "printf allowed > " + inside + " && cat " + inside,
    }));
    assert.equal(allowed.exitCode, 0, allowed.stderr.text);
    assert.equal(allowed.stdout.text, "allowed");
    assert.equal(existsSync(inside), true);
    assert.deepEqual(allowed.sandbox, {
      mode: "workspace-write",
      denied: false,
      enforcement: "partial",
    });

    const denied = await executor.run(executor.resolve({
      command: "printf blocked > " + outside,
    }));
    assert.notEqual(denied.exitCode, 0);
    assert.match(denied.stderr.text, /permission denied/i);
    assert.equal(existsSync(outside), false);
    assert.deepEqual(denied.sandbox, {
      mode: "workspace-write",
      denied: true,
      enforcement: "partial",
    });
  } finally {
    rmSync(inside, { force: true });
    rmSync(outside, { force: true });
    await dispose(ctx);
  }
});

test("reports sandbox facts for restricted background processes", { skip: !CAN_RUN_NATIVE_GUARD }, async () => {
  const { ctx, executor } = createExecutor("read-only");
  try {
    const process = executor.start(executor.resolve({
      command: "printf guarded-background",
    }));
    await process.done;

    assert.equal(process.status, "completed");
    assert.equal(process.exitCode, 0);
    assert.equal(process.readOutput().delta, "guarded-background");
    assert.deepEqual(process.sandbox, {
      mode: "read-only",
      denied: false,
      enforcement: "partial",
    });
  } finally {
    await dispose(ctx);
  }
});

test("preserves restricted token invariants in native descendants", { skip: !CAN_RUN_NATIVE_GUARD }, async () => {
  const { ctx, executor } = createExecutor("read-only");
  try {
    const result = await executor.run(executor.resolve({
      command: "./native/bin/win32-x64/msys-token-guard.exe --probe-current-token",
    }));

    assert.equal(result.exitCode, 0, result.stderr.text);
    assert.equal(result.stdout.text.replace(/\r\n/g, "\n"), "token-adjust-default=denied\n");
    assert.deepEqual(result.sandbox, {
      mode: "read-only",
      denied: false,
      enforcement: "partial",
    });
  } finally {
    await dispose(ctx);
  }
});

test("times out the complete restricted process tree", { skip: !CAN_RUN_NATIVE_GUARD }, async () => {
  const { ctx, executor } = createExecutor("read-only");
  const started = Date.now();
  try {
    const result = await executor.run(executor.resolve({
      command: "sleep 10",
      timeoutMs: 200,
    }));

    assert.equal(result.timedOut, true);
    assert.equal(result.aborted, false);
    assert.ok(Date.now() - started < 5_000);
    assert.deepEqual(result.sandbox, {
      mode: "read-only",
      denied: false,
      enforcement: "partial",
    });
  } finally {
    await dispose(ctx);
  }
});

test("aborts the complete restricted foreground process tree", { skip: !CAN_RUN_NATIVE_GUARD }, async () => {
  const { ctx, executor } = createExecutor("read-only");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 200);
  const started = Date.now();
  try {
    const result = await executor.run(executor.resolve({
      command: "sleep 10",
      signal: controller.signal,
    }));

    assert.equal(result.timedOut, false);
    assert.equal(result.aborted, true);
    assert.ok(Date.now() - started < 5_000);
    assert.deepEqual(result.sandbox, {
      mode: "read-only",
      denied: false,
      enforcement: "partial",
    });
  } finally {
    clearTimeout(timer);
    await dispose(ctx);
  }
});

test("kills the complete restricted background process tree", { skip: !CAN_RUN_NATIVE_GUARD }, async () => {
  const { ctx, executor } = createExecutor("read-only");
  try {
    const process = executor.start(executor.resolve({ command: "sleep 10" }));
    assert.equal(process.status, "running");
    assert.equal(process.kill(), true);
    await process.done;

    assert.equal(process.status, "killed");
    assert.deepEqual(process.sandbox, {
      mode: "read-only",
      denied: false,
      enforcement: "partial",
    });
  } finally {
    await dispose(ctx);
  }
});
