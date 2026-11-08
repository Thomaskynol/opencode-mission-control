import { describe, it, expect, beforeEach, afterEach, spyOn, mock } from 'bun:test';
import { join } from 'path';
import { tmpdir } from 'os';
import { mkdtemp } from 'fs/promises';
import { rmSync, existsSync, mkdirSync } from 'fs';
import * as paths from '../../src/lib/paths';
import * as jobState from '../../src/lib/job-state';

let base = '';
let stateDir = '';

describe('monitor: divergência serve vs TUI documentada sem sucesso falso (RED)', () => {
  let mockGetRunning: any;
  let mockGetJob: any;
  let mockUpdateJob: any;

  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), 'tmc-mon-diverge-'));
    stateDir = join(base, 'state');
    mkdirSync(stateDir, { recursive: true });
    spyOn(paths, 'getDataDir').mockResolvedValue(stateDir);
    mockGetRunning = spyOn(jobState, 'getRunningJobs').mockResolvedValue([]);
    mockGetJob = spyOn(jobState, 'getJob').mockResolvedValue(undefined as any);
    mockUpdateJob = spyOn(jobState, 'updateJob').mockResolvedValue(undefined as any);
  });

  afterEach(() => {
    mock.restore();
    if (base && existsSync(base)) rmSync(base, { recursive: true, force: true });
  });

  function serveJob(overrides: Record<string, unknown> = {}): any {
    return {
      id: 'tmc-serve-1', name: 'tmc-serve', worktreePath: '/tmp/tmc-wt',
      branch: 'mc/tmc-serve', tmuxTarget: 'tmc-serve', placement: 'session',
      status: 'running', prompt: 'do', mode: 'vanilla', createdAt: new Date().toISOString(),
      port: 14501, serverUrl: 'http://127.0.0.1:14501', remoteSessionID: 'ses_tmc',
      ...overrides,
    };
  }

  it('SSE idle sem report: completa por outcome mas loga lacuna observável (não sucesso falso)', async () => {
    const { JobMonitor } = await import('../../src/lib/monitor');
    const mon: any = new JobMonitor();
    mockGetJob.mockResolvedValue(serveJob());
    // outcome terminal confirmado pelo mock de sessão
    spyOn(mon, 'syncSessionOutcome').mockImplementation(async (job: any, _c: any) => {
      await mon.handleSSEEvent(job, { type: 'session.execution.succeeded', data: { sessionID: job.remoteSessionID } });
    });
    const warns: string[] = [];
    const orig = console.warn;
    console.warn = (...a: any[]) => { warns.push(a.map(String).join(' ')); };
    try {
      await mon.handleSSEEvent(serveJob(), { type: 'session.idle', data: { sessionID: 'ses_tmc' } });
    } finally {
      console.warn = orig;
    }
    expect(mockUpdateJob).toHaveBeenCalledWith('tmc-serve-1', expect.objectContaining({ status: 'completed' }));
    expect(warns.some((w) => /sem mc_report/.test(w) && /não (são|é) observáve/.test(w))).toBe(true);
  });

  it('TUI idle sem report: completa por idle mas loga motivo não observável', async () => {
    const { JobMonitor } = await import('../../src/lib/monitor');
    const tui = serveJob({ id: 'tmc-tui-1', name: 'tmc-tui', port: undefined, serverUrl: undefined, remoteSessionID: undefined, tmuxTarget: 'tmc-tui' });
    delete (tui as any).port;
    delete (tui as any).remoteSessionID;
    const mon: any = new JobMonitor({ pollInterval: 1000, idleThreshold: 0 } as any);
    mockGetRunning.mockResolvedValue([tui]);
    const tmux = await import('../../src/lib/tmux');
    const sPane = spyOn(tmux, 'isPaneRunning').mockResolvedValue(true as never);
    const sCap = spyOn(tmux, 'capturePane').mockResolvedValue('ctrl+p commands\nidle prompt' as never);
    const warns: string[] = [];
    const orig = console.warn;
    console.warn = (...a: any[]) => { warns.push(a.map(String).join(' ')); };
    try {
      // duas polls: primeira arma o tracker, segunda dispara o idle (threshold 0)
      await mon.poll();
      await mon.poll();
    } finally {
      console.warn = orig;
      sPane.mockRestore?.();
      sCap.mockRestore?.();
    }
    expect(mockUpdateJob).toHaveBeenCalledWith('tmc-tui-1', expect.objectContaining({ status: 'completed' }));
    expect(warns.some((w) => /sem mc_report/.test(w) && /motivo do agente ignorar/.test(w))).toBe(true);
  });
});
