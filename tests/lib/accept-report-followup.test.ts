import { describe, it, expect } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

/**
 * Lane F follow-up (cav-2):
 * 1. actor human é auto-declaração não atestada — nunca afirmar humano/TUI como fato.
 * 2. fallback desconhecido por gap não coberto — nunca "No problems reported" com gaps.
 * RED: falham antes da correção.
 */

describe('cav-2.1 actor human auto-declarado, nunca fato', () => {
  it('bindReviewApproval human gera evidência auto-declarada (sem alegar TUI como fato)', async () => {
    const { bindReviewApproval } = await import('../../src/orchestrator-cli/auto-commands');
    const base = mkdtempSync(join(tmpdir(), 'mc-actor-spoof-'));
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
      const approval = await bindReviewApproval('feature', 'integration', base, 'reason test', {
        actor: 'human',
      });
      const withActor = approval as unknown as { actor?: string; actorEvidence?: string };
      expect(withActor.actor).toBe('human');
      // Evidência deve rotular auto-declaração, nunca afirmar humano/TUI como fato.
      expect(String(withActor.actorEvidence ?? '')).toMatch(/auto-declarado.*sem atesta/i);
      expect(String(withActor.actorEvidence ?? '')).toMatch(/não verificado/i);
      expect(String(withActor.actorEvidence ?? '')).not.toMatch(/invocação humana via TUI/i);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('HELP do approve rotula human como auto-declaração (sem afirmar humano como fato)', async () => {
    const { HELP } = await import('../../src/orchestrator-cli/commands');
    expect(HELP).toMatch(/auto-declarad/i);
    // Não pode afirmar "só com invocação humana explícita" como fato atestado.
    expect(HELP).not.toMatch(/só com invocação humana explícita/i);
    expect(HELP).not.toMatch(/invocação humana via TUI/i);
  });

  it('tools/report exibe human como auto-declarado, nunca "(humano)" como fato', async () => {
    const planStateMod = await import('../../src/lib/plan-state');
    const jobStateMod = await import('../../src/lib/job-state');
    const reportsMod = await import('../../src/lib/reports');
    const { mock, spyOn } = await import('bun:test');
    const restore: Array<() => void> = [];
    try {
      restore.push(spyOn(planStateMod, 'loadPlan').mockResolvedValue({
        id: 'p-human', name: 'Human work', mode: 'autopilot', status: 'completed',
        jobs: [{
          id: 'j1', name: 'stats', prompt: 'do', status: 'merged',
          branch: 'mc/plan/stats', mergedAt: new Date().toISOString(),
          reviewApproval: {
            reviewedCommit: 'abc1234', reviewedBase: 'def5678',
            reason: 'accept', at: new Date().toISOString(), kind: 'accept',
            actor: 'human', actorEvidence: 'auto-declarado via --actor',
          },
        }],
        integrationBranch: 'mc/integration-1', baseCommit: 'abc',
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
      const durable = await import('../../src/lib/durable-state');
      restore.push(spyOn(durable, 'loadRuntimeSnapshot').mockResolvedValue({
        autoIntake: { id: 'i1', request: 'r', decisions: [], questions: [] },
        pendingQuestions: [],
      } as never));
      restore.push(spyOn(durable, 'loadMergeEvidence').mockResolvedValue({
        stats: { jobName: 'stats', testStatus: 'passed', testCommand: 'bun test', reviewedCommit: 'abc1234', scope: 'integration' },
      } as never));
      const { dispatchArgv } = await import('../../src/orchestrator-cli/commands');
      const controls = { pause: async () => '', resume: async () => '', cancel: async () => '', answer: async () => '', launch: async () => '' };
      await dispatchArgv(['report'], controls as never);
      expect(captured).toMatch(/auto-declarado/i);
      expect(captured).not.toMatch(/ator human \(humano\)/);
    } finally {
      mock.restore();
      for (const fn of restore) try { fn(); } catch {}
    }
  });
});

describe('cav-2.2 fallback desconhecido por gap não coberto', () => {
  it('decisions reworded + unverified => desconhecido por entrada, sem No problems reported', async () => {
    const { deriveProblemsFromRecords, buildFinalReportMarkdown } = await import('../../src/lib/reports');
    const input = {
      title: 'Reword',
      decisions: ['operator honour accepted for stats (reworded, sem padrão conhecido)'],
      verified: [],
      unmet: [],
      unverified: ['stats [queued] — outcome not verified by desembaraço'],
      integration: { branch: 'mc/integration-1', merged: [] as string[], conflicts: [] as string[] },
      contributions: [],
    } as never;
    const derived = deriveProblemsFromRecords(input);
    expect(JSON.stringify(derived)).toMatch(/desconhecido/i);
    // Cada gap deve ter entrada própria (não apenas genérica).
    expect(derived.some((p) => p.problem.includes('stats [queued]'))).toBe(true);
    const markdown = buildFinalReportMarkdown(input);
    const problemsSection = markdown.split('## Problems & Solutions')[1].split('## Verified')[0];
    expect(problemsSection).not.toMatch(/No problems reported/);
    expect(problemsSection).toMatch(/desconhecido/i);
    expect(problemsSection).toMatch(/stats \[queued\]/);
  });

  it('unmet sem cobertura também gera desconhecido por entrada', async () => {
    const { buildFinalReportMarkdown } = await import('../../src/lib/reports');
    const markdown = buildFinalReportMarkdown({
      title: 'Unmet',
      decisions: ['alguma decisão reworded sem padrão'],
      verified: [],
      unmet: ['weird-job [failed]: erro exótico sem padrão'],
      unverified: [],
      integration: { branch: 'mc/integration-1', merged: [] },
    });
    const problemsSection = markdown.split('## Problems & Solutions')[1].split('## Verified')[0];
    expect(problemsSection).not.toMatch(/No problems reported/);
    expect(problemsSection).toMatch(/desconhecido/i);
    expect(problemsSection).toMatch(/weird-job/);
  });
});
