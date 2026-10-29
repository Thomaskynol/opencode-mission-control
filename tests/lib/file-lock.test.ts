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

  it('should not break a live holder with heartbeat during a long operation (2 processes)', async () => {
    const lock = join(testDir, 'lease.lock');
    const marker = join(testDir, 'holder-done.txt');
    const invaded = join(testDir, 'invaded.txt');
    const repoRoot = new URL('../../', import.meta.url).pathname;
    const workerImport = JSON.stringify(join(repoRoot, 'src/lib/file-lock.ts'));

    const holderPath = join(testDir, 'lease-holder.ts');
    const contenderPath = join(testDir, 'lease-contender.ts');
    await Bun.write(
      holderPath,
      `import { withFileLock } from ${workerImport};\n` +
        `const lock = process.env.MC_LOCK!;\n` +
        `const marker = process.env.MC_MARKER!;\n` +
        `await withFileLock(lock, async () => {\n` +
        `  await new Promise((r) => setTimeout(r, 3000));\n` +
        `  await Bun.write(marker, 'holder-done');\n` +
        `}, { staleMs: 2000, heartbeatMs: 200, timeoutMs: 10000 });\n`,
    );
    await Bun.write(
      contenderPath,
      `import { withFileLock } from ${workerImport};\n` +
        `const lock = process.env.MC_LOCK!;\n` +
        `const invaded = process.env.MC_INVADED!;\n` +
        `try {\n` +
        `  await withFileLock(lock, async () => {\n` +
        `    await Bun.write(invaded, 'invaded');\n` +
        `  }, { staleMs: 2000, heartbeatMs: 200, timeoutMs: 1500, retryMs: 50 });\n` +
        `  console.log('ACQUIRED');\n` +
        `} catch (e) {\n` +
        `  console.log('TIMED_OUT:' + (e as Error).message);\n` +
        `}\n`,
    );

    const holderEnv = { MC_LOCK: lock, MC_MARKER: marker };
    const contenderEnv = { MC_LOCK: lock, MC_INVADED: invaded };
    const holder = Bun.spawn([process.execPath, holderPath], {
      env: holderEnv,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    // Let the holder acquire first, then contend mid-hold (past staleMs).
    await new Promise((r) => setTimeout(r, 500));
    const contender = Bun.spawn([process.execPath, contenderPath], {
      env: contenderEnv,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [holderExit, contenderExit] = await Promise.all([holder.exited, contender.exited]);
    const [holderErr, contenderOut, contenderErr] = await Promise.all([
      new Response(holder.stderr).text(),
      new Response(contender.stdout).text(),
      new Response(contender.stderr).text(),
    ]);
    expect(`${holderErr}${contenderErr}`).toBe('');
    expect(holderExit).toBe(0);
    expect(contenderExit).toBe(0);
    // Live holder was never broken: contender timed out, holder completed.
    expect(contenderOut).toContain('TIMED_OUT');
    expect(contenderOut).not.toContain('ACQUIRED');
    const fs = await import('fs');
    expect(fs.readFileSync(marker, 'utf8')).toBe('holder-done');
    expect(fs.existsSync(invaded)).toBe(false);
    expect(fs.existsSync(lock)).toBe(false);
  });
});
