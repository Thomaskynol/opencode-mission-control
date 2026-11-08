import { describe, it, expect, beforeEach, afterEach, spyOn, mock } from 'bun:test';
import * as jobState from '../../src/lib/job-state';
import * as tmux from '../../src/lib/tmux';
import * as worktree from '../../src/lib/worktree';
import * as orchestratorSingleton from '../../src/lib/orchestrator-singleton';
import * as reports from '../../src/lib/reports';

const { mc_status } = await import('../../src/tools/status');

const mockContext = {
  sessionID: 'tmc-session', messageID: 'm', agent: 'a', directory: '/tmp',
  worktree: '/tmp', abort: new AbortController().signal, metadata: mock(), ask: mock(),
} as any;

function job(overrides: Partial<jobState.Job> = {}): jobState.Job {
  return {
    id: 'tmc-job-1', name: 'tmc-job', worktreePath: '/tmp/tmc-wt', branch: 'mc/tmc-job',
    tmuxTarget: 'tmc-job', placement: 'session', status: 'running', prompt: 'do',
    mode: 'vanilla', createdAt: new Date().toISOString(), ...overrides,
  } as jobState.Job;
}

describe('mc_status: estágio do report consultável (RED)', () => {
  beforeEach(() => {
    mock.restore();
    spyOn(jobState, 'getJobByName').mockResolvedValue(job() as any);
    spyOn(tmux, 'capturePane').mockResolvedValue('' as any);
    spyOn(worktree, 'isInManagedWorktree').mockResolvedValue({ isManaged: true } as any);
    spyOn(orchestratorSingleton, 'getSharedMonitor').mockReturnValue({
      getEventAccumulator: mock(() => undefined),
    } as any);
    spyOn(reports, 'readReport').mockResolvedValue(null);
    spyOn(reports, 'readReviewVerdict').mockResolvedValue(null);
  });

  afterEach(() => {
    mock.restore();
  });

  it('TUI running sem report: estágio ausente-tui, sem fingir skill', async () => {
    const out = await mc_status.execute({ name: 'tmc-job' }, mockContext) as unknown as string;
    expect(out).toContain('missing-tui-running');
    expect(out).not.toMatch(/skill .*utilizad/i);
  });

  it('serve running sem report: estágio ausente-serve com sem-ACK', async () => {
    (jobState.getJobByName as any).mockResolvedValue(job({
      port: 14502, serverUrl: 'http://127.0.0.1:14502', remoteSessionID: 'ses_tmc',
    }));
    const out = await mc_status.execute({ name: 'tmc-job' }, mockContext) as unknown as string;
    expect(out).toMatch(/sem ACK do serve/);
  });

  it('com report carregado: estágio loaded + veredito persistido visível', async () => {
    (reports.readReport as any).mockResolvedValue({
      jobId: 'tmc-job-1', jobName: 'tmc-job', status: 'working', message: 'wip',
      timestamp: new Date().toISOString(),
    });
    (reports.readReviewVerdict as any).mockResolvedValue({
      jobId: 'tmc-job-1', jobName: 'tmc-job', verdict: 'pass', commit: 'abc1234',
      branch: 'mc/tmc-job', transport: 'serve', timestamp: new Date().toISOString(),
    });
    const out = await mc_status.execute({ name: 'tmc-job' }, mockContext) as unknown as string;
    expect(out).toContain('loaded-signal');
    expect(out).toMatch(/Review Verdict:.*pass/);
    expect(out).toContain('abc1234');
  });
});
