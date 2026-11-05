import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
/**
 * OBJETIVO 3 (M8) — header clicando com Gaps + aceite nunca Verified.
 *
 * Forma M8: 5 merged; 3 task-verified SEM mc_report + 2 com evidência só de
 * smoke global E com aceite. input.unverified = 4 (2 smoke + 2 aceites);
 * Gaps renderiza 7 (4 + 3 `missing per-instance report`). Antes do fix o
 * header dizia "Unverified: 4" contra 7 linhas em Gaps.
 * Fix: header conta o total renderizado com categorias; aceite continua
 * fora de Verified via excludeAcceptedFromVerified.
 */
import {
  buildFinalReportMarkdown,
  describeGapCategories,
  excludeAcceptedFromVerified,
  formatAcceptGap,
  type FinalReportInput,
} from '../../src/lib/reports';
import * as jobState from '../../src/lib/job-state';
import * as planState from '../../src/lib/plan-state';
import * as reports from '../../src/lib/reports';
import * as durableState from '../../src/lib/durable-state';
import * as omo from '../../src/lib/omo';

const { mc_report_final } = await import('../../src/tools/report');

const COMMIT = '7762a1462fb1cf0b6b750dc37f126dd95fd9e989';

function m8Input(): FinalReportInput {
  const merged = ['v1', 'v2', 'v3', 's1', 's2'];
  return {
    title: 'M8',
    integration: { branch: 'mc/integration-m8', merged, conflicts: [] },
    contributions: [
      { instance: 'ses-s1', job: 's1', summary: '[completed] smoke only' },
      { instance: 'ses-s2', job: 's2', summary: '[completed] smoke only' },
    ],
    verified: [
      `v1 [merged, task-scoped] bun test passed @ ${COMMIT.slice(0, 8)}`,
      `v2 [merged, task-scoped] bun test passed @ ${COMMIT.slice(0, 8)}`,
      `v3 [merged, task-scoped] bun test passed @ ${COMMIT.slice(0, 8)}`,
    ],
    unmet: [],
    unverified: [
      's1 [merged] — covered only by global integration smoke (bun test), no task-scoped verification',
      's2 [merged] — covered only by global integration smoke (bun test), no task-scoped verification',
      formatAcceptGap('s1', 'agent-operator'),
      formatAcceptGap('s2', 'agent-operator'),
    ],
  };
}

describe('M8 unit: header categories match rendered Gaps', () => {
  it('4 unverified input + 3 sem mc_report = 7 gaps com categorias', () => {
    const markdown = buildFinalReportMarkdown(m8Input());
    const gaps = markdown.split('## Gaps')[1];
    const unverifiedLines = gaps.split('\n').filter((l) => l.startsWith('- Unverified:'));
    expect(unverifiedLines).toHaveLength(7);
    expect(gaps).toMatch(/missing per-instance report for "v1"/);
    expect(gaps).toMatch(/missing per-instance report for "v2"/);
    expect(gaps).toMatch(/missing per-instance report for "v3"/);
    // Total explícito com categorias clicando com o header.
    expect(gaps).toMatch(/Total Unverified: 7 \(.*aceite.*cobertura parcial.*sem mc_report.*\)/);
    // Aceites com ressalva nunca em Verified.
    const verified = markdown.split('## Verified')[1].split('## Gaps')[0];
    expect(verified).toContain('v1 [merged, task-scoped]');
    expect(verified).not.toContain('s1');
    expect(verified).not.toContain('s2');
  });

  it('describeGapCategories resume 2 aceites + 2 parcial + 3 sem mc_report', () => {
    const input = m8Input();
    const all = [
      ...input.unverified!,
      'missing per-instance report for "v1" (merged without mc_report)',
      'missing per-instance report for "v2" (merged without mc_report)',
      'missing per-instance report for "v3" (merged without mc_report)',
    ];
    const cats = describeGapCategories(all);
    expect(cats).toMatch(/2 aceite\(s\) com ressalva/);
    expect(cats).toMatch(/2 cobertura parcial \(smoke global\)/);
    expect(cats).toMatch(/3 sem mc_report/);
  });

  it('aceite nunca vira Verified (excludeAcceptedFromVerified permanece)', () => {
    const candidates = [
      's1 [merged, task-scoped] bun test passed @ 7762a146',
      'v1 [merged, task-scoped] bun test passed @ 7762a146',
    ];
    expect(excludeAcceptedFromVerified(candidates, ['s1'])).toEqual([
      'v1 [merged, task-scoped] bun test passed @ 7762a146',
    ]);
    expect(excludeAcceptedFromVerified(candidates, [])).toEqual(candidates);
  });
});

