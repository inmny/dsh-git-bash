import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { AclSandbox } from "@deepseek-ai/dsh-sandbox-windows-acl";
import { resolveGitBashPath } from "../lib/discovery.js";

const CAN_RUN_NATIVE_GUARD = process.platform === "win32" && process.arch === "x64";
const GUARD = resolve("native/bin/win32-x64/msys-token-guard.exe");

function bashArgs(command) {
  return [resolveGitBashPath(), "--noprofile", "--norc", "-c", command];
}

async function runReadOnly(command, args) {
  const sandbox = new AclSandbox({ mode: "read-only", writableDirs: [], tempDir: null });
  try {
    await sandbox.init();
    return await sandbox.spawn({
      command,
      args,
      cwd: process.cwd(),
      stdio: "pipe",
    }).wait();
  } finally {
    sandbox.dispose();
  }
}

test("guard refuses to run outside a restricted token", { skip: !CAN_RUN_NATIVE_GUARD }, () => {
  const result = spawnSync(
    GUARD,
    ["--", ...bashArgs("printf should-not-run")],
    { cwd: process.cwd(), encoding: "utf8", windowsHide: true },
  );

  assert.equal(result.status, 125);
  assert.equal(result.signal, null);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /^msys-token-guard: token carries no restricting SIDs failed/);
});

test("guard fails closed when the companion hook is missing", { skip: !CAN_RUN_NATIVE_GUARD }, async () => {
  const directory = resolve("native/build/native-guard-missing-hook-" + process.pid);
  const copiedGuard = resolve(directory, "msys-token-guard.exe");
  rmSync(directory, { recursive: true, force: true });
  mkdirSync(directory, { recursive: true });
  copyFileSync(GUARD, copiedGuard);
  try {
    const result = await runReadOnly(
      copiedGuard,
      ["--", ...bashArgs("printf should-not-run")],
    );
    assert.equal(result.exitCode, 125);
    assert.equal(result.stdout.toString("utf8"), "");
    assert.match(
      result.stderr.toString("utf8"),
      /^msys-token-guard: GetFileAttributesW\(hook DLL\) failed/,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("guard maps an invalid companion hook to setup exit 125", { skip: !CAN_RUN_NATIVE_GUARD }, async () => {
  const directory = resolve("native/build/native-guard-invalid-hook-" + process.pid);
  const copiedGuard = resolve(directory, "msys-token-guard.exe");
  const invalidHook = resolve(directory, "msys-token-guard-hook.dll");
  rmSync(directory, { recursive: true, force: true });
  mkdirSync(directory, { recursive: true });
  copyFileSync(GUARD, copiedGuard);
  copyFileSync(GUARD, invalidHook);
  try {
    const result = await runReadOnly(
      copiedGuard,
      ["--", ...bashArgs("printf should-not-run")],
    );
    assert.equal(result.exitCode, 125);
    assert.equal(result.stdout.toString("utf8"), "");
    assert.match(
      result.stderr.toString("utf8"),
      /^msys-token-guard: hook readiness handshake failed/,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
