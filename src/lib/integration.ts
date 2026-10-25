/**
 * Integration branch lifecycle management.
 * Handles creation, worktree setup, cleanup, and refresh of integration branches
 * used for orchestrated merge trains.
 */

import { join } from 'path';
import { gitCommand, getDefaultBranch } from './git';
import { withFileLock, INTEGRATION_STALE_MS, type FileLockOptions } from './file-lock';
import { getProjectId, getXdgDataDir } from './paths';
import { createWorktree, removeWorktree } from './worktree';
import type { PostCreateHook } from './providers/worktree-provider';
import { extractConflicts } from './utils';

const XDG_DATA_DIR = getXdgDataDir();

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
): Promise<{ branch: string; worktreePath: string }> {
  const projectId = await getProjectId();
  const branchName = `mc/integration-${planId}`;
  const worktreePath = join(XDG_DATA_DIR, projectId, `mc-integration-${planId}`);

  // Check if branch already exists from a failed previous run
  const branchCheckResult = await gitCommand(['branch', '--list', branchName]);
  const branchExists = branchCheckResult.stdout.includes(branchName);

  if (branchExists) {
    // Clean up the old branch and worktree
    try {
      await deleteIntegrationBranch(planId);
    } catch (e) {
      // Ignore errors during cleanup of failed run
    }
  }

  // Get the current main HEAD to create branch from
  const baseBranch = baseRef ?? await getDefaultBranch();
  const baseHeadResult = await gitCommand(['rev-parse', baseBranch]);
  if (baseHeadResult.exitCode !== 0) {
    throw new Error(`Failed to get ${baseBranch} HEAD: ` + baseHeadResult.stderr);
  }

  // Create the branch from main HEAD
  const createBranchResult = await gitCommand([
    'branch',
    branchName,
    baseHeadResult.stdout,
  ]);
  if (createBranchResult.exitCode !== 0) {
    throw new Error(`Failed to create integration branch: ${createBranchResult.stderr}`);
  }

  const worktreePathResult = await createWorktree({
    branch: branchName,
    basePath: worktreePath,
    postCreate,
  });

  return {
    branch: branchName,
    worktreePath: worktreePathResult,
  };
}

/**
 * Get the worktree path for an integration branch.
 * Throws if the worktree doesn't exist.
 *
 * @param planId - The plan ID
 * @returns Promise with the worktree path
 */
export async function getIntegrationWorktree(planId: string): Promise<string> {
  const projectId = await getProjectId();
  const worktreePath = join(XDG_DATA_DIR, projectId, `mc-integration-${planId}`);

  // Verify the worktree exists by checking if it's in the worktree list
  const listResult = await gitCommand(['worktree', 'list', '--porcelain']);
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
export async function deleteIntegrationBranch(planId: string): Promise<void> {
  const projectId = await getProjectId();
  const branchName = `mc/integration-${planId}`;
  const worktreePath = join(XDG_DATA_DIR, projectId, `mc-integration-${planId}`);

  // Remove the worktree (force to handle any uncommitted changes)
  try {
    await removeWorktree(worktreePath, true);
  } catch (e) {
    // Ignore if worktree doesn't exist
  }

  // Delete the branch
  const deleteBranchResult = await gitCommand(['branch', '-D', branchName]);
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
 * Uses INTEGRATION_STALE_MS (not the 15s default): merge+test runs hold
 * the lock for minutes, and a stale break mid-run would corrupt the branch.
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
): Promise<{ success: boolean; conflicts?: string[] }> {
  const projectId = await getProjectId();
  const worktreePath = join(XDG_DATA_DIR, projectId, `mc-integration-${planId}`);

  // Fetch latest main from origin
  const fetchResult = await gitCommand(['-C', worktreePath, 'fetch', 'origin']);
  if (fetchResult.exitCode !== 0) {
    return { success: false, conflicts: ['Failed to fetch from origin'] };
  }

  // Attempt to rebase onto the default branch
  const defaultBranch = await getDefaultBranch();
  const rebaseResult = await gitCommand(['-C', worktreePath, 'rebase', `origin/${defaultBranch}`]);

  if (rebaseResult.exitCode !== 0) {
    // Extract conflicts from stderr
    const conflicts = extractConflicts(rebaseResult.stderr);

    // Abort the rebase to leave worktree clean
    await gitCommand(['-C', worktreePath, 'rebase', '--abort']).catch(() => {});

    return { success: false, conflicts };
  }

  return { success: true };
}

