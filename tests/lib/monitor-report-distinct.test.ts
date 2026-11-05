import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spyOn, mock } from 'bun:test';
import { join } from 'path';
import { tmpdir } from 'os';
import { mkdtemp } from 'fs/promises';
import { rmSync, existsSync, mkdirSync, writeFileSync } from 'fs';
import * as paths from '../../src/lib/paths';
import * as jobState from '../../src/lib/job-state';
import * as reportsMod from '../../src/lib/reports';
import { JobMonitor } from '../../src/lib/monitor';

let base = '';
let stateDir = '';

function serveJob(overrides: Record<string, unknown> = {}): any {
  return {
    id: 'job-serve-1',
    name: 'serve-job',
    worktreePath: '/tmp/wt-serve',
    branch: 'mc/serve-job',
    tmuxTarget: 'mc-serve-job',
    placement: 'session',
    status: 'running',
    prompt: 'do serve',
    mode: 'vanilla',
    createdAt: new Date().toISOString(),
    port: 14201,
    serverUrl: 'http://127.0.0.1:14201',
    remoteSessionID: 'ses_remote',
    ...overrides,
  };
}

describe('monitor distingue ausente vs inválida + poll serve consulta report', () => {
  let mockGetRunning: any;
  let mockGetJob: any;
  let mockUpdateJob: any;

  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), 'mc-mon-distinct-'));
    stateDir = join(base, 'state');
    mkdirSync(stateDir, { recursive: true });
    spyOn(paths, 'getDataDir').mockResolvedValue(stateDir);
    mockGetRunning = spyOn(jobState, 'getRunningJobs').mockResolvedValue([]);
    mockGetJob = spyOn(jobState, 'getJob').mockResolvedValue(undefined as any);
    mockUpdateJob = spyOn(jobState, 'updateJob').mockResolvedValue(undefined as any);
    // isInManagedWorktree etc. não usados aqui; reports reais via stateDir.
  });

  afterEach(() => {
    mock.restore();
    if (base && existsSync(base)) rmSync(base, { recursive: true, force: true });
  });

  function reportsFile(jobId: string): string {
    const dir = join(stateDir, '..', 'reports');
    mkdirSync(dir, { recursive: true });
    return join(dir, `${jobId}.json`);
  }

  it('ausente retorna missing com log distinto (sem inventar report)', async () => {
    const job = serveJob();
    const mon: any = new JobMonitor();
    const warns: string[] = [];
    const orig = console.warn;
    console.warn = (...a: any[]) => { warns.push(a.map(String).join(' ')); };
    try {
      const out = await mon.checkAgentReport(job);
      expect(out).toBe('missing');
      expect(warns.some((w) => /No mc_report yet.*missing.*distinct from invalid/.test(w))).toBe(true);
      expect(warns.some((w) => /Invalid\/malformed/.test(w))).toBe(false);
      expect(mockUpdateJob).not.toHaveBeenCalled();
    } finally {
      console.warn = orig;
    }
    // Segunda chamada: mesmo retorno, sem spam (log só na primeira).
    const warns2: string[] = [];
    console.warn = (...a: any[]) => { warns2.push(a.map(String).join(' ')); };
    try {
      const out2 = await mon.checkAgentReport(job);
      expect(out2).toBe('missing');
      expect(warns2).toHaveLength(0);
    } finally {
      console.warn = orig;
    }
  });

  it('inválida (arquivo existe, JSON malformado) retorna invalid com log distinto, nunca Verified', async () => {
    const job = serveJob({ id: 'job-bad-1', name: 'bad-job' });
    writeFileSync(reportsFile('job-bad-1'), '{ malformed json {{{');
    const mon: any = new JobMonitor();
    const warns: string[] = [];
    const orig = console.warn;
    console.warn = (...a: any[]) => { warns.push(a.map(String).join(' ')); };
    try {
      const out = await mon.checkAgentReport(job);
      expect(out).toBe('invalid');
      expect(warns.some((w) => /Invalid\/malformed mc_report.*distinct from missing/.test(w))).toBe(true);
      expect(mockUpdateJob).not.toHaveBeenCalled();
    } finally {
      console.warn = orig;
    }
  });

  it('válido terminal retorna completed e conclui; válido não-terminal retorna reported', async () => {
    const done = serveJob({ id: 'job-done-1', name: 'done-job' });
    writeFileSync(
      reportsFile('job-done-1'),
      JSON.stringify({ jobId: 'job-done-1', jobName: 'done-job', status: 'completed', message: 'ok', timestamp: new Date().toISOString() }),
    );
    const mon: any = new JobMonitor();
    const out = await mon.checkAgentReport(done);
    expect(out).toBe('completed');
    expect(mockUpdateJob).toHaveBeenCalledWith('job-done-1', expect.objectContaining({ status: 'completed' }));

    mock.restore();
    spyOn(paths, 'getDataDir').mockResolvedValue(stateDir);
    spyOn(jobState, 'updateJob').mockResolvedValue(undefined as any);
    const working = serveJob({ id: 'job-work-1', name: 'work-job' });
    writeFileSync(
      reportsFile('job-work-1'),
      JSON.stringify({ jobId: 'job-work-1', jobName: 'work-job', status: 'working', message: 'wip', timestamp: new Date().toISOString() }),
    );
    const mon2: any = new JobMonitor();
    let reported: unknown = null;
    mon2.on('agent_report', (_j: unknown, r: unknown) => { reported = r; });
    const out2 = await mon2.checkAgentReport(working);
    expect(out2).toBe('reported');
    expect(reported).toMatchObject({ status: 'working' });
  });

  it('poll serve chama checkAgentReport (antes: só subscribeToSSE)', async () => {
    const job = serveJob();
    mockGetRunning.mockResolvedValue([job]);
    const mon: any = new JobMonitor();
    const spyCheck = spyOn(mon, 'checkAgentReport').mockResolvedValue('missing' as never);
    const spySub = spyOn(mon, 'subscribeToSSE').mockResolvedValue(undefined as never);
    await mon.poll();
    expect(spyCheck).toHaveBeenCalledTimes(1);
    expect(spyCheck).toHaveBeenCalledWith(job);
    expect(spySub).toHaveBeenCalledTimes(1);
  });

  it('poll serve com report terminal conclui sem subscribe (não inventa, não perde)', async () => {
    const job = serveJob();
    mockGetRunning.mockResolvedValue([job]);
    const mon: any = new JobMonitor();
    spyOn(mon, 'checkAgentReport').mockResolvedValue('completed' as never);
    const spySub = spyOn(mon, 'subscribeToSSE').mockResolvedValue(undefined as never);
    await mon.poll();
    expect(spySub).not.toHaveBeenCalled();
  });

  it('serve missing/inválida inclui sem-ACK; job não-serve não leva a ressalva', async () => {
    const mon: any = new JobMonitor();
    const orig = console.warn;
    // missing em serve job: ressalva sem-ACK presente.
    let warns: string[] = [];
    console.warn = (...a: any[]) => { warns.push(a.map(String).join(' ')); };
    try {
      const out = await mon.checkAgentReport(serveJob({ id: 'job-ack-1', name: 'ack-job' }));
      expect(out).toBe('missing');
      expect(warns.some((w) => /sem ACK do serve/.test(w))).toBe(true);
    } finally {
      console.warn = orig;
    }
    // inválida em serve job: ressalva sem-ACK presente.
    writeFileSync(
      reportsFile('job-ack-2'),
      '{ malformed {{{',
    );
    warns = [];
    console.warn = (...a: any[]) => { warns.push(a.map(String).join(' ')); };
    try {
      const out2 = await mon.checkAgentReport(serveJob({ id: 'job-ack-2', name: 'ack-bad' }));
      expect(out2).toBe('invalid');
      expect(warns.some((w) => /sem ACK do serve/.test(w))).toBe(true);
    } finally {
      console.warn = orig;
    }
    // job sem port (não-serve): mesma distinção, sem ressalva sem-ACK.
    const tui = serveJob({ id: 'job-tui-1', name: 'tui-job', port: undefined, serverUrl: undefined, remoteSessionID: undefined });
    delete (tui as any).port;
    warns = [];
    console.warn = (...a: any[]) => { warns.push(a.map(String).join(' ')); };
    try {
      const out3 = await mon.checkAgentReport(tui);
      expect(out3).toBe('missing');
      expect(warns.some((w) => /No mc_report yet/.test(w))).toBe(true);
      expect(warns.some((w) => /sem ACK do serve/.test(w))).toBe(false);
    } finally {
      console.warn = orig;
    }
  });

  it('report válido associa job+sessão corretos (sem cross-talk entre jobs)', async () => {
    const { writeReport } = reportsMod;
    // Worker do job B reporta via mesmo sink do mc_report (writeReport direto).
    await writeReport({
      jobId: 'job-cross-b',
      jobName: 'cross-b',
      status: 'working',
      message: 'wip b',
      timestamp: new Date().toISOString(),
    });
    const mon: any = new JobMonitor();
    const jobA = serveJob({ id: 'job-cross-a', name: 'cross-a' });
    // Job A continua missing: report de B não vaza para A.
    expect(await mon.checkAgentReport(jobA)).toBe('missing');
    // Job B: reported, associado ao id correto, sem concluir job errado.
    let agentJob: unknown = null;
    mon.on('agent_report', (j: unknown) => { agentJob = j; });
    const outB = await mon.checkAgentReport(serveJob({ id: 'job-cross-b', name: 'cross-b' }));
    expect(outB).toBe('reported');
    expect((agentJob as { id?: string })?.id).toBe('job-cross-b');
    expect(mockUpdateJob).not.toHaveBeenCalledWith('job-cross-a', expect.anything());
  });
});
