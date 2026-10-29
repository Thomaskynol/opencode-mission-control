import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
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
async function mkRepo(prefix: string): Promise<string> {
  const d = await tempDir(prefix);
  await git(d, 'init', '-q');
  await git(d, 'branch', '-M', 'main');
  await git(d, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--allow-empty', '-m', 'init');
  return d;
}
function validDraft(extra?: Record<string, unknown>) {
  return {
    requirements: [{ id: 'r1', text: 'do X', acceptance: ['done'] }],
    tasks: [{ name: 'task-a', prompt: 'Do X in src/a.ts', acceptance: ['done'] }],
    decisions: [],
    questions: [],
    nextSteps: [],
    ...(extra ?? {}),
  };
}

describe('F05 permission decision fail-closed (public path)', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = realFetch; });

  async function decisionFor(response: string): Promise<{ sent: boolean; body?: unknown; error?: string }> {
    const calls: Array<{ url: string; body: unknown }> = [];
    globalThis.fetch = (async (url: unknown, init: unknown) => {
      // loadConfig fetch? forms loads config via loadConfig (file, not fetch). Only permission reply uses fetch.
      const u = String(url);
      if (u.includes('/permission/')) {
        calls.push({ url: u, body: JSON.parse(String((init as RequestInit)?.body)) });
        return new Response('', { status: 204 });
      }
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    }) as typeof fetch;
    const { answerViaPermission } = await import('../../src/orchestrator-cli/forms');
    try {
      const sent = await answerViaPermission(14101, 'ses_x', 'perm:req-1', response);
      return { sent, body: calls[0]?.body };
    } catch (e) {
      return { sent: false, body: calls[0]?.body, error: e instanceof Error ? e.message : String(e) };
    } finally {
      if (calls.length === 0) {
        // ensure no permission reply was sent
      }
    }
  }

  it('"não autorizo" denies (never once)', async () => {
    const r = await decisionFor('não autorizo');
    expect(r.body).toBeDefined();
    expect(r.body).toMatchObject({ decision: 'reject' });
  });

  it('"aguarde"/vazio/pergunta nunca geram once/allow (pedem esclarecimento sem enviar)', async () => {
    for (const t of ['aguarde', '', '   ', 'como devo proceder?']) {
      const calls: string[] = [];
      globalThis.fetch = (async (url: unknown) => { calls.push(String(url)); return new Response('', { status: 204 }); }) as typeof fetch;
      const { answerViaPermission } = await import('../../src/orchestrator-cli/forms');
      let threw = false;
      try { await answerViaPermission(14101, 'ses_x', 'perm:req-1', t); } catch { threw = true; }
      expect(threw).toBe(true);
      expect(calls.filter((u) => u.includes('/permission/'))).toHaveLength(0);
    }
  });

  it('approve/deny estruturados funcionam (PT+EN)', async () => {
    for (const t of ['approve', '1', 'yes', 'sim', 'autorizo']) {
      const r = await decisionFor(t);
      expect(r.body).toMatchObject({ decision: 'once' });
    }
    for (const t of ['deny', '2', 'no', 'não', 'nao', 'nego']) {
      const r = await decisionFor(t);
      expect(r.body).toMatchObject({ decision: 'reject' });
    }
  });
});

