/**
 * Integration branch lifecycle management.
 * Handles creation, worktree setup, cleanup, and refresh of integration branches
 * used for orchestrated merge trains.
 */

import { join, resolve } from 'path';
import { gitCommand, getDefaultBranch } from './git';
import { withFileLock, INTEGRATION_STALE_MS, type FileLockOptions } from './file-lock';
import { getProjectId, getXdgDataDir, getActiveRepoRoot, resolveRepoRoot } from './paths';
import type { PostCreateHook } from './providers/worktree-provider';
import { extractConflicts } from './utils';

/**
 * Explicit authorization for publishing actions (push/PR/deploy).
 * The human must opt in per call — absence of the flag is a refusal.
 */
export interface PublishAuthOptions {
  humanAuth?: boolean;
}

/**
 * Guard: refuse push/PR/deploy without explicit human authorization.
 * Call this at the start of any code path that publishes to a remote.
 * Throws when `opts?.humanAuth !== true`.
 */
export function requireHumanAuth(action: string, opts?: PublishAuthOptions): void {
  if (opts?.humanAuth === true) {
    return;
  }
  throw new Error(
    `[MC] Refusing "${action}" without explicit human authorization. ` +
    `Push/PR/deploy require requireHumanAuth — re-run with { humanAuth: true } ` +
    `after the user explicitly approved this exact operation.`,
  );
}

function effectiveRepoRoot(repoRoot?: string): string {
  // Explicit param wins, then active scope, then process cwd (backward compat).
  // Never depend on bare cwd when a --repo was given upstream.
  return resolveRepoRoot(repoRoot ?? getActiveRepoRoot() ?? process.cwd());
}

async function integrationPaths(planId: string, repoRoot?: string): Promise<{ branch: string; worktreePath: string; repo: string }> {
  const repo = effectiveRepoRoot(repoRoot);
  const projectId = await getProjectId(repo);
  const branch = `mc/integration-${planId}`;
  const worktreePath = join(getXdgDataDir(), projectId, `mc-integration-${planId}`);
  return { branch, worktreePath, repo };
}

