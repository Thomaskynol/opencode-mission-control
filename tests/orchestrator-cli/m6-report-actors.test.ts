import { describe, it, expect, spyOn, mock } from 'bun:test';

/**
 * Lane M6 (auditoria investigator): autonomia/relato honesto no report.
 * 1. Ator por decisão de takeover/retry/resume/accept (human auto-declarado
 *    COM RESSALVA vs agent-operator vs system; sem evidência = desconhecido).
 * 2. "Nenhum review accept usado" explícito vs lista de aceites sob ressalva
 *    (nunca Verified por aceite).
 * 3. Ramos não exercitados (fix-before-rollback) + budget auto-fix declarados.
 * 4. OMO/plugins/skills: disponível vs carregado vs efetivamente utilizado.
 * 5. agent-operator nunca integra reprovado/não-verificado (gates fail-closed).
 */

describe('M6: rótulo canônico de ator (nunca atribuir sem evidência)', () => {
  it('formatActorLabel distingue human/agent-operator/system/desconhecido', async () => {
    const { formatActorLabel } = await import('../../src/lib/reports');
    expect(formatActorLabel('human')).toMatch(/auto-declarado.*sem atesta.*não verificado/i);
    expect(formatActorLabel('human')).not.toMatch(/\(humano\)/);
    expect(formatActorLabel('agent-operator')).toMatch(/não-humano/);
    expect(formatActorLabel('system')).toMatch(/não-humano/);
    expect(formatActorLabel(undefined)).toMatch(/desconhecido/);
    expect(formatActorLabel('')).toMatch(/desconhecido/);
    expect(formatActorLabel('joão')).toMatch(/desconhecido/);
  });

  it('extractActorMention lê flag e rótulo; ausente = undefined (desconhecido)', async () => {
    const { extractActorMention } = await import('../../src/lib/reports');
    expect(extractActorMention('approve --retry "a" --actor agent-operator por x')).toBe('agent-operator');
    expect(extractActorMention('aceite ator human (auto-declarado) @ abc')).toBe('human');
    expect(extractActorMention('sistema: ator system fez y')).toBe('system');
    expect(extractActorMention('handoff: conductor detached pid 1')).toBeUndefined();
  });

  it('resolveCliActor: padrão agent-operator, human/system explícitos, inválido recusa', async () => {
    const { resolveCliActor } = await import('../../src/orchestrator-cli/auto-commands');
    const def = resolveCliActor(new Map(), 'approve');
    expect(def.actor).toBe('agent-operator');
    expect(def.evidence).toMatch(/sem --actor explícito.*não-humano/);
    const human = resolveCliActor(new Map([['actor', 'human']]), 'approve');
    expect(human.actor).toBe('human');
    expect(human.evidence).toMatch(/auto-declarado.*sem atesta.*não verificado/);
    expect(resolveCliActor(new Map([['actor', 'system']]), 'resume').actor).toBe('system');
    expect(() => resolveCliActor(new Map([['actor', 'root']]), 'approve')).toThrow(/Invalid --actor/);
  });
});

