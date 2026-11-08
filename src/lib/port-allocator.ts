import { join } from 'path';
import { getDataDir } from './paths';
import { withFileLock, lockPathFor } from './file-lock';
import { atomicWrite } from './utils';
import type { MCConfig } from './config';
import type { Job } from './job-state';

const LOCK_FILE = 'port.lock';
const AUDIT_FILE = 'port-audit.jsonl';

/**
 * Blocker 3: owned port-lock entries. The legacy `number[]` format stored no
 * owner — a dead holder leaked the port forever, and any second process
 * could release someone else's live port. Entries now carry the allocating
 * pid + timestamp; legacy arrays still read (pid unknown) and rewrite on
 * the next allocation.
 */
export interface PortLockEntry {
  port: number;
  /** Allocating pid; 0 = legacy entry with unknown owner. */
  pid: number;
  /** ISO timestamp of allocation ('' when derived from a legacy entry). */
  ts: string;
}

export interface AllocateOptions {
  /** Owner recorded on the entry (defaults to process.pid). */
  ownerPid?: number;
}

export interface ReleaseOptions {
  /** Releaser identity (defaults to process.pid). */
  ownerPid?: number;
  /**
   * Operator override for paths that just destroyed the server (kill,
   * cleanup of completed jobs): removes even a live-holder entry, audited
   * as `release-forced`. Never the default — a plain release of a live
   * foreign port is refused.
   */
  force?: boolean;
}

export interface ReleaseResult {
  released: boolean;
  reason: string;
}

/**
 * Stale budget for ownerless (legacy) entries: without a pid there is no
 * liveness probe, so only age (lock-file mtime at read) justifies a reap.
 * Known-pid entries never age out while the holder is alive.
 */
export const PORT_LOCK_TTL_MS = 2 * 60 * 60 * 1000;

/** Liveness probe: signal 0 reaches the pid. Unknown pids fail closed (dead). */
export function isPidAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Cross-process lock for port allocation (see file-lock.ts).
 * Serializes read-modify-write cycles on port.lock across processes so
 * two concurrent launches can never allocate the same port.
 */
async function withPortLock<T>(fn: () => Promise<T>): Promise<T> {
  const dataDir = await getDataDir();
  return withFileLock(lockPathFor(join(dataDir, LOCK_FILE)), fn);
}

async function getLockFilePath(): Promise<string> {
  const dataDir = await getDataDir();
  return join(dataDir, LOCK_FILE);
}

async function appendAudit(event: Record<string, unknown>): Promise<void> {
  try {
    const fs = await import('fs');
    const dataDir = await getDataDir();
    fs.appendFileSync(join(dataDir, AUDIT_FILE), JSON.stringify({ ts: new Date().toISOString(), ...event }) + '\n');
  } catch {
    // Audit is best-effort: never fail an allocation/release because of it.
  }
}

function normalizeEntries(raw: unknown, mtimeMs?: number): PortLockEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: PortLockEntry[] = [];
  for (const e of raw) {
    if (typeof e === 'number' && Number.isInteger(e)) {
      out.push({ port: e, pid: 0, ts: typeof mtimeMs === 'number' ? new Date(mtimeMs).toISOString() : '' });
    } else if (e && typeof e === 'object') {
      const r = e as Record<string, unknown>;
      if (typeof r['port'] === 'number' && Number.isInteger(r['port'])) {
        out.push({
          port: r['port'] as number,
          pid: typeof r['pid'] === 'number' && Number.isInteger(r['pid']) ? (r['pid'] as number) : 0,
          ts: typeof r['ts'] === 'string' ? (r['ts'] as string) : '',
        });
      }
    }
  }
  return out;
}

/** Read owned lock entries (legacy `number[]` accepted, pid unknown). Exported for audit/tests. */
export async function readLockedPorts(): Promise<PortLockEntry[]> {
  const filePath = await getLockFilePath();
  const file = Bun.file(filePath);
  const exists = await file.exists();

  if (!exists) {
    return [];
  }

  try {
    const content = await file.text();
    const parsed = JSON.parse(content);
    let mtimeMs: number | undefined;
    try {
      const fs = await import('fs');
      mtimeMs = fs.statSync(filePath).mtimeMs;
    } catch {
      mtimeMs = undefined;
    }
    return normalizeEntries(parsed, mtimeMs);
  } catch {
    // Corrupted lock file — treat as empty
    return [];
  }
}

