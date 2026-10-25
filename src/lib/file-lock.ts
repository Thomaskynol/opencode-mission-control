/**
 * Inter-process file lock for serializing read-modify-write cycles.
 *
 * The in-process GitMutex (see git-mutex.ts) cannot protect against races
 * between separate processes (e.g. mc_plan_cancel and mc_cleanup from
 * different sessions). This module provides mutual exclusion across
 * processes using an atomic lockfile (O_EXCL creation), plus a per-path
 * in-process mutex so same-process callers don't spin on the filesystem.
 *
 * Lockfile layout: `<state-file>.lock` containing `<pid>:<ts>:<rand>` token.
 * A lock whose mtime is older than `staleMs` is treated as left behind by a
 * dead process (kill -9) and broken. Release only unlinks when the token
 * still matches, so a holder never deletes another process's lock.
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
  /** Lock age after which a lock is considered orphaned. Default 15000ms. */
  staleMs?: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_RETRY_MS = 20;
const DEFAULT_STALE_MS = 15_000;

/**
 * Stale threshold for the integration-branch lock (see integration.ts).
 * Merge-train test runs hold the lock for up to 600s
 * (DEFAULT_TEST_TIMEOUT_MS in merge-train.ts), so the default 15s stale
 * break would delete a live holder's lock mid-merge and let a second
 * process interleave into the same branch. 11 minutes covers the longest
 * legitimate hold with margin; a kill -9'd holder is still reaped.
 * Wait timeout is intentionally NOT raised: a second merger that arrives
 * while the lock is legitimately held fails fast instead of blocking.
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
 * Acquire the lock, returning an idempotent async release function.
 * Throws after `timeoutMs` when another live holder keeps the lock.
 */
export async function acquireFileLock(
  lockPath: string,
  opts: FileLockOptions = {},
): Promise<() => Promise<void>> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const retryMs = opts.retryMs ?? DEFAULT_RETRY_MS;
  const staleMs = opts.staleMs ?? DEFAULT_STALE_MS;
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
      return async () => {
        if (released) return;
        released = true;
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
      // Lock exists: break it when orphaned (e.g. holder got kill -9).
      const age = lockAgeMs(lockPath);
      if (age !== null && age > staleMs) {
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
 * Run `fn` with the lock held (in-process mutex + inter-process lockfile).
 * The lock is always released, even when `fn` throws.
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
