import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { join } from 'path';
import { tmpdir } from 'os';
import * as paths from '../../src/lib/paths';
// NOTE: tests/lib suites elsewhere register permanent module stubs for the
// literal specifiers '../../src/lib/reports' and '../../src/lib/job-state'
// (monitor.test.ts, notifications.test.ts). Import those two modules through
// a cache-busting specifier here so this file always links the real
// implementations. Product code uses '../lib/*' keys and is unaffected.
import { addJob, getJob } from '../../src/lib/job-state.ts?m6real=1';
import {
  formatReportLine,
  writeMilestoneReport,
} from '../../src/lib/reports.ts?m6real=1';
import {
  addPendingQuestion,
  clearPendingQuestionsForJob,
  type PendingQuestion,
} from '../../src/lib/question-relay';
import { pauseJob } from '../../src/tools/job-pause';
import { resumeJob } from '../../src/tools/job-resume';
import { mc_answer } from '../../src/tools/answer';
import {
  QUESTION_AUTO_RESPONSE_MS,
  QUESTION_DEFAULT_RESPONSE,
  answerQuestion,
  listPersistedQuestions,
  persistPendingQuestion,
  renderQuestionForm,
} from '../../src/orchestrator-cli/forms';
import {
  dispatchCommand,
  listQuestionForms,
  previewOrder,
  readMilestoneLog,
  type HumanControls,
} from '../../src/orchestrator-cli/commands';
import { getDashboard, queryTask, readLatestReport } from '../../src/orchestrator-cli/coordinator-client';

let testStateDir: string;
let testBaseDir: string;
let restoreDataDir: () => void;

async function createTempDir(): Promise<string> {
  const fs = await import('fs');
  return fs.promises.mkdtemp(join(tmpdir(), 'mc-human-controls-test-'));
}

function serveJob(overrides: Record<string, unknown> = {}) {
  return {
    id: 'job-1',
    name: 'alpha',
    worktreePath: '/tmp/wt-alpha',
    branch: 'mc/alpha',
    tmuxTarget: 'mc-alpha',
    placement: 'session',
    status: 'running',
    prompt: 'do things',
    mode: 'vanilla',
    createdAt: new Date().toISOString(),
    port: 14101,
    serverUrl: 'http://127.0.0.1:14101',
    remoteSessionID: 'ses_remote1',
    ...overrides,
  } as Parameters<typeof addJob>[0];
}

function pendingFixture(overrides: Partial<PendingQuestion> = {}): PendingQuestion {
  return {
    jobId: 'job-1',
    jobName: 'alpha',
    taskSummary: 'do things',
    partId: 'p1',
    callID: 'c1',
    remoteSessionID: 'ses_remote1',
    port: 14101,
    question: 'Which color?',
    options: [{ label: 'Red' }, { label: 'Blue', description: 'calm' }],
    detectedAt: Date.now(),
    ...overrides,
  };
}

function fakeControls(log: string[]): HumanControls {
  return {
    pause: async (name, opts) => {
      log.push(`pause:${name}${opts?.detach ? ':detach' : ''}`);
      return `paused ${name}`;
    },
    resume: async (name, opts) => {
      log.push(`resume:${name}:${opts?.message ?? ''}${opts?.waitForIdle ? ':wait' : ''}`);
      return `resumed ${name}`;
    },
    cancel: async (name) => {
      log.push(`cancel:${name}`);
      return `Canceled (process stopped, code preserved): ${name}`;
    },
    answer: async (name, response) => {
      log.push(`answer:${name}:${response}`);
      return `answered ${name}`;
    },
    launch: async (prompt) => {
      log.push(`launch:${prompt.length}`);
      return `launch ready (${prompt.length} chars)`;
    },
  };
}

