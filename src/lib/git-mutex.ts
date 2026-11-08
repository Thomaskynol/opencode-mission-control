/**
 * In-process mutex for serializing git operations.
 * Prevents concurrent git commands from corrupting the .git directory.
 *
 * Uses a Promise-based queue (no file-based locking) since all git operations
 * originate from this single process.
 */
import { join } from 'node:path';
import { withFileLock, lockPathFor } from './file-lock';
import { getXdgDataDir } from './paths';

export class GitMutex {
  private queue: Array<{
    resolve: (release: () => void) => void;
  }> = [];
  private locked = false;

  acquire(): Promise<() => void> {
    return new Promise<() => void>((resolve) => {
      if (!this.locked) {
        this.locked = true;
        resolve(this.createRelease());
        return;
      }
      this.queue.push({ resolve });
    });
  }

  async withLock<T>(fn: () => Promise<T>): Promise<T> {
    const release = await this.acquire();
    try {
      return await fn();
    } finally {
      release();
    }
  }

  get pending(): number {
    return this.queue.length;
  }

  get isLocked(): boolean {
    return this.locked;
  }

  private createRelease(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;

      const next = this.queue.shift();
      if (next) {
        next.resolve(this.createRelease());
      } else {
        this.locked = false;
      }
    };
  }
}

const defaultMutex = new GitMutex();
export default defaultMutex;

/**
 * Cross-process git serialization (blocker 3). The in-process GitMutex above
 * cannot protect against a second process (conductor reconcile + CLI approve
 * run git concurrently in the same repo). This layers the inter-process
 * file lock (lease + heartbeat + owner token — a live holder is never
 * broken, release never deletes another holder's lock; see file-lock.ts)
 * over the in-process mutex. Lock ordering is safe: git never acquires a
 * plan/integration lock while holding this one.
 */
export async function withGitLock<T>(fn: () => Promise<T>): Promise<T> {
  // Global (not per-repo): serializes .git writers machine-wide for the
  // duration of one short git op. Generous wait — git ops are quick; a
  // holder past the wait is likely stuck, fail loudly instead of piling up.
  // NOTE: no defaultMutex here — withFileLock already serializes same-process
  // callers per path, and callers (git.ts) hold defaultMutex themselves;
  // sharing that instance on both layers would self-deadlock (non-reentrant).
  const lockPath = lockPathFor(join(getXdgDataDir(), 'git.lock'));
  try {
    const { dirname } = await import('node:path');
    const fs = await import('node:fs');
    fs.mkdirSync(dirname(lockPath), { recursive: true });
  } catch {}
  return withFileLock(lockPath, fn, {
    timeoutMs: 60_000,
  });
}
