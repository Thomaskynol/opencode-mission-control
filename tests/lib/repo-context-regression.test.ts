import { describe, it, expect, beforeEach, afterEach, spyOn, mock } from 'bun:test';
import { join } from 'path';
import { tmpdir } from 'os';
import * as paths from '../../src/lib/paths';

async function tempDir(prefix: string): Promise<string> {
  const fs = await import('fs');
  return fs.promises.mkdtemp(join(tmpdir(), prefix));
}

async function git(cwd: string, ...args: string[]): Promise<void> {
  const proc = Bun.spawn(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  const code = await proc.exited;
  if (code !== 0) {
    const err = await new Response(proc.stderr).text();
    throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${err}`);
  }
}

async function makeRepo(prefix: string): Promise<string> {
  const dir = await tempDir(prefix);
  await git(dir, 'init', '-q');
  await git(dir, 'branch', '-M', 'main');
  await git(dir, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--allow-empty', '-m', 'init');
  return dir;
}

describe('F02 repo-context regression (public path, cwd != --repo)', () => {
  let repoA: string;
  let xdgTmp: string;
  let prevXdg: string | undefined;

  beforeEach(async () => {
    // F02 isolation: other suites (config/plan-state) use vi.mock('../../src/lib/paths')
    // which leaks a mocked getDataDir (returning undefined/deleted dirs) into
    // this file when the full suite runs in one process. Restore the real
    // implementation here so this regression proves real repo scoping, not mock state.
    const realGetDataDir = async (cwd?: string): Promise<string> => {
      const { join: joinPath } = await import('path');
      const fs = await import('fs');
      const effective: string | undefined =
        cwd ?? (paths as unknown as { getActiveRepoRoot?: () => string | undefined }).getActiveRepoRoot?.() ?? process.cwd();
      const projectId = await paths.getProjectId(effective);
      const dir = joinPath(paths.getXdgDataDir(), projectId, 'state');
      fs.mkdirSync(dir, { recursive: true });
      return dir;
    };
    try {
      spyOn(paths as unknown as Record<string, unknown>, 'getDataDir').mockImplementation(realGetDataDir as never);
    } catch {}
    prevXdg = process.env.MC_XDG_DATA_DIR;
    xdgTmp = await tempDir('mc-xdg-f02-');
    process.env.MC_XDG_DATA_DIR = xdgTmp;
    repoA = await makeRepo('mc-f02-target-');
  });

  afterEach(async () => {
    try { mock.restore(); } catch {}
    if (prevXdg === undefined) delete process.env.MC_XDG_DATA_DIR;
    else process.env.MC_XDG_DATA_DIR = prevXdg;
    const fs = await import('fs');
    for (const d of [repoA, xdgTmp]) {
      try { if (d && fs.existsSync(d)) fs.rmSync(d, { recursive: true, force: true }); } catch {}
    }
  });

  it('getProjectId resists basename collision (canonical path, not only basename)', async () => {
    const fs = await import('fs');
    const parent1 = await tempDir('mc-collide-1-');
    const parent2 = await tempDir('mc-collide-2-');
    const a = join(parent1, 'proj');
    const b = join(parent2, 'proj');
    fs.mkdirSync(a, { recursive: true });
    fs.mkdirSync(b, { recursive: true });
    await git(a, 'init', '-q');
    await git(a, 'branch', '-M', 'main');
    await git(a, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--allow-empty', '-m', 'init');
    await git(b, 'init', '-q');
    await git(b, 'branch', '-M', 'main');
    await git(b, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--allow-empty', '-m', 'init');
    const idA = await paths.getProjectId(a);
    const idB = await paths.getProjectId(b);
    // Same basename "proj" in different parents must NOT collide.
    expect(idA).not.toBe(idB);
    // And each must be stable (same repo, same id; worktree-safe).
    expect(await paths.getProjectId(a)).toBe(idA);
    fs.rmSync(parent1, { recursive: true, force: true });
    fs.rmSync(parent2, { recursive: true, force: true });
  });

  it('starting from third folder with --repo A does not create state in origin (launcher)', async () => {
    // No chdir: current cwd (repo checkout) is already a third folder != repoA.
    // This keeps the test isolated (no global chdir pollution) while still
    // exercising cwd != --repo via the public CLI path.
    const { dispatchCommand } = await import('../../src/orchestrator-cli/commands');
    const cwdNow = process.cwd();
    expect(paths.resolveRepoRoot(repoA)).not.toBe(paths.resolveRepoRoot(cwdNow));
    const out = await dispatchCommand(
      `start my request --repo ${repoA}`,
      { pause: async () => '', resume: async () => '', cancel: async () => '', answer: async () => '', launch: async (p: string) => p },
    );
    const m = out.match(/Intake (\S+) persisted/);
    expect(m).not.toBeNull();
    const id = m![1];
    // Intake must be persisted under repoA's scope, never under the launcher cwd scope.
    const dataA = await paths.getDataDir(repoA);
    const dataCwd = await paths.getDataDir(cwdNow);
    expect(dataA).not.toBe(dataCwd);
    const fs = await import('fs');
    const runtimeA = join(dataA, 'runtime-state.json');
    const runtimeCwd = join(dataCwd, 'runtime-state.json');
    const hasA = fs.existsSync(runtimeA) && (await Bun.file(runtimeA).text()).includes(id);
    let hasCwd = false;
    try {
      hasCwd = fs.existsSync(runtimeCwd) && (await Bun.file(runtimeCwd).text()).includes(id);
    } catch { hasCwd = false; }
    expect(hasA).toBe(true);
    expect(hasCwd).toBe(false);
  });

  it('starting from third folder with --repo A does not create integration branch in origin', async () => {
    // Public integration API used by startPlan: explicit repoRoot, cwd != repo.
    // No workers, no harness replacing coordination — pure git scoping proof.
    const { createIntegrationBranch, deleteIntegrationBranch } = await import('../../src/lib/integration');
    const cwdNow = process.cwd();
    expect(paths.resolveRepoRoot(repoA)).not.toBe(paths.resolveRepoRoot(cwdNow));
    const planId = `f02-${Date.now().toString(36)}`;
    const { branch, worktreePath } = await createIntegrationBranch(planId, undefined, undefined, repoA);
    try {
      expect(branch).toBe(`mc/integration-${planId}`);
      // Branch exists in target repo A.
      const procA = Bun.spawn(['git', 'branch', '--list', branch], { cwd: repoA, stdout: 'pipe', stderr: 'pipe' });
      const outA = await new Response(procA.stdout).text();
      await procA.exited;
      expect(outA).toContain(branch);
      // Branch does NOT exist in origin (launcher cwd repo).
      const procCwd = Bun.spawn(['git', 'branch', '--list', branch], { cwd: cwdNow, stdout: 'pipe', stderr: 'pipe' });
      const outCwd = await new Response(procCwd.stdout).text();
      await procCwd.exited;
      expect(outCwd).not.toContain(branch);
      // Worktree path is under target's project scope, never origin's.
      const dataA = await paths.getDataDir(repoA);
      const dataCwd = await paths.getDataDir(cwdNow);
      expect(worktreePath).toContain(await paths.getProjectId(repoA));
      expect(dataA).not.toBe(dataCwd);
    } finally {
      await deleteIntegrationBranch(planId, repoA).catch(() => {});
    }
  });
});
