import { describe, it, expect, beforeEach, afterEach, spyOn, mock, type Mock } from 'bun:test';
import { join } from 'path';
import { tmpdir } from 'os';
import * as paths from '../../src/lib/paths';
import * as jobState from '../../src/lib/job-state';
import * as tmuxMod from '../../src/lib/tmux';
import * as reportsMod from '../../src/lib/reports';
import { JobMonitor, eventBelongsToSession } from '../../src/lib/monitor';

let mockGetJob: Mock<any>;
let mockUpdateJob: Mock<any>;
let mockGetRunningJobs: Mock<any>;

const realFetch = globalThis.fetch;
let testBaseDir = '';
let testStateDir = '';

function serveJob(overrides: Record<string, unknown> = {}): any {
  return {
    id: 'sse-fix',
    name: 'sse-fix-worker',
    worktreePath: '/tmp/wt-sse-fix',
    branch: 'mc/sse-fix',
    tmuxTarget: 'mc-sse-fix',
    placement: 'session',
    status: 'running',
    prompt: 'do sse work',
    mode: 'vanilla',
    createdAt: new Date().toISOString(),
    port: 14997,
    serverUrl: 'http://127.0.0.1:14997',
    remoteSessionID: 'ses_sse_fix',
    serverPassword: 'pw-sse-fix',
    ...overrides,
  };
}

function seedSubscription(monitor: JobMonitor, jobId = 'sse-fix', port = 14997): void {
  (monitor as any).sseSubscriptions.set(jobId, {
    abortController: new AbortController(),
    client: { baseUrl: `http://127.0.0.1:${port}/api`, headers: {} },
    reconnectAttempts: 0,
  });
}

/** Route stubbed fetch by URL: session outcome + form detail, 404 otherwise. */
function stubServeFetch(opts: { outcome?: string; form?: unknown }): void {
  globalThis.fetch = (async (url: unknown) => {
    const u = String(url);
    if (u.includes('/form/frm_wire')) {
      return new Response(JSON.stringify({ data: opts.form }), { status: 200 });
    }
    if (u.includes('/session/ses_sse_fix') && !u.includes('/form') && !u.includes('/permission')) {
      const body =
        opts.outcome === undefined ? { id: 'ses_sse_fix' } : { id: 'ses_sse_fix', outcome: opts.outcome };
      return new Response(JSON.stringify({ data: body }), { status: 200 });
    }
    return new Response('{}', { status: 404 });
  }) as typeof fetch;
}

const wireForm = {
  id: 'frm_wire',
  sessionID: 'ses_sse_fix',
  title: 'Wire Q',
  metadata: { kind: 'question', tool: { id: 'call_wire' } },
  fields: [{ key: 'q0', title: 'Pick', description: 'choose one', options: [] }],
  state: { status: 'pending' },
};

