import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import test from "node:test";
import {
  GIT_BASH_PATH_ENV,
  gitBashCandidates,
  resolveGitBashPath,
} from "../lib/discovery.js";

const installed = resolveGitBashPath();
const standardProgramFilesPath = "C:\\Program Files\\Git\\bin\\bash.exe";

test("prefers an explicit Git Bash executable", () => {
  assert.equal(resolveGitBashPath(installed), realpathSync.native(installed));
});

test("honors DSH_GIT_BASH_PATH", () => {
  assert.equal(
    resolveGitBashPath(undefined, {
      env: { [GIT_BASH_PATH_ENV]: installed },
      platform: "win32",
    }),
    realpathSync.native(installed),
  );
});

test("generates standard Program Files candidates", () => {
  const env = { ProgramFiles: "C:\\Program Files", PATH: "" };
  assert.ok(gitBashCandidates(env).includes(standardProgramFilesPath));
});

test("fails loudly for an invalid configured executable", () => {
  assert.throws(
    () => resolveGitBashPath("C:\\missing\\bash.exe"),
    /configured executable does not exist/,
  );
});

test("runs commands with the resolved Git Bash", () => {
  const executable = resolveGitBashPath();
  const result = spawnSync(
    executable,
    ["--noprofile", "--norc", "-c", "printf '%s|%s' \"$BASH_VERSION\" \"$MSYSTEM\""],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^\d+\.\d+.*\|MINGW(?:32|64)$/);
});
