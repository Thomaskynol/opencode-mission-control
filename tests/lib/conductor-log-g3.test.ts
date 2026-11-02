import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { join } from 'path';
import { tmpdir } from 'os';
import * as paths from '../../src/lib/paths';

// G3: detached conductor death must never be mute (stdio:ignore, no log).
// The spawner persists stdout/stderr to a conductor log file and surfaces
// the log path on failure; masked exceptions are warned, never swallowed.
describe('G3: detached conductor logs instead of dying mute', () => {
  let testBaseDir = '';
  let testStateDir = '';
  let testRepoDir = '';
  let restoreDataDir: () => void = () => {};

  beforeEach(async () => {
    const fs = await import('fs');
    testBaseDir = await fs.promises.mkdtemp(join(tmpdir(), 'mc-g3-log-'));
    testStateDir = join(testBaseDir, 'state');
    testRepoDir = join(testBaseDir, 'repo');
    fs.mkdirSync(testStateDir, { recursive: true });
    fs.mkdirSync(testRepoDir, { recursive: true });
    const spy = spyOn(paths, 'getDataDir').mockImplementation(async () => testStateDir);
    restoreDataDir = () => spy.mockRestore();
  });

  afterEach(() => {
    try { restoreDataDir(); } catch {}
    const { mock } = require('bun:test') as typeof import('bun:test');
    mock.restore();
    if (testBaseDir) {
      try { (require('fs') as typeof import('fs')).rmSync(testBaseDir, { recursive: true, force: true }); } catch {}
    }
  });

  it('spawn writes a persistent log (never stdio:ignore mute)', async () => {
    const mod = await import('../../src/orchestrator-cli/auto-commands');
    const src = await Bun.file(new URL('../../src/orchestrator-cli/auto-commands.ts', import.meta.url)).text();
    expect(src).not.toMatch(/stdio:\s*'ignore'/);
    expect(src).toMatch(/conductor-.*\.log/);
    const intakeId = `g3-${Date.now()}`;
    // Spawn a driver for a missing intake: the child will fail fast, but the
    // parent must still have left the log with the spawn line + log path.
    let pid = 0;
    try {
      const c = await mod.spawnPersistentConductor(intakeId, testRepoDir, undefined);
      pid = c.pid;
    } catch (e) {
      // If spawn itself fails, it must name the log path (never mute).
      expect((e as Error).message).toMatch(/conductor.*\.log|log:/i);
      const fs = await import('fs');
      const logPath = join(testStateDir, `conductor-${intakeId}.log`);
      expect(fs.existsSync(logPath)).toBe(true);
      return;
    }
    expect(pid).toBeGreaterThan(0);
    // Detach: do not keep the child; it exits on its own (missing intake).
    await new Promise((r) => setTimeout(r, 500));
    const fs = await import('fs');
    const logPath = join(testStateDir, `conductor-${intakeId}.log`);
    expect(fs.existsSync(logPath)).toBe(true);
    const text = fs.readFileSync(logPath, 'utf8');
    expect(text).toMatch(/spawn/);
    // Cleanup stray child if still alive (best-effort, test-owned only).
    try { process.kill(pid, 'SIGKILL'); } catch {}
  });

  it('provisional claim failure is warned, not swallowed', async () => {
    const src = await Bun.file(new URL('../../src/orchestrator-cli/auto-commands.ts', import.meta.url)).text();
    expect(src).toMatch(/provisional conductor claim failed/);
    expect(src).not.toMatch(/Best-effort provisional claim: verification below reports absence\.\s*\n\s*\}/);
  });
});
