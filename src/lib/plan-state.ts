import { join } from 'path';
import { z } from 'zod';
import { getDataDir } from './paths';
import { withFileLock, lockPathFor } from './file-lock';
import type { PlanSpec, JobSpec, CheckpointContext } from './plan-types';
import { isValidPlanTransition, isValidJobTransition } from './plan-types';
import { PlanSpecSchema } from './schemas';
import { atomicWrite } from './utils';

const PLAN_FILE = 'plan.json';

/** Cross-process lock for plan.json read-modify-write cycles (see file-lock.ts). */
async function withPlanLock<T>(fn: () => Promise<T>, repoRoot?: string): Promise<T> {
  const dataDir = await getDataDir(repoRoot);
  return withFileLock(lockPathFor(join(dataDir, PLAN_FILE)), fn);
}

async function getPlanFilePath(repoRoot?: string): Promise<string> {
  const dataDir = await getDataDir(repoRoot);
  return join(dataDir, PLAN_FILE);
}



export async function loadPlan(repoRoot?: string): Promise<PlanSpec | null> {
  const filePath = await getPlanFilePath(repoRoot);
  const file = Bun.file(filePath);
  const exists = await file.exists();

  if (!exists) {
    return null;
  }

  try {
    const content = await file.text();
    const parsed = JSON.parse(content);
    return PlanSpecSchema.parse(parsed);
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new Error(`Invalid plan state in ${filePath}: ${error.issues.map(e => `${e.path.join('.')}: ${e.message}`).join(', ')}`);
    }
    throw new Error(`Failed to load plan state from ${filePath}: ${error}`);
  }
}

export async function savePlan(plan: PlanSpec, repoRoot?: string): Promise<void> {
  await withPlanLock(async () => {
    const existing = await loadPlan(repoRoot);

    if (existing && existing.id !== plan.id) {
      throw new Error('active plan already exists');
    }

    if (existing && existing.status !== plan.status) {
      if (!isValidPlanTransition(existing.status, plan.status)) {
        console.warn(`[MC] Invalid plan transition: ${existing.status} → ${plan.status} (plan: ${plan.name})`);
      }
    }

    const ghAuthenticated = await validateGhAuth();
    const planToSave = { ...plan, ghAuthenticated };

    const filePath = await getPlanFilePath(repoRoot);
    try {
      const data = JSON.stringify(planToSave, null, 2);
      await atomicWrite(filePath, data);
    } catch (error) {
      throw new Error(`Failed to save plan state to ${filePath}: ${error}`);
    }
  }, repoRoot);
}

export async function getActivePlan(repoRoot?: string): Promise<PlanSpec | null> {
  return loadPlan(repoRoot);
}

export async function updatePlanJob(
  planId: string,
  jobName: string,
  updates: Partial<JobSpec>,
  opts?: { force?: boolean },
  repoRoot?: string,
): Promise<void> {
  // Back-compat: updatePlanJob(id, name, updates, "repoRoot-string") treats 4th arg as repoRoot.
  const effectiveRepo = typeof opts === 'string' ? (opts as unknown as string) : repoRoot;
  const effectiveOpts = typeof opts === 'string' ? undefined : opts;
  await withPlanLock(async () => {
    const plan = await loadPlan(effectiveRepo);

    if (!plan) {
      throw new Error('No active plan exists');
    }

    if (plan.id !== planId) {
      throw new Error(
        `Plan ID mismatch: expected ${planId}, got ${plan.id}`,
      );
    }

    const jobIndex = plan.jobs.findIndex((j) => j.name === jobName);
    if (jobIndex === -1) {
      throw new Error(`Job "${jobName}" not found in plan "${plan.name}"`);
    }

    if (updates.status && updates.status !== plan.jobs[jobIndex].status) {
      if (!isValidJobTransition(plan.jobs[jobIndex].status, updates.status)) {
        const msg = `[MC] Invalid job transition: ${plan.jobs[jobIndex].status} → ${updates.status} (job: ${jobName})`;
        if (!effectiveOpts?.force) {
          // Fail-closed: an invalid transition is a bug, never a state to
          // persist. Reject without applying so a skipped gate (e.g.
          // queued → merged) cannot mark work integrated. Recovery paths
          // that must force a terminal state (launch failure from
          // queued/waiting_deps) pass { force: true } explicitly.
          throw new Error(`Invalid job transition: ${plan.jobs[jobIndex].status} → ${updates.status} (job: ${jobName})`);
        }
        console.warn(`${msg} (forced recovery)`);
      }
    }

    plan.jobs[jobIndex] = {
      ...plan.jobs[jobIndex],
      ...updates,
    };

    const filePath = await getPlanFilePath(effectiveRepo);
    try {
      const data = JSON.stringify(plan, null, 2);
      await atomicWrite(filePath, data);
    } catch (error) {
      throw new Error(`Failed to save plan state to ${filePath}: ${error}`);
    }
  }, effectiveRepo);
}

export interface PlanFieldUpdates {
  status?: PlanSpec['status'];
  checkpoint?: PlanSpec['checkpoint'];
  checkpointContext?: CheckpointContext | null;
  completedAt?: string;
  prUrl?: string;
  auditLog?: PlanSpec['auditLog'];
}

/**
 * Atomically update plan-level fields without overwriting job states.
 *
 * Unlike savePlan(), this reads the current plan inside the mutex and merges
 * only the specified fields. This prevents a stale plan snapshot from clobbering
 * concurrent updatePlanJob() writes — the root cause of completed jobs appearing
 * as "running" after a sibling job failed (see #63).
 */
export async function updatePlanFields(
  planId: string,
  updates: PlanFieldUpdates,
  repoRoot?: string,
): Promise<void> {
  await withPlanLock(async () => {
    const plan = await loadPlan(repoRoot);

    if (!plan) {
      throw new Error('No active plan exists');
    }

    if (plan.id !== planId) {
      throw new Error(
        `Plan ID mismatch: expected ${planId}, got ${plan.id}`,
      );
    }

    if (updates.status !== undefined && updates.status !== plan.status) {
      if (!isValidPlanTransition(plan.status, updates.status)) {
        console.warn(`[MC] Invalid plan transition: ${plan.status} → ${updates.status} (plan: ${plan.name})`);
      }
      plan.status = updates.status;
    }
    if (updates.checkpoint !== undefined) {
      plan.checkpoint = updates.checkpoint;
    }
    if (updates.checkpointContext !== undefined) {
      plan.checkpointContext = updates.checkpointContext;
    }
    if (updates.completedAt !== undefined) {
      plan.completedAt = updates.completedAt;
    }
    if (updates.prUrl !== undefined) {
      plan.prUrl = updates.prUrl;
    }

    const ghAuthenticated = await validateGhAuth();
    const planToSave = { ...plan, ghAuthenticated };

    const filePath = await getPlanFilePath(repoRoot);
    try {
      const data = JSON.stringify(planToSave, null, 2);
      await atomicWrite(filePath, data);
    } catch (error) {
      throw new Error(`Failed to save plan state to ${filePath}: ${error}`);
    }
  }, repoRoot);
}

export async function clearPlan(repoRoot?: string): Promise<void> {
  await withPlanLock(async () => {
    const filePath = await getPlanFilePath(repoRoot);
    const fs = await import('fs');
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  }, repoRoot);
}

export async function validateGhAuth(): Promise<boolean> {
  try {
    const proc = Bun.spawn(['gh', 'auth', 'status'], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const exitCode = await proc.exited;
    return exitCode === 0;
  } catch {
    return false;
  }
}
