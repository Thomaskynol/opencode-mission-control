import { describe, it, expect, beforeEach, afterEach, spyOn, mock } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

/**
 * Lane F (accept-report): ator nas aprovações + ressalva + Problems de registros reais.
 * RED: estes testes falham antes da implementação (ator ausente, Problems inventado).
 */

describe('lane F: ator registrado e exibido (humano vs agente-operador vs sistema)', () => {
  it('bindReviewApproval registra agent-operator por padrão (nunca humano implícito)', async () => {
    const { bindReviewApproval } = await import('../../src/orchestrator-cli/auto-commands');
    // Precisa de repo git real para resolver refs; cria mínimo.
    const base = mkdtempSync(join(tmpdir(), 'mc-actor-'));
    try {
      const proc = Bun.spawnSync(['git', 'init'], { cwd: base });
      if (proc.exitCode !== 0) throw new Error('git init failed');
      Bun.spawnSync(['git', 'config', 'user.email', 't@t.com'], { cwd: base });
      Bun.spawnSync(['git', 'config', 'user.name', 'T'], { cwd: base });
      writeFileSync(join(base, 'a.txt'), 'hi');
      Bun.spawnSync(['git', 'add', '.'], { cwd: base });
      Bun.spawnSync(['git', 'commit', '-m', 'init'], { cwd: base });
      Bun.spawnSync(['git', 'branch', '-M', 'main'], { cwd: base });
      Bun.spawnSync(['git', 'branch', 'feature'], { cwd: base });
      Bun.spawnSync(['git', 'branch', 'integration'], { cwd: base });
      const approval = await bindReviewApproval('feature', 'integration', base, 'reason test');
      const withActor = approval as unknown as { actor?: string; actorEvidence?: string };
      expect(withActor.actor).toBe('agent-operator');
      expect(String(withActor.actorEvidence ?? '')).toMatch(/não-humano|agent-operator|sem --actor/i);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('approve --actor human registra humano com evidência explícita', async () => {
    const { bindReviewApproval } = await import('../../src/orchestrator-cli/auto-commands');
    const base = mkdtempSync(join(tmpdir(), 'mc-actor-human-'));
    try {
      Bun.spawnSync(['git', 'init'], { cwd: base });
      Bun.spawnSync(['git', 'config', 'user.email', 't@t.com'], { cwd: base });
      Bun.spawnSync(['git', 'config', 'user.name', 'T'], { cwd: base });
      writeFileSync(join(base, 'a.txt'), 'hi');
      Bun.spawnSync(['git', 'add', '.'], { cwd: base });
      Bun.spawnSync(['git', 'commit', '-m', 'init'], { cwd: base });
      Bun.spawnSync(['git', 'branch', '-M', 'main'], { cwd: base });
      Bun.spawnSync(['git', 'branch', 'feature'], { cwd: base });
      Bun.spawnSync(['git', 'branch', 'integration'], { cwd: base });
      // cav-2.1: mesmo com evidência forjada, human permanece auto-declarado não atestado.
      const approval = await bindReviewApproval('feature', 'integration', base, 'reason test', {
        actor: 'human',
        actorEvidence: 'explicit --actor human (invocação humana via TUI)',
      });
      const withActor = approval as unknown as { actor?: string; actorEvidence?: string };
      expect(withActor.actor).toBe('human');
      expect(String(withActor.actorEvidence ?? '')).toMatch(/auto-declarado.*sem atesta/i);
      expect(String(withActor.actorEvidence ?? '')).not.toMatch(/invocação humana via TUI/i);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('PlanSpecSchema preserva ator no reviewApproval', async () => {
    const { PlanSpecSchema } = await import('../../src/lib/schemas');
    const plan = {
      id: 'p1',
      name: 'n',
      mode: 'autopilot',
      status: 'paused',
      jobs: [
        {
          id: 'j1',
          name: 'stats',
          prompt: 'do stats',
          status: 'ready_to_merge',
          branch: 'feature-stats',
          reviewApproval: {
            reviewedCommit: 'abc1234',
            reviewedBase: 'def5678',
            reason: 'operator accept',
            at: new Date().toISOString(),
            kind: 'accept',
            actor: 'agent-operator',
            actorEvidence: 'CLI approve sem --actor explícito — registrado como agent-operator (não-humano)',
          },
        },
      ],
      integrationBranch: 'integration',
      baseCommit: 'def5678',
      createdAt: new Date().toISOString(),
    };
    const parsed = PlanSpecSchema.parse(JSON.parse(JSON.stringify(plan)));
    const got = (parsed.jobs[0] as unknown as { reviewApproval?: { actor?: string } }).reviewApproval;
    expect(got?.actor).toBe('agent-operator');
  });
});

describe('lane F: pendência aceita permanece Unverified (nunca verified)', () => {
  it('aceite-agente com scope integration NÃO verifica (bloqueia selo verified)', async () => {
    const { isTaskVerified } = await import('../../src/lib/verification');
    const rec = {
      testStatus: 'passed',
      scope: 'integration',
      testCommand: 'bun test',
      reviewedCommit: 'a81ccfb68d4c3accbd49cc2feb22cf8375341dd0',
    } as never;
    expect(isTaskVerified(rec)).toBe(false);
  });

  it('buildFinalReportMarkdown mantém aceite com ressalva fora de Verified', async () => {
    const { buildFinalReportMarkdown } = await import('../../src/lib/reports');
    const markdown = buildFinalReportMarkdown({
      title: 'Accept',
      decisions: ['approve accept: "stats" pinned at a81ccfb6 on base 899a0b76 — ator agent-operator (não-humano) — COM RESSALVA'],
      integration: { branch: 'mc/integration-1', merged: ['stats'], conflicts: [] },
      verified: [],
      unverified: ['stats [merged] — covered only by global integration smoke (bun test), no task-scoped verification'],
      problems: [{ problem: 'aceite stats com ressalva', solution: 'COM RESSALVA — permanece Unverified', status: 'pendente' }],
    });
    const verifiedSection = markdown.split('## Verified')[1].split('## Gaps')[0];
    expect(verifiedSection).not.toContain('stats');
    expect(verifiedSection).toMatch(/Nothing verified yet/i);
    const gaps = markdown.split('## Gaps')[1];
    expect(gaps).toMatch(/stats.*Unverified|Unverified.*stats/i);
    // Ressalva visível: ator + COM RESSALVA fora de Verified
    expect(markdown).toMatch(/agent-operator.*não-humano|COM RESSALVA/i);
  });
});

describe('lane F: Problems de registros reais (resolvido/pendente/desconhecido)', () => {
  it('deriva outage do provedor + deadlock/retry/aceite de decisions reais', async () => {
    const mod = await import('../../src/lib/reports');
    const derive = (mod as unknown as { deriveProblemsFromRecords?: (i: unknown) => Array<{ problem: string; solution: string; status?: string }> }).deriveProblemsFromRecords;
    expect(typeof derive).toBe('function');
    const problems = derive!({
      title: 'M5',
      decisions: [
        'review capitalize: fail (provider.no-route Model unavailable: opencode-go) — fail-closed',
        'review stats: fail (2 reason(s)) — deadlock req-3 x req-4, vereditos alternados',
        'approve accept: "stats" pinned at a81ccfb6 on base 899a0b76 — ator agent-operator (não-humano) — COM RESSALVA',
        'review stats: pass (operator accept honored for a81ccfb6 — version-bound, no re-review)',
      ],
      verified: [],
      unmet: [],
      unverified: ['stats [merged] — covered only by global integration smoke (bun test), no task-scoped verification'],
      integration: { branch: 'mc/integration-1', merged: ['stats'] },
      contributions: [],
    } as never);
    const text = JSON.stringify(problems);
    expect(text).toMatch(/provider\.no-route|outage/i);
    expect(text).toMatch(/deadlock|req-3|retry/i);
    expect(text).toMatch(/accept.*stats|agent-operator/i);
    // Status distinguido, nunca inventa sucesso: aceite é pendente, não resolvido
    const acceptEntry = problems.find((p) => /accept/i.test(p.problem));
    expect(acceptEntry?.status).toBe('pendente');
    // Nenhum problema alega verified para pendência aceita
    for (const p of problems) {
      if (/accept/i.test(p.problem)) expect(p.status).not.toBe('resolvido');
    }
  });

  it('marca desconhecido quando evidência removida (lacuna, não sucesso)', async () => {
    const mod = await import('../../src/lib/reports');
    const derive = (mod as unknown as { deriveProblemsFromRecords?: (i: unknown) => Array<{ problem: string }> }).deriveProblemsFromRecords;
    const problems = derive!({
      title: 'Empty',
      decisions: [],
      verified: [],
      unmet: ['broken [failed]: tests red'],
      unverified: [],
      integration: { branch: 'mc/integration-1', merged: [] },
      contributions: [],
    } as never);
    // Sem decisions, a causa é desconhecida — deve declarar, não alegar sucesso
    const text = JSON.stringify(problems);
    expect(text).toMatch(/desconhecido/i);
  });

  it('não alega "No problems reported" quando há gaps (não esconde pendência)', async () => {
    const { buildFinalReportMarkdown } = await import('../../src/lib/reports');
    const markdown = buildFinalReportMarkdown({
      title: 'Gaps',
      decisions: ['review stats: fail (2 reason(s)) — deadlock req-3 x req-4'],
      verified: [],
      unmet: [],
      unverified: ['stats [merged] — covered only by global integration smoke, no task-scoped verification'],
      integration: { branch: 'mc/integration-1', merged: ['stats'] },
    });
    const problemsSection = markdown.split('## Problems & Solutions')[1].split('## Verified')[0];
    expect(problemsSection).not.toMatch(/No problems reported/);
    expect(problemsSection).toMatch(/stats|deadlock|pendente|desconhecido/i);
  });
});

describe('lane F: CLI report com dados reais (ator + ressalva visíveis)', () => {
  it('`report` expõe aceite-agente e ressalva a partir de estado real', async () => {
    const planStateMod = await import('../../src/lib/plan-state');
    const jobStateMod = await import('../../src/lib/job-state');
    const reportsMod = await import('../../src/lib/reports');
    const restore: Array<() => void> = [];
    try {
      restore.push(spyOn(planStateMod, 'loadPlan').mockResolvedValue({
        id: 'plan-accept-1',
        name: 'Accept work',
        mode: 'autopilot',
        status: 'completed',
        jobs: [
          {
            id: 'stats-id', name: 'stats', prompt: 'do stats', status: 'merged',
            branch: 'mc/plan/stats', mergedAt: new Date().toISOString(),
            reviewApproval: {
              reviewedCommit: 'a81ccfb68d4c3accbd49cc2feb22cf8375341dd0',
              reviewedBase: '899a0b761edf26a77f5ce9a131e5e7db0e776c2d',
              reason: 'operator accept of on_error checkpoint for "stats"',
              at: new Date().toISOString(), kind: 'accept',
              actor: 'agent-operator',
              actorEvidence: 'CLI approve sem --actor explícito — registrado como agent-operator (não-humano)',
            },
          },
        ],
        integrationBranch: 'mc/integration-plan-1',
        baseCommit: 'abc',
        createdAt: new Date().toISOString(),
      } as never));
      restore.push(spyOn(jobStateMod, 'loadJobState').mockResolvedValue({
        version: 3, jobs: [], updatedAt: new Date().toISOString(),
      } as never));
      restore.push(spyOn(reportsMod, 'readAllReports').mockResolvedValue([]));
      let captured = '';
      restore.push(spyOn(reportsMod, 'writeFinalReport').mockImplementation(async (_id: string, md: string) => {
        captured = md;
        return '/tmp/final.md';
      }));
      // durable-state sidecars: intake decisions com aceite + provider outage
      const durable = await import('../../src/lib/durable-state');
      restore.push(spyOn(durable, 'loadRuntimeSnapshot').mockResolvedValue({
        autoIntake: {
          id: 'intake-1',
          request: 'stats mission',
          decisions: [
            'review stats: fail (deadlock req-3 x req-4)',
            'approve accept: "stats" pinned at a81ccfb6 — ator agent-operator (não-humano) — COM RESSALVA',
          ],
          questions: [],
        },
        pendingQuestions: [],
      } as never));
      restore.push(spyOn(durable, 'loadMergeEvidence').mockResolvedValue({
        stats: {
          jobName: 'stats', testStatus: 'passed', testCommand: 'bun test',
          reviewedCommit: 'a81ccfb68d4c3accbd49cc2feb22cf8375341dd0',
          reviewedBase: '899a0b761edf26a77f5ce9a131e5e7db0e776c2d',
          scope: 'integration',
        },
      } as never));

      const { dispatchArgv } = await import('../../src/orchestrator-cli/commands');
      const controls = { pause: async () => '', resume: async () => '', cancel: async () => '', answer: async () => '', launch: async () => '' };
      const out = await dispatchArgv(['report'], controls as never);
      expect(out).toContain('Final report for plan');
      expect(captured).toMatch(/agent-operator.*não-humano|COM RESSALVA/i);
      // Pendência aceita fora de Verified
      const verifiedSection = captured.split('## Verified')[1].split('## Gaps')[0];
      expect(verifiedSection).not.toContain('stats [merged, task-scoped]');
      expect(captured.split('## Gaps')[1]).toMatch(/stats/i);
    } finally {
      mock.restore();
      for (const fn of restore) try { fn(); } catch {}
    }
  });
});
