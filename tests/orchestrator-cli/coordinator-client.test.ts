import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import * as jobStateMod from '../../src/lib/job-state';
import * as reportsMod from '../../src/lib/reports';
import * as durableMod from '../../src/lib/durable-state';
import { getDashboard } from '../../src/orchestrator-cli/coordinator-client';

function mockJob() {
  return {
    id: 'j1',
    name: 'alpha',
    worktreePath: '/tmp/wt',
    branch: 'mc/alpha',
    tmuxTarget: 'mc-alpha',
    placement: 'session',
    status: 'running',
    prompt: 'do alpha',
    mode: 'vanilla',
    createdAt: new Date().toISOString(),
  };
}

describe('coordinator-client paused (review fix)', () => {
  beforeEach(() => {
    spyOn(jobStateMod, 'loadJobState').mockImplementation(async () => ({
      version: 3,
      jobs: [mockJob()],
      updatedAt: new Date().toISOString(),
    }) as any);
    spyOn(durableMod, 'loadRuntimeSnapshot').mockResolvedValue(null);
  });

  afterEach(() => {
    mock.restore();
  });

  it('ignores a stale paused report once the job reported progress', async () => {
    spyOn(reportsMod, 'readAllReports').mockResolvedValue([
      {
        jobId: 'j1',
        jobName: 'alpha',
        status: 'paused',
        message: 'waiting',
        timestamp: new Date(Date.now() - 3600000).toISOString(),
      },
      {
        jobId: 'j1',
        jobName: 'alpha',
        status: 'progress',
        message: 'continuing',
        timestamp: new Date().toISOString(),
      },
    ] as any);
    const dashboard = await getDashboard();
    expect(dashboard.paused).toEqual([]);
  });

  it('still lists a job whose latest report is paused', async () => {
    spyOn(reportsMod, 'readAllReports').mockResolvedValue([
      {
        jobId: 'j1',
        jobName: 'alpha',
        status: 'progress',
        message: 'working',
        timestamp: new Date(Date.now() - 3600000).toISOString(),
      },
      {
        jobId: 'j1',
        jobName: 'alpha',
        status: 'paused',
        message: 'waiting',
        timestamp: new Date().toISOString(),
      },
    ] as any);
    const dashboard = await getDashboard();
    expect(dashboard.paused).toEqual(['alpha']);
  });
});
