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
  /** Monotonic fencing epoch: takeover bumps, stale holder has smaller epoch. */
  epoch: number;
  /** Owner nonce: takeover rotates, stale holder's token stops matching. */
  token: string;
  /** Last liveness heartbeat (ISO). Fresh claim sets to acquiredAt. */
  lastHeartbeat: string;
  /** Last work-progress mark (ISO). Fresh claim sets to acquiredAt. */
  lastProgress: string;
}

export interface ConductorStaleOptions {
  maxHeartbeatMs?: number;
  maxProgressMs?: number;
}

export interface ConductorClaimOptions {
  expectedToken?: string;
  expectedEpoch?: number;
  force?: boolean;
}

export interface ConductorVerifyOptions extends ConductorStaleOptions {
  token?: string;
  epoch?: number;
}

export interface ConductorClearExpectation {
  token?: string;
  pid?: number;
}

/** Default: heartbeat 30min, progress 2h. Long healthy task heartbeats often;
 *  10h silence is stale. Only marks suspect — never kills (explicit action kills). */
export const DEFAULT_CONDUCTOR_MAX_HEARTBEAT_MS = 30 * 60 * 1000;
export const DEFAULT_CONDUCTOR_MAX_PROGRESS_MS = 2 * 60 * 60 * 1000;

function newConductorToken(pid: number): string {
  return `${pid}:${Date.now()}:${Math.random().toString(36).slice(2, 10)}`;
}

function parseLeaseTimeMs(value: unknown): number | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

function normalizeConductorLease(raw: unknown): ConductorLease | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r['planId'] !== 'string' || !Number.isFinite(r['pid'] as number)) return null;
  const pid = r['pid'] as number;
  if (pid <= 0) return null;
  const acquiredAt = typeof r['acquiredAt'] === 'string' ? (r['acquiredAt'] as string) : new Date().toISOString();
  const epochRaw = r['epoch'];
  const epoch = typeof epochRaw === 'number' && Number.isFinite(epochRaw) && epochRaw >= 0 ? Math.floor(epochRaw) : 0;
  const token = typeof r['token'] === 'string' && (r['token'] as string).length > 0 ? (r['token'] as string) : '';
  const lastHeartbeat = typeof r['lastHeartbeat'] === 'string' ? (r['lastHeartbeat'] as string) : acquiredAt;
  const lastProgress = typeof r['lastProgress'] === 'string' ? (r['lastProgress'] as string) : acquiredAt;
  return {
    planId: r['planId'] as string,
    pid,
    command: typeof r['command'] === 'string' ? (r['command'] as string) : '',
    owner: typeof r['owner'] === 'string' ? (r['owner'] as string) : `pid-${pid}`,
    acquiredAt,
    epoch,
    token,
    lastHeartbeat,
    lastProgress,
  };
}

/**
 * Staleness detector (pure): true when heartbeat OR progress is older than
 * its budget. Null/invalid lease counts as stale (no owner). Legacy leases
 * without heartbeat fields fall back to acquiredAt. Only marks — never kills.
 */
export function isStale(
  lease: ConductorLease | null | undefined,
  now?: number | Date | string,
  opts?: ConductorStaleOptions,
): boolean {
  if (!lease) return true;
  const nowMs =
    typeof now === 'number' ? now
    : now instanceof Date ? now.getTime()
    : typeof now === 'string' ? Date.parse(now)
    : Date.now();
  if (!Number.isFinite(nowMs)) return true;
  const maxHeartbeatMs = opts?.maxHeartbeatMs ?? DEFAULT_CONDUCTOR_MAX_HEARTBEAT_MS;
  const maxProgressMs = opts?.maxProgressMs ?? DEFAULT_CONDUCTOR_MAX_PROGRESS_MS;
  const hb = parseLeaseTimeMs(lease.lastHeartbeat) ?? parseLeaseTimeMs(lease.acquiredAt);
  const pg = parseLeaseTimeMs(lease.lastProgress) ?? parseLeaseTimeMs(lease.acquiredAt);
  if (hb === null || pg === null) return true;
  if (nowMs - hb > maxHeartbeatMs) return true;
  if (nowMs - pg > maxProgressMs) return true;
  return false;
}

async function getConductorFilePath(repoRoot?: string): Promise<string> {
  const dataDir = await getDataDir(repoRoot);
  return join(dataDir, CONDUCTOR_FILE);
}

/**
 * Claim conductor ownership with fencing (CAS under the inter-process lock).
 * - Same pid re-claim is idempotent: keeps epoch/token, refreshes heartbeat.
 * - Different pid takeover always bumps epoch + rotates token, so the old
 *   holder's token/epoch stops matching (fencing — old actions rejected).
 * - CAS: when expectedToken/expectedEpoch is supplied and the current lease
 *   is live+fresh, a mismatch throws instead of overwriting blindly.
 * Throws when no matching plan exists — the lease never points at nothing.
 */
