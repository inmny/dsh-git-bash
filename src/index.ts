import type { Context } from "@deepseek-ai/cordis";
import { LocalBashExecutor } from "@deepseek-ai/dsh-bash-local";
import type { Config as LocalBashConfig } from "@deepseek-ai/dsh-bash-local";
import { SandboxUnavailableError } from "@deepseek-ai/dsh-sandbox";
import type { SandboxExecutionPolicy, SandboxMode } from "@deepseek-ai/dsh-sandbox";
import type {} from "@deepseek-ai/dsh-sandbox-policy";
import type {
  ShellExecRequest,
  ShellExecSpec,
  ShellProcess,
  ShellRunResult,
} from "@deepseek-ai/dsh-shell";
import z from "@deepseek-ai/schemastery";
import { resolveGitBashPath } from "./discovery.js";

export { GIT_BASH_PATH_ENV, gitBashCandidates, resolveGitBashPath } from "./discovery.js";

const DEFAULT_GRACE_MS = 3_000;
const DEFAULT_MAX_SPILL_BYTES = 64 * 1024 * 1024;
const RESTRICTED_TOKEN_DETAIL =
  "Git for Windows Bash cannot start under the Windows restricted-token sandbox " +
  "because the MSYS2 runtime requires a shared file mapping that the token denies; " +
  "use danger-full-access for Git Bash commands";

export interface Config extends LocalBashConfig {
  // Absolute Git for Windows bash.exe path. Auto-detected when omitted.
  executable?: string;
}

export const Config: z<Config> = z.object({
  executable: z.string(),
  cwd: z.string(),
  timeoutMs: z.number().default(120_000),
  maxTimeoutMs: z.number().default(600_000),
  maxOutputBytes: z.number().default(64_000),
  maxSpillBytes: z.number().default(DEFAULT_MAX_SPILL_BYTES),
  graceMs: z.number().default(DEFAULT_GRACE_MS),
});

// DSH shell executor backed by Git for Windows Bash.
export class GitBashExecutor extends LocalBashExecutor {
  static inject = ["subprocess", "sandboxPolicy"];
  static Config = Config;

  readonly executable: string;
  private readonly mode: SandboxMode;

  constructor(ctx: Context, config: Config) {
    const { executable, ...localConfig } = config;
    super(ctx, localConfig);
    this.executable = resolveGitBashPath(executable);
    this.mode = ctx.sandboxPolicy.defaultMode;
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

  private policy(spec: ShellExecSpec): SandboxExecutionPolicy {
    if (!spec.sandboxPolicy) {
      throw new Error("git-bash: resolved execution is missing sandbox policy");
    }
    return spec.sandboxPolicy;
  }

  private requireUnrestricted(policy: SandboxExecutionPolicy): void {
    if (policy.mode !== "danger-full-access") {
      throw new SandboxUnavailableError(policy.mode, RESTRICTED_TOKEN_DETAIL);
    }
  }

  override async run(spec: ShellExecSpec): Promise<ShellRunResult> {
    const policy = this.policy(spec);
    this.requireUnrestricted(policy);
    return {
      ...await this.runArgv(spec, this.argv(spec.command)),
      sandbox: { mode: policy.mode, denied: false },
    };
  }

  override start(spec: ShellExecSpec): ShellProcess {
    const policy = this.policy(spec);
    this.requireUnrestricted(policy);
    return this.startArgv(spec, this.argv(spec.command));
  }
}

export default GitBashExecutor;
