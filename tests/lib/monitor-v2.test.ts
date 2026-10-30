import { describe, it, expect, beforeEach, afterEach, spyOn, mock, type Mock } from 'bun:test';
import { join } from 'path';
import { tmpdir } from 'os';
import * as paths from '../../src/lib/paths';
import * as jobState from '../../src/lib/job-state';
import * as tmuxMod from '../../src/lib/tmux';
import * as reportsMod from '../../src/lib/reports';
import { JobMonitor } from '../../src/lib/monitor';
import { eventBelongsToSession } from '../../src/lib/monitor';
const { getPendingQuestionsForJob } = await import('../../src/lib/question-relay');
const { loadRuntimeSnapshot } = await import('../../src/lib/durable-state');

let mockGetJob: Mock<any>;
let mockUpdateJob: Mock<any>;

const realFetch = globalThis.fetch;
let testBaseDir = '';
let testStateDir = '';

function v2Job(overrides: Record<string, unknown> = {}): any {
  return {
    id: 'v2-live',
    name: 'v2alpha',
    worktreePath: '/tmp/wt-v2alpha',
    branch: 'mc/v2alpha',
    tmuxTarget: 'mc-v2alpha',
    placement: 'session',
    status: 'running',
    prompt: 'do v2 things',
    mode: 'vanilla',
    createdAt: new Date().toISOString(),
    port: 14201,
    serverUrl: 'http://127.0.0.1:14201',
    remoteSessionID: 'ses_v2remote',
    ...overrides,
  };
}

