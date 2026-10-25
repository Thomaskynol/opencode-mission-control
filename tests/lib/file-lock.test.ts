import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { join } from 'path';
import { tmpdir } from 'os';
import { withFileLock, acquireFileLock } from '../../src/lib/file-lock';

let testDir: string;

async function createTempDir(): Promise<string> {
  const fs = await import('fs');
  return fs.promises.mkdtemp(join(tmpdir(), 'mc-file-lock-test-'));
}

const WORKER_SCRIPT = `
import { withFileLock } from WORKER_IMPORT;
const lock = process.env.MC_LOCK;
const counter = process.env.MC_COUNTER;
const n = Number(process.env.MC_N);
for (let i = 0; i < n; i++) {
  await withFileLock(lock, async () => {
    const f = Bun.file(counter);
    let v = 0;
    if (await f.exists()) {
      const text = (await f.text()).trim();
      v = text ? parseInt(text, 10) : 0;
      if (Number.isNaN(v)) throw new Error('corrupted counter: ' + JSON.stringify(text));
    }
    await new Promise((r) => setTimeout(r, 2));
    await Bun.write(counter, String(v + 1));
  });
}
`;

describe('file-lock', () => {
  beforeEach(async () => {
    testDir = await createTempDir();
  });

  afterEach(async () => {
    const fs = await import('fs');
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('should serialize concurrent increments within one process', async () => {
    const lock = join(testDir, 'state.lock');
    let value = 0;
    await Promise.all(
      Array.from({ length: 10 }, () =>
        withFileLock(lock, async () => {
          const seen = value;
          await new Promise((r) => setTimeout(r, 1));
          value = seen + 1;
        }),
      ),
    );
    expect(value).toBe(10);
  });

  it('should serialize read-modify-write across 2 processes without lost updates', async () => {
    const lock = join(testDir, 'counter.lock');
    const counter = join(testDir, 'counter.txt');
    const workerPath = join(testDir, 'worker.ts');
    const repoRoot = new URL('../../', import.meta.url).pathname;
    const workerImport = JSON.stringify(join(repoRoot, 'src/lib/file-lock.ts'));
    await Bun.write(workerPath, WORKER_SCRIPT.replace('WORKER_IMPORT', workerImport));

    const perProcess = 10;
    const env = { MC_LOCK: lock, MC_COUNTER: counter, MC_N: String(perProcess) };
    const proc1 = Bun.spawn([process.execPath, workerPath], { env, stdout: 'pipe', stderr: 'pipe' });
    const proc2 = Bun.spawn([process.execPath, workerPath], { env, stdout: 'pipe', stderr: 'pipe' });
    const [exit1, exit2] = await Promise.all([proc1.exited, proc2.exited]);
    const [err1, err2] = await Promise.all([
      new Response(proc1.stderr).text(),
      new Response(proc2.stderr).text(),
    ]);
    expect(`${err1}${err2}`).toBe('');
    expect(exit1).toBe(0);
    expect(exit2).toBe(0);

    const final = parseInt((await Bun.file(counter).text()).trim(), 10);
    expect(final).toBe(perProcess * 2);
  });

  it('should time out when the lock is held past the deadline', async () => {
    const lock = join(testDir, 'held.lock');
    const release = await acquireFileLock(lock, { timeoutMs: 1000 });
    try {
      await expect(withFileLock(lock, async () => {}, { timeoutMs: 100, retryMs: 10 })).rejects.toThrow(
        /Timed out acquiring file lock/,
      );
    } finally {
      await release();
    }
  });

  it('should break a stale lock left by a dead process', async () => {
    const lock = join(testDir, 'stale.lock');
    const fs = await import('fs');
    fs.writeFileSync(lock, 'dead-pid-token');
    const oldTime = new Date(Date.now() - 60_000);
    fs.utimesSync(lock, oldTime, oldTime);

    let ran = false;
    await withFileLock(lock, async () => {
      ran = true;
    }, { staleMs: 5_000, timeoutMs: 5_000 });
    expect(ran).toBe(true);
  });

  it('should not delete another holder’s lock on release', async () => {
    const lock = join(testDir, 'owner.lock');
    const release = await acquireFileLock(lock, { timeoutMs: 1000 });
    // Simulate another process replacing the lock file (e.g. after stale-break).
    const fs = await import('fs');
    fs.unlinkSync(lock);
    fs.writeFileSync(lock, 'someone-else-token');
    await release();
    expect(fs.existsSync(lock)).toBe(true);
    expect(fs.readFileSync(lock, 'utf8')).toBe('someone-else-token');
  });
});
