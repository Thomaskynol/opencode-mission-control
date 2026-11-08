import { describe, it, expect, beforeEach, afterEach, spyOn, mock } from 'bun:test';
import { join } from 'path';
import { tmpdir } from 'os';
import { mkdtemp } from 'fs/promises';
import { rmSync, existsSync, mkdirSync } from 'fs';
import * as paths from '../../src/lib/paths';

let base = '';
let stateDir = '';

describe('reports: estágio + veredito + resolução sem misassociação (RED)', () => {
  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), 'tmc-stage-verdict-'));
    stateDir = join(base, 'state');
    mkdirSync(stateDir, { recursive: true });
    spyOn(paths, 'getDataDir').mockResolvedValue(stateDir);
  });

  afterEach(() => {
    mock.restore();
    if (base && existsSync(base)) rmSync(base, { recursive: true, force: true });
  });

  it('resolveReportStage diferencia serve-noack de tui-running de finalizado', async () => {
    const m = await import('../../src/lib/reports');
    const serve = m.resolveReportStage(
      { port: 14201, remoteSessionID: 'ses_x', status: 'running' } as any,
      { hasReport: false, fileExists: false, staleNameOnly: false, pluginPrepared: true },
    );
    expect(serve.kind).toBe('missing-serve-noack');
    expect(m.formatReportStageLine(serve)).toMatch(/sem ACK do serve/);

    const tui = m.resolveReportStage({ status: 'running' } as any, {
      hasReport: false, fileExists: false, staleNameOnly: false,
    });
    expect(tui.kind).toBe('missing-tui-running');

    const fin = m.resolveReportStage({ status: 'completed' } as any, {
      hasReport: false, fileExists: false, staleNameOnly: false,
    });
    expect(fin.kind).toBe('missing-finalized');
  });

  it('resolveReportStage marca .opencode ausente e inválida distintos, sem fingir skill', async () => {
    const m = await import('../../src/lib/reports');
    const noPlugin = m.resolveReportStage(
      { port: 14201, remoteSessionID: 'ses_x', status: 'running' } as any,
      { hasReport: false, fileExists: false, staleNameOnly: false, pluginPrepared: false },
    );
    expect(noPlugin.kind).toBe('missing-serve-no-plugin');
    const invalid = m.resolveReportStage(
      { port: 14201, remoteSessionID: 'ses_x', status: 'running' } as any,
      { hasReport: false, fileExists: true, staleNameOnly: false, pluginPrepared: true },
    );
    expect(invalid.kind).toBe('invalid-serve-noack');
    for (const info of [noPlugin, invalid]) {
      const line = m.formatReportStageLine(info);
      expect(line).not.toMatch(/skill .*utilizad/i);
      expect(line).not.toMatch(/carregad[ao] com sucesso/i);
    }
  });

  it('resolveJobReport prefere id e nunca associa stale-name como atual', async () => {
    const m = await import('../../src/lib/reports');
    const now = new Date().toISOString();
    const all = [
      { jobId: 'old-id', jobName: 'same-name', status: 'completed', message: 'old', timestamp: now },
    ] as any;
    const r = m.resolveJobReport({ id: 'new-id', name: 'same-name' } as any, all);
    expect(r.report).toBeNull();
    expect(r.staleNameReport?.jobId).toBe('old-id');
  });

  it('veredito persiste vinculado a job+versões e remove auditável', async () => {
    const m = await import('../../src/lib/reports');
    await m.writeReviewVerdict({
      jobId: 'tmc-job-1', jobName: 'tmc-job', verdict: 'pass',
      commit: 'abc1234', branch: 'mc/tmc-job', transport: 'serve',
      modelRequested: 'opencode/foo', modelObserved: 'opencode/foo',
      reason: 'task-scoped pass',
    });
    const back = await m.readReviewVerdict('tmc-job-1');
    expect(back).toMatchObject({ jobId: 'tmc-job-1', commit: 'abc1234', transport: 'serve' });
    const line = m.formatReviewVerdictLine(back!);
    expect(line).toContain('tmc-job');
    const removed = await m.removeReviewVerdictAudited('tmc-job-1', 'tmc-cleanup-test');
    expect(removed).toBe(true);
    expect(await m.readReviewVerdict('tmc-job-1')).toBeNull();
  });

  it('removeReportAudited remove com auditoria e retorna false quando ausente', async () => {
    const m = await import('../../src/lib/reports');
    const now = new Date().toISOString();
    await m.writeReport({ jobId: 'tmc-r-1', jobName: 'tmc-r', status: 'working', message: 'wip', timestamp: now });
    expect(await m.removeReportAudited('tmc-r-1', 'tmc-cleanup-test')).toBe(true);
    expect(await m.readReport('tmc-r-1')).toBeNull();
    expect(await m.removeReportAudited('tmc-r-1', 'tmc-cleanup-test')).toBe(false);
  });
});
