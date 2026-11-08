import { describe, it, expect, beforeEach, afterEach, spyOn, mock } from 'bun:test';
import { join } from 'path';
import { tmpdir } from 'os';
import { mkdtemp } from 'fs/promises';
import { rmSync, existsSync, mkdirSync, writeFileSync } from 'fs';
import * as paths from '../../src/lib/paths';
import * as jobState from '../../src/lib/job-state';
import * as planState from '../../src/lib/plan-state';
import * as reports from '../../src/lib/reports';
import * as durableState from '../../src/lib/durable-state';
import * as omo from '../../src/lib/omo';

const { mc_report_final } = await import('../../src/tools/report');
const { listInvalidReportJobIds } = await import('../../src/tools/report');

let base = '';
let stateDir = '';

describe('report_final: veredito consultável + verdict-* ignorado como inválido (RED)', () => {
  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), 'tmc-report-verdict-'));
    stateDir = join(base, 'state');
    mkdirSync(stateDir, { recursive: true });
    spyOn(paths, 'getDataDir').mockResolvedValue(stateDir);
  });

  afterEach(() => {
    mock.restore();
    if (base && existsSync(base)) rmSync(base, { recursive: true, force: true });
  });

  it('verdict-*.json não conta como report inválido', async () => {
    const dir = join(stateDir, '..', 'reports');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'verdict-tmc-job-1.json'), JSON.stringify({ jobId: 'tmc-job-1', verdict: 'pass' }));
    const invalid = await listInvalidReportJobIds();
    expect(invalid).not.toContain('verdict-tmc-job-1');
  });

  it('veredito aparece no relatório final como evidência consultável', async () => {
    spyOn(planState, 'loadPlan').mockResolvedValue({
      id: 'tmc-plan', name: 'TMC', mode: 'autopilot', status: 'running',
      jobs: [{ id: 'tmc-job-1', name: 'tmc-job', prompt: 'do', status: 'merged', branch: 'mc/tmc-job', createdAt: new Date().toISOString() }],
      integrationBranch: 'mc/integration-tmc', baseCommit: 'abc', createdAt: new Date().toISOString(),
    } as any);
    spyOn(jobState, 'loadJobState').mockResolvedValue({
      version: 3,
      jobs: [{ id: 'tmc-job-1', name: 'tmc-job', worktreePath: '/tmp/tmc', branch: 'mc/tmc-job', tmuxTarget: 't', placement: 'session', status: 'merged', prompt: 'do', mode: 'vanilla', createdAt: new Date().toISOString() }],
      updatedAt: new Date().toISOString(),
    } as any);
    spyOn(durableState, 'loadRuntimeSnapshot').mockResolvedValue(null);
    spyOn(durableState, 'loadMergeEvidence').mockResolvedValue({} as any);
    spyOn(omo, 'detectOMO').mockResolvedValue({ detected: false } as any);
    const { writeReviewVerdict } = await import('../../src/lib/reports');
    await writeReviewVerdict({
      jobId: 'tmc-job-1', jobName: 'tmc-job', verdict: 'pass', commit: 'abc1234',
      branch: 'mc/tmc-job', transport: 'serve', reason: 'task-scoped pass',
    });
    let lastMarkdown = '';
    spyOn(reports, 'writeFinalReport').mockImplementation(async (_id: string, md: string) => {
      lastMarkdown = md;
      return '/tmp/tmc-final.md';
    });
    await (mc_report_final.execute as any)({}, { sessionID: 'tmc' });
    expect(lastMarkdown).toMatch(/verdict.*tmc-job.*pass/i);
    expect(lastMarkdown).toContain('abc1234');
  });

  it('stale same-name report de jobId anterior não conta como report (serve segue com sem-ACK)', async () => {
    spyOn(planState, 'loadPlan').mockResolvedValue({
      id: 'tmc-plan', name: 'TMC', mode: 'autopilot', status: 'running',
      jobs: [{ id: 'tmc-new-1', name: 'tmc-job', prompt: 'do', status: 'merged', branch: 'mc/tmc-job', createdAt: new Date().toISOString() }],
      integrationBranch: 'mc/integration-tmc', baseCommit: 'abc', createdAt: new Date().toISOString(),
    } as any);
    spyOn(jobState, 'loadJobState').mockResolvedValue({
      version: 3,
      jobs: [{ id: 'tmc-new-1', name: 'tmc-job', worktreePath: '/tmp/tmc', branch: 'mc/tmc-job', tmuxTarget: 't', placement: 'session', status: 'merged', prompt: 'do', mode: 'vanilla', createdAt: new Date().toISOString(), port: 14505, serverUrl: 'http://127.0.0.1:14505', remoteSessionID: 'ses_tmc' }],
      updatedAt: new Date().toISOString(),
    } as any);
    spyOn(durableState, 'loadRuntimeSnapshot').mockResolvedValue(null);
    spyOn(durableState, 'loadMergeEvidence').mockResolvedValue({} as any);
    spyOn(omo, 'detectOMO').mockResolvedValue({ detected: false } as any);
    // Stale: mesmo nome, jobId anterior — nunca conta como report do job atual.
    await reports.writeReport({
      jobId: 'tmc-old-1', jobName: 'tmc-job', status: 'completed', message: 'old run done',
      timestamp: new Date().toISOString(),
    });
    let lastMarkdown = '';
    spyOn(reports, 'writeFinalReport').mockImplementation(async (_id: string, md: string) => {
      lastMarkdown = md;
      return '/tmp/tmc-final.md';
    });
    await (mc_report_final.execute as any)({}, { sessionID: 'tmc' });
    // O stale não suprime o gap: a ressalva sem-ACK aparece para o job atual.
    expect(lastMarkdown).toMatch(/tmc-job.*sem ACK do serve/);
  });
});
