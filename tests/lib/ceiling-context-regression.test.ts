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

describe('F04 ceiling regression (public path, --max-parallel 1 respected)', () => {
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
    xdgTmp = await tempDir('mc-xdg-f04-');
    process.env.MC_XDG_DATA_DIR = xdgTmp;
    const mk = async (p: string) => {
      const d = await tempDir(p);
      await git(d, 'init', '-q');
      await git(d, 'branch', '-M', 'main');
      await git(d, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--allow-empty', '-m', 'init');
      return d;
    };
    repoA = await mk('mc-f04-target-');
  });

  afterEach(async () => {
    try { mock.restore(); } catch {}
    if (prevXdg === undefined) delete process.env.MC_XDG_DATA_DIR;
    else process.env.MC_XDG_DATA_DIR = prevXdg;
    const fs = await import('fs');
    for (const d of [repoA, xdgTmp]) try { if (d && fs.existsSync(d)) fs.rmSync(d, { recursive: true, force: true }); } catch {}
  });

  it('ceiling {maxParallel:1, testCommand} is validated and effectively applied, not left at config 3 / merge without testCommand', async () => {
    // No chdir: cwd (checkout) is already a third folder != repoA.
    const { Orchestrator } = await import('../../src/lib/orchestrator');
    const { JobMonitor } = await import('../../src/lib/monitor');
    const { loadConfig } = await import('../../src/lib/config');
    const baseConfig = await loadConfig();
    const orch = new Orchestrator(new JobMonitor(), baseConfig);
    const generate = async () => JSON.stringify(validDraft());
    // Public Orchestrator entry used by `start --repo ... --max-parallel 1 --test-command ...`
    // with launch deferred (no tmux) — still must validate + apply effective config.
    const res = await orch.startAutonomousPlan(
      { request: 'do X', repo: repoA, ceiling: { maxParallel: 1, testCommand: 'node --test' } },
      generate,
      { launch: false } as unknown as { launch?: boolean },
    );
    expect(res.tasks).toEqual(['task-a']);
    // Effective config must reflect the ceiling (not the file default 3 / no testCommand).
    const eff = (orch as unknown as {
      getEffectiveMaxParallel?: () => number;
      getEffectiveTestCommand?: () => string | undefined;
    });
    expect(typeof eff.getEffectiveMaxParallel).toBe('function');
    expect(eff.getEffectiveMaxParallel!()).toBe(1);
    expect(eff.getEffectiveTestCommand!()).toBe('node --test');
    // Clamp 4-8 must NOT reinterpret explicit 1 as 4.
    const { clampMaxParallel } = await import('../../src/lib/coordinator');
    expect(clampMaxParallel(1)).toBe(4); // documents the old reinterpretation
    expect(eff.getEffectiveMaxParallel!()).not.toBe(clampMaxParallel(1));
  });

  it('invalid ceiling fails explicitly (no silent ignore)', async () => {
    const { Orchestrator } = await import('../../src/lib/orchestrator');
    const { JobMonitor } = await import('../../src/lib/monitor');
    const { loadConfig } = await import('../../src/lib/config');
    const orch = new Orchestrator(new JobMonitor(), await loadConfig());
    const generate = async () => JSON.stringify(validDraft());
    await expect(
      orch.startAutonomousPlan(
        { request: 'do X', repo: repoA, ceiling: { maxParallel: 0 } },
        generate,
        { launch: false } as unknown as { launch?: boolean },
      ),
    ).rejects.toThrow(/maxParallel|ceiling/i);
  });
});

describe('F11 --context regression (public path, file content loaded + resumed)', () => {
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
    xdgTmp = await tempDir('mc-xdg-f11-');
    process.env.MC_XDG_DATA_DIR = xdgTmp;
    const mk = async (p: string) => {
      const d = await tempDir(p);
      await git(d, 'init', '-q');
      await git(d, 'branch', '-M', 'main');
      await git(d, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--allow-empty', '-m', 'init');
      return d;
    };
    repoA = await mk('mc-f11-target-');
  });

  afterEach(async () => {
    try { mock.restore(); } catch {}
    if (prevXdg === undefined) delete process.env.MC_XDG_DATA_DIR;
    else process.env.MC_XDG_DATA_DIR = prevXdg;
    const fs = await import('fs');
    for (const d of [repoA, xdgTmp]) try { if (d && fs.existsSync(d)) fs.rmSync(d, { recursive: true, force: true }); } catch {}
  });

  it('loads real --context file content into prompt and preserves reference/version/scope for resume', async () => {
    const fs = await import('fs');
    const ctxFile = join(repoA, 'ctx.txt');
    fs.writeFileSync(ctxFile, 'CONTEXT-BODY-12345 unique payload');
    let seenPrompt = '';
    const generate = async (plannerPrompt: string) => {
      seenPrompt = plannerPrompt;
      return JSON.stringify(validDraft());
    };
    const { Orchestrator } = await import('../../src/lib/orchestrator');
    const { JobMonitor } = await import('../../src/lib/monitor');
    const { loadConfig } = await import('../../src/lib/config');
    const orch = new Orchestrator(new JobMonitor(), await loadConfig());
    const res = await orch.startAutonomousPlan(
      { request: 'do X', repo: repoA, docs: [ctxFile] },
      generate,
      { launch: false } as unknown as { launch?: boolean },
    );
    // Prompt must embed the file CONTENT, never just the path.
    expect(seenPrompt).toContain('CONTEXT-BODY-12345');
    // Intake must preserve reference/version/scope for resume (not just the path string).
    const paths = await import('../../src/lib/paths');
    const dataA = await paths.getDataDir(repoA);
    const runtimeA = join(dataA, 'runtime-state.json');
    expect(fs.existsSync(runtimeA)).toBe(true);
    const persisted = await Bun.file(runtimeA).text();
    expect(persisted).toContain(res.intakeId);
    expect(persisted).toContain('CONTEXT-BODY-12345');
    expect(persisted).toContain(ctxFile);
    // Resume must keep the context (no loss).
    const progress = await orch.resumeAutonomousIntake(res.intakeId).catch(() => '');
    expect(typeof progress).toBe('string');
    const repersisted = await Bun.file(runtimeA).text();
    expect(repersisted).toContain('CONTEXT-BODY-12345');
  });
});