describe('F06 effective model single resolution (public path)', () => {
  it('planner e coordinator observam o mesmo modelo efetivo (sem divergência silenciosa)', async () => {
    const tracker = await import('../../src/lib/model-tracker');
    tracker._resetForTesting();
    tracker.setCurrentModel({ providerID: 'opencode-go', modelID: 'muse-spark-1.3-contributor' });
    const { resolvePlannerModel } = await import('../../src/lib/auto-plan');
    const { Orchestrator } = await import('../../src/lib/orchestrator');
    const { JobMonitor } = await import('../../src/lib/monitor');
    const orch = new Orchestrator(new JobMonitor(), { defaultPlacement: 'session' } as never);
    const planner = resolvePlannerModel();
    const coord = (orch as unknown as { resolveCoordinatorModel: () => { providerID: string; id: string } }).resolveCoordinatorModel();
    expect(`${coord.providerID}/${coord.id}`).toBe(planner);
    tracker._resetForTesting();
  });

  it('variant pinada atravessa planner e workers sem divergência', async () => {
    const tracker = await import('../../src/lib/model-tracker');
    tracker._resetForTesting();
    // Instalação real com variant (quando suportada): deve ser observada igual nos caminhos usados.
    (tracker as unknown as { setCurrentModel: (m: unknown) => void }).setCurrentModel({
      providerID: 'opencode-go', modelID: 'muse-spark-1.3-contributor', variant: 'max',
    });
    const info = (tracker as unknown as { getCurrentModelInfo?: (s?: string) => { variant?: string } }).getCurrentModelInfo?.();
    // O tracker deve preservar a variant (pin triplo) — sem perda silenciosa.
    expect(info?.variant).toBe('max');
    const { Orchestrator } = await import('../../src/lib/orchestrator');
    const { JobMonitor } = await import('../../src/lib/monitor');
    const orch = new Orchestrator(new JobMonitor(), { defaultPlacement: 'session' } as never);
    const coord = (orch as unknown as { resolveCoordinatorModel: () => { variant?: string } }).resolveCoordinatorModel();
    expect(coord.variant).toBe('max');
    tracker._resetForTesting();
  });

  it('sem modelo rastreado não há fallback silencioso para nome fixo (aviso ou erro explícito)', async () => {
    const tracker = await import('../../src/lib/model-tracker');
    tracker._resetForTesting();
    const prev = process.env.MC_PLANNER_MODEL;
    delete process.env.MC_PLANNER_MODEL;
    try {
      const { resolvePlannerModel } = await import('../../src/lib/auto-plan');
      let threw = false;
      let warned = false;
      const origWarn = console.warn;
      console.warn = (..._a: unknown[]) => { warned = true; };
      try { resolvePlannerModel(); } catch { threw = true; } finally { console.warn = origWarn; }
      // Fail-closed: ou lança, ou avisa explicitamente — nunca silencioso.
      expect(threw || warned).toBe(true);
    } finally {
      if (prev !== undefined) process.env.MC_PLANNER_MODEL = prev;
      tracker._resetForTesting();
    }
  });

  it('coordinator sem modelo não retorna unknown/unknown silencioso', async () => {
    const tracker = await import('../../src/lib/model-tracker');
    tracker._resetForTesting();
    const prev = process.env.MC_PLANNER_MODEL;
    delete process.env.MC_PLANNER_MODEL;
    try {
      const { Orchestrator } = await import('../../src/lib/orchestrator');
      const { JobMonitor } = await import('../../src/lib/monitor');
      const orch = new Orchestrator(new JobMonitor(), { defaultPlacement: 'session' } as never);
      let threw = false;
      try {
        (orch as unknown as { resolveCoordinatorModel: () => unknown }).resolveCoordinatorModel();
      } catch { threw = true; }
      const coord = threw ? null : (orch as unknown as { resolveCoordinatorModel: () => { providerID: string; id: string } }).resolveCoordinatorModel();
      // Ou lança, ou não é unknown/unknown.
      expect(threw || (coord!.providerID !== 'unknown' || coord!.id !== 'unknown')).toBe(true);
    } finally {
      if (prev !== undefined) process.env.MC_PLANNER_MODEL = prev;
      tracker._resetForTesting();
    }
  });
});

