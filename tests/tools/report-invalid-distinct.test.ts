import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spyOn, mock } from 'bun:test';
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
import { formatInvalidReportGap, listInvalidReportJobIds } from '../../src/tools/report';

const { mc_report, mc_report_final } = await import('../../src/tools/report');

let base = '';
let stateDir = '';

function planJob(name: string, status: string, id?: string) {
  return {
    id: id ?? `${name}-id`,
    name,
    prompt: `do ${name}`,
    status,
    branch: `mc/${name}`,
    createdAt: new Date().toISOString(),
  };
}

describe('report ausente vs inválida + worker com tool produz json', () => {
  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), 'mc-report-distinct-'));
    stateDir = join(base, 'state');
    mkdirSync(stateDir, { recursive: true });
    spyOn(paths, 'getDataDir').mockResolvedValue(stateDir);
  });

  afterEach(() => {
    mock.restore();
    if (base && existsSync(base)) rmSync(base, { recursive: true, force: true });
  });

  it('worker com tool produz <jobId>.json (mc_report escreve no reports dir)', async () => {
    // isInManagedWorktree exige prefixo XDG; usa MC_XDG_DATA_DIR real do processo.
    // Aqui testa writeReport direto (mesmo sink do mc_report) + listagem.
    const { writeReport, readReport, readAllReports } = reports;
    await writeReport({
      jobId: 'job-tool-1',
      jobName: 'tool-job',
      status: 'completed',
      message: 'done via tool',
      timestamp: new Date().toISOString(),
    });
    const back = await readReport('job-tool-1');
    expect(back).toMatchObject({ jobId: 'job-tool-1', jobName: 'tool-job', status: 'completed' });
    const all = await readAllReports();
    expect(all.some((r) => r.jobId === 'job-tool-1')).toBe(true);
  });

  it('listInvalidReportJobIds distingue malformado de ausente', async () => {
    const dir = join(stateDir, '..', 'reports');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'job-good-1.json'), JSON.stringify({ jobId: 'job-good-1', jobName: 'g', status: 'working', message: 'm', timestamp: new Date().toISOString() }));
    writeFileSync(join(dir, 'job-bad-1.json'), '{ malformed {{{');
    const invalid = await listInvalidReportJobIds();
    expect(invalid).toContain('job-bad-1');
    expect(invalid).not.toContain('job-good-1');
    expect(invalid).not.toContain('job-missing-9');
    expect(formatInvalidReportGap('bad-job')).toMatch(/invalid per-instance report.*distinct from missing/);
  });

  it('sem tool: gap missing com motivo distinto de inválida; malformado nunca vira Verified', async () => {
    spyOn(planState, 'loadPlan').mockResolvedValue({
      id: 'plan-r',
      name: 'R',
      mode: 'autopilot',
      status: 'running',
      jobs: [planJob('missing-job', 'merged'), planJob('bad-job', 'merged', 'job-bad-1')],
      integrationBranch: 'mc/integration-r',
      baseCommit: 'abc',
      createdAt: new Date().toISOString(),
    } as any);
    spyOn(jobState, 'loadJobState').mockResolvedValue({
      version: 3,
      jobs: [
        { id: 'missing-job-id', name: 'missing-job', worktreePath: '/tmp/x', branch: 'mc/missing-job', tmuxTarget: 't', placement: 'session', status: 'merged', prompt: 'p', mode: 'vanilla', createdAt: new Date().toISOString() },
        { id: 'job-bad-1', name: 'bad-job', worktreePath: '/tmp/y', branch: 'mc/bad-job', tmuxTarget: 't', placement: 'session', status: 'merged', prompt: 'p', mode: 'vanilla', createdAt: new Date().toISOString() },
      ],
      updatedAt: new Date().toISOString(),
    } as any);
    // Ambos com evidência task-scoped (Verified), mas sem/inválido report:
    // missing-job sem arquivo; bad-job com JSON malformado (pulado por readAllReports).
    const dir = join(stateDir, '..', 'reports');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'job-bad-1.json'), '{ bad json');
    const COMMIT = '7762a1462fb1cf0b6b750dd37f126dd95fd9e989';
    spyOn(durableState, 'loadRuntimeSnapshot').mockResolvedValue(null);
    spyOn(durableState, 'loadMergeEvidence').mockResolvedValue({
      'missing-job': { jobName: 'missing-job', testStatus: 'passed', scope: 'task', testCommand: 'bun test', reviewedCommit: COMMIT },
      'bad-job': { jobName: 'bad-job', testStatus: 'passed', scope: 'task', testCommand: 'bun test', reviewedCommit: COMMIT },
    } as any);
    spyOn(omo, 'detectOMO').mockResolvedValue({ detected: false } as any);
    let lastMarkdown = '';
    spyOn(reports, 'writeFinalReport').mockImplementation(async (_id: string, md: string) => {
      lastMarkdown = md;
      return '/tmp/final.md';
    });

    const result = await (mc_report_final.execute as any)({}, { sessionID: 't' }) as unknown as string;
    expect(result).toContain('Unverified: 2');
    // Gap missing com motivo próprio…
    expect(lastMarkdown).toMatch(/missing per-instance report for "missing-job" \(merged without mc_report\)/);
    // …gap inválida com motivo distinto…
    expect(lastMarkdown).toMatch(/bad-job.*invalid per-instance report.*distinct from missing mc_report/);
    // Task evidence verifica (ambos em Verified) mas o malformado nunca vira
    // Verified POR SI (ignorado como evidência de report; verificação vem do
    // gate task-scoped, não do report).
    const verified = lastMarkdown.split('## Verified')[1].split('## Gaps')[0];
    expect(verified).toContain('missing-job [merged, task-scoped]');
    expect(verified).toContain('bad-job [merged, task-scoped]');
    // Gap inválido não duplica missing para o mesmo job.
    expect(lastMarkdown).not.toMatch(/missing per-instance report for "bad-job"/);
  });
});
