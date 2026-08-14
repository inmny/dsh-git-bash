import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceDir = resolve(root, "native");
const buildDir = resolve(sourceDir, "build", "win32-x64");
const executable = resolve(sourceDir, "bin", "win32-x64", "msys-token-guard.exe");
const hook = resolve(sourceDir, "bin", "win32-x64", "msys-token-guard-hook.dll");

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit", windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

if (process.platform !== "win32") {
  if (!existsSync(executable) || !existsSync(hook)) {
    throw new Error("prebuilt token guard artifacts are missing: " + executable + ", " + hook);
  }
  console.log("using prebuilt token guard artifacts: " + executable + ", " + hook);
  process.exit(0);
}
if (process.arch !== "x64") {
  throw new Error("native token guard currently supports win32-x64, received " + process.platform + "-" + process.arch);
}

mkdirSync(buildDir, { recursive: true });
run("cmake", ["--fresh", "-S", sourceDir, "-B", buildDir, "-A", "x64"]);
run("cmake", ["--build", buildDir, "--config", "Release", "--target", "msys-token-guard", "msys-token-guard-hook"]);
if (!existsSync(executable) || !existsSync(hook)) {
  throw new Error("native build did not produce " + executable + " and " + hook);
}
console.log("built " + executable + " and " + hook);
