/**
 * Lane C — relatório final registra USADO vs DETECTADO (Achado 4 M4).
 *
 * RED: `buildFinalReportMarkdown` não tem seção de ambiente; `mc_report_final`
 * não registra modo efetivo/model observado por job nem rotula notas do operador.
 */
import { describe, it, expect, beforeEach, afterEach, spyOn, mock } from 'bun:test';
import { join } from 'path';
import { tmpdir } from 'os';
import * as paths from '../../src/lib/paths';
import * as jobStateMod from '../../src/lib/job-state';
import * as planStateMod from '../../src/lib/plan-state';
import * as reportsMod from '../../src/lib/reports';
import { buildFinalReportMarkdown } from '../../src/lib/reports';

function mockPlanJob(name: string, status: string) {
  return {
    id: `${name}-id`,
    name,
    prompt: `do ${name}`,
    status,
    branch: `mc/${name}`,
    createdAt: new Date().toISOString(),
  };
}

describe('final report environment — used vs detected', () => {
  it('renders an Environment section separating effective use from mere detection', () => {
    const markdown = buildFinalReportMarkdown({
      title: 'Env',
      environment: [
        'job is-even [mode vanilla] model opencode-go/muse-spark-1.3-contributor#default (observed, session ses_1)',
        'OMO detected (global) — NOT used: all jobs ran vanilla (defaultMode vanilla)',
      ],
    });
    expect(markdown).toContain('## Environment (Used vs Detected)');
    expect(markdown).toContain('opencode-go/muse-spark-1.3-contributor#default (observed');
    expect(markdown).toContain('NOT used');
  });

  it('mc_report_final labels operator notes and records per-job effective mode/model', async () => {
    const fs = await import('fs');
    const baseDir = await fs.promises.mkdtemp(join(tmpdir(), 'mc-lanec-env-'));
    const stateDir = join(baseDir, 'state');
    fs.mkdirSync(stateDir, { recursive: true });
    const dirSpy = spyOn(paths, 'getDataDir').mockResolvedValue(stateDir);
    spyOn(planStateMod, 'loadPlan').mockResolvedValue({
      id: 'plan-1',
      name: 'Plan',
      mode: 'autopilot',
      status: 'running',
      jobs: [mockPlanJob('done-job', 'completed')],
      integrationBranch: 'mc/integration-plan-1',
      baseCommit: 'abc',
      createdAt: new Date().toISOString(),
    } as never);
    spyOn(jobStateMod, 'loadJobState').mockResolvedValue({
      version: 3,
      jobs: [
        {
          id: 'done-job-id',
          name: 'done-job',
          worktreePath: '/tmp/wt',
          branch: 'mc/done-job',
          tmuxTarget: 'mc-done',
          placement: 'session',
          status: 'running',
          prompt: 'do it',
          mode: 'vanilla',
          createdAt: new Date().toISOString(),
          modelRequested: { providerID: 'opencode-go', id: 'muse-spark-1.3-contributor', variant: 'default' },
          modelObserved: { providerID: 'opencode-go', id: 'muse-spark-1.3-contributor', variant: 'default' },
        },
      ],
      updatedAt: new Date().toISOString(),
    } as never);
    spyOn(reportsMod, 'readAllReports').mockResolvedValue([]);
    const written: string[] = [];
    spyOn(reportsMod, 'writeFinalReport').mockImplementation(async (_id: string, md: string) => {
      written.push(md);
      return '/tmp/final-report.md';
    });
    try {
      const { mc_report_final } = await import('../../src/tools/report');
      await mc_report_final.execute({ notes: 'operator saw green' } as never, {} as never);
      expect(written).toHaveLength(1);
      expect(written[0]).toContain('## Environment (Used vs Detected)');
      expect(written[0]).toContain('done-job [mode vanilla, agent unset]');
      expect(written[0]).toContain('muse-spark-1.3-contributor');
      expect(written[0]).toContain('Operator note: operator saw green');
    } finally {
      dirSpy.mockRestore();
      mock.restore();
      if (fs.existsSync(baseDir)) fs.rmSync(baseDir, { recursive: true, force: true });
    }
  });
});