export async function claimConductorLease(
  planId: string,
  pid: number,
  command: string,
  owner?: string,
  repoRoot?: string,
  opts?: ConductorClaimOptions,
): Promise<ConductorLease> {
  const plan = await loadPlan(repoRoot);
  if (!plan) throw new Error(`Cannot claim conductor for plan "${planId}": no active plan.`);
  if (plan.id !== planId) {
    throw new Error(`Cannot claim conductor: plan ID mismatch (expected ${planId}, got ${plan.id}).`);
  }
  if (!Number.isFinite(pid) || pid <= 0) {
    throw new Error(`Cannot claim conductor for plan "${planId}": invalid pid ${pid}.`);
  }
  const filePath = await getConductorFilePath(repoRoot);
  let result: ConductorLease | null = null;
  await withFileLock(lockPathFor(filePath), async () => {
    let current: ConductorLease | null = null;
    try {
      const file = Bun.file(filePath);
      if (await file.exists()) {
        current = normalizeConductorLease(JSON.parse(await file.text()));
      }
    } catch {
      current = null;
    }
    const nowIso = new Date().toISOString();
    if (current && current.planId === planId && current.pid === pid) {
      if (opts?.expectedToken !== undefined && current.token && opts.expectedToken !== current.token) {
        throw new Error(`Conductor lease fencing: stale token for pid ${pid} (epoch ${current.epoch}).`);
      }
      if (opts?.expectedEpoch !== undefined && opts.expectedEpoch !== current.epoch) {
        throw new Error(`Conductor lease fencing: stale epoch ${opts.expectedEpoch} (current ${current.epoch}).`);
      }
      result = {
        ...current,
        command,
        owner: owner ?? current.owner,
        lastHeartbeat: nowIso,
        lastProgress: current.lastProgress,
      };
      await atomicWrite(filePath, JSON.stringify(result, null, 2));
      return;
    }
    if (current && current.planId === planId) {
      const liveFresh = isPidAlive(current.pid) && !isStale(current);
      if (liveFresh && !opts?.force) {
        if (opts?.expectedToken !== undefined && current.token && opts.expectedToken !== current.token) {
          throw new Error(`Conductor lease held by live pid ${current.pid} (epoch ${current.epoch}).`);
        }
        if (opts?.expectedEpoch !== undefined && opts.expectedEpoch <= current.epoch) {
          throw new Error(`Conductor lease fencing: stale epoch ${opts.expectedEpoch} (current ${current.epoch}).`);
        }
      }
      const nextEpoch = (current.epoch ?? 0) + 1;
      result = {
        planId,
        pid,
        command,
        owner: owner ?? `pid-${pid}`,
        acquiredAt: nowIso,
        epoch: nextEpoch,
        token: newConductorToken(pid),
        lastHeartbeat: nowIso,
        lastProgress: nowIso,
      };
      await atomicWrite(filePath, JSON.stringify(result, null, 2));
      return;
    }
    const baseEpoch = current && current.planId === planId ? (current.epoch ?? 0) : 0;
    result = {
      planId,
      pid,
      command,
      owner: owner ?? `pid-${pid}`,
      acquiredAt: nowIso,
      epoch: baseEpoch + 1,
      token: newConductorToken(pid),
      lastHeartbeat: nowIso,
      lastProgress: nowIso,
    };
    await atomicWrite(filePath, JSON.stringify(result, null, 2));
  });
  if (!result) throw new Error(`Conductor claim failed for plan "${planId}".`);
  return result;
}

