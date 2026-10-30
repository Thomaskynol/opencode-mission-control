import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { join } from 'path';
import { tmpdir } from 'os';
import * as paths from '../../src/lib/paths';
import { saveMergeEvidence, loadMergeEvidence } from '../../src/lib/durable-state';

/**
 * R05 trail: one entry per job is shared by the task review, the merge write
 * and the global integration gate — so writes must be monotonic, never
 * destructive:
 * - a task-scoped `passed` is immutable: a later `skipped` merge write or a
 *   later `integration` write must not downgrade it or flip its scope;
 * - pins/files merge by field (already ok) and stay preserved;
 * - a global `integration` pass only lands when no task pass exists.
 */
describe('evidence trail: task pass is immutable across merge/integration writes', () => {
  let testStateDir: string;
  let restore: () => void = () => {};

  beforeEach(async () => {
    const fs = await import('fs');
    testStateDir = await fs.promises.mkdtemp(join(tmpdir(), 'mc-trail-test-'));
    const spy = spyOn(paths, 'getDataDir').mockResolvedValue(testStateDir);
    restore = () => spy.mockRestore();
  });

  afterEach(async () => {
    try { restore(); } catch {}
    const fs = await import('fs');
    if (testStateDir) fs.rmSync(testStateDir, { recursive: true, force: true });
  });

  it('an intermediate skipped merge write does not destroy a task pass', async () => {
    await saveMergeEvidence({
      jobName: 'trail-job',
      mergedAt: new Date().toISOString(),
      reviewedCommit: 'job-head-abc',
      reviewedBase: 'base-head-1',
      changedFiles: ['src/a.ts'],
      testCommand: 'bun test',
      testStatus: 'passed',
      testOutput: 'pass: real coverage (3 passed)',
      scope: 'task',
    });
    // Per-merge success write with skipTest:true carries merge metadata only.
    await saveMergeEvidence({
      jobName: 'trail-job',
      mergedAt: new Date().toISOString(),
      reviewedCommit: 'job-head-abc',
      reviewedBase: 'base-head-1',
      changedFiles: ['src/a.ts', 'src/b.ts'],
    });
    const rec = (await loadMergeEvidence())['trail-job'];
    expect(rec.testStatus).toBe('passed');
    expect(rec.scope).toBe('task');
    expect(rec.reviewedCommit).toBe('job-head-abc');
    expect(rec.changedFiles).toContain('src/a.ts');
  });

  it('a global integration write does not mutate an existing task pass', async () => {
    await saveMergeEvidence({
      jobName: 'trail-job-2',
      mergedAt: new Date().toISOString(),
      reviewedCommit: 'job-head-def',
      reviewedBase: 'base-head-1',
      changedFiles: ['src/c.ts'],
      testCommand: 'bun test',
      testStatus: 'passed',
      scope: 'task',
    });
    // Simulate the global gate attempting an integration write over it.
    await saveMergeEvidence({
      jobName: 'trail-job-2',
      mergedAt: new Date().toISOString(),
      testCommand: 'bun test',
      testStatus: 'passed',
      testOutput: 'global smoke passed',
      scope: 'integration',
    });
    const rec = (await loadMergeEvidence())['trail-job-2'];
    expect(rec.testStatus).toBe('passed');
    expect(rec.scope).toBe('task');
    expect(rec.reviewedCommit).toBe('job-head-def');
    expect(rec.testCommand).toBe('bun test');
  });

  it('an integration pass lands when no task pass exists (pins preserved)', async () => {
    await saveMergeEvidence({
      jobName: 'trail-job-3',
      mergedAt: new Date().toISOString(),
      reviewedCommit: 'job-head-3',
      reviewedBase: 'base-head-1',
      changedFiles: ['src/d.ts'],
    });
    await saveMergeEvidence({
      jobName: 'trail-job-3',
      mergedAt: new Date().toISOString(),
      testCommand: 'bun test',
      testStatus: 'passed',
      testOutput: 'global smoke passed',
      scope: 'integration',
    });
    const rec = (await loadMergeEvidence())['trail-job-3'];
    expect(rec.testStatus).toBe('passed');
    expect(rec.scope).toBe('integration');
    expect(rec.reviewedCommit).toBe('job-head-3');
    expect(rec.changedFiles).toContain('src/d.ts');
  });
});
