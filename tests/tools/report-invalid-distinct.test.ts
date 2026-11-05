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
  });

  it('serve merged sem report válido rende gap sem-ACK (1 por job); não-serve segue sem ressalva', async () => {
    spyOn(planState, 'loadPlan').mockResolvedValue({
      id: 'plan-s',
      name: 'S',
      mode: 'autopilot',
      status: 'running',
      jobs: [
        planJob('serve-missing', 'merged'),
        planJob('serve-bad', 'merged', 'job-serve-bad'),
        planJob('tui-missing', 'merged'),
      ],
      integrationBranch: 'mc/integration-s',
      baseCommit: 'abc',
      createdAt: new Date().toISOString(),
    } as any);
    const serveState = (id: string, name: string) => ({
      id, name, worktreePath: `/tmp/${name}`, branch: `mc/${name}`, tmuxTarget: 't',
      placement: 'session', status: 'merged', prompt: 'p', mode: 'vanilla',
      createdAt: new Date().toISOString(), port: 14301, serverUrl: 'http://127.0.0.1:14301',
      remoteSessionID: `ses_${name}`,
    });
    spyOn(jobState, 'loadJobState').mockResolvedValue({
      version: 3,
      jobs: [
        serveState('serve-missing-id', 'serve-missing'),
        serveState('job-serve-bad', 'serve-bad'),
        { id: 'tui-missing-id', name: 'tui-missing', worktreePath: '/tmp/t', branch: 'mc/tui-missing', tmuxTarget: 't', placement: 'session', status: 'merged', prompt: 'p', mode: 'vanilla', createdAt: new Date().toISOString() },
      ],
      updatedAt: new Date().toISOString(),
    } as any);
    // Sem evidência task-scoped: gaps puros de report (sem Verified por gate).
    const dir = join(stateDir, '..', 'reports');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'job-serve-bad.json'), '{ bad json');
    // serve-missing COM evidência task-scoped (Verified por gate) mas sem
    // report: cobre o ramo missing genérico com sem-ACK. serve-bad e
    // tui-missing sem evidência: ramos inválido e silencioso.
    const COMMIT = '7762a1462fb1cf0b6b750dd37f126dd95fd9e989';
    spyOn(durableState, 'loadRuntimeSnapshot').mockResolvedValue(null);
    spyOn(durableState, 'loadMergeEvidence').mockResolvedValue({
      'serve-missing': { jobName: 'serve-missing', testStatus: 'passed', scope: 'task', testCommand: 'bun test', reviewedCommit: COMMIT },
    } as any);
    spyOn(omo, 'detectOMO').mockResolvedValue({ detected: false } as any);
    let lastMarkdown = '';
    spyOn(reports, 'writeFinalReport').mockImplementation(async (_id: string, md: string) => {
      lastMarkdown = md;
      return '/tmp/final-s.md';
    });

    const result = await (mc_report_final.execute as any)({}, { sessionID: 't' }) as unknown as string;
    // serve-missing verifica por gate mas segue com gap missing sem-ACK;
    // serve-bad (inválido) + tui-missing (silencioso): 3 Unverified no total.
    expect(result).toContain('Unverified: 3');
    // serve missing: gap canônico + ressalva sem-ACK.
    const serveMissingLine = lastMarkdown.split('\n').find((l) => l.includes('Unverified:') && l.includes('serve-missing')) ?? '';
    expect(serveMissingLine).toContain('missing per-instance report');
    expect(serveMissingLine).toContain('sem ACK do serve');
    // serve inválida: gap distinto + ressalva sem-ACK, nunca Verified por si.
    const serveBadLine = lastMarkdown.split('\n').find((l) => l.includes('serve-bad') && l.includes('invalid per-instance report')) ?? '';
    expect(serveBadLine).toContain('distinct from missing mc_report');
    expect(serveBadLine).toContain('sem ACK do serve');
    const verified = lastMarkdown.split('## Verified')[1].split('## Gaps')[0];
    expect(verified).not.toContain('serve-bad');
    // não-serve missing sem evidência: gap silencioso canônico, sem ressalva.
    const tuiLine = lastMarkdown.split('\n').find((l) => l.includes('Unverified:') && l.includes('tui-missing')) ?? '';
    expect(tuiLine).toContain('sem evidência task-scoped, outcome not verified');
    expect(tuiLine).not.toContain('sem ACK');
  });
});