/** Read the current conductor lease (null when never claimed or invalid). Never throws. */
export async function readConductorLease(repoRoot?: string): Promise<ConductorLease | null> {
  try {
    const filePath = await getConductorFilePath(repoRoot);
    const file = Bun.file(filePath);
    if (!(await file.exists())) return null;
    const parsed = JSON.parse(await file.text()) as ConductorLease;
    return normalizeConductorLease(parsed);
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
 * Verify a lease: same plan, same pid, pid answers to signal 0, AND the
 * lease is fresh (heartbeat/progress within budget). When token/epoch is
 * supplied it must match — an old holder with a smaller epoch is rejected
 * (fencing). PID-alive alone is NOT enough.
 */
export async function verifyConductorLease(
  planId: string,
  pid: number,
  repoRoot?: string,
  opts?: ConductorVerifyOptions,
): Promise<boolean> {
  const effectiveRoot = typeof repoRoot === 'object' && repoRoot !== null && opts === undefined
    ? undefined
    : repoRoot;
  const effectiveOpts = typeof repoRoot === 'object' && repoRoot !== null && opts === undefined
    ? (repoRoot as unknown as ConductorVerifyOptions)
    : opts;
  const lease = await readConductorLease(effectiveRoot);
  if (!lease) return false;
  if (lease.planId !== planId || lease.pid !== pid) return false;
  if (effectiveOpts?.token !== undefined && lease.token && effectiveOpts.token !== lease.token) return false;
  if (effectiveOpts?.epoch !== undefined && effectiveOpts.epoch !== lease.epoch) return false;
  if (!isPidAlive(pid)) return false;
  if (isStale(lease, Date.now(), effectiveOpts)) return false;
  return true;
}

/**
 * Refresh liveness without changing ownership. Throws on fencing mismatch
 * (wrong token) or when no lease exists — a stale holder cannot heartbeat
 * its way back into ownership.
 */
export async function recordHeartbeat(
  planId: string,
  pid: number,
  repoRoot?: string,
  opts?: { token?: string },
): Promise<ConductorLease> {
  const filePath = await getConductorFilePath(repoRoot);
  let result: ConductorLease | null = null;
  await withFileLock(lockPathFor(filePath), async () => {
    const file = Bun.file(filePath);
    if (!(await file.exists())) throw new Error(`No conductor lease for plan "${planId}".`);
    const current = normalizeConductorLease(JSON.parse(await file.text()));
    if (!current || current.planId !== planId || current.pid !== pid) {
      throw new Error(`Conductor lease fencing: pid ${pid} does not own plan "${planId}".`);
    }
    if (opts?.token !== undefined && current.token && opts.token !== current.token) {
      throw new Error(`Conductor lease fencing: stale token for pid ${pid} (epoch ${current.epoch}).`);
    }
    result = { ...current, lastHeartbeat: new Date().toISOString() };
    await atomicWrite(filePath, JSON.stringify(result, null, 2));
  });
  if (!result) throw new Error(`Heartbeat failed for plan "${planId}".`);
  return result;
}

/** Mark work progress (also refreshes heartbeat — progress proves liveness). */
export async function recordProgress(
  planId: string,
  pid: number,
  repoRoot?: string,
  opts?: { token?: string },
): Promise<ConductorLease> {
  const filePath = await getConductorFilePath(repoRoot);
  let result: ConductorLease | null = null;
  await withFileLock(lockPathFor(filePath), async () => {
    const file = Bun.file(filePath);
    if (!(await file.exists())) throw new Error(`No conductor lease for plan "${planId}".`);
    const current = normalizeConductorLease(JSON.parse(await file.text()));
    if (!current || current.planId !== planId || current.pid !== pid) {
      throw new Error(`Conductor lease fencing: pid ${pid} does not own plan "${planId}".`);
    }
    if (opts?.token !== undefined && current.token && opts.token !== current.token) {
      throw new Error(`Conductor lease fencing: stale token for pid ${pid} (epoch ${current.epoch}).`);
    }
    const nowIso = new Date().toISOString();
    result = { ...current, lastHeartbeat: nowIso, lastProgress: nowIso };
    await atomicWrite(filePath, JSON.stringify(result, null, 2));
  });
  if (!result) throw new Error(`Progress mark failed for plan "${planId}".`);
  return result;
}

/**
 * Remove the lease. When an expectation is supplied, only removes when it
 * matches (fencing) — a stale holder cannot clear the new owner's lease.
 * Without expectation keeps legacy behavior (unconditional, test cleanup).
 * Never throws.
 */
export async function clearConductorLease(
  repoRoot?: string,
  expected?: ConductorClearExpectation | string,
): Promise<void> {
  try {
    const effectiveRoot = typeof repoRoot === 'object' && repoRoot !== null && expected === undefined
      ? undefined
      : (repoRoot as string | undefined);
    const effectiveExpected = typeof repoRoot === 'object' && repoRoot !== null && expected === undefined
      ? (repoRoot as unknown as ConductorClearExpectation)
      : expected;
    const filePath = await getConductorFilePath(effectiveRoot);
    const { acquireFileLock } = await import('./file-lock');
    const release = await acquireFileLock(lockPathFor(filePath));
    try {
      const fs = await import('fs');
      if (effectiveExpected !== undefined) {
        try {
          const raw = fs.readFileSync(filePath, 'utf8');
          const current = normalizeConductorLease(JSON.parse(raw));
          if (current) {
            const wantToken = typeof effectiveExpected === 'string'
              ? effectiveExpected
              : effectiveExpected.token;
            const wantPid = typeof effectiveExpected === 'string' ? undefined : effectiveExpected.pid;
            if (wantToken !== undefined && current.token && wantToken !== current.token) return;
            if (wantPid !== undefined && wantPid !== current.pid) return;
          }
        } catch {}
      }
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