describe('M6: Problems exibe ator por intervenção (takeover/retry/resume)', () => {
  it('takeover com --actor agent-operator exibe ator não-humano', async () => {
    const { deriveProblemsFromRecords } = await import('../../src/lib/reports');
    const problems = deriveProblemsFromRecords({
      title: 'M6',
      decisions: ['conductor takeover: approve --takeover --actor agent-operator assumed plan p (epoch 3, pid 9) — ator agent-operator (não-humano)'],
      verified: [],
      unmet: [],
      unverified: ['a [running] — outcome not verified'],
      integration: { branch: 'mc/i', merged: [], conflicts: [] },
      contributions: [],
    } as never);
    const entry = problems.find((p) => /intervenção do operador/i.test(p.problem));
    expect(entry).toBeDefined();
    expect(entry!.problem).toMatch(/agent-operator.*não-humano/);
    expect(entry!.status).toBe('pendente');
  });

  it('retry sem evidência de ator registra desconhecido (nunca presume)', async () => {
    const { deriveProblemsFromRecords } = await import('../../src/lib/reports');
    const problems = deriveProblemsFromRecords({
      title: 'M6',
      decisions: ['approve/retry worker-a: conductor detached driver pid 5 (lease ok)'],
      verified: [],
      unmet: [],
      unverified: ['worker-a [running] — outcome not verified'],
      integration: { branch: 'mc/i', merged: [], conflicts: [] },
      contributions: [],
    } as never);
    const entry = problems.find((p) => /intervenção do operador/i.test(p.problem));
    expect(entry).toBeDefined();
    expect(entry!.problem).toMatch(/desconhecido/);
  });

  it('resume com ator human mantém ressalva de auto-declaração', async () => {
    const { deriveProblemsFromRecords } = await import('../../src/lib/reports');
    const problems = deriveProblemsFromRecords({
      title: 'M6',
      decisions: ['handoff: resume --intake abc --actor human por ator human (auto-declarado via --actor, sem atestação fora de banda — não verificado) — resume: conductor live'],
      verified: [],
      unmet: [],
      unverified: ['a [running] — outcome not verified'],
      integration: { branch: 'mc/i', merged: [], conflicts: [] },
      contributions: [],
    } as never);
    const entry = problems.find((p) => /intervenção do operador/i.test(p.problem));
    expect(entry).toBeDefined();
    expect(entry!.problem).toMatch(/auto-declarado/);
    expect(entry!.status).toBe('pendente');
  });

  it('aceite permanece pendente mesmo com pass posterior não-aceite (nunca resolvido)', async () => {
    const { deriveProblemsFromRecords } = await import('../../src/lib/reports');
    const problems = deriveProblemsFromRecords({
      title: 'M6',
      decisions: [
        'approve accept: "s" pinned at a81ccfb6 on base 899a0b76 — ator agent-operator (não-humano) — COM RESSALVA',
        'review other: pass (task-scoped evidence @ 12345678)',
      ],
      verified: [],
      unmet: [],
      unverified: ['s [merged] — covered only by global integration smoke (bun test), no task-scoped verification'],
      integration: { branch: 'mc/i', merged: ['s'] },
      contributions: [],
    } as never);
    const acceptEntry = problems.find((p) => /accept/i.test(p.problem));
    expect(acceptEntry?.status).toBe('pendente');
  });
});

describe('M6: Gaps sem otimismo (Unmet vazio + Unverified presente)', () => {
  it('qualifica "No unmet items" quando há Unverified; puro quando não há gaps', async () => {
    const { buildFinalReportMarkdown } = await import('../../src/lib/reports');
    const withUnverified = buildFinalReportMarkdown({
      title: 'M6',
      decisions: ['handoff: resume --intake x por ator desconhecido (desconhecido) — resume: pause respected'],
      verified: [],
      unmet: [],
      unverified: ['a [paused] — outcome not verified'],
      integration: { branch: 'mc/i', merged: [] },
    });
    const gaps = withUnverified.split('## Gaps')[1];
    expect(gaps).toMatch(/No unmet items reported.*atenção.*Unverified.*não é sucesso/i);
    const clean = buildFinalReportMarkdown({ title: 'M6 clean' });
    expect(clean.split('## Gaps')[1]).toMatch(/No unmet items reported/);
    expect(clean.split('## Gaps')[1]).not.toMatch(/atenção/);
  });
});

describe('M6: gates fail-closed — agent-operator não integra reprovado/não-verificado', () => {
  it('merge-train recusa veredito fail e ausência de veredito (strict)', async () => {
    const { MergeTrain } = await import('../../src/lib/merge-train');
    const train = new MergeTrain('/tmp/mc-m6-gate-scope', { requireReviewPass: true });
    train.enqueue({
      id: 'j1', name: 'evil', prompt: 'do', status: 'ready_to_merge',
      branch: 'mc/evil',
    } as never);
    const failVerdict = {
      verdict: 'fail', blocking: true, reasons: ['nojo'],
      jobName: 'evil', reviewedCommit: 'a'.repeat(40), reviewedBase: 'b'.repeat(40),
    } as never;
    const blocked = await train.processNext(failVerdict);
    expect(blocked.success).toBe(false);
    expect(blocked.type).toBe('review_blocked');
    expect(blocked.output).toMatch(/verdict=fail/);
    // Strict sem veredito também recusa (nunca merge sem pass explícito).
    train.enqueue({
      id: 'j1', name: 'evil', prompt: 'do', status: 'ready_to_merge',
      branch: 'mc/evil',
    } as never);
    const noVerdict = await train.processNext(null);
    expect(noVerdict.success).toBe(false);
    expect(noVerdict.type).toBe('review_blocked');
    expect(noVerdict.output).toMatch(/verdict=pass/);
  });
});