describe('M8 tool: mc_report_final header conta o total renderizado', () => {
  let mockWriteFinalReport: Mock;

  function makePlanJob(name: string, status: string, reviewApproval?: { actor?: string }) {
    return {
      id: `${name}-id`,
      name,
      prompt: `do ${name}`,
      status,
      branch: `mc/${name}`,
      createdAt: new Date().toISOString(),
      ...(reviewApproval ? { reviewApproval: { ...reviewApproval, reviewedCommit: COMMIT } } : {}),
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();

    vi.spyOn(planState, 'loadPlan').mockResolvedValue({
      id: 'plan-m8',
      name: 'M8',
      mode: 'autopilot',
      status: 'running',
      jobs: [
        makePlanJob('v1', 'merged'),
        makePlanJob('v2', 'merged'),
        makePlanJob('v3', 'merged'),
        makePlanJob('s1', 'merged', { actor: 'agent-operator' }),
        makePlanJob('s2', 'merged', { actor: 'agent-operator' }),
      ],
      integrationBranch: 'mc/integration-m8',
      baseCommit: 'abc',
      createdAt: new Date().toISOString(),
    } as any);

    vi.spyOn(jobState, 'loadJobState').mockResolvedValue({
      version: 3,
      jobs: [],
      updatedAt: new Date().toISOString(),
    } as any);

    vi.spyOn(reports, 'readAllReports').mockResolvedValue([
      { jobId: 's1-id', jobName: 's1', status: 'completed', message: 'smoke only', timestamp: new Date().toISOString() },
      { jobId: 's2-id', jobName: 's2', status: 'completed', message: 'smoke only', timestamp: new Date().toISOString() },
    ] as any);

    mockWriteFinalReport = vi.spyOn(reports, 'writeFinalReport').mockImplementation(
      async (_planId: string, markdown: string) => {
        (mockWriteFinalReport as any).lastMarkdown = markdown;
        return '/tmp/final-m8.md';
      },
    ) as unknown as Mock;

    vi.spyOn(durableState, 'loadRuntimeSnapshot').mockResolvedValue(null);
    vi.spyOn(durableState, 'loadMergeEvidence').mockResolvedValue({
      v1: { jobName: 'v1', testStatus: 'passed', scope: 'task', testCommand: 'bun test', reviewedCommit: COMMIT },
      v2: { jobName: 'v2', testStatus: 'passed', scope: 'task', testCommand: 'bun test', reviewedCommit: COMMIT },
      v3: { jobName: 'v3', testStatus: 'passed', scope: 'task', testCommand: 'bun test', reviewedCommit: COMMIT },
      s1: { jobName: 's1', testStatus: 'passed', testCommand: 'bun test' },
      s2: { jobName: 's2', testStatus: 'passed', testCommand: 'bun test' },
    } as any);
    vi.spyOn(omo, 'detectOMO').mockResolvedValue({ detected: false } as any);
  });

  it('header Unverified: 7 (categorias) = 7 linhas em Gaps; aceite fora de Verified', async () => {
    const result = await mc_report_final.execute({}, { sessionID: 't' } as any) as unknown as string;
    expect(result).toContain('Integrated: 5');
    expect(result).toContain('Unmet: 0');
    expect(result).toContain('Unverified: 7');
    expect(result).toMatch(/aceite.*cobertura parcial.*sem mc_report/);

    const markdown = (mockWriteFinalReport as any).lastMarkdown as string;
    const gaps = markdown.split('## Gaps')[1];
    expect(gaps.split('\n').filter((l) => l.startsWith('- Unverified:'))).toHaveLength(7);
    const verifiedSection = markdown.split('## Verified')[1].split('## Gaps')[0];
    expect(verifiedSection).toContain('v1 [merged, task-scoped]');
    expect(verifiedSection).not.toMatch(/s1 \[merged/);
    expect(verifiedSection).not.toMatch(/s2 \[merged/);
    expect(markdown).toMatch(/COM RESSALVA.*aceite nunca Verified/);
  });
});
