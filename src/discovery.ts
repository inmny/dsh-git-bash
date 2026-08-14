import {
  accessSync,
  constants,
  realpathSync,
  statSync,
} from "node:fs";
import { win32 } from "node:path";

export const GIT_BASH_PATH_ENV = "DSH_GIT_BASH_PATH";

export interface GitBashDiscoveryOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}

function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const wanted = name.toLowerCase();
  const entry = Object.entries(env).find(([key]) => key.toLowerCase() === wanted);
  const value = entry?.[1]?.trim();
  return value && value.length > 0 ? value : undefined;
}

function expandEnvironmentVariables(value: string, env: NodeJS.ProcessEnv): string {
  return value.replace(/%([^%]+)%/g, (match, name: string) => envValue(env, name) ?? match);
}

function canonicalExecutable(candidate: string): string | undefined {
  try {
    if (!statSync(candidate).isFile()) return undefined;
    accessSync(candidate, constants.X_OK);
    return realpathSync.native(candidate);
  } catch {
    return undefined;
  }
}

function uniqueWindowsPaths(paths: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const candidate of paths) {
    const normalized = win32.normalize(candidate.trim());
    if (normalized.length === 0) continue;
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(normalized);
  }
  return result;
}

function appendGitRoot(candidates: string[], root: string | undefined): void {
  if (!root) return;
  candidates.push(
    win32.join(root, "bin", "bash.exe"),
    win32.join(root, "usr", "bin", "bash.exe"),
  );
}

// Return likely Git for Windows Bash locations in preference order.
export function gitBashCandidates(env: NodeJS.ProcessEnv = process.env): string[] {
  const candidates: string[] = [];

  for (const variable of ["ProgramFiles", "ProgramW6432", "ProgramFiles(x86)"]) {
    const directory = envValue(env, variable);
    if (directory) appendGitRoot(candidates, win32.join(directory, "Git"));
  }

  const localAppData = envValue(env, "LOCALAPPDATA");
  if (localAppData) appendGitRoot(candidates, win32.join(localAppData, "Programs", "Git"));

  const userProfile = envValue(env, "USERPROFILE");
  if (userProfile) {
    appendGitRoot(candidates, win32.join(userProfile, "scoop", "apps", "git", "current"));
    appendGitRoot(candidates, win32.join(userProfile, "AppData", "Local", "Programs", "Git"));
  }

  appendGitRoot(candidates, envValue(env, "GIT_INSTALL_ROOT"));

  const pathValue = envValue(env, "PATH") ?? "";
  for (const rawEntry of pathValue.split(win32.delimiter)) {
    const entry = rawEntry.trim().replace(/^"|"$/g, "");
    if (entry.length === 0) continue;

    const gitRoot = /^(.*[\\/]git)(?:[\\/].*)?$/i.exec(entry)?.[1];
    if (gitRoot) appendGitRoot(candidates, gitRoot);

    if (/(?:^|[\\/])git(?:[\\/]|$)/i.test(entry)) {
      candidates.push(win32.join(entry, "bash.exe"));
    }
  }

  return uniqueWindowsPaths(candidates);
}

// Resolve and validate the Git for Windows Bash executable.
export function resolveGitBashPath(
  executable?: string,
  options: GitBashDiscoveryOptions = {},
): string {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") {
    throw new Error("git-bash: Git for Windows is supported only on Windows");
  }

  const configured = executable?.trim() || envValue(env, GIT_BASH_PATH_ENV);
  if (configured) {
    const expanded = expandEnvironmentVariables(configured, env);
    const resolved = canonicalExecutable(expanded);
    if (resolved) return resolved;
    throw new Error(
      `git-bash: configured executable does not exist or is not executable: ${expanded}`,
    );
  }

  const candidates = gitBashCandidates(env);
  for (const candidate of candidates) {
    const resolved = canonicalExecutable(candidate);
    if (resolved) return resolved;
  }

  throw new Error(
    [
      "git-bash: Git for Windows Bash was not found.",
      `Install Git for Windows or set ${GIT_BASH_PATH_ENV} to bash.exe.`,
      candidates.length > 0 ? `Checked: ${candidates.join(", ")}` : "No candidate paths were available.",
    ].join(" "),
  );
}
