import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { join } from 'path';
import { tmpdir } from 'os';

async function tempDir(prefix: string): Promise<string> {
  const fs = await import('fs');
  return fs.promises.mkdtemp(join(tmpdir(), prefix));
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const proc = Bun.spawn(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(`git ${args.join(' ')} failed: ${err}`);
  return out.trim();
}

function minimalPlan(overrides: Record<string, unknown> = {}) {
  return {
    id: 'plan-dest-1',
    name: 'dest test',
    mode: 'autopilot',
    status: 'pending',
    jobs: [],
    integrationBranch: 'mc/integration-dest-1',
    baseCommit: 'abc123',
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('dest-branch: explicit start branch reaches the plan', () => {
  let restoreDataDir: () => void = () => {};
  let stateDir: string;

  beforeEach(async () => {
    // Full-suite isolation: plan-state/config suites vi.mock('../../src/lib/paths')
    // which leaks a mocked getDataDir into this file when bun runs all files
    // in one process (same guard as f03f05f06f07-regression). Pin state at a
    // temp dir so the round-trip below proves real persistence, not mock state.
    const fs = await import('fs');
    stateDir = await fs.promises.mkdtemp(join(tmpdir(), 'mc-xdg-dest-state-'));
    const paths = await import('../../src/lib/paths');
    try {
      const spy = spyOn(paths, 'getDataDir').mockResolvedValue(stateDir);
      restoreDataDir = () => (spy as unknown as { mockRestore: () => void }).mockRestore();
    } catch { restoreDataDir = () => {}; }
  });

  afterEach(async () => {
    try { restoreDataDir(); } catch {}
    const fs = await import('fs');
    try { if (stateDir && fs.existsSync(stateDir)) fs.rmSync(stateDir, { recursive: true, force: true }); } catch {}
  });

  it('PlanSpecSchema preserves an explicit baseBranch (no silent default)', async () => {
    const { PlanSpecSchema } = await import('../../src/lib/schemas');
    const parsed = PlanSpecSchema.parse(minimalPlan({ baseBranch: 'demo/dest-rv' }));
    expect((parsed as { baseBranch?: string }).baseBranch).toBe('demo/dest-rv');
  });

  it('loadPlan round-trip keeps baseBranch so integration lands on the destination', async () => {
    const prevXdg = process.env.MC_XDG_DATA_DIR;
    const xdgTmp = await tempDir('mc-xdg-dest-');
    process.env.MC_XDG_DATA_DIR = xdgTmp;
    const d = await tempDir('mc-dest-');
    const repo = d;
    try {
      await git(d, 'init', '-q');
      await git(d, 'branch', '-M', 'main');
      await git(d, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--allow-empty', '-m', 'init');
      const { loadPlan } = await import('../../src/lib/plan-state');
      const fs = await import('fs');
      fs.writeFileSync(
        join(stateDir, 'plan.json'),
        JSON.stringify(minimalPlan({ baseBranch: 'demo/dest-rv' })),
      );
      const loaded = await loadPlan(repo);
      expect(loaded?.baseBranch).toBe('demo/dest-rv');
    } finally {
      if (prevXdg === undefined) delete process.env.MC_XDG_DATA_DIR;
      else process.env.MC_XDG_DATA_DIR = prevXdg;
      const fs = await import('fs');
      for (const p of [repo, xdgTmp]) try { if (p && fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true }); } catch {}
    }
  });
});