describe('F03 complement triggers real plan revision (public path)', () => {
  let repo: string; let xdgTmp: string; let prevXdg: string | undefined;
  let stateDir: string;
  const orchs: Array<{ stopReconciler?: () => void }> = [];
  const monitors: Array<{ stop?: () => void }> = [];
  let restoreDataDir: () => void = () => {};
  beforeEach(async () => {
    prevXdg = process.env.MC_XDG_DATA_DIR;
    xdgTmp = await tempDir('mc-xdg-f03-');
    process.env.MC_XDG_DATA_DIR = xdgTmp;
    const fs = await import('fs');
    stateDir = (await import('path')).join(xdgTmp, 'state');
    fs.mkdirSync(stateDir, { recursive: true });
    const paths = await import('../../src/lib/paths');
    try {
      const { spyOn } = await import('bun:test');
      const spy = spyOn(paths, 'getDataDir').mockResolvedValue(stateDir);
      restoreDataDir = () => (spy as unknown as { mockRestore: () => void }).mockRestore();
    } catch { restoreDataDir = () => {}; }
    repo = await mkRepo('mc-f03-');
    const tracker = await import('../../src/lib/model-tracker');
    tracker._resetForTesting();
    tracker.setCurrentModel({ providerID: 'opencode-go', modelID: 'muse-spark-1.3-contributor' });
  });
  afterEach(async () => {
    for (const o of orchs.splice(0)) try { o.stopReconciler?.(); } catch {}
    for (const m of monitors.splice(0)) try { m.stop?.(); } catch {}
    try { restoreDataDir(); } catch {}
    if (prevXdg === undefined) delete process.env.MC_XDG_DATA_DIR;
    else process.env.MC_XDG_DATA_DIR = prevXdg;
    const fs = await import('fs');
    for (const d of [repo, xdgTmp]) try { if (d && fs.existsSync(d)) fs.rmSync(d, { recursive: true, force: true }); } catch {}
    const tracker = await import('../../src/lib/model-tracker');
    tracker._resetForTesting();
  });

  it('complement com requisito novo muda resultado funcional (nova task via caminhos existentes)', async () => {
    const { Orchestrator } = await import('../../src/lib/orchestrator');
    const { JobMonitor } = await import('../../src/lib/monitor');
    const { loadConfig } = await import('../../src/lib/config');
    const { loadPlan, savePlan } = await import('../../src/lib/plan-state');
    const { loadAutoIntake, saveAutoIntake } = await import('../../src/lib/durable-state');
    const { withRepoRoot } = await import('../../src/lib/paths');
    const jm = new JobMonitor();
    monitors.push(jm as unknown as { stop?: () => void });
    const orch = new Orchestrator(jm, await loadConfig());
    orchs.push(orch as unknown as { stopReconciler?: () => void });
    (orch as unknown as { launchJob: unknown }).launchJob = async () => {};
    // Base: intake + plano com task-a (sem tmux — savePlan direto, caminho público de estado).
    const intakeId = 'intake-f03-base';
    const now = new Date().toISOString();
    const baseHead = await git(repo, 'rev-parse', 'HEAD');
    await withRepoRoot(repo, async () => {
      await saveAutoIntake({
        id: intakeId, request: 'do X', repo, requirements: [{ id: 'r1', text: 'do X', acceptance: ['done'] }],
        decisions: [], questions: [], nextSteps: [], status: 'running',
        createdAt: now, updatedAt: now,
      });
      await savePlan({
        id: 'plan-f03', name: 'do X', mode: 'autopilot', status: 'running',
        jobs: [{ id: 'j-a', name: 'task-a', prompt: 'Do X in src/a.ts', status: 'queued' } as never],
        integrationBranch: 'main', baseCommit: baseHead, createdAt: now,
      } as never, repo);
    });
    const before = await loadPlan(repo);
    expect(before!.jobs.map((j) => j.name)).toEqual(['task-a']);
    // Complemento com requisito novo: o modelo revisa e propõe task-b.
    const gen2 = async () => JSON.stringify({
      requirements: [
        { id: 'r1', text: 'do X', acceptance: ['done'] },
        { id: 'r2', text: 'handle timeouts', acceptance: ['timeout covered'] },
      ],
      tasks: [
        { name: 'task-a', prompt: 'Do X in src/a.ts', acceptance: ['done'] },
        { name: 'task-b', prompt: 'Handle timeouts in src/a.ts', acceptance: ['timeout covered'] },
      ],
      decisions: ['added timeout handling'],
      questions: [],
      nextSteps: [],
    });
    await withRepoRoot(repo, async () => {
      await (orch as unknown as { complementAutonomousRequest: (id: string, t: string, g: unknown) => Promise<unknown> }).complementAutonomousRequest(intakeId, 'Also handle timeouts', gen2);
    });
    const after = await loadPlan(repo);
    const names = after!.jobs.map((j) => j.name);
    // Resultado funcional: nova task criada OU pergunta humana registrada (nunca só Follow-up/decisão-log).
    const intake = await withRepoRoot(repo, async () => loadAutoIntake(intakeId));
    const functional = names.includes('task-b') || intake!.questions.some((q) => /timeout/i.test(q));
    expect(functional).toBe(true);
    expect(intake!.request).toMatch(/Follow-up/);
  });
});

