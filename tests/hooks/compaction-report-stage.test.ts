import { describe, it, expect, beforeEach, afterEach, spyOn, mock } from 'bun:test';
import * as jobState from '../../src/lib/job-state';
import * as reports from '../../src/lib/reports';
import * as awareness from '../../src/hooks/awareness';

const { getCompactionContext } = await import('../../src/hooks/compaction');

function job(overrides: Partial<jobState.Job> = {}): jobState.Job {
  return {
    id: 'tmc-job-1', name: 'tmc-job', worktreePath: '/tmp/tmc-wt', branch: 'mc/tmc-job',
    tmuxTarget: 'tmc-job', placement: 'session', status: 'running', prompt: 'do tmc',
    mode: 'vanilla', createdAt: new Date().toISOString(), ...overrides,
  } as jobState.Job;
}

describe('compaction: estágio do report sem misassociação (RED)', () => {
  beforeEach(() => {
    mock.restore();
    spyOn(jobState, 'loadJobState').mockResolvedValue({ version: 3, jobs: [], updatedAt: new Date().toISOString() } as any);
    spyOn(reports, 'readAllReports').mockResolvedValue([]);
    spyOn(awareness, 'getWorktreeContext').mockResolvedValue({ isInJob: false } as any);
  });

  afterEach(() => {
    mock.restore();
  });

  it('serve sem report: report: none com motivo sem-ACK', async () => {
    (jobState.loadJobState as any).mockResolvedValue({
      version: 3, jobs: [job({ port: 14504, serverUrl: 'http://127.0.0.1:14504', remoteSessionID: 'ses_tmc' })],
      updatedAt: new Date().toISOString(),
    });
    const out = await getCompactionContext();
    expect(out).toContain('report: none');
    expect(out).toMatch(/sem ACK do serve|serve-mode/i);
  });

  it('stale-name não associado como atual', async () => {
    const now = new Date().toISOString();
    (jobState.loadJobState as any).mockResolvedValue({
      version: 3, jobs: [job({ id: 'tmc-new-id', name: 'tmc-job' })],
      updatedAt: new Date().toISOString(),
    });
    (reports.readAllReports as any).mockResolvedValue([
      { jobId: 'tmc-old-id', jobName: 'tmc-job', status: 'completed', message: 'old done', timestamp: now },
    ]);
    const out = await getCompactionContext();
    expect(out).not.toContain('old done');
    expect(out).toContain('report: none');
  });
});
