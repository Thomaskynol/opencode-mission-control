import { join, dirname } from 'path';
import { z } from 'zod';
import { getDataDir } from './paths';
import { withFileLock, lockPathFor } from './file-lock';
import type { PlanSpec, JobSpec, CheckpointContext } from './plan-types';
import { isValidPlanTransition, isValidJobTransition } from './plan-types';
import { PlanSpecSchema } from './schemas';
import { atomicWrite } from './utils';

const PLAN_FILE = 'plan.json';

/** Fencing identity for writes: must match the live conductor lease. */
export interface PlanFencing {
  token?: string;
  epoch?: number;
  pid?: number;
}

/* ------------------------------------------------------------------ */
/* R6 real-entry test-env contract. A generic NODE_ENV=test/VITEST=true */
/* inherited from the launcher shell silently disables production       */
/* guarantees (conductor fencing bypasses, external reviewer skipped).  */
/* Real entries (CLI start/resume/approve in orchestrator-cli/index.ts) */
/* refuse fail-closed under that env; unit fakes keep using isTestScope */
/* in-process. Escape hatch for explicitly-scoped runs only:            */
/* MC_ALLOW_TEST_ENV=1 (non-generic, documented here and at the gates). */
/* ------------------------------------------------------------------ */

/** True when a generic test env var is present (Bun sets NODE_ENV=test under `bun test`). */
export function isTestEnvPresent(): boolean {
  return process.env.NODE_ENV === 'test' || process.env.VITEST === 'true';
}

/** Explicit non-generic override for deliberately test-scoped runs. */
export function isTestEnvAllowed(): boolean {
  return process.env.MC_ALLOW_TEST_ENV === '1';
}

/**
 * Fail-closed gate for REAL entry points: throws when a generic test env
 * is present without the explicit MC_ALLOW_TEST_ENV=1 override. Call at
 * process boundaries (CLI main), never in library call paths unit tests
 * exercise directly.
 */
export function assertRealEntryEnv(entry: string): void {
  if (isTestEnvPresent() && !isTestEnvAllowed()) {
    throw new Error(
      `[MC] Refusing ${entry}: NODE_ENV=test/VITEST=true disables production guarantees ` +
        `(conductor fencing, external review). Unset the variable for real runs, or set ` +
        `MC_ALLOW_TEST_ENV=1 for an explicitly-scoped test run.`,
    );
  }
}

/**
 * Fail-closed fencing: when a conductor lease exists for this plan, a write
 * without a matching token/epoch is a stale-holder write and is rejected.
 * No lease (or lease for a different plan) allows the write (plan creation
 * happens before the first claim; legacy callers without a lease keep working).
 * Owner-process fast path: a write from the lease owner pid without explicit
 * fencing is allowed (orchestrator legacy paths run in the owner process);
 * any other pid without fencing is rejected. Explicit fencing must always match.
 */
export async function assertPlanFencing(
  planId: string,
  repoRoot?: string,
  fencing?: PlanFencing,
): Promise<void> {
  const lease = await readConductorLease(repoRoot);
  if (!lease) return;
  if (lease.planId !== planId) return;
  if (!fencing) {
    if (process.pid === lease.pid) return;
    throw new Error(
      `Conductor lease fencing: write to plan "${planId}" requires fencing (epoch ${lease.epoch}) — stale holder without token rejected.`,
    );
  }
  if (lease.token && fencing.token !== lease.token) {
    throw new Error(
      `Conductor lease fencing: stale token for plan "${planId}" (epoch ${lease.epoch}) — write rejected.`,
    );
  }
  if (fencing.epoch !== lease.epoch) {
    throw new Error(
      `Conductor lease fencing: stale epoch ${String(fencing.epoch)} (current ${lease.epoch}) for plan "${planId}" — write rejected.`,
    );
  }
  if (fencing.pid !== undefined && fencing.pid !== lease.pid) {
    throw new Error(
      `Conductor lease fencing: pid ${fencing.pid} does not own plan "${planId}" (owner ${lease.pid}) — write rejected.`,
    );
  }
}

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

