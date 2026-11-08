/**
 * Shared git command helper that routes all git operations through GitMutex.
 * This ensures serialized access to the .git directory and prevents corruption
 * from concurrent git operations.
 */

import { spawn } from 'bun';
import mutex, { withGitLock } from './git-mutex';

/**
 * Execute a git command with mutex protection.
 * All git operations should use this function instead of spawning git directly.
 *
 * @param args - Git command arguments (e.g., ['status', '--porcelain'])
 * @param opts - Optional execution options
 * @returns Promise with stdout, stderr, and exit code
 */
export async function gitCommand(
  args: string[],
  opts?: { cwd?: string },
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  // Blocker 3: cross-process serialization (conductor + CLI share the repo).
  // In-process mutex alone let two processes interleave .git writers.
  return withGitLock(async () => mutex.withLock(async () => {
    const proc = spawn(['git', ...args], {
      cwd: opts?.cwd,
      stdout: 'pipe',
      stderr: 'pipe',
    });

    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const exitCode = await proc.exited;

    return {
      stdout: stdout.trim(),
      stderr: stderr.trim(),
      exitCode,
    };
  }));
}

/**
 * Resolve the HEAD commit of a branch or ref.
 */
export async function getBranchHead(
  ref: string,
  cwd?: string,
): Promise<{ head: string | null; error?: string }> {
  const result = await gitCommand(['rev-parse', ref], cwd ? { cwd } : undefined);
  if (result.exitCode !== 0) {
    return { head: null, error: result.stderr || `unknown ref ${ref}` };
  }
  return { head: result.stdout.trim() || null };
}

/**
 * List files changed on `headRef` relative to `baseRef` (triple-dot diff).
 */
export async function listChangedFiles(
  baseRef: string,
  headRef: string,
  cwd?: string,
): Promise<{ files: string[] | null; error?: string }> {
  const result = await gitCommand(
    ['diff', '--name-only', `${baseRef}...${headRef}`],
    cwd ? { cwd } : undefined,
  );
  if (result.exitCode !== 0) {
    return { files: null, error: result.stderr || 'diff failed' };
  }
  return { files: result.stdout.split('\n').map((f) => f.trim()).filter(Boolean) };
}

/**
 * Detect the repository's default branch name.
 * Tries origin/HEAD first (remote default), falls back to checking local main/master.
 */
export async function getDefaultBranch(cwd?: string): Promise<string> {
  // Strategy 1: Check remote HEAD (most reliable)
  const remoteHead = await gitCommand(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], { cwd });
  if (remoteHead.exitCode === 0 && remoteHead.stdout) {
    const match = remoteHead.stdout.match(/^origin\/(.+)/);
    if (match) return match[1];
    return remoteHead.stdout;
  }

  // Strategy 2: Check which local branch exists
  const mainCheck = await gitCommand(['rev-parse', '--verify', 'main'], { cwd });
  if (mainCheck.exitCode === 0) return 'main';

  const masterCheck = await gitCommand(['rev-parse', '--verify', 'master'], { cwd });
  if (masterCheck.exitCode === 0) return 'master';

  // Default fallback
  return 'main';
}