async function writeLockedPorts(entries: PortLockEntry[]): Promise<void> {
  const filePath = await getLockFilePath();
  await atomicWrite(filePath, JSON.stringify(entries));
}

/**
 * OS-level availability probe: can we actually bind this port right now?
 * Detects holders invisible to the lock file / job list (another XDG
 * instance, a leaked serve process, anything else on the machine).
 * A successful bind means free — the probe server is stopped immediately.
 */
async function isPortFree(port: number): Promise<boolean> {
  try {
    const server = Bun.serve({
      port,
      hostname: '127.0.0.1',
      fetch: () => new Response('mc-port-probe', { status: 404 }),
    });
    server.stop(true);
    return true;
  } catch {
    return false;
  }
}

/**
 * Reap entries whose holder is provably dead (pid answers no signal), plus
 * ownerless legacy entries older than PORT_LOCK_TTL_MS. Live holders are
 * never touched. Every reap is audit-logged. Returns the reaped ports.
 */
export async function reapDeadPortHolders(): Promise<number[]> {
  return withPortLock(async () => {
    const entries = await readLockedPorts();
    if (entries.length === 0) return [];
    const now = Date.now();
    const keep: PortLockEntry[] = [];
    const reaped: PortLockEntry[] = [];
    for (const e of entries) {
      if (e.pid > 0) {
        if (!isPidAlive(e.pid)) reaped.push(e);
        else keep.push(e);
      } else {
        const age = e.ts ? now - Date.parse(e.ts) : Number.NaN;
        if (Number.isFinite(age) && age > PORT_LOCK_TTL_MS) reaped.push(e);
        else keep.push(e);
      }
    }
    if (reaped.length === 0) return [];
    await writeLockedPorts(keep);
    for (const e of reaped) {
      await appendAudit({ event: 'reap-dead-holder', port: e.port, prevPid: e.pid, byPid: process.pid });
    }
    return reaped.map((e) => e.port);
  });
}

/**
 * Allocate the next available port from the configured range.
 * Scans active jobs and the lock file to prevent races.
 * Before delivering a candidate, probes whether the OS will actually let us
 * bind it — ports held by foreign processes (other XDG instances, leaked
 * servers) are skipped instead of reallocated into a deterministic collision.
 *
 * Blocker 3 recovery: dead-holder entries are reaped (audited) inside the
 * same lock acquisition, so a kill -9'd launcher never leaks its port.
 * The entry records the allocating pid for later ownership checks.
 */