describe('M6: mc_report_final honesto (no-accept, budget, rollback, tri-state, aceite-humano)', () => {
  async function runReport(plan: unknown, snap: unknown, evidence: unknown, jobs: unknown) {
    const planStateMod = await import('../../src/lib/plan-state');
    const jobStateMod = await import('../../src/lib/job-state');
    const reportsMod = await import('../../src/lib/reports');
    const restore: Array<() => void> = [];
    try {
      restore.push(spyOn(planStateMod, 'loadPlan').mockResolvedValue(plan as never));
      restore.push(spyOn(jobStateMod, 'loadJobState').mockResolvedValue({
        version: 3, jobs: jobs as never, updatedAt: new Date().toISOString(),
      } as never));
      restore.push(spyOn(reportsMod, 'readAllReports').mockResolvedValue([]));
      let captured = '';
      restore.push(spyOn(reportsMod, 'writeFinalReport').mockImplementation(async (_id: string, md: string) => {
        captured = md;
        return '/tmp/final-m6.md';
      }));
      const durable = await import('../../src/lib/durable-state');
      restore.push(spyOn(durable, 'loadRuntimeSnapshot').mockResolvedValue(snap as never));
      restore.push(spyOn(durable, 'loadMergeEvidence').mockResolvedValue(evidence as never));
      const { mc_report_final } = await import('../../src/tools/report');
      await mc_report_final.execute({}, {} as never);
      return captured;
    } finally {
      mock.restore();
      for (const fn of restore) try { fn(); } catch {}
    }
  }

  const basePlan = (jobs: unknown) => ({
    id: 'p-m6', name: 'M6 work', mode: 'autopilot', status: 'completed',
    jobs, integrationBranch: 'mc/integration-1', baseCommit: 'abc',
    createdAt: new Date().toISOString(),
  });
  const baseSnap = (decisions: string[]) => ({
    autoIntake: { id: 'i1', request: 'r', decisions, questions: [] },
    pendingQuestions: [],
  });

  it('declara "Nenhum review accept usado" + budget/rollback/permission tri-state sem aceites', async () => {
    const captured = await runReport(
      basePlan([{ id: 'j1', name: 'a', prompt: 'do', status: 'completed', branch: 'mc/a' }]),
      baseSnap(['review a: fail (x) — auto-fix attempt 1/2 dispatched', 'auto-fix budget exhausted (2/2) — escalating']),
      {},
      [],
    );
    expect(captured).toMatch(/Nenhum review accept usado neste run/);
    expect(captured).toMatch(/auto-fix: 1\/2.*budget esgotado/i);
    expect(captured).toMatch(/fix-before-rollback: ramo não exercitado/);
    expect(captured).toMatch(/decisionLog de permissões.*não conservado/);
    expect(captured).toMatch(/plugins \(disponível:/);
    expect(captured).toMatch(/skills \(disponível:/);
  });

  it('aceite human integra sem selo verified, com ressalva de auto-declaração', async () => {
    const commit = 'a81ccfb68d4c3accbd49cc2feb22cf8375341dd0';
    const captured = await runReport(
      basePlan([{
        id: 'j1', name: 'stats', prompt: '- [ ] works', status: 'merged',
        branch: 'mc/stats', mergedAt: new Date().toISOString(),
        reviewApproval: {
          reviewedCommit: commit, reviewedBase: 'b'.repeat(40),
          reason: 'operator accept', at: new Date().toISOString(), kind: 'accept',
          actor: 'human', actorEvidence: 'actor human (auto-declarado via --actor, sem atestação fora de banda — não verificado)',
        },
      }]),
      baseSnap([`approve accept: "stats" pinned at a81ccfb6 — ator human (auto-declarado via --actor, sem atestação fora de banda — não verificado) — COM RESSALVA`]),
      { stats: { jobName: 'stats', testStatus: 'passed', testCommand: 'bun test', reviewedCommit: commit, scope: 'integration' } },
      [],
    );
    expect(captured).toMatch(/auto-declarado/);
    expect(captured).toMatch(/COM RESSALVA/);
    expect(captured).not.toMatch(/Nenhum review accept usado/);
    const verifiedSection = captured.split('## Verified')[1].split('## Gaps')[0];
    expect(verifiedSection).not.toContain('stats');
  });

  it('fix-before-rollback disponível só para serve-mode; auto-fix ausente é desconhecido honesto', async () => {
    const captured = await runReport(
      basePlan([{ id: 'j1', name: 'a', prompt: 'do', status: 'completed', branch: 'mc/a' }]),
      baseSnap([]),
      {},
      [{ id: 'j1', name: 'srv', status: 'running', branch: 'mc/srv', mode: 'vanilla', port: 18731, remoteSessionID: 'ses_1', createdAt: new Date().toISOString() }],
    );
    expect(captured).toMatch(/fix-before-rollback: disponível para srv/);
    expect(captured).toMatch(/auto-fix: nenhuma tentativa registrada.*não observável/);
  });
});
