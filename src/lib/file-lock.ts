/**
 * Inter-process lock for serializing read-modify-write cycles.
 *
 * The in-process GitMutex (see git-mutex.ts) cannot protect against races
 * between separate processes (e.g. mc_plan_cancel and mc_cleanup from
 * different sessions). This module provides mutual exclusion across
 * processes using an atomic lockfile (O_EXCL creation) with a lease,
 * plus a per-path in-process mutex so same-process callers don't spin on
 * the filesystem.
 *
 * This is a lockfile with a lease — not flock(2). The holder renews the
 * lease with a heartbeat (mtime touch) while it is alive; a lock is only
 * broken when its mtime shows NO heartbeat progress for longer than
 * `staleMs` (i.e. the holder is dead, e.g. kill -9). A live holder is
 * never broken by age alone.
 *
 * Lockfile layout: `<state-file>.lock` containing `<pid>:<ts>:<rand>` token.
 * Release only unlinks when the token still matches, so a holder never
 * deletes another process's lock.
 *
 * Not reentrant: do not nest withFileLock on the same path.
 */

import fs from 'node:fs';
import { GitMutex } from './git-mutex';

export interface FileLockOptions {
  /** Max time to wait for the lock before throwing. Default 10000ms. */
  timeoutMs?: number;
  /** Delay between acquisition attempts. Default 20ms. */
  retryMs?: number;
  /**
   * Lease duration without heartbeat progress after which a lock is
   * considered orphaned. Default 15000ms. A live holder renews the lease
   * via heartbeat (see `heartbeatMs`), so this only fires for dead holders.
   */
  staleMs?: number;
  /**
   * Heartbeat interval for lease renewal while holding the lock.
   * Default: `min(max(1000, floor(staleMs/3)), 30000)`.
   */
  heartbeatMs?: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_RETRY_MS = 20;
const DEFAULT_STALE_MS = 15_000;

/**
 * Stale threshold for the integration-branch lock (see integration.ts).
 * Merge-train test runs hold the lock for up to 600s
 * (DEFAULT_TEST_TIMEOUT_MS in merge-train.ts); with the lease heartbeat
 * (default 30s for this stale window) a live holder keeps renewing, so a
 * second process never breaks it mid-merge. A kill -9'd holder stops
 * heartbeating and is still reaped after 11 minutes. Wait timeout is
 * intentionally NOT raised: a second merger that arrives while the lock
 * is legitimately held fails fast instead of blocking.
 */
export const INTEGRATION_STALE_MS = 660_000;

const localMutexes = new Map<string, GitMutex>();

function localMutexFor(lockPath: string): GitMutex {
  let mutex = localMutexes.get(lockPath);
  if (!mutex) {
    mutex = new GitMutex();
    localMutexes.set(lockPath, mutex);
  }
  return mutex;
}

function readToken(lockPath: string): string | null {
  try {
    return fs.readFileSync(lockPath, 'utf8');
  } catch {
    return null;
  }
}

function lockAgeMs(lockPath: string): number | null {
  try {
    const stat = fs.statSync(lockPath);
    return Date.now() - stat.mtimeMs;
  } catch {
    return null;
  }
}

/**
 * Effective heartbeat interval for a given stale window.
 * Kept small relative to staleMs so a live holder always renews in time;
 * capped at 30s so the 660s integration lease does not wake every 3 minutes.
 */
export function heartbeatMsFor(staleMs: number, explicit?: number): number {
  if (explicit !== undefined) return explicit;
  return Math.min(Math.max(1000, Math.floor(staleMs / 3)), 30_000);
}

/**
 * Acquire the lock, returning an idempotent async release function.
 * Throws after `timeoutMs` when another live holder keeps the lock.
 *
 * While held, the owner renews the lease via heartbeat (mtime touch every
 * `heartbeatMs`); contenders only break a lock whose mtime shows NO
 * heartbeat progress for longer than `staleMs`.
 */
export async function acquireFileLock(
  lockPath: string,
  opts: FileLockOptions = {},
): Promise<() => Promise<void>> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const retryMs = opts.retryMs ?? DEFAULT_RETRY_MS;
  const staleMs = opts.staleMs ?? DEFAULT_STALE_MS;
  const heartbeatMs = heartbeatMsFor(staleMs, opts.heartbeatMs);
  const token = `${process.pid}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    try {
      const fd = fs.openSync(lockPath, 'wx', 0o644);
      try {
        fs.writeSync(fd, token);
      } finally {
        fs.closeSync(fd);
      }

      let released = false;
      // Lease heartbeat: keep mtime fresh while we are alive so a
      // contender never mistakes a live holder for a stale lock.
      const heartbeat = setInterval(() => {
        try {
          if (readToken(lockPath) !== token) {
            clearInterval(heartbeat);
            return;
          }
          const now = new Date();
          fs.utimesSync(lockPath, now, now);
        } catch {
          clearInterval(heartbeat);
        }
      }, heartbeatMs);
      (heartbeat as unknown as { unref?: () => void }).unref?.();
      return async () => {
        if (released) return;
        released = true;
        clearInterval(heartbeat);
        // Only unlink our own lock — never another holder's.
        try {
          if (readToken(lockPath) === token) {
            fs.unlinkSync(lockPath);
          }
        } catch {
          // Lock already gone: nothing to do.
        }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'EEXIST') {
        throw error;
      }
      // Lock exists: break it only when orphaned (no heartbeat progress
      // for longer than staleMs, e.g. holder got kill -9). A live holder
      // keeps touching mtime, so age alone never breaks it.
      const age = lockAgeMs(lockPath);
      if (age !== null && age > staleMs) {
        // Re-stat immediately before breaking: the holder may have
        // heartbeated between open-fail and stat.
        const freshAge = lockAgeMs(lockPath);
        if (freshAge === null) {
          // Vanished in the meantime: retry immediately.
          continue;
        }
        if (freshAge <= staleMs) {
          // Heartbeat progressed: live holder, not stale.
          if (Date.now() >= deadline) {
            throw new Error(`Timed out acquiring file lock: ${lockPath} after ${timeoutMs}ms`);
          }
          await new Promise((resolve) => setTimeout(resolve, retryMs));
          continue;
        }
        try {
          fs.unlinkSync(lockPath);
        } catch {
          // Lost the race to break it: fall through and retry.
        }
        continue;
      }
      if (age === null) {
        // Lock vanished between open and stat: retry immediately.
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(`Timed out acquiring file lock: ${lockPath} after ${timeoutMs}ms`);
      }
      await new Promise((resolve) => setTimeout(resolve, retryMs));
    }
  }
}

/**
 * Run `fn` with the lock held (in-process mutex + inter-process lockfile
 * with lease heartbeat). The lock is always released, even when `fn` throws.
 */
export async function withFileLock<T>(
  lockPath: string,
  fn: () => Promise<T>,
  opts: FileLockOptions = {},
): Promise<T> {
  return localMutexFor(lockPath).withLock(async () => {
    const release = await acquireFileLock(lockPath, opts);
    try {
      return await fn();
    } finally {
      await release();
    }
  });
}

/** Lockfile path convention: `<state-file>.lock` next to the state file. */
export function lockPathFor(stateFilePath: string): string {
  return `${stateFilePath}.lock`;
}
