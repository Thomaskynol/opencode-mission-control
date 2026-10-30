/**
 * Test-only helpers to isolate side effects (lane: test isolation).
 * Common tests must NEVER start real OpenCodes nor kill existing tmux sessions.
 * Live (real tmux/git) tests are explicit opt-in via TEST_LIVE=1.
 */

/** Live mode requires explicit opt-in; default is fake drivers only. */
export function isLive(): boolean {
  return process.env.TEST_LIVE === '1';
}

/** Unique per-execution name so live runs never collide with existing sessions. */
export function uniqueName(prefix: string): string {
  const rand = Math.random().toString(36).slice(2, 6);
  return `${prefix}-${process.pid}-${Date.now().toString(36)}-${rand}`;
}

/**
 * Ownership criterion for safe kill (tested here, not in src).
 * Only a session that carries this run's token may be killed by the test.
 * Production auto-fix is untouched; this guards tests only.
 */
export function isOwnedMcSession(sessionName: string, runToken: string): boolean {
  return sessionName.startsWith('mc-') && sessionName.includes(runToken);
}

/**
 * Pure parser for `tmux list-windows -a -F "#{session}:#{index} #{@mc_job_id}"`.
 * Returns targets whose tag matches jobId. Ownership = tag match.
 */
export function parseTaggedWindows(listOutput: string, jobId: string): string[] {
  const out: string[] = [];
  for (const line of listOutput.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const [target, taggedId] = trimmed.split(' ', 2);
    if (taggedId === jobId && target) out.push(target);
  }
  return out;
}

/**
 * Isolate XDG state for one test. Points MC_XDG_DATA_DIR at a fresh temp dir.
 * Returns the dir and a restore function. Never moves /tmp logs into the repo.
 */
export async function isolateXdg(): Promise<{ dir: string; restore: () => void }> {
  const { join } = await import('path');
  const { tmpdir } = await import('os');
  const fs = await import('fs');
  const dir = await fs.promises.mkdtemp(join(tmpdir(), 'mc-xdg-test-'));
  const prev = process.env.MC_XDG_DATA_DIR;
  process.env.MC_XDG_DATA_DIR = dir;
  return {
    dir,
    restore: () => {
      if (prev === undefined) delete process.env.MC_XDG_DATA_DIR;
      else process.env.MC_XDG_DATA_DIR = prev;
      try {
        if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
      } catch {}
    },
  };
}