export async function savePlan(plan: PlanSpec, repoRoot?: string, fencing?: PlanFencing): Promise<void>;
export async function savePlan(plan: PlanSpec, fencing?: PlanFencing): Promise<void>;
export async function savePlan(plan: PlanSpec, repoRoot?: string | PlanFencing, fencing?: PlanFencing): Promise<void> {
  const effectiveFencing: PlanFencing | undefined =
    fencing ?? (typeof repoRoot === 'object' && repoRoot !== null ? (repoRoot as PlanFencing) : undefined);
  const effectiveRepo: string | undefined =
    typeof repoRoot === 'string' ? repoRoot : undefined;
  await withPlanLock(async () => {
    const existing = await loadPlan(effectiveRepo);

    if (existing && existing.id !== plan.id) {
      throw new Error('active plan already exists');
    }

    if (existing && existing.id === plan.id) {
      await assertPlanFencing(plan.id, effectiveRepo, effectiveFencing);
    }

    if (existing && existing.status !== plan.status) {
      if (!isValidPlanTransition(existing.status, plan.status)) {
        console.warn(`[MC] Invalid plan transition: ${existing.status} → ${plan.status} (plan: ${plan.name})`);
      }
    }

    const ghAuthenticated = await validateGhAuth();
    const planToSave = { ...plan, ghAuthenticated };

    const filePath = await getPlanFilePath(effectiveRepo);
    try {
      const data = JSON.stringify(planToSave, null, 2);
      await atomicWrite(filePath, data);
    } catch (error) {
      throw new Error(`Failed to save plan state to ${filePath}: ${error}`);
    }
  }, effectiveRepo);
}

export async function getActivePlan(repoRoot?: string): Promise<PlanSpec | null> {
  return loadPlan(repoRoot);
}

export async function updatePlanJob(
  planId: string,
  jobName: string,
  updates: Partial<JobSpec>,
  opts?: { force?: boolean; fencing?: PlanFencing } | string,
  repoRoot?: string,
  fencing?: PlanFencing,
): Promise<void> {
  // Back-compat: updatePlanJob(id, name, updates, "repoRoot-string") treats 4th arg as repoRoot.
  const effectiveRepo = typeof opts === 'string' ? (opts as unknown as string) : repoRoot;
  const effectiveOpts = typeof opts === 'string' ? undefined : opts;
  const effectiveFencing: PlanFencing | undefined =
    fencing ?? effectiveOpts?.fencing;
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

    await assertPlanFencing(planId, effectiveRepo, effectiveFencing);

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
  repoRoot?: string | PlanFencing,
  fencing?: PlanFencing,
): Promise<void> {
  const effectiveFencing: PlanFencing | undefined =
    fencing ?? (typeof repoRoot === 'object' && repoRoot !== null ? (repoRoot as PlanFencing) : undefined);
  const effectiveRepo: string | undefined =
    typeof repoRoot === 'string' ? repoRoot : undefined;
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

    await assertPlanFencing(planId, effectiveRepo, effectiveFencing);

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
    if (updates.auditLog !== undefined) {
      plan.auditLog = updates.auditLog;
    }

    const ghAuthenticated = await validateGhAuth();
    const planToSave = { ...plan, ghAuthenticated };

    const filePath = await getPlanFilePath(effectiveRepo);
    try {
      const data = JSON.stringify(planToSave, null, 2);
      await atomicWrite(filePath, data);
    } catch (error) {
      throw new Error(`Failed to save plan state to ${filePath}: ${error}`);
    }
  }, effectiveRepo);
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
      const liveFresh = isConductorPidAlive(current.pid) && !isStale(current);
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
    return await readConductorLeaseFile(filePath);
  } catch {
    return null;
  }
}

/** Read a lease from an explicit data dir (merge-train derives its scope from the worktree path). */
export async function readConductorLeaseFromDir(dataDir: string): Promise<ConductorLease | null> {
  try {
    return await readConductorLeaseFile(join(dataDir, CONDUCTOR_FILE));
  } catch {
    return null;
  }
}

async function readConductorLeaseFile(filePath: string): Promise<ConductorLease | null> {
  try {
    const file = Bun.file(filePath);
    if (!(await file.exists())) return null;
    const parsed = JSON.parse(await file.text()) as ConductorLease;
    return normalizeConductorLease(parsed);
  } catch {
    return null;
  }
}

/**
 * Liveness probe: true when signal 0 reaches the pid.
 * LIMIT (pid reuse): the OS may recycle a dead holder's pid for an
 * unrelated process, in which case signal 0 answers and the lease looks
 * alive. Safe direction: a (possibly recycled) live pid is never reaped —
 * the takeover path (epoch bump via claim) stays available, and verify
 * paths additionally require token/epoch match, so a recycled pid alone
 * never authenticates a stale holder.
 */
