/**
 * Lane C — `mc_report_final` acessível pela CLI (pendência 3 M4).
 *
 * RED: `report` cai no default → HELP; nenhum verbo emite o relatório final.
 */
import { describe, it, expect, beforeEach, afterEach, spyOn, mock } from 'bun:test';
import * as jobStateMod from '../../src/lib/job-state';
import * as planStateMod from '../../src/lib/plan-state';
import * as reportsMod from '../../src/lib/reports';
import { dispatchArgv, type HumanControls } from '../../src/orchestrator-cli/commands';

function mockPlanJob(name: string, status: string) {
  return {
    id: `${name}-id`,
    name,
    prompt: `do ${name}`,
    status,
    branch: `mc/${name}`,
    createdAt: new Date().toISOString(),
  };
}

const controls: HumanControls = {
  pause: async () => 'paused',
  resume: async () => 'resumed',
  cancel: async () => 'canceled',
  answer: async () => 'answered',
  launch: async () => 'launch ready',
};

beforeEach(() => {
  spyOn(planStateMod, 'loadPlan').mockResolvedValue({
    id: 'plan-1',
    name: 'Plan',
    mode: 'autopilot',
    status: 'running',
    jobs: [mockPlanJob('done-job', 'completed')],
    integrationBranch: 'mc/integration-plan-1',
    baseCommit: 'abc',
    createdAt: new Date().toISOString(),
  } as never);
  spyOn(jobStateMod, 'loadJobState').mockResolvedValue({
    version: 3,
    jobs: [],
    updatedAt: new Date().toISOString(),
  } as never);
  spyOn(reportsMod, 'readAllReports').mockResolvedValue([]);
  spyOn(reportsMod, 'writeFinalReport').mockImplementation(async () => '/tmp/final-report.md');
});

afterEach(() => {
  mock.restore();
});

describe('CLI report command — mc_report_final via caminho público', () => {
  it('`report` emits the final report (not HELP)', async () => {
    const out = await dispatchArgv(['report'], controls);
    expect(out).toContain('Final report for plan "Plan"');
    expect(out).not.toContain('Human TUI commands');
  });

  it('`report --notes` records operator text as an explicit note, never as automatic evidence', async () => {
    const out = await dispatchArgv(['report', '--notes', 'operator saw green'], controls);
    expect(out).toContain('Final report for plan "Plan"');
    const calls = (reportsMod.writeFinalReport as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    const written = String(calls[0]?.[1] ?? '');
    expect(written).toContain('Operator note: operator saw green');
  });
});
