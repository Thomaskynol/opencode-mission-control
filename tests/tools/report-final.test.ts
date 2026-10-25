import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import * as jobState from '../../src/lib/job-state';
import * as planState from '../../src/lib/plan-state';
import * as reports from '../../src/lib/reports';

const { mc_report_final } = await import('../../src/tools/report');

let mockLoadPlan: Mock;
let mockLoadJobState: Mock;
let mockReadAllReports: Mock;
let mockWriteFinalReport: Mock;

function makePlanJob(name: string, status: string) {
  return {
    id: `${name}-id`,
    name,
    prompt: `do ${name}`,
    status,
    branch: `mc/${name}`,
    createdAt: new Date().toISOString(),
  };
}

describe('mc_report_final verification lists (review fix)', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mockLoadPlan = vi.spyOn(planState, 'loadPlan').mockResolvedValue({
      id: 'plan-1',
      name: 'Plan',
      mode: 'autopilot',
      status: 'running',
      jobs: [
        makePlanJob('merged-job', 'merged'),
        makePlanJob('done-job', 'completed'),
      ],
      integrationBranch: 'mc/integration-plan-1',
      baseCommit: 'abc',
      createdAt: new Date().toISOString(),
    } as any) as unknown as Mock;

    mockLoadJobState = vi.spyOn(jobState, 'loadJobState').mockResolvedValue({
      version: 3,
      jobs: [],
      updatedAt: new Date().toISOString(),
    } as any) as unknown as Mock;

    mockReadAllReports = vi.spyOn(reports, 'readAllReports').mockResolvedValue([
      {
        jobId: 'done-job-id',
        jobName: 'done-job',
        status: 'completed',
        message: 'all done, trust me',
        timestamp: new Date().toISOString(),
      },
    ] as any) as unknown as Mock;

    mockWriteFinalReport = vi.spyOn(reports, 'writeFinalReport').mockImplementation(
      async (_planId: string, markdown: string) => {
        // Capture the markdown via the mock's implementation return.
        (mockWriteFinalReport as any).lastMarkdown = markdown;
        return '/tmp/final-report.md';
      },
    ) as unknown as Mock;
  });

  it('counts only merged jobs as verified; completed-but-unmerged stays unverified', async () => {
    const mockContext = { sessionID: 'test-session' } as any;
    const result = await mc_report_final.execute({}, mockContext) as unknown as string;

    expect(result).toContain('Verified: 1');
    const markdown = (mockWriteFinalReport as any).lastMarkdown as string;
    const verifiedSection = markdown.split('## Verified')[1].split('## Gaps')[0];
    expect(verifiedSection).toContain('merged-job [merged]');
    expect(verifiedSection).not.toContain('done-job');
    // A "completed" worker claim without a merge is not evidence: it lands
    // under Gaps as unverified, never under Verified.
    expect(markdown).toContain('done-job [completed] — outcome not verified');
  });
});