export function isConductorPidAlive(pid: number): boolean {
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
  if (!isConductorPidAlive(pid)) return false;
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
  opts?: { token?: string; epoch?: number },
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
    if (opts?.epoch !== undefined && opts.epoch !== current.epoch) {
      throw new Error(`Conductor lease fencing: stale epoch ${opts.epoch} (current ${current.epoch}) for plan "${planId}".`);
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
  opts?: { token?: string; epoch?: number },
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
    if (opts?.epoch !== undefined && opts.epoch !== current.epoch) {
      throw new Error(`Conductor lease fencing: stale epoch ${opts.epoch} (current ${current.epoch}) for plan "${planId}".`);
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
/* R2 point-of-effect fencing for merges. The merge train threads this    */
/* identity to the git effect and re-reads the lease FRESH immediately    */
/* before merge/commit/rollback — never trusting the reconcile-start      */
/* check or the integration lock alone (a lock serializes writers but     */
/* never proves the writer is still the conductor). A stale holder is     */
/* refused with no git/state effect. Liveness staleness windows are NOT   */
/* required here: the calling process is demonstrably alive while         */
/* executing the merge; step-down on silence stays the reconciler's job.  */
/* ------------------------------------------------------------------ */

export interface MergeFencingIdentity {
  planId: string;
  /** Repo scope for the lease lookup (preferred when the caller knows it). */
  repoRoot?: string;
  /** Data-dir scope (merge-train derives it from the worktree path). */
  dataDir?: string;
  token?: string;
  epoch?: number;
  pid?: number;
}

export async function verifyMergeFencing(
  fencing: MergeFencingIdentity,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const lease = fencing.dataDir !== undefined
    ? await readConductorLeaseFromDir(fencing.dataDir)
    : await readConductorLease(fencing.repoRoot);
  if (!lease || lease.planId !== fencing.planId) return { ok: true };
  const held = `held by pid ${lease.pid} (epoch ${lease.epoch})`;
  if (fencing.token === undefined && fencing.epoch === undefined && fencing.pid === undefined) {
    return {
      ok: false,
      reason: `Conductor lease fencing: anonymous merge for plan "${fencing.planId}" refused (${held}) — stale holder without fencing identity.`,
    };
  }
  if (fencing.token !== undefined && lease.token && fencing.token !== lease.token) {
    return {
      ok: false,
      reason: `Conductor lease fencing: stale token for plan "${fencing.planId}" (${held}) — merge refused.`,
    };
  }
  if (fencing.epoch !== undefined && fencing.epoch !== lease.epoch) {
    return {
      ok: false,
      reason: `Conductor lease fencing: stale epoch ${fencing.epoch} (current ${lease.epoch}) for plan "${fencing.planId}" — merge refused.`,
    };
  }
  if (fencing.pid !== undefined && fencing.pid !== lease.pid) {
    return {
      ok: false,
      reason: `Conductor lease fencing: pid ${fencing.pid} does not own plan "${fencing.planId}" (owner ${lease.pid}) — merge refused.`,
    };
  }
  if (!isConductorPidAlive(lease.pid)) {
    return {
      ok: false,
      reason: `Conductor lease fencing: owner pid ${lease.pid} of plan "${fencing.planId}" is dead — reap the lease before merging.`,
    };
  }
  return { ok: true };
}

export interface ConductorReapResult {
  reaped: boolean;
  reason: string;
  prev?: ConductorLease;
  next?: ConductorLease | null;
  auditLogged?: boolean;
}

/**
 * R2 recovery without manual `rm`: atomically replace a dead holder's lease.
 * Safe direction only — reaps when signal 0 proves the holder pid dead, bumps
 * the epoch (stale holders stay fenced), rotates the token, and appends a
 * `conductor-reaped` entry to conductor-audit.jsonl beside the lease. A live
 * holder (or a recycled pid that answers signal 0) is NEVER reaped — see the
 * isConductorPidAlive limit; use the takeover claim path for live holders.
 */
export async function reapConductorLeaseIfDead(
  planId: string,
  repoRoot?: string,
  opts?: { pid?: number; owner?: string; command?: string },
): Promise<ConductorReapResult> {
  const filePath = await getConductorFilePath(repoRoot);
  let result: ConductorReapResult = { reaped: false, reason: 'unknown' };
  await withFileLock(lockPathFor(filePath), async () => {
    const current = await readConductorLeaseFile(filePath);
    if (!current) {
      result = { reaped: false, reason: 'no-lease' };
      return;
    }
    if (current.planId !== planId) {
      result = { reaped: false, reason: 'plan-mismatch', prev: current };
      return;
    }
    if (isConductorPidAlive(current.pid)) {
      result = { reaped: false, reason: 'holder-alive', prev: current };
      return;
    }
    const nowIso = new Date().toISOString();
    const pid = opts?.pid ?? process.pid;
    const next: ConductorLease = {
      planId,
      pid,
      command: opts?.command ?? `reap dead pid ${current.pid}`,
      owner: opts?.owner ?? `reap:${process.pid}`,
      acquiredAt: nowIso,
      epoch: current.epoch + 1,
      token: newConductorToken(pid),
      lastHeartbeat: nowIso,
      lastProgress: nowIso,
    };
    await atomicWrite(filePath, JSON.stringify(next, null, 2));
    let auditLogged = false;
    try {
      const fs = await import('fs');
      const line = JSON.stringify({
        ts: nowIso,
        event: 'conductor-reaped',
        planId,
        prevPid: current.pid,
        prevEpoch: current.epoch,
        nextPid: next.pid,
        nextEpoch: next.epoch,
        byPid: process.pid,
      }) + '\n';
      fs.appendFileSync(join(dirname(filePath), 'conductor-audit.jsonl'), line);
      auditLogged = true;
    } catch (error) {
      console.warn(`[MC] conductor reap audit append failed for plan "${planId}": ${error instanceof Error ? error.message : String(error)}`);
    }
    result = { reaped: true, reason: 'reaped-dead-holder', prev: current, next, auditLogged };
  });
  return result;
}

export interface ConductorTakeoverResult {
  lease: ConductorLease;
  prev: ConductorLease | null;
  auditLogged: boolean;
}

/**
 * G2 legitimate takeover: an explicit operator intent (e.g. `approve
 * --takeover`) atomically replaces the holder — live or dead — with an
 * epoch bump + token rotation, and appends a `conductor-takeover` audit
 * line beside the lease. Never a silent `rm`: the previous owner stays
 * fenced (stale token/epoch rejected) and the switch is auditable.
 * Fails closed when no plan or no lease exists.
 */
export async function takeoverConductorLease(
  planId: string,
  pid: number,
  command: string,
  owner: string,
  repoRoot?: string,
  reason?: string,
): Promise<ConductorTakeoverResult> {
  const plan = await loadPlan(repoRoot);
  if (!plan) throw new Error(`Cannot takeover conductor for plan "${planId}": no active plan.`);
  if (plan.id !== planId) {
    throw new Error(`Cannot takeover conductor: plan ID mismatch (expected ${planId}, got ${plan.id}).`);
  }
  if (!Number.isFinite(pid) || pid <= 0) {
    throw new Error(`Cannot takeover conductor for plan "${planId}": invalid pid ${pid}.`);
  }
  const prev = await readConductorLease(repoRoot).catch(() => null);
  if (!prev || prev.planId !== planId) {
    throw new Error(`Cannot takeover conductor for plan "${planId}": no lease to take over.`);
  }
  const lease = await claimConductorLease(planId, pid, command, owner, repoRoot, { force: true });
  let auditLogged = false;
  try {
    const filePath = await getConductorFilePath(repoRoot);
    const fs = await import('fs');
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      event: 'conductor-takeover',
      planId,
      reason: reason ?? command,
      prevPid: prev.pid,
      prevEpoch: prev.epoch,
      nextPid: lease.pid,
      nextEpoch: lease.epoch,
      byPid: pid,
    }) + '\n';
    fs.appendFileSync(join(dirname(filePath), 'conductor-audit.jsonl'), line);
    auditLogged = true;
  } catch (error) {
    console.warn(`[MC] conductor takeover audit append failed for plan "${planId}": ${error instanceof Error ? error.message : String(error)}`);
  }
  return { lease, prev, auditLogged };
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
  repoRoot?: string | PlanFencing,
  fencing?: PlanFencing,
): Promise<{ ok: boolean; status: JobSpec['status'] }> {
  void owner;
  const effectiveFencing: PlanFencing | undefined =
    fencing ?? (typeof repoRoot === 'object' && repoRoot !== null ? (repoRoot as PlanFencing) : undefined);
  const effectiveRepo: string | undefined =
    typeof repoRoot === 'string' ? repoRoot : undefined;
  return withPlanLock(async () => {
    const plan = await loadPlan(effectiveRepo);
    if (!plan) throw new Error('No active plan exists');
    if (plan.id !== planId) {
      throw new Error(`Plan ID mismatch: expected ${planId}, got ${plan.id}`);
    }
    await assertPlanFencing(planId, effectiveRepo, effectiveFencing);
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
    const filePath = await getPlanFilePath(effectiveRepo);
    await atomicWrite(filePath, JSON.stringify(plan, null, 2));
    return { ok: true as const, status: 'running' as const };
  }, effectiveRepo);
}

/* ------------------------------------------------------------------ */
/* Review auto-fix attempts (M9): durable per-job counter beside        */
/* plan.json. The conductor is one-shot per retry, so a per-process    */
/* Map resets prev.attempts to 0 on every retry ("attempt 1/2" forever, */
/* budget never exhausts). Persisted {attempts,lastSignature} per      */
/* plan+job: retry preserves, the budget exhausts, pass clears.        */
/* Sidecar (not JobSpec) so no schema change is needed; keyed by       */
/* plan+job. Reads never throw (absent/corrupt → null → fresh start).  */
/* ------------------------------------------------------------------ */

const REVIEW_ATTEMPTS_FILE = 'review-attempts.json';

export interface ReviewAttemptRecord {
  attempts: number;
  lastSignature: string;
}

function normalizeReviewAttempt(raw: unknown): ReviewAttemptRecord | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (!Number.isInteger(r['attempts']) || (r['attempts'] as number) < 0) return null;
  if (typeof r['lastSignature'] !== 'string') return null;
  return { attempts: r['attempts'] as number, lastSignature: r['lastSignature'] as string };
}