export async function allocatePort(
  config: MCConfig,
  activeJobs: Job[],
  opts?: AllocateOptions,
): Promise<number> {
  return withPortLock(async () => {
    const rangeStart = config.portRangeStart ?? 14100;
    const rangeEnd = config.portRangeEnd ?? 14199;
    const ownerPid = opts?.ownerPid ?? process.pid;

    let entries = await readLockedPorts();
    // Opportunistic reap in the same critical section (no extra lock round).
    // Same TTL/dead-holder rule as reapDeadPortHolders: known-pid entries
    // reap only when the holder is dead; ownerless legacy entries (pid 0 or
    // absent) reap only when older than PORT_LOCK_TTL_MS. Without the legacy
    // branch a dead legacy entry pinned its port forever and the range
    // exhausted.
    const now = Date.now();
    const live: PortLockEntry[] = [];
    let reaped = false;
    for (const e of entries) {
      if (e.pid > 0) {
        if (!isPidAlive(e.pid)) {
          reaped = true;
          await appendAudit({ event: 'reap-dead-holder', port: e.port, prevPid: e.pid, byPid: process.pid });
        } else {
          live.push(e);
        }
      } else {
        const age = e.ts ? now - Date.parse(e.ts) : Number.NaN;
        if (Number.isFinite(age) && age > PORT_LOCK_TTL_MS) {
          reaped = true;
          await appendAudit({ event: 'reap-dead-holder', port: e.port, prevPid: e.pid, byPid: process.pid });
        } else {
          live.push(e);
        }
      }
    }
    if (reaped) {
      await writeLockedPorts(live);
      entries = live;
    }

    const jobPorts = new Set(
      activeJobs
        .map((j) => j.port)
        .filter((p): p is number => p !== undefined),
    );
    const lockedPorts = new Set(entries.map((e) => e.port));
    const usedPorts = new Set([...jobPorts, ...lockedPorts]);
    const osOccupied: number[] = [];

    for (let port = rangeStart; port <= rangeEnd; port++) {
      if (usedPorts.has(port)) {
        continue;
      }
      if (!(await isPortFree(port))) {
        osOccupied.push(port);
        continue;
      }
      entries.push({ port, pid: ownerPid, ts: new Date().toISOString() });
      await writeLockedPorts(entries);
      return port;
    }

    const osHint =
      osOccupied.length > 0
        ? ` ${osOccupied.length} port(s) held at OS level (${osOccupied.join(', ')})` +
          ` by another process or XDG instance — check listeners (ss -ltnp) or widen the range.`
        : '';
    throw new Error(
      `No available ports in range ${rangeStart}-${rangeEnd}. ` +
        `${usedPorts.size} ports in use.${osHint} Use mc_cleanup to free ports from completed jobs.`,
    );
  });
}

/** Allocate with an explicit owner (tests, cross-process harnesses). */
export async function allocatePortWithOwner(
  config: MCConfig,
  activeJobs: Job[],
  opts: { ownerPid: number },
): Promise<number> {
  return allocatePort(config, activeJobs, opts);
}

function decideRelease(
  entry: PortLockEntry | undefined,
  callerPid: number,
  force: boolean,
): ReleaseResult {
  if (!entry) return { released: false, reason: 'not-locked (idempotent no-op)' };
  if (force) return { released: true, reason: `forced release of port ${entry.port} (prev owner ${entry.pid})` };
  if (entry.pid === callerPid) return { released: true, reason: `released own port ${entry.port}` };
  if (entry.pid > 0 && !isPidAlive(entry.pid)) {
    return { released: true, reason: `reaped dead holder ${entry.pid} on port ${entry.port}` };
  }
  if (entry.pid === 0) {
    // Legacy ownerless entry: no one to protect, keep historic permissive
    // cleanup (audited so the removal is traceable).
    return { released: true, reason: `released legacy ownerless port ${entry.port}` };
  }
  return { released: false, reason: `refused: port ${entry.port} owned by live pid ${entry.pid}` };
}

/**
 * Release a port back to the available pool.
 * Possession-safe: a release from a different live holder is REFUSED (never
 * removes another process's active port) and audit-logged. Idempotent —
 * no-op when the port is not in the lock file. Operator paths that just
 * destroyed the server (kill, cleanup of completed jobs) pass
 * `{ force: true }` for an audited override.
 */
export async function releasePort(port: number, opts?: ReleaseOptions): Promise<void> {
  const callerPid = opts?.ownerPid ?? process.pid;
  const force = opts?.force === true;
  await withPortLock(async () => {
    const entries = await readLockedPorts();
    const idx = entries.findIndex((e) => e.port === port);
    const decision = decideRelease(idx >= 0 ? entries[idx] : undefined, callerPid, force);
    if (!decision.released) {
      if (idx >= 0) {
        await appendAudit({ event: 'release-refused', port, prevPid: entries[idx].pid, byPid: callerPid, reason: decision.reason });
      }
      return;
    }
    if (idx < 0) return;
    const [removed] = entries.splice(idx, 1);
    await writeLockedPorts(entries);
    await appendAudit({
      event: force ? 'release-forced' : 'release',
      port,
      prevPid: removed.pid,
      byPid: callerPid,
      reason: decision.reason,
    });
  });
}
