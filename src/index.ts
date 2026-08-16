import type { Context } from "@deepseek-ai/cordis";
import {
  assertServiceableBashConfig,
  LocalBashExecutor,
} from "@deepseek-ai/dsh-bash-local";
import type { Config as LocalBashConfig } from "@deepseek-ai/dsh-bash-local";
import { SandboxUnavailableError } from "@deepseek-ai/dsh-sandbox";
import type {
  ConfinedArgv,
  ConfinedSandboxMode,
  RunnerFailureRule,
  SandboxEnforcement,
  SandboxExecutionPolicy,
  SandboxMode,
  SandboxPolicy,
} from "@deepseek-ai/dsh-sandbox";
import type {} from "@deepseek-ai/dsh-sandbox-policy";
import {
  SHELL_SETTINGS_NAMESPACE,
  type ShellExecRequest,
  type ShellExecSpec,
  type ShellProcess,
  type ShellRunResult,
} from "@deepseek-ai/dsh-shell";
import z from "@deepseek-ai/schemastery";
import { accessSync, constants, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveGitBashPath } from "./discovery.js";

export { GIT_BASH_PATH_ENV, gitBashCandidates, resolveGitBashPath } from "./discovery.js";

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const GUARD_EXECUTABLE = resolve(
  PACKAGE_ROOT,
  "native",
  "bin",
  "win32-x64",
  "msys-token-guard.exe",
);
const GUARD_HOOK = resolve(
  PACKAGE_ROOT,
  "native",
  "bin",
  "win32-x64",
  "msys-token-guard-hook.dll",
);
const EXECUTABLE_SPAWN_CODES = new Set(["EACCES", "ENOENT"]);
const GIT_BASH_EXECUTABLE_PATTERN =
  /^(?:[A-Z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+[\\/]|%[^%]+%[\\/])(?:.*[\\/])?bash\.exe$/i;
const GUARD_FAILURE_RULE: RunnerFailureRule = {
  allowedExitCodes: [125],
  fatalSignatures: ["msys-token-guard:"],
};

export interface Config extends LocalBashConfig {
  // Absolute Git for Windows bash.exe path. Auto-detected when omitted.
  executable?: string;
}

const LOCAL_BASH_CONFIG = LocalBashExecutor.Config;

type ResolvedGitBashConfig = Required<Omit<Config, "cwd">> & Pick<Config, "cwd">;

interface GitBashSettingsService {
  register(
    namespace: typeof SHELL_SETTINGS_NAMESPACE,
    schema: z<Config>,
    options: { base: Config; validate: (value: Config) => void },
  ): { get(): Config };
}

// Keep the field schema permissive enough to render a recovery card for a
// legacy bad value; resolveConfiguredExecutable enforces it on new writes and use.
export const Config = z.intersect([
  LOCAL_BASH_CONFIG,
  z.object({
    executable: z.string()
      .default("")
      .role("path")
      .description("Absolute path to Git for Windows bash.exe; blank uses automatic discovery."),
  }),
]) as z<Config>;

function resolveConfiguredExecutable(config: Config): string | undefined {
  const executable = config.executable?.trim();
  if (!executable) return undefined;
  if (!GIT_BASH_EXECUTABLE_PATTERN.test(executable)) {
    throw new TypeError(
      "git-bash: executable must be an absolute Windows path ending in bash.exe",
    );
  }
  return resolveGitBashPath(executable);
}

function createSettingsValidator(): (config: Config) => void {
  let initialSection = true;
  return (config) => {
    assertServiceableBashConfig(config);
    if (initialSection) {
      initialSection = false;
      return;
    }
    resolveConfiguredExecutable(config);
  };
}

function checkedCompositionConfig(config: Config): Config {
  // Blank configuration intentionally defers auto-discovery so the settings
  // card remains available on hosts that still need Git for Windows configured.
  resolveConfiguredExecutable(config);
  return config;
}

interface RunnerFailureMatch {
  detail: string;
}

interface ProcessFacts {
  mode: ConfinedSandboxMode;
  enforcement: SandboxEnforcement;
  denialSignatures: readonly string[];
  runnerFailureRules: readonly RunnerFailureRule[];
  runnerProgram: string | undefined;
  workdir: string;
}

function isUsableWorkdir(path: string): boolean {
  try {
    if (!statSync(path).isDirectory()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function isRunnerSpawnFailure(
  error: unknown,
  runnerProgram: string | undefined,
  workdir: string,
): boolean {
  if (runnerProgram === undefined || !isUsableWorkdir(workdir)) return false;
  if (typeof error !== "object" || error === null) return false;
  const { code, path, syscall } = error as NodeJS.ErrnoException;
  if (typeof code !== "string" || !EXECUTABLE_SPAWN_CODES.has(code)) return false;
  if (typeof syscall !== "string") return false;

  const exactSyscall = "spawn " + runnerProgram;
  if (path === undefined) return syscall === exactSyscall;
  if (typeof path !== "string" || path.length === 0 || path !== runnerProgram) return false;
  return syscall === "spawn" || syscall === exactSyscall;
}

function matchesSignature(
  exitCode: number | null,
  stderr: string,
  signatures: readonly string[],
): boolean {
  if (exitCode === null || exitCode === 0) return false;
  const lowered = stderr.toLowerCase();
  return signatures.some((signature) => lowered.includes(signature.toLowerCase()));
}

function classifyDenial(result: ShellRunResult, signatures: readonly string[]): boolean {
  return matchesSignature(result.exitCode, result.stderr.text, signatures);
}

function classifyRunnerFailure(
  exitCode: number | null,
  stderr: string,
  rules: readonly RunnerFailureRule[],
): RunnerFailureMatch | undefined {
  if (exitCode === null || exitCode === 0) return undefined;
  const lines = stderr.split(/\r?\n/);
  for (const rule of rules) {
    if (rule.allowedExitCodes !== undefined && !rule.allowedExitCodes.includes(exitCode)) {
      continue;
    }
    const informationalLines = new Set(
      (rule.informationalLines ?? []).map((line) => line.toLowerCase()),
    );
    const fatalSignatures = rule.fatalSignatures
      .filter((signature) => signature.trim().length > 0)
      .map((signature) => signature.toLowerCase());
    for (const line of lines) {
      const lowered = line.toLowerCase();
      if (informationalLines.has(lowered)) continue;
      if (fatalSignatures.some((signature) => lowered.includes(signature))) {
        return { detail: line };
      }
    }
  }
  return undefined;
}

function assertNativeGuard(mode: ConfinedSandboxMode): void {
  if (process.platform !== "win32" || process.arch !== "x64") {
    throw new SandboxUnavailableError(
      mode,
      "Git Bash restricted mode requires win32-x64, received " +
        process.platform + "-" + process.arch,
    );
  }

  for (const artifact of [GUARD_EXECUTABLE, GUARD_HOOK]) {
    try {
      if (!statSync(artifact).isFile()) throw new Error("not a file");
      accessSync(artifact, constants.R_OK);
    } catch (error) {
      throw new SandboxUnavailableError(
        mode,
        "Git Bash native guard artifact is unavailable: " + artifact + " (" + String(error) + ")",
      );
    }
  }
}

// DSH shell executor backed by Git for Windows Bash.
export class GitBashExecutor extends LocalBashExecutor {
  static inject = ["subprocess", "sandbox", "sandboxPolicy"];
  static Config = Config;

  private configSource!: () => ResolvedGitBashConfig;
  private executableCache: { configured: string; resolved: string } | undefined;
  private readonly mode: SandboxMode;
  private readonly processFacts = new Map<ShellProcess, ProcessFacts>();

  constructor(ctx: Context, config: Config) {
    // Keep the inherited process mechanics while replacing its fixed settings
    // registration with the extended, executable-aware section below.
    super(ctx.isolate("settings"), checkedCompositionConfig(config));
    const entry = config as ResolvedGitBashConfig;
    this.configSource = () => entry;
    ctx.inject(["settings"], (settingsCtx) => {
      const settings = settingsCtx.get("settings", true) as GitBashSettingsService;
      const scope = settings.register(SHELL_SETTINGS_NAMESPACE, Config, {
        base: entry,
        validate: createSettingsValidator(),
      });
      this.configSource = () => scope.get() as ResolvedGitBashConfig;
      settingsCtx.effect(
        () => () => {
          this.configSource = () => entry;
        },
        "git-bash: restore composition settings",
      );
    });
    this.mode = ctx.sandboxPolicy.defaultMode;
  }

  override get config(): ResolvedGitBashConfig {
    return this.configSource();
  }

  get executable(): string {
    const config = this.config as Config;
    const configured = config.executable?.trim() ?? "";
    if (this.executableCache?.configured === configured) {
      return this.executableCache.resolved;
    }

    const resolved = resolveConfiguredExecutable(config) ?? resolveGitBashPath();
    this.executableCache = { configured, resolved };
    return resolved;
  }

  override get sandboxMode(): SandboxMode {
    return this.mode;
  }

  override resolve(request: ShellExecRequest): ShellExecSpec {
    return {
      ...super.resolve(request),
      sandboxPolicy: request.sandboxPolicy ?? this.ctx.sandboxPolicy.resolve(),
    };
  }

  private argv(command: string): readonly string[] {
    return [this.executable, "--noprofile", "--norc", "-c", command];
  }

  private guardedArgv(command: string, mode: ConfinedSandboxMode): readonly string[] {
    assertNativeGuard(mode);
    return [GUARD_EXECUTABLE, "--", ...this.argv(command)];
  }

  private policy(spec: ShellExecSpec): SandboxExecutionPolicy {
    if (!spec.sandboxPolicy) {
      throw new Error("git-bash: resolved execution is missing sandbox policy");
    }
    return spec.sandboxPolicy;
  }

  private confine(command: string, policy: SandboxPolicy): ConfinedArgv {
    const confined = this.ctx.sandbox.confine(this.guardedArgv(command, policy.mode), policy);
    return {
      ...confined,
      runnerFailureRules: [...confined.runnerFailureRules, GUARD_FAILURE_RULE],
    };
  }

  override async run(spec: ShellExecSpec): Promise<ShellRunResult> {
    const policy = this.policy(spec);
    const { mode } = policy;
    if (mode === "danger-full-access") {
      return {
        ...await this.runArgv(spec, this.argv(spec.command)),
        sandbox: { mode, denied: false },
      };
    }

    const confined = this.confine(spec.command, { ...policy, mode });
    let result: ShellRunResult;
    try {
      result = await this.runArgv(spec, confined.argv);
    } catch (error) {
      if (spec.signal?.aborted === true) spec.signal.throwIfAborted();
      if (isRunnerSpawnFailure(error, confined.argv[0], spec.workdir)) {
        throw new SandboxUnavailableError(mode, String(error));
      }
      throw error;
    }

    const runnerFailure = classifyRunnerFailure(
      result.exitCode,
      result.stderr.text,
      confined.runnerFailureRules,
    );
    if (runnerFailure !== undefined) {
      throw new SandboxUnavailableError(mode, runnerFailure.detail);
    }
    return {
      ...result,
      sandbox: {
        mode,
        denied: classifyDenial(result, confined.denialSignatures),
        enforcement: confined.enforcement,
      },
    };
  }

  override start(spec: ShellExecSpec): ShellProcess {
    const policy = this.policy(spec);
    const { mode } = policy;
    if (mode === "danger-full-access") {
      return this.startArgv(spec, this.argv(spec.command));
    }

    const confined = this.confine(spec.command, { ...policy, mode });
    let proc: ShellProcess;
    try {
      proc = this.startArgv(spec, confined.argv);
    } catch (error) {
      if (isRunnerSpawnFailure(error, confined.argv[0], spec.workdir)) {
        throw new SandboxUnavailableError(mode, String(error));
      }
      throw error;
    }
    this.processFacts.set(proc, {
      mode,
      enforcement: confined.enforcement,
      denialSignatures: confined.denialSignatures,
      runnerFailureRules: confined.runnerFailureRules,
      runnerProgram: confined.argv[0],
      workdir: spec.workdir,
    });
    return proc;
  }

  protected override onProcessDone(
    proc: ShellProcess,
    stderr: string,
    spawnFailed: boolean,
    spawnError?: unknown,
  ): void {
    const facts = this.processFacts.get(proc);
    if (facts !== undefined) {
      this.processFacts.delete(proc);
      const runnerFailed = spawnFailed
        ? isRunnerSpawnFailure(spawnError, facts.runnerProgram, facts.workdir)
        : classifyRunnerFailure(proc.exitCode, stderr, facts.runnerFailureRules) !== undefined;
      proc.sandbox = {
        mode: facts.mode,
        denied: !runnerFailed && matchesSignature(
          proc.exitCode,
          stderr,
          facts.denialSignatures,
        ),
        enforcement: facts.enforcement,
        ...(runnerFailed ? { runnerFailed } : {}),
      };
    }
    super.onProcessDone(proc, stderr, spawnFailed, spawnError);
  }
}

export default GitBashExecutor;