describe('monitor SSE real-shape recovery (lane FD)', () => {
  beforeEach(async () => {
    mockGetJob = spyOn(jobState, 'getJob').mockResolvedValue(undefined as any);
    mockUpdateJob = spyOn(jobState, 'updateJob').mockResolvedValue(undefined as any);
    mockGetRunningJobs = spyOn(jobState, 'getRunningJobs').mockResolvedValue([]);
    spyOn(tmuxMod, 'isPaneRunning').mockResolvedValue(false as never);
    spyOn(tmuxMod, 'capturePane').mockResolvedValue('' as never);
    spyOn(tmuxMod, 'captureExitStatus').mockResolvedValue(undefined as never);
    spyOn(reportsMod, 'readReport').mockResolvedValue(null as never);
    const fs = await import('fs');
    testBaseDir = await fs.promises.mkdtemp(join(tmpdir(), 'mc-monitor-sse-'));
    testStateDir = join(testBaseDir, 'state');
    fs.mkdirSync(testStateDir, { recursive: true });
    spyOn(paths, 'getDataDir').mockResolvedValue(testStateDir);
    globalThis.fetch = realFetch;
  });

  afterEach(async () => {
    globalThis.fetch = realFetch;
    mock.restore();
    const { removePendingQuestion } = await import('../../src/lib/question-relay');
    removePendingQuestion('sse-fix', 'frm_wire');
    removePendingQuestion('sse-fix', 'perm:per_wire');
    const fs = await import('fs');
    if (testBaseDir && fs.existsSync(testBaseDir)) {
      fs.rmSync(testBaseDir, { recursive: true, force: true });
    }
  });

  it('matches session pointers nested in data.form / data.part (real 2.2.5 wire)', () => {
    expect(
      eventBelongsToSession({ type: 'form.created', data: { form: { id: 'f', sessionID: 'ses_sse_fix' } } }, 'ses_sse_fix'),
    ).toBe(true);
    expect(
      eventBelongsToSession({ type: 'message.part.updated', data: { part: { sessionID: 'ses_sse_fix' } } }, 'ses_sse_fix'),
    ).toBe(true);
    expect(
      eventBelongsToSession({ type: 'form.created', data: { form: { id: 'f', sessionID: 'ses_other' } } }, 'ses_sse_fix'),
    ).toBe(false);
  });

  it('registers form.created with the real wire shape (data.form.id), not data.id', async () => {
    stubServeFetch({ form: wireForm });
    const job = serveJob();
    const monitor = new JobMonitor();
    seedSubscription(monitor);
    const questionHandler = mock();
    monitor.on('question', questionHandler);

    // Real 2.2.5 wire (captured live): the id lives under data.form.
    await (monitor as any).handleSSEEvent(job, {
      type: 'form.created',
      data: { form: { id: 'frm_wire', sessionID: 'ses_sse_fix', title: 'Wire Q', fields: [] } },
    });

    expect(questionHandler).toHaveBeenCalledTimes(1);
  });

  it('never completes on session.idle alone: outcome absent keeps the job running', async () => {
    stubServeFetch({ outcome: undefined });
    const job = serveJob();
    mockGetJob.mockResolvedValue(job);
    const monitor = new JobMonitor();
    seedSubscription(monitor);
    const completeHandler = mock();
    monitor.on('complete', completeHandler);

    await (monitor as any).handleSSEEvent(job, {
      type: 'session.idle',
      data: { sessionID: 'ses_sse_fix' },
    });

    expect(mockUpdateJob).not.toHaveBeenCalled();
    expect(completeHandler).not.toHaveBeenCalled();
  });

  it('never completes on session.status idle alone: outcome absent keeps the job running', async () => {
    stubServeFetch({ outcome: undefined });
    const job = serveJob();
    mockGetJob.mockResolvedValue(job);
    const monitor = new JobMonitor();
    seedSubscription(monitor);
    const completeHandler = mock();
    monitor.on('complete', completeHandler);

    await (monitor as any).handleSSEEvent(job, {
      type: 'session.status',
      data: { sessionID: 'ses_sse_fix', status: { type: 'idle' } },
    });

    expect(mockUpdateJob).not.toHaveBeenCalled();
    expect(completeHandler).not.toHaveBeenCalled();
  });

  it('completes on session.idle only when the authoritative outcome is terminal', async () => {
    stubServeFetch({ outcome: 'succeeded' });
    const job = serveJob();
    mockGetJob.mockResolvedValue(job);
    const monitor = new JobMonitor();
    seedSubscription(monitor);
    const completeHandler = mock();
    monitor.on('complete', completeHandler);

    await (monitor as any).handleSSEEvent(job, {
      type: 'session.idle',
      data: { sessionID: 'ses_sse_fix' },
    });

    expect(mockUpdateJob).toHaveBeenCalledWith('sse-fix', expect.objectContaining({ status: 'completed' }));
    expect(completeHandler).toHaveBeenCalledTimes(1);
  });

  it('recovers a missed terminal event via poll: outcome succeeded completes without new SSE', async () => {
    stubServeFetch({ outcome: 'succeeded' });
    const job = serveJob();
    mockGetRunningJobs.mockResolvedValue([job]);
    mockGetJob.mockResolvedValue(job);
    const monitor = new JobMonitor();
    seedSubscription(monitor);
    const completeHandler = mock();
    monitor.on('complete', completeHandler);

    await (monitor as any).poll();

    expect(mockUpdateJob).toHaveBeenCalledWith('sse-fix', expect.objectContaining({ status: 'completed' }));
    expect(completeHandler).toHaveBeenCalledTimes(1);
  });

  it('poll recovery never completes alone: outcome absent keeps the job running', async () => {
    stubServeFetch({ outcome: undefined });
    const job = serveJob();
    mockGetRunningJobs.mockResolvedValue([job]);
    mockGetJob.mockResolvedValue(job);
    const monitor = new JobMonitor();
    seedSubscription(monitor);
    const completeHandler = mock();
    const failedHandler = mock();
    monitor.on('complete', completeHandler);
    monitor.on('failed', failedHandler);

    await (monitor as any).poll();

    expect(mockUpdateJob).not.toHaveBeenCalled();
    expect(completeHandler).not.toHaveBeenCalled();
    expect(failedHandler).not.toHaveBeenCalled();
  });

  it('poll recovery never duplicates: already-terminal job stays untouched', async () => {
    stubServeFetch({ outcome: 'succeeded' });
    const job = serveJob();
    mockGetRunningJobs.mockResolvedValue([job]);
    mockGetJob.mockResolvedValue({ ...job, status: 'completed' });
    const monitor = new JobMonitor();
    seedSubscription(monitor);
    const completeHandler = mock();
    monitor.on('complete', completeHandler);

    await (monitor as any).poll();

    expect(mockUpdateJob).not.toHaveBeenCalled();
    expect(completeHandler).not.toHaveBeenCalled();
  });
});
