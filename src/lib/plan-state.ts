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
export async function withPlanLock<T>(fn: () => Promise<T>, repoRoot?: string): Promise<T> {
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

/* ------------------------------------------------------------------ */
/* Conductor lease: durable proof that a live process owns the plan.   */
/* PID liveness alone never suffices (sonda 13): the new conductor     */
/* must claim (planId+pid+owner+timestamp) under the inter-process      */
/* lock and the handoff only completes after the claim is re-read.     */
/* Stored beside plan.json (no PlanSpec schema change) with its own    */
/* lockfile so plan.json writers and lease writers never interleave.   */
/* ------------------------------------------------------------------ */

const CONDUCTOR_FILE = 'conductor.json';

export interface ConductorLease {
  planId: string;
  pid: number;
  command: string;
  owner: string;
  acquiredAt: string;
}

async function getConductorFilePath(repoRoot?: string): Promise<string> {
  const dataDir = await getDataDir(repoRoot);
  return join(dataDir, CONDUCTOR_FILE);
}

/**
 * Claim conductor ownership for a plan (new driver proves assumption).
 * Overwrites any prior lease (last writer wins; the handoff verifies the
 * winner before the temp detaches, so a stale holder is never trusted).
 * Throws when no matching plan exists — the lease never points at nothing.
 */
export async function claimConductorLease(
  planId: string,
  pid: number,
  command: string,
  owner?: string,
  repoRoot?: string,
): Promise<ConductorLease> {
  const plan = await loadPlan(repoRoot);
  if (!plan) throw new Error(`Cannot claim conductor for plan "${planId}": no active plan.`);
  if (plan.id !== planId) {
    throw new Error(`Cannot claim conductor: plan ID mismatch (expected ${planId}, got ${plan.id}).`);
  }
  if (!Number.isFinite(pid) || pid <= 0) {
    throw new Error(`Cannot claim conductor for plan "${planId}": invalid pid ${pid}.`);
  }
  const lease: ConductorLease = {
    planId,
    pid,
    command,
    owner: owner ?? `pid-${pid}`,
    acquiredAt: new Date().toISOString(),
  };
  const filePath = await getConductorFilePath(repoRoot);
  await withFileLock(lockPathFor(filePath), async () => {
    await atomicWrite(filePath, JSON.stringify(lease, null, 2));
  });
  return lease;
}

/** Read the current conductor lease (null when never claimed). Never throws. */
export async function readConductorLease(repoRoot?: string): Promise<ConductorLease | null> {
  try {
    const filePath = await getConductorFilePath(repoRoot);
    const file = Bun.file(filePath);
    if (!(await file.exists())) return null;
    const parsed = JSON.parse(await file.text()) as ConductorLease;
    if (!parsed || parsed.planId === undefined || !Number.isFinite(parsed.pid)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function isPidAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Verify a lease: same plan, same pid, and that pid answers to signal 0.
 * PID-alive alone is NOT enough — the caller must also require this to be
 * true (the lease is the new conductor's proof of assumption).
 */
export async function verifyConductorLease(
  planId: string,
  pid: number,
  repoRoot?: string,
): Promise<boolean> {
  const lease = await readConductorLease(repoRoot);
  if (!lease) return false;
  if (lease.planId !== planId || lease.pid !== pid) return false;
  return isPidAlive(pid);
}

/** Remove the lease (test cleanup / explicit release). Never throws. */
export async function clearConductorLease(repoRoot?: string): Promise<void> {
  try {
    const filePath = await getConductorFilePath(repoRoot);
    const { acquireFileLock } = await import('./file-lock');
    const release = await acquireFileLock(lockPathFor(filePath));
    try {
      const fs = await import('fs');
      try {
        fs.unlinkSync(filePath);
      } catch {}
    } finally {
      await release();
    }
  } catch {}
}

/* ------------------------------------------------------------------ */
/* Atomic job dispatch claim (sonda 15). Two coordinators racing on    */
/* the same queued job must not both dispatch: only queued→running     */
/* under the plan lock succeeds; an already-claimed job returns       */
/* ok:false with its current status (never throws, never double-sets). */
/* shortcut: owner is recorded only in the lease/audit trail, not in  */
/* the JobSpec (no schema change); upgrade when JobSpec gains owner.   */
/* ------------------------------------------------------------------ */

export async function claimJobForDispatch(
  planId: string,
  jobName: string,
  owner: string,
  repoRoot?: string,
): Promise<{ ok: boolean; status: JobSpec['status'] }> {
  void owner;
  return withPlanLock(async () => {
    const plan = await loadPlan(repoRoot);
    if (!plan) throw new Error('No active plan exists');
    if (plan.id !== planId) {
      throw new Error(`Plan ID mismatch: expected ${planId}, got ${plan.id}`);
    }
    const jobIndex = plan.jobs.findIndex((j) => j.name === jobName || j.id === jobName);
    if (jobIndex === -1) {
      throw new Error(`Job "${jobName}" not found in plan "${plan.name}"`);
    }
    const current = plan.jobs[jobIndex].status;
    if (current !== 'queued') {
      return { ok: false as const, status: current };
    }
    if (!isValidJobTransition('queued', 'running')) {
      return { ok: false as const, status: current };
    }
    plan.jobs[jobIndex] = { ...plan.jobs[jobIndex], status: 'running' };
    const filePath = await getPlanFilePath(repoRoot);
    await atomicWrite(filePath, JSON.stringify(plan, null, 2));
    return { ok: true as const, status: 'running' as const };
  }, repoRoot);
}
