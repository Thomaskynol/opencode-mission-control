import { describe, it, expect, beforeEach, afterEach, spyOn, mock } from 'bun:test';
import { join } from 'path';
import { tmpdir } from 'os';

async function tempDir(prefix: string): Promise<string> {
  const fs = await import('fs');
  return fs.promises.mkdtemp(join(tmpdir(), prefix));
}

async function git(cwd: string, ...args: string[]): Promise<void> {
  const proc = Bun.spawn(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  const code = await proc.exited;
  if (code !== 0) {
    const err = await new Response(proc.stderr).text();
    throw new Error(`git ${args.join(' ')} failed: ${err}`);
  }
}

function validDraft() {
  return {
    requirements: [{ id: 'r1', text: 'do X', acceptance: ['done'] }],
    tasks: [{ name: 'task-a', prompt: 'Do X in src/a.ts', acceptance: ['done'] }],
    decisions: [],
    questions: [],
    nextSteps: [],
  };
}

// F4 RED: a second start in the same repo scope while a plan is active must
// refuse BEFORE persisting anything — the running intake (ceiling 4) must
// survive, not be replaced by the failed attempt (ceiling 1).

describe('F4: failed start never clobbers the running intake', () => {
  let repoA: string;
  let xdgTmp: string;
  let prevXdg: string | undefined;

  beforeEach(async () => {
    const paths = await import('../../src/lib/paths');
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
    xdgTmp = await tempDir('mc-xdg-f04b-');
    process.env.MC_XDG_DATA_DIR = xdgTmp;
    const d = await tempDir('mc-f04b-target-');
    await git(d, 'init', '-q');
    await git(d, 'branch', '-M', 'main');
    await git(d, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--allow-empty', '-m', 'init');
    repoA = d;
  });

  afterEach(async () => {
    try { mock.restore(); } catch {}
    if (prevXdg === undefined) delete process.env.MC_XDG_DATA_DIR;
    else process.env.MC_XDG_DATA_DIR = prevXdg;
    const fs = await import('fs');
    for (const d of [repoA, xdgTmp]) try { if (d && fs.existsSync(d)) fs.rmSync(d, { recursive: true, force: true }); } catch {}
  });

  it('second start with an active plan refuses and preserves the first intake ceiling', async () => {
    const { Orchestrator } = await import('../../src/lib/orchestrator');
    const { JobMonitor } = await import('../../src/lib/monitor');
    const { loadConfig } = await import('../../src/lib/config');
    const { savePlan } = await import('../../src/lib/plan-state');
    const { saveAutoIntake, loadAutoIntake } = await import('../../src/lib/durable-state');
    const orch = new Orchestrator(new JobMonitor(), await loadConfig());
    const generate = async () => JSON.stringify(validDraft());

    await saveAutoIntake({
      id: 'intake-first',
      request: 'do X',
      repo: repoA,
      ceiling: { maxParallel: 4, testCommand: 'node --test' },
      requirements: [],
      decisions: [],
      questions: [],
      nextSteps: [],
      status: 'running',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    await savePlan(
      {
        id: 'plan-active',
        name: 'do X',
        mode: 'autopilot',
        status: 'running',
        jobs: [],
        integrationBranch: 'mc/integration-plan-active',
        baseCommit: 'abc',
        createdAt: new Date().toISOString(),
      } as never,
      repoA,
    );

    await expect(
      orch.startAutonomousPlan(
        { request: 'do Y', repo: repoA, ceiling: { maxParallel: 1, testCommand: 'node --test' } },
        generate,
        { launch: false } as unknown as { launch?: boolean },
      ),
    ).rejects.toThrow(/Active plan already exists/i);

    const kept = await loadAutoIntake('intake-first');
    expect(kept).not.toBeNull();
    expect(kept!.ceiling).toMatchObject({ maxParallel: 4, testCommand: 'node --test' });
  });
});
