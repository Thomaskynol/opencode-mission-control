import { describe, it, expect } from 'vitest';
import {
  buildFinalReportMarkdown,
  describeOmoLimitation,
  type FinalReportInput,
} from '../../src/lib/reports';

// r3401131: a report with merged jobs but no mc_report contributions must
// name the gap explicitly — never a clean Verified section next to a
// "No per-instance contributions" placeholder.

function baseInput(overrides: Partial<FinalReportInput> = {}): FinalReportInput {
  return {
    title: 'Plan',
    integration: { branch: 'mc/integration-1', merged: [], conflicts: [] },
    ...overrides,
  };
}

describe('r3401131 missing per-instance contributions (fail-open placeholder is a bug)', () => {
  it('merged jobs without mc_report list explicit missing-report gaps (not Verified-clean)', () => {
    const markdown = buildFinalReportMarkdown(
      baseInput({
        integration: { branch: 'mc/integration-1', merged: ['implement-total'], conflicts: [] },
        contributions: [],
        verified: [],
        unverified: [],
      }),
    );
    // No silent placeholder: the missing report is named where readers look.
    expect(markdown).toMatch(/missing per-instance report/i);
    expect(markdown).toContain('implement-total');
    // Gaps carry it; Verified never claims the merged job without evidence.
    const gaps = markdown.split('## Gaps')[1];
    expect(gaps).toMatch(/missing per-instance report/i);
    const verified = markdown.split('## Verified')[1].split('## Gaps')[0];
    expect(verified).not.toContain('implement-total');
  });

  it('partial coverage names only the job(s) still missing a report', () => {
    const markdown = buildFinalReportMarkdown(
      baseInput({
        integration: { branch: 'mc/integration-1', merged: ['job-a', 'job-b'], conflicts: [] },
        contributions: [{ instance: 'id-a', job: 'job-a', summary: '[completed] did a' }],
        verified: [],
        unverified: [],
      }),
    );
    expect(markdown).toContain('id-a / job-a: [completed] did a');
    expect(markdown).toMatch(/missing per-instance report for "job-b"/i);
    expect(markdown).not.toMatch(/missing per-instance report for "job-a"/i);
  });

  it('no merges + no contributions keeps the neutral placeholder (no false missing gap)', () => {
    const markdown = buildFinalReportMarkdown(baseInput());
    expect(markdown).toContain('No per-instance contributions reported');
    expect(markdown).not.toMatch(/missing per-instance report/i);
  });

  it('0 merges + worker contributions → neutral placeholder stands, work stays unverified until evidence', () => {
    const markdown = buildFinalReportMarkdown(
      baseInput({
        contributions: [{ instance: 'id-w', job: 'work-a', summary: '[completed] did work' }],
        verified: [],
        unverified: ['work-a [completed] — outcome not verified by criterion'],
      }),
    );
    // No false missing-report gap when nothing was merged…
    expect(markdown).not.toMatch(/missing per-instance report/i);
    expect(markdown).toContain('id-w / work-a');
    // …but the work never lands in Verified without evidence: demo marks unverified.
    const verified = markdown.split('## Verified')[1].split('## Gaps')[0];
    expect(verified).not.toContain('work-a');
    expect(markdown.split('## Gaps')[1]).toMatch(/work-a.*not verified/i);
  });
});

describe('r3401131 OMO report status (limitation declared, never silent)', () => {
  it('without OMO declares the limitation instead of a silent success', () => {
    expect(describeOmoLimitation(false)).toMatch(/limitation/i);
    expect(describeOmoLimitation(false)).toMatch(/not detected/);
  });

  it('with OMO records the detected parity path', () => {
    expect(describeOmoLimitation(true, 'ralph')).toMatch(/detected/i);
  });
});
