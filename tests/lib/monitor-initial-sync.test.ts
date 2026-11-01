import { describe, it, expect, beforeEach, afterEach, spyOn, mock, type Mock } from 'bun:test';
import { join } from 'path';
import { tmpdir } from 'os';
import * as paths from '../../src/lib/paths';
import * as jobState from '../../src/lib/job-state';
import * as tmuxMod from '../../src/lib/tmux';
import * as reportsMod from '../../src/lib/reports';
import { JobMonitor } from '../../src/lib/monitor';
import { createV2Client } from '../../src/lib/sdk-client';

let mockGetJob: Mock<any>;
let mockUpdateJob: Mock<any>;

const realFetch = globalThis.fetch;
let testBaseDir = '';
let testStateDir = '';

function runningJob(overrides: Record<string, unknown> = {}): any {
  return {
    id: 'demo-r5',
    name: 'demo-r5-worker',
    worktreePath: '/tmp/wt-demo-r5',
    branch: 'mc/demo-r5',
    tmuxTarget: 'mc-demo-r5',
    placement: 'session',
    status: 'running',
    prompt: 'do demo work',
    mode: 'vanilla',
    createdAt: new Date().toISOString(),
    port: 14991,
    serverUrl: 'http://127.0.0.1:14991',
    remoteSessionID: 'ses_demo_r5',
    serverPassword: 'pw-demo-r5',
    ...overrides,
  };
}

function stubSessionGet(outcome: string | undefined, status = 200) {
  globalThis.fetch = (async (url: unknown) => {
    if (String(url).includes('/session/ses_demo_r5')) {
      const body = outcome === undefined ? { id: 'ses_demo_r5' } : { id: 'ses_demo_r5', outcome };
      return new Response(JSON.stringify({ data: body }), { status });
    }
    return new Response('{}', { status: 404 });
  }) as typeof fetch;
}

describe('monitor initial sync (demo-r5 regression)', () => {
  beforeEach(async () => {
    mockGetJob = spyOn(jobState, 'getJob').mockResolvedValue(undefined as any);
    mockUpdateJob = spyOn(jobState, 'updateJob').mockResolvedValue(undefined as any);
    spyOn(tmuxMod, 'isPaneRunning').mockResolvedValue(false as never);
    spyOn(tmuxMod, 'capturePane').mockResolvedValue('' as never);
    spyOn(tmuxMod, 'captureExitStatus').mockResolvedValue(undefined as never);
    spyOn(reportsMod, 'readReport').mockResolvedValue(null as never);
    const fs = await import('fs');
    testBaseDir = await fs.promises.mkdtemp(join(tmpdir(), 'mc-monitor-initial-sync-'));
    testStateDir = join(testBaseDir, 'state');
    fs.mkdirSync(testStateDir, { recursive: true });
    spyOn(paths, 'getDataDir').mockResolvedValue(testStateDir);
    globalThis.fetch = realFetch;
  });

  afterEach(async () => {
    globalThis.fetch = realFetch;
    mock.restore();
    const fs = await import('fs');
    if (testBaseDir && fs.existsSync(testBaseDir)) {
      fs.rmSync(testBaseDir, { recursive: true, force: true });
    }
  });

  it('completes a running job whose remote session already succeeded', async () => {
    const job = runningJob();
    mockGetJob.mockResolvedValue(job);
    stubSessionGet('succeeded');

    const monitor = new JobMonitor();
    const completeHandler = mock();
    monitor.on('complete', completeHandler);

    await monitor.syncSessionOutcome(job, createV2Client(job.port, job.serverPassword));

    expect(mockUpdateJob).toHaveBeenCalledWith('demo-r5', expect.objectContaining({ status: 'completed' }));
    expect(completeHandler).toHaveBeenCalledTimes(1);
  });

  it('fails a running job whose remote session already failed', async () => {
    const job = runningJob();
    mockGetJob.mockResolvedValue(job);
    stubSessionGet('failed');

    const monitor = new JobMonitor();
    const failedHandler = mock();
    monitor.on('failed', failedHandler);

    await monitor.syncSessionOutcome(job, createV2Client(job.port, job.serverPassword));

    expect(mockUpdateJob).toHaveBeenCalledWith('demo-r5', expect.objectContaining({ status: 'failed' }));
    expect(failedHandler).toHaveBeenCalledTimes(1);
  });

  it('keeps a running job whose remote session is still active (no outcome)', async () => {
    const job = runningJob();
    mockGetJob.mockResolvedValue(job);
    stubSessionGet(undefined);

    const monitor = new JobMonitor();
    const completeHandler = mock();
    const failedHandler = mock();
    monitor.on('complete', completeHandler);
    monitor.on('failed', failedHandler);

    await monitor.syncSessionOutcome(job, createV2Client(job.port, job.serverPassword));

    expect(mockUpdateJob).not.toHaveBeenCalled();
    expect(completeHandler).not.toHaveBeenCalled();
    expect(failedHandler).not.toHaveBeenCalled();
  });

  it('ignores interrupted outcome (pause ack changes nothing)', async () => {
    const job = runningJob();
    mockGetJob.mockResolvedValue(job);
    stubSessionGet('interrupted');

    const monitor = new JobMonitor();
    const completeHandler = mock();
    const failedHandler = mock();
    monitor.on('complete', completeHandler);
    monitor.on('failed', failedHandler);

    await monitor.syncSessionOutcome(job, createV2Client(job.port, job.serverPassword));

    expect(mockUpdateJob).not.toHaveBeenCalled();
    expect(completeHandler).not.toHaveBeenCalled();
    expect(failedHandler).not.toHaveBeenCalled();
  });

  it('is idempotent: already-terminal local job is ignored, no duplicate', async () => {
    const job = runningJob({ status: 'completed' });
    mockGetJob.mockResolvedValue(job);
    stubSessionGet('succeeded');

    const monitor = new JobMonitor();
    const completeHandler = mock();
    monitor.on('complete', completeHandler);

    await monitor.syncSessionOutcome(job, createV2Client(job.port, job.serverPassword));

    expect(mockUpdateJob).not.toHaveBeenCalled();
    expect(completeHandler).not.toHaveBeenCalled();
  });

  it('subscribe without password warns fail-open, no throw, no subscription', async () => {
    const { serverPassword: _dropped, ...noPassword } = runningJob();
    const job = { ...noPassword, serverPassword: undefined };
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});

    const monitor = new JobMonitor();
    let threw: unknown = null;
    try {
      await (monitor as any).subscribeToSSE(job);
    } catch (error) {
      threw = error;
    }

    expect(threw).toBeNull();
    expect(warnSpy).toHaveBeenCalled();
    expect((monitor as any).sseSubscriptions.has('demo-r5')).toBe(false);
    expect(mockUpdateJob).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});