describe('monitor v2 events', () => {
  beforeEach(async () => {
    mockGetJob = spyOn(jobState, 'getJob').mockResolvedValue(undefined as any);
    mockUpdateJob = spyOn(jobState, 'updateJob').mockResolvedValue(undefined as any);
    // Isolate tmux/reports without leaking module mocks to other files.
    spyOn(tmuxMod, 'isPaneRunning').mockResolvedValue(false as never);
    spyOn(tmuxMod, 'capturePane').mockResolvedValue('' as never);
    spyOn(tmuxMod, 'captureExitStatus').mockResolvedValue(undefined as never);
    spyOn(reportsMod, 'readReport').mockResolvedValue(null as never);
    const fs = await import('fs');
    testBaseDir = await fs.promises.mkdtemp(join(tmpdir(), 'mc-monitor-v2-test-'));
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

  describe('eventBelongsToSession', () => {
    it('matches live data.sessionID and durable aggregateID', () => {
      expect(eventBelongsToSession({ type: 'x', data: { sessionID: 'ses_1' } }, 'ses_1')).toBe(true);
      expect(eventBelongsToSession({ type: 'x', data: { sessionID: 'ses_2' } }, 'ses_1')).toBe(false);
      expect(
        eventBelongsToSession({ type: 'x', durable: { aggregateID: 'ses_1' } }, 'ses_1'),
      ).toBe(true);
      expect(eventBelongsToSession({ type: 'server.connected', data: {} }, 'ses_1')).toBe(false);
      expect(eventBelongsToSession({ type: 'x', data: { sessionID: 'ses_1' } }, undefined)).toBe(
        false,
      );
    });
  });

  describe('execution terminal events', () => {
    it('completes a running job on session.execution.succeeded', async () => {
      const job = v2Job();
      mockGetJob.mockResolvedValue(job);
      mockUpdateJob.mockResolvedValue(undefined);

      const monitor = new JobMonitor();
      const completeHandler = mock();
      monitor.on('complete', completeHandler);

      await (monitor as any).handleSSEEvent(job, {
        type: 'session.execution.succeeded',
        data: { sessionID: 'ses_v2remote' },
      });

      expect(mockUpdateJob).toHaveBeenCalledWith('v2-live', expect.objectContaining({ status: 'completed' }));
      expect(completeHandler).toHaveBeenCalledTimes(1);
    });

    it('fails a running job on session.execution.failed', async () => {
      const job = v2Job();
      mockGetJob.mockResolvedValue(job);
      mockUpdateJob.mockResolvedValue(undefined);

      const monitor = new JobMonitor();
      const failedHandler = mock();
      monitor.on('failed', failedHandler);

      await (monitor as any).handleSSEEvent(job, {
        type: 'session.execution.failed',
        data: { sessionID: 'ses_v2remote' },
      });

      expect(mockUpdateJob).toHaveBeenCalledWith('v2-live', expect.objectContaining({ status: 'failed' }));
      expect(failedHandler).toHaveBeenCalledTimes(1);
    });

    it('drops stale execution events for non-running jobs', async () => {
      const job = v2Job({ status: 'stopped' });
      mockGetJob.mockResolvedValue(job);

      const monitor = new JobMonitor();
      const completeHandler = mock();
      monitor.on('complete', completeHandler);

      await (monitor as any).handleSSEEvent(job, {
        type: 'session.execution.succeeded',
        data: { sessionID: 'ses_v2remote' },
      });

      expect(mockUpdateJob).not.toHaveBeenCalled();
      expect(completeHandler).not.toHaveBeenCalled();
    });
  });

  describe('form lifecycle', () => {
    function stubFormFetch(form: unknown) {
      globalThis.fetch = (async (url: unknown) => {
        if (String(url).includes('/form/frm_v2q')) {
          return new Response(JSON.stringify({ data: form }), { status: 200 });
        }
        return new Response('{}', { status: 404 });
      }) as typeof fetch;
    }

    const pendingForm = {
      id: 'frm_v2q',
      sessionID: 'ses_v2remote',
      title: 'Pick a color',
      metadata: { kind: 'question', tool: { id: 'call_1' } },
      fields: [
        {
          key: 'q0',
          title: 'Color',
          description: 'Which color?',
          options: [{ value: 'Red', label: 'Red', description: 'warm' }],
        },
      ],
      state: { status: 'pending' },
    };

    it('registers form.created as a pending question (memory + durable) and emits', async () => {
      stubFormFetch(pendingForm);
      const job = v2Job();
      const monitor = new JobMonitor();
      (monitor as any).sseSubscriptions.set('v2-live', {
        abortController: new AbortController(),
        client: { baseUrl: 'http://127.0.0.1:14201/api', headers: {} },
        reconnectAttempts: 0,
      });

      const questionHandler = mock();
      monitor.on('question', questionHandler);

      await (monitor as any).handleSSEEvent(job, {
        type: 'form.created',
        data: { id: 'frm_v2q', sessionID: 'ses_v2remote' },
      });

      expect(questionHandler).toHaveBeenCalledTimes(1);
      const pending = getPendingQuestionsForJob('v2-live');
      expect(pending).toHaveLength(1);
      expect(pending[0].partId).toBe('frm_v2q');
      expect(pending[0].question).toContain('Pick a color');

      const sidecar = await loadRuntimeSnapshot();
      expect((sidecar?.pendingQuestions ?? []).map((q) => q.partId)).toContain('frm_v2q');

      // Cleanup memory for cross-test isolation.
      const { removePendingQuestion } = await import('../../src/lib/question-relay');
      removePendingQuestion('v2-live', 'frm_v2q');
    });

    it('drops memory + sidecar entries on form.replied', async () => {
      const { addPendingQuestion, removePendingQuestion } = await import(
        '../../src/lib/question-relay'
      );
      const { persistPendingQuestion } = await import('../../src/orchestrator-cli/forms');
      const q: any = {
        jobId: 'v2-live',
        jobName: 'v2alpha',
        taskSummary: 'do v2 things',
        partId: 'frm_v2q',
        callID: 'call_1',
        remoteSessionID: 'ses_v2remote',
        port: 14201,
        question: 'Pick a color',
        options: [],
        detectedAt: Date.now(),
      };
      addPendingQuestion(q);
      await persistPendingQuestion(q);

      const monitor = new JobMonitor();
      await (monitor as any).handleSSEEvent(v2Job(), {
        type: 'form.replied',
        data: { id: 'frm_v2q', sessionID: 'ses_v2remote' },
      });

      expect(getPendingQuestionsForJob('v2-live')).toHaveLength(0);
      const sidecar = await loadRuntimeSnapshot();
      expect((sidecar?.pendingQuestions ?? []).map((p) => p.partId)).not.toContain('frm_v2q');
      removePendingQuestion('v2-live', 'frm_v2q');
    });
  });

  describe('permission.asked', () => {
    it('auto-approves without network when the worker session is unknown', async () => {
      const job = v2Job({ remoteSessionID: undefined });
      const monitor = new JobMonitor();

      await (monitor as any).handleSSEEvent(job, {
        type: 'permission.asked',
        data: { id: 'per_1', sessionID: 'ses_x', action: 'mcp', resources: [], message: 'tool' },
      });

      expect(mockUpdateJob).not.toHaveBeenCalled();
    });
  });
});