async function getReviewAttemptsFilePath(repoRoot?: string): Promise<string> {
  const dataDir = await getDataDir(repoRoot);
  return join(dataDir, REVIEW_ATTEMPTS_FILE);
}

async function readReviewAttemptsFile(filePath: string): Promise<Record<string, Record<string, ReviewAttemptRecord>>> {
  try {
    const file = Bun.file(filePath);
    if (!(await file.exists())) return {};
    const parsed: unknown = JSON.parse(await file.text());
    if (!parsed || typeof parsed !== 'object') return {};
    const out: Record<string, Record<string, ReviewAttemptRecord>> = {};
    for (const [planId, jobs] of Object.entries(parsed as Record<string, unknown>)) {
      if (!jobs || typeof jobs !== 'object') continue;
      for (const [jobName, rec] of Object.entries(jobs as Record<string, unknown>)) {
        const norm = normalizeReviewAttempt(rec);
        if (!norm) continue;
        (out[planId] ??= {})[jobName] = norm;
      }
    }
    return out;
  } catch {
    return {};
  }
}

/** Load the persisted review attempts for a job (null when never recorded). Never throws. */
export async function loadReviewAttempt(
  planId: string,
  jobName: string,
  repoRoot?: string,
): Promise<ReviewAttemptRecord | null> {
  try {
    const filePath = await getReviewAttemptsFilePath(repoRoot);
    const all = await readReviewAttemptsFile(filePath);
    return all[planId]?.[jobName] ?? null;
  } catch {
    return null;
  }
}

