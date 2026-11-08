import { describe, it, expect, beforeEach, afterEach, spyOn, mock } from 'bun:test';
import * as jobState from '../../src/lib/job-state';
import * as planState from '../../src/lib/plan-state';
import * as reports from '../../src/lib/reports';
import * as orchestratorSingleton from '../../src/lib/orchestrator-singleton';

const { mc_overview } = await import('../../src/tools/overview');

function job(overrides: Partial<jobState.Job> = {}): jobState.Job {
  return {
    id: 'tmc-job-1', name: 'tmc-job', worktreePath: '/tmp/tmc-wt', branch: 'mc/tmc-job',
    tmuxTarget: 'tmc-job', placement: 'session', status: 'running', prompt: 'do',
    mode: 'vanilla', createdAt: new Date().toISOString(), ...overrides,
  } as jobState.Job;
}

describe('mc_overview: estágio + veredito consultáveis, sem misassociação stale (RED)', () => {
  beforeEach(() => {
    mock.restore();
    spyOn(jobState, 'loadJobState').mockResolvedValue({ version: 3, jobs: [], updatedAt: new Date().toISOString() } as any);
    spyOn(jobState, 'getRunningJobs').mockResolvedValue([]);
    spyOn(planState, 'loadPlan').mockResolvedValue(null);
    spyOn(reports, 'readAllReports').mockResolvedValue([]);
    spyOn(reports, 'readAllReviewVerdicts').mockResolvedValue([]);
    spyOn(orchestratorSingleton, 'getSharedMonitor').mockReturnValue({
      getEventAccumulator: mock(() => undefined),
    } as any);
  });

  afterEach(() => {
    mock.restore();
  });

  it('TUI running sem report: estágio ausente-tui na linha', async () => {
    (jobState.getRunningJobs as any).mockResolvedValue([job()]);
    const out = await mc_overview.execute({}) as unknown as string;
    expect(out).toContain('tmc-job');
    expect(out).toContain('TUI running');
  });

  it('serve running sem report: linha com sem-ACK (não finge uso)', async () => {
    (jobState.getRunningJobs as any).mockResolvedValue([job({
      id: 'tmc-s-1', name: 'tmc-serve', port: 14503, serverUrl: 'http://127.0.0.1:14503', remoteSessionID: 'ses_tmc',
    })]);
    const out = await mc_overview.execute({}) as unknown as string;
    expect(out).toContain('tmc-serve');
    expect(out).toMatch(/sem ACK do serve/);
    expect(out).not.toMatch(/skill .*utilizad/i);
  });

  it('relaunch (novo jobId, mesmo nome): report antigo NÃO associado ao novo job', async () => {
    const now = new Date().toISOString();
    (jobState.getRunningJobs as any).mockResolvedValue([job({ id: 'tmc-new-id', name: 'tmc-job' })]);
    (reports.readAllReports as any).mockResolvedValue([
      { jobId: 'tmc-old-id', jobName: 'tmc-job', status: 'completed', message: 'old done', timestamp: now },
    ]);
    const out = await mc_overview.execute({}) as unknown as string;
    expect(out).not.toContain('old done');
    // Stale explícito com o jobId antigo — sem OU permissivo: a linha stale
    // com o jobId anterior é obrigatória quando só existe report stale.
    expect(out).toMatch(/stale.*tmc-old-id/);
  });

  it('veredito persistido aparece no overview', async () => {
    (jobState.getRunningJobs as any).mockResolvedValue([job()]);
    (reports.readAllReviewVerdicts as any).mockResolvedValue([
      { jobId: 'tmc-job-1', jobName: 'tmc-job', verdict: 'pass', commit: 'abc1234', branch: 'mc/tmc-job', transport: 'serve', timestamp: new Date().toISOString() },
    ]);
    const out = await mc_overview.execute({}) as unknown as string;
    expect(out).toMatch(/Review Verdicts|verdict: pass/i);
    expect(out).toContain('abc1234');
  });
});
