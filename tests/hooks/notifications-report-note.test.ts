import { describe, it, expect, beforeEach, afterEach, spyOn, mock } from 'bun:test';
import { setupNotifications } from '../../src/hooks/notifications';
import type { Job } from '../../src/lib/job-state';
import * as reports from '../../src/lib/reports';

function job(overrides: Partial<Job> = {}): Job {
  return {
    id: 'tmc-job-1', name: 'tmc-job', worktreePath: '/tmp/tmc-wt', branch: 'mc/tmc-job',
    tmuxTarget: 'tmc-job', placement: 'session', status: 'completed', prompt: 'do',
    mode: 'vanilla', createdAt: new Date().toISOString(), completedAt: new Date().toISOString(),
    ...overrides,
  } as Job;
}

describe('notifications: conclusão sem report vira nota útil, não sucesso falso (RED)', () => {
  let handlers: Map<string, ((job: Job, ...extra: unknown[]) => void)[]>;
  let mockClient: any;

  beforeEach(() => {
    handlers = new Map();
    mock.restore();
    spyOn(reports, 'readReport').mockResolvedValue(null);
    mockClient = {
      session: {
        prompt: mock(async () => undefined),
        get: mock(async () => ({ data: { title: 'T' } })),
        update: mock(async () => undefined),
      },
      tui: { showToast: mock(async () => undefined) },
    };
    setupNotifications({
      client: mockClient,
      monitor: { on: (e: string, h: any) => {
        const arr = handlers.get(e) ?? [];
        arr.push(h);
        handlers.set(e, arr);
      } } as any,
      getActiveSessionID: (async () => 'ses_tmc_active') as any,
      isSubagent: (async () => false) as any,
    });
  });

  afterEach(() => {
    mock.restore();
  });

  it('complete sem report menciona lacuna observável', async () => {
    handlers.get('complete')![0]!(job());
    await new Promise((r) => setTimeout(r, 50));
    const text = mockClient.session.prompt.mock.calls[0][0].body.parts[0].text as string;
    expect(text).toContain("Job 'tmc-job' completed");
    expect(text).toMatch(/[Ss]em mc_report/);
    expect(text).toMatch(/não (são|é) observáve/);
  });

  it('complete com report não adiciona ressalva', async () => {
    (reports.readReport as any).mockResolvedValue({
      jobId: 'tmc-job-1', jobName: 'tmc-job', status: 'completed', message: 'done',
      timestamp: new Date().toISOString(),
    });
    handlers.get('complete')![0]!(job());
    await new Promise((r) => setTimeout(r, 50));
    const text = mockClient.session.prompt.mock.calls[0][0].body.parts[0].text as string;
    expect(text).toContain("Job 'tmc-job' completed");
    expect(text).not.toMatch(/sem mc_report/);
  });
});