async function runIntegrationPostCreate(worktreePath: string, repo: string, postCreate?: PostCreateHook): Promise<void> {
  if (!postCreate) return;
  const fs = await import('fs');
  // Source is the explicit repo root (never getMainWorktree via bare cwd).
  if (postCreate.copyFiles) {
    for (const file of postCreate.copyFiles) {
      const src = join(repo, file);
      const dest = join(worktreePath, file);
      if (fs.existsSync(src)) {
        fs.mkdirSync(join(dest, '..'), { recursive: true });
        try { fs.copyFileSync(src, dest); } catch {}
      }
    }
  }
  if (postCreate.symlinkDirs) {
    for (const dir of postCreate.symlinkDirs) {
      const src = join(repo, dir);
      const dest = join(worktreePath, dir);
      if (fs.existsSync(src) && !fs.existsSync(dest)) {
        fs.mkdirSync(join(dest, '..'), { recursive: true });
        try { fs.symlinkSync(resolve(src), dest); } catch {}
      }
    }
  }
  if (postCreate.commands) {
    for (const cmd of postCreate.commands) {
      const proc = Bun.spawn(['sh', '-c', cmd], {
        cwd: worktreePath,
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const exitCode = await proc.exited;
      if (exitCode !== 0) {
        const stderr = await new Response(proc.stderr).text();
        throw new Error(`Post-create command failed: "${cmd}" (exit ${exitCode}): ${stderr}`);
      }
    }
  }
}

/**
 * Create an integration branch from the current main HEAD.
 * Sets up a dedicated worktree for the integration branch.
 * Handles edge case: if branch already exists from a failed run, deletes and recreates.
 *
 * @param planId - The plan ID to create integration branch for
 * @returns Promise with branch name and worktree path
 */
export async function createIntegrationBranch(
  planId: string,
  postCreate?: PostCreateHook,
  baseRef?: string,
  repoRoot?: string,
): Promise<{ branch: string; worktreePath: string }> {
  const { branch: branchName, worktreePath, repo } = await integrationPaths(planId, repoRoot);

  // Check if branch already exists from a failed previous run
  const branchCheckResult = await gitCommand(['branch', '--list', branchName], { cwd: repo });
  const branchExists = branchCheckResult.stdout.includes(branchName);

  if (branchExists) {
    // Clean up the old branch and worktree
    try {
      await deleteIntegrationBranch(planId, repo);
    } catch (e) {
      // Ignore errors during cleanup of failed run
    }
  }

  // Get the current main HEAD to create branch from
  const baseBranch = baseRef ?? await getDefaultBranch(repo);
  const baseHeadResult = await gitCommand(['rev-parse', baseBranch], { cwd: repo });
  if (baseHeadResult.exitCode !== 0) {
    throw new Error(`Failed to get ${baseBranch} HEAD: ` + baseHeadResult.stderr);
  }

  // Create the branch from main HEAD
  const createBranchResult = await gitCommand([
    'branch',
    branchName,
    baseHeadResult.stdout,
  ], { cwd: repo });
  if (createBranchResult.exitCode !== 0) {
    throw new Error(`Failed to create integration branch: ${createBranchResult.stderr}`);
  }

  // Repo-scoped worktree add (never via bare-cwd helper): runs inside the
  // explicit repo so starting from a third folder never creates the branch
  // in the launcher's repo.
  const fs = await import('fs');
  fs.mkdirSync(join(worktreePath, '..'), { recursive: true });
  const wtResult = await gitCommand(['worktree', 'add', worktreePath, branchName], { cwd: repo });
  if (wtResult.exitCode !== 0) {
    // Roll back the branch when the worktree cannot be created.
    await gitCommand(['branch', '-D', branchName], { cwd: repo }).catch(() => {});
    throw new Error(`Failed to create integration worktree: ${wtResult.stderr || wtResult.stdout}`);
  }

  await runIntegrationPostCreate(worktreePath, repo, postCreate);

  return {
    branch: branchName,
    worktreePath,
  };
}

/**
 * Get the worktree path for an integration branch.
 * Throws if the worktree doesn't exist.
 *
 * @param planId - The plan ID
 * @returns Promise with the worktree path
 */
export async function getIntegrationWorktree(planId: string, repoRoot?: string): Promise<string> {
  const { worktreePath, repo } = await integrationPaths(planId, repoRoot);

  // Verify the worktree exists by checking if it's in the worktree list
  const listResult = await gitCommand(['worktree', 'list', '--porcelain'], { cwd: repo });
  if (listResult.exitCode !== 0) {
    throw new Error('Failed to list worktrees');
  }

  if (!listResult.stdout.includes(worktreePath)) {
    throw new Error(`Integration worktree not found for plan ${planId}`);
  }

  return worktreePath;
}

/**
 * Delete an integration branch and its worktree.
 * Handles "already deleted" gracefully (no error if missing).
 *
 * @param planId - The plan ID
 */
export async function deleteIntegrationBranch(planId: string, repoRoot?: string): Promise<void> {
  const { branch: branchName, worktreePath, repo } = await integrationPaths(planId, repoRoot);

  // Remove the worktree (force to handle any uncommitted changes), scoped to the repo.
  // Direct git with cwd (never the bare-cwd helper) so cleanup never touches the launcher.
  try {
    await gitCommand(['worktree', 'remove', '--force', worktreePath], { cwd: repo });
  } catch (e) {
    // Ignore if worktree doesn't exist
  }

  // Delete the branch
  const deleteBranchResult = await gitCommand(['branch', '-D', branchName], { cwd: repo });
  if (deleteBranchResult.exitCode !== 0) {
    // Ignore if branch doesn't exist
    if (!deleteBranchResult.stderr.includes('not found')) {
      throw new Error(`Failed to delete integration branch: ${deleteBranchResult.stderr}`);
    }
  }
}

/**
 * Lockfile path for one integration branch worktree.
 * One lock per integration branch serializes merge-train writers.
 */
export function integrationLockPath(worktreePath: string): string {
  return `${worktreePath}.lock`;
}

/**
 * Run `fn` holding the per-integration-branch file lock.
 * Merge-train integration must go through here so concurrent processes
 * cannot interleave merges into the same branch.
 * Uses INTEGRATION_STALE_MS (not the 15s default) with lease heartbeat:
 * merge+test runs hold the lock for minutes and keep renewing, so only
 * a dead holder (no heartbeat progress) is ever broken.
 */
export async function withIntegrationLock<T>(
  worktreePath: string,
  fn: () => Promise<T>,
  opts?: FileLockOptions,
): Promise<T> {
  return withFileLock(integrationLockPath(worktreePath), fn, {
    staleMs: INTEGRATION_STALE_MS,
    ...opts,
  });
}

/**
 * Refresh the integration branch from main.
 * Fetches latest main from origin and attempts to rebase the integration branch.
 * On conflict: aborts rebase and returns conflict info.
 * On success: returns success status.
 *
 * @param planId - The plan ID
 * @returns Promise with success status and optional conflicts
 */
export async function refreshIntegrationFromMain(
  planId: string,
  repoRoot?: string,
): Promise<{ success: boolean; conflicts?: string[] }> {
  const { worktreePath, repo } = await integrationPaths(planId, repoRoot);

  // Contrato: base canônica getDefaultBranch; sem remote usa base local em vez de falhar no fetch.
  const defaultBranch = await getDefaultBranch(repo);
  const remotesResult = await gitCommand(['remote'], { cwd: repo });
  const hasOrigin =
    remotesResult.exitCode === 0 &&
    remotesResult.stdout.split('\n').map((r) => r.trim()).includes('origin');
  let targetBranch = defaultBranch;
  if (hasOrigin) {
    // Attempt to fetch latest from origin (remote-sync path).
    const fetchResult = await gitCommand(['-C', worktreePath, 'fetch', 'origin']);
    if (fetchResult.exitCode !== 0) {
      return { success: false, conflicts: ['Failed to fetch from origin'] };
    }
    targetBranch = `origin/${defaultBranch}`;
  }

  const verifyResult = await gitCommand(['-C', worktreePath, 'rev-parse', '--verify', targetBranch]);
  if (verifyResult.exitCode !== 0) {
    return { success: false, conflicts: [`Base branch "${targetBranch}" not found`] };
  }
  const rebaseResult = await gitCommand(['-C', worktreePath, 'rebase', targetBranch]);

  if (rebaseResult.exitCode !== 0) {
    // Extract conflicts from stderr
    const conflicts = extractConflicts(rebaseResult.stderr);

    // Abort the rebase to leave worktree clean
    await gitCommand(['-C', worktreePath, 'rebase', '--abort']).catch(() => {});

    return { success: false, conflicts };
  }

  return { success: true };
}