describe('m6 human controls', () => {
  beforeEach(async () => {
    // Reports live at <dataDir>/../reports, so the mocked data dir must be
    // nested one level inside a temp base to keep everything contained.
    testBaseDir = await createTempDir();
    testStateDir = join(testBaseDir, 'state');
    const fs = await import('fs');
    fs.mkdirSync(testStateDir, { recursive: true });
    const spy = spyOn(paths, 'getDataDir').mockResolvedValue(testStateDir);
    restoreDataDir = () => spy.mockRestore();
  });

  afterEach(async () => {
    clearPendingQuestionsForJob('job-1');
    restoreDataDir();
    const fs = await import('fs');
    if (fs.existsSync(testBaseDir)) {
      fs.rmSync(testBaseDir, { recursive: true, force: true });
    }
  });

  describe('pause', () => {
    it('interrupts the session loop, keeps status running, writes a paused milestone', async () => {
      await addJob(serveJob());
      const calls: string[] = [];
      const job = (await getJob('job-1'))!;
      const result = await pauseJob(job, {
        interrupt: async () => { calls.push('interrupt'); },
        background: async () => { calls.push('background'); },
      });

      expect(calls).toEqual(['interrupt']);
      expect(result).toMatch(/paused/i);
      expect((await getJob('job-1'))!.status).toBe('running');
      const report = (await readLatestReport('job-1'))!;
      expect(report.status).toBe('paused');
      expect(report.message).toMatch(/preserved/i);
    });

    it('detaches blocking subagents when asked', async () => {
      await addJob(serveJob());
      const calls: string[] = [];
      await pauseJob((await getJob('job-1'))!, {
        interrupt: async () => { calls.push('interrupt'); },
        background: async () => { calls.push('background'); },
      }, { detach: true });
      expect(calls).toEqual(['interrupt', 'background']);
    });

    it('refuses tmux-only jobs and points to mc_kill', async () => {
      await addJob(serveJob({ port: undefined, remoteSessionID: undefined, serverUrl: undefined }));
      await expect(
        pauseJob((await getJob('job-1'))!, {
          interrupt: async () => {},
          background: async () => {},
        }),
      ).rejects.toThrow(/mc_kill/);
    });

    it('refuses jobs that are not running', async () => {
      await addJob(serveJob({ status: 'stopped' }));
      await expect(
        pauseJob((await getJob('job-1'))!, {
          interrupt: async () => {},
          background: async () => {},
        }),
      ).rejects.toThrow(/not running/);
    });
  });

  describe('resume', () => {
    it('continues the same session with follow-up text before resuming', async () => {
      await addJob(serveJob());
      const calls: string[] = [];
      const result = await resumeJob((await getJob('job-1'))!, {
        resume: async () => { calls.push('resume'); },
        prompt: async (text) => { calls.push(`prompt:${text}`); },
        wait: async () => { calls.push('wait'); },
      }, { message: 'keep going' });

      expect(calls).toEqual(['prompt:keep going', 'resume']);
      expect(result).toMatch(/same session/);
      const report = (await readLatestReport('job-1'))!;
      expect(report.message).toMatch(/follow-up/);
    });

    it('waits for idle only when asked', async () => {
      await addJob(serveJob());
      const calls: string[] = [];
      const ops = {
        resume: async () => { calls.push('resume'); },
        prompt: async (text: string) => { calls.push(`prompt:${text}`); },
        wait: async () => { calls.push('wait'); },
      };
      await resumeJob((await getJob('job-1'))!, ops);
      expect(calls).toEqual(['resume']);
      await resumeJob((await getJob('job-1'))!, ops, { waitForIdle: true });
      expect(calls).toEqual(['resume', 'resume', 'wait']);
    });

    it('refuses jobs without session info', async () => {
      await addJob(serveJob({ port: undefined, remoteSessionID: undefined, serverUrl: undefined }));
      await expect(
        resumeJob((await getJob('job-1'))!, {
          resume: async () => {},
          prompt: async () => {},
          wait: async () => {},
        }),
      ).rejects.toThrow(/serve-mode/);
    });
  });

  describe('cancel routes by exact job name and preserves code', () => {
    it('dispatches cancel to the named job with a preservation note', async () => {
      const log: string[] = [];
      const result = await dispatchCommand('cancel alpha', fakeControls(log));
      expect(log).toEqual(['cancel:alpha']);
      expect(result).toMatch(/code preserved/);
      expect(result).not.toMatch(/mc_cleanup/);
    });

    it('requires a job name (never a generic match)', async () => {
      await expect(dispatchCommand('cancel', fakeControls([]))).rejects.toThrow(/Usage/);
    });
  });

  describe('durable questions', () => {
    it('answers from memory first and clears both stores', async () => {
      addPendingQuestion(pendingFixture());
      await persistPendingQuestion(pendingFixture());
      const sent: Array<{ port: number; session: string; text: string }> = [];
      const result = await answerQuestion('alpha', 'Red', async (port, session, text) => {
        sent.push({ port, session, text });
      });

      expect(sent).toEqual([{ port: 14101, session: 'ses_remote1', text: 'Red' }]);
      expect(result).toMatch(/Answer sent to job "alpha"/);
      expect(await listPersistedQuestions()).toHaveLength(0);
      // Answered once: asking again finds nothing in either store.
      await expect(
        answerQuestion('alpha', 'Red', async () => {}),
      ).rejects.toThrow(/No pending question/);
    });

    it('falls back to the durable sidecar when memory missed', async () => {
      await persistPendingQuestion(pendingFixture({ question: 'Sidecar Q?' }));
      const sent: string[] = [];
      const result = await answerQuestion('alpha', 'Blue', async (_p, _s, text) => {
        sent.push(text);
      });
      expect(sent).toEqual(['Blue']);
      expect(result).toMatch(/durable sidecar/);
      expect(await listPersistedQuestions()).toHaveLength(0);
    });

    it('renders a respondable form with auto-response terms', () => {
      const form = renderQuestionForm(pendingFixture());
      expect(form).toContain('1. Red');
      expect(form).toContain('2. Blue — calm');
      expect(form).toContain(QUESTION_DEFAULT_RESPONSE);
      expect(form).toContain(`${QUESTION_AUTO_RESPONSE_MS / 1000}s`);
    });

    it('mc_answer validates before touching the session', async () => {
      await expect(mc_answer.execute({ name: 'ghost', response: 'x' })).rejects.toThrow(/not found/);
      await addJob(serveJob({ status: 'stopped' }));
      await expect(mc_answer.execute({ name: 'alpha', response: 'x' })).rejects.toThrow(/not running/);
    });
  });

  describe('short milestone reports, immediate alerts, no invented percentages', () => {
    it('omits the percentage suffix unless the worker reported progress', async () => {
      await writeMilestoneReport('job-1', 'alpha', 'reached milestone A');
      const line = formatReportLine((await readLatestReport('job-1'))!);
      expect(line).not.toContain('%');
    });

    it('shows worker-reported progress verbatim', async () => {
      await writeMilestoneReport('job-1', 'alpha', 'halfway', { progress: 50 });
      expect(formatReportLine((await readLatestReport('job-1'))!)).toContain('(50%)');
    });

    it('rejects out-of-range progress instead of recording it', async () => {
      await expect(writeMilestoneReport('job-1', 'alpha', 'x', { progress: 150 })).rejects.toThrow(/progress/i);
    });

    it('truncates long lines for the TUI', () => {
      const line = formatReportLine({
        jobId: 'job-1',
        jobName: 'alpha',
        status: 'working',
        message: 'm'.repeat(500),
        timestamp: new Date().toISOString(),
      });
      expect(line.length).toBeLessThanOrEqual(143);
      expect(line.endsWith('...')).toBe(true);
    });
  });

  describe('conversational dispatcher', () => {
    it('routes pause/resume/add/answer/task/send/questions/order/session/log', async () => {
      await addJob(serveJob());
      const log: string[] = [];

      expect(await dispatchCommand('pause alpha --detach', fakeControls(log))).toContain('paused alpha');
      expect(await dispatchCommand('resume alpha keep going', fakeControls(log))).toContain('resumed alpha');
      expect(await dispatchCommand('add alpha more context', fakeControls(log))).toContain('resumed alpha');
      expect(await dispatchCommand('answer alpha Red', fakeControls(log))).toContain('answered alpha');
      expect(await dispatchCommand('task alpha', fakeControls(log))).toContain('Task: alpha [running]');
      expect(await dispatchCommand('send do the big thing', fakeControls(log))).toContain('launch ready');
      expect(await dispatchCommand('questions', fakeControls(log))).toContain('No pending questions');
      expect(await dispatchCommand('order', fakeControls(log))).toContain('No active plan');
      expect(await dispatchCommand('log alpha', fakeControls(log))).toContain('No milestone reports yet');

      expect(log[0]).toBe('pause:alpha:detach');
      expect(log[1]).toBe('resume:alpha:keep going');
      expect(log.find((e) => e.startsWith('launch:'))).toBeDefined();
    });

    it('send wraps the request with coordinator guards', async () => {
      const log: string[] = [];
      const seen: string[] = [];
      await dispatchCommand('send do the big thing', {
        ...fakeControls(log),
        launch: async (prompt) => { seen.push(prompt); return 'ok'; },
      });
      expect(seen[0]).toContain('do the big thing');
      expect(seen[0]).toMatch(/never push/i);
    });

    it('shows help for unknown commands', async () => {
      const help = await dispatchCommand('frobnicate', fakeControls([]));
      expect(help).toContain('pause <name>');
    });
  });

  describe('coordinator-local reads', () => {
    it('dashboard stays short and flags paused jobs without raw logs', async () => {
      await addJob(serveJob());
      await writeMilestoneReport('job-1', 'alpha', 'Paused for input', { status: 'paused' });
      const dashboard = await getDashboard();
      expect(dashboard.running).toBe(1);
      expect(dashboard.paused).toEqual(['alpha']);
      expect(dashboard.tasks[0].lastReport).toContain('[paused]');
    });

    it('queryTask reports unknown progress honestly', async () => {
      await addJob(serveJob());
      const out = await queryTask('alpha');
      expect(out).toContain('Progress: unknown (never invented)');
      expect(out).toContain('mc_status');
    });

    it('queryTask fails cleanly for unknown jobs', async () => {
      await expect(queryTask('ghost')).rejects.toThrow(/not found/);
    });

    it('milestone log stays a one-liner', async () => {
      await addJob(serveJob());
      await writeMilestoneReport('job-1', 'alpha', 'step done', { progress: 25 });
      expect(await readMilestoneLog('alpha')).toContain('(25%)');
    });

    it('lists persisted questions as forms', async () => {
      await persistPendingQuestion(pendingFixture());
      expect(await listQuestionForms()).toContain('Which color?');
    });
  });
});