describe('F07 resume recovers interrupted planning and merging (public path)', () => {
  let repo: string; let xdgTmp: string; let prevXdg: string | undefined;
  let stateDir: string;
  const orchs: Array<{ stopReconciler?: () => void }> = [];
  const monitors: Array<{ stop?: () => void }> = [];
  let restoreDataDir: () => void = () => {};
  beforeEach(async () => {
    prevXdg = process.env.MC_XDG_DATA_DIR;
    xdgTmp = await tempDir('mc-xdg-f07-');
    process.env.MC_XDG_DATA_DIR = xdgTmp;
    const fs = await import('fs');
    stateDir = (await import('path')).join(xdgTmp, 'state');
    fs.mkdirSync(stateDir, { recursive: true });
    const paths = await import('../../src/lib/paths');
    try {
      const { spyOn } = await import('bun:test');
      const spy = spyOn(paths, 'getDataDir').mockResolvedValue(stateDir);
      restoreDataDir = () => (spy as unknown as { mockRestore: () => void }).mockRestore();
    } catch { restoreDataDir = () => {}; }
    repo = await mkRepo('mc-f07-');
    const tracker = await import('../../src/lib/model-tracker');
    tracker._resetForTesting();
    tracker.setCurrentModel({ providerID: 'opencode-go', modelID: 'muse-spark-1.3-contributor' });
  });
  afterEach(async () => {
    for (const o of orchs.splice(0)) try { o.stopReconciler?.(); } catch {}
    for (const m of monitors.splice(0)) try { m.stop?.(); } catch {}
    try { restoreDataDir(); } catch {}
    if (prevXdg === undefined) delete process.env.MC_XDG_DATA_DIR;
    else process.env.MC_XDG_DATA_DIR = prevXdg;
    const fs = await import('fs');
    for (const d of [repo, xdgTmp]) try { if (d && fs.existsSync(d)) fs.rmSync(d, { recursive: true, force: true }); } catch {}
    const tracker = await import('../../src/lib/model-tracker');
    tracker._resetForTesting();
    try { (await import('../../src/lib/orchestrator-singleton'))._resetForTesting?.(); } catch {}
  });

  it('retomada com planejamento interrompido gera plano (não "no active plan" vazio)', async () => {
    const { Orchestrator } = await import('../../src/lib/orchestrator');
    const { JobMonitor } = await import('../../src/lib/monitor');
    const { loadConfig } = await import('../../src/lib/config');
    const { saveAutoIntake } = await import('../../src/lib/durable-state');
    const { loadPlan } = await import('../../src/lib/plan-state');
    const { withRepoRoot } = await import('../../src/lib/paths');
    const intakeId = 'intake-f07-await';
    const now = new Date().toISOString();
    await withRepoRoot(repo, async () => {
      await saveAutoIntake({
        id: intakeId, request: 'do X via resume', repo, requirements: [],
        decisions: [], questions: [], nextSteps: [], status: 'awaiting-plan',
        createdAt: now, updatedAt: now,
      });
    });
    const jm = new JobMonitor();
    monitors.push(jm as unknown as { stop?: () => void });
    const orch = new Orchestrator(jm, await loadConfig());
    orchs.push(orch as unknown as { stopReconciler?: () => void });
    (orch as unknown as { launchJob: unknown }).launchJob = async () => {};
    (orch as unknown as { repoRoot: string }).repoRoot = repo;
    const gen = async () => JSON.stringify(validDraft());
    const out = await withRepoRoot(repo, async () =>
      (orch as unknown as { resumeAutonomousIntake: (id: string, g?: unknown) => Promise<string> }).resumeAutonomousIntake(intakeId, gen),
    );
    const plan = await loadPlan(repo);
    expect(plan).not.toBeNull();
    expect(out).not.toMatch(/no active plan/i);
  });

  it('queda em merging reativa sem sucesso vazio (kill -9 simulado reconcilia)', async () => {
    const { Orchestrator } = await import('../../src/lib/orchestrator');
    const { JobMonitor } = await import('../../src/lib/monitor');
    const { loadConfig } = await import('../../src/lib/config');
    const { loadPlan, savePlan } = await import('../../src/lib/plan-state');
    const { saveAutoIntake } = await import('../../src/lib/durable-state');
    const { withRepoRoot } = await import('../../src/lib/paths');
    const intakeId = 'intake-f07-crash';
    const now = new Date().toISOString();
    const baseHead = await git(repo, 'rev-parse', 'HEAD');
    await withRepoRoot(repo, async () => {
      await saveAutoIntake({
        id: intakeId, request: 'do X crash', repo, requirements: [{ id: 'r1', text: 'do X', acceptance: ['done'] }],
        decisions: [], questions: [], nextSteps: [], status: 'running',
        createdAt: now, updatedAt: now,
      });
      await savePlan({
        id: 'plan-f07-crash', name: 'do X crash', mode: 'autopilot', status: 'merging',
        jobs: [{ id: 'j-a', name: 'task-a', prompt: 'Do X', status: 'merging' } as never],
        integrationBranch: 'main', baseCommit: baseHead, createdAt: now,
      } as never, repo);
    });
    // Processo morto: nova instância (sem reconciliador) retoma pelo caminho público.
    const jm2 = new JobMonitor();
    monitors.push(jm2 as unknown as { stop?: () => void });
    const orch2 = new Orchestrator(jm2, await loadConfig());
    orchs.push(orch2 as unknown as { stopReconciler?: () => void });
    (orch2 as unknown as { launchJob: unknown }).launchJob = async () => {};
    (orch2 as unknown as { repoRoot: string }).repoRoot = repo;
    const out = await withRepoRoot(repo, async () =>
      (orch2 as unknown as { resumeAutonomousIntake: (id: string) => Promise<string> }).resumeAutonomousIntake(intakeId),
    );
    expect(out.trim().length).toBeGreaterThan('Resumed'.length);
    expect(out).not.toMatch(/^Resumed\s*$/);
    // Reativação real: merging não fica preso — volta a running (reconciliador reativa) e relata.
    const after = await loadPlan(repo);
    expect(after!.status).toBe('running');
    expect(out).toMatch(/reativ|resum/i);
  });
});