/** Persist the review attempts for a job (retry preserves; pass clears via clearReviewAttempt). */
export async function saveReviewAttempt(
  planId: string,
  jobName: string,
  record: ReviewAttemptRecord,
  repoRoot?: string,
): Promise<void> {
  const norm = normalizeReviewAttempt(record);
  if (!norm) throw new Error(`Invalid review attempt record for job "${jobName}" (attempts must be an integer >= 0).`);
  const filePath = await getReviewAttemptsFilePath(repoRoot);
  await withFileLock(lockPathFor(filePath), async () => {
    const all = await readReviewAttemptsFile(filePath);
    (all[planId] ??= {})[jobName] = norm;
    await atomicWrite(filePath, JSON.stringify(all, null, 2));
  });
}

/** Clear the persisted review attempts for a job (review pass). Never throws. */
export async function clearReviewAttempt(
  planId: string,
  jobName: string,
  repoRoot?: string,
): Promise<void> {
  try {
    const filePath = await getReviewAttemptsFilePath(repoRoot);
    await withFileLock(lockPathFor(filePath), async () => {
      const all = await readReviewAttemptsFile(filePath);
      if (all[planId]?.[jobName] === undefined) return;
      delete all[planId][jobName];
      if (Object.keys(all[planId]).length === 0) delete all[planId];
      await atomicWrite(filePath, JSON.stringify(all, null, 2));
    });
  } catch {}
}
