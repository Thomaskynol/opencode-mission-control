import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { join } from 'path';
import { tmpdir } from 'os';
import * as paths from '../../src/lib/paths';
import {
  saveAutoIntake,
  loadAutoIntake,
  appendAutoDecision,
  appendAutoQuestion,
  setAutoNextSteps,
  setAutoIntakeStatus,
  persistPendingQuestion,
  loadRuntimeSnapshot,
} from '../../src/lib/durable-state';

let testStateDir: string;
let dataDirSpy: ReturnType<typeof spyOn>;

async function tempDir(prefix: string): Promise<string> {
  const fs = await import('fs');
  return fs.promises.mkdtemp(join(tmpdir(), prefix));
}

describe('auto-intake persistence (resume without reconstruction)', () => {
  beforeEach(async () => {
    testStateDir = await tempDir('mc-auto-intake-test-');
    dataDirSpy = spyOn(paths, 'getDataDir').mockResolvedValue(testStateDir);
  });

  afterEach(async () => {
    dataDirSpy.mockRestore();
    const fs = await import('fs');
    if (fs.existsSync(testStateDir)) {
      fs.rmSync(testStateDir, { recursive: true, force: true });
    }
  });

  it('round-trips request, requirements, plan, decisions, questions and next steps', async () => {
    await saveAutoIntake({
      id: 'intake-1',
      request: 'Add retry to sync tool',
      repo: '/tmp/demo',
      targetBranch: 'feat/retry',
      ceiling: { maxParallel: 3 },
      requirements: [{ id: 'r1', text: 'retry works', acceptance: ['bun test passes'] }],
      decisions: ['use exponential backoff'],
      questions: ['Which backoff base?'],
      nextSteps: ['dispatch add-retry'],
      status: 'planned',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const loaded = await loadAutoIntake('intake-1');
    expect(loaded).not.toBeNull();
    expect(loaded!.request).toBe('Add retry to sync tool');
    expect(loaded!.requirements).toHaveLength(1);
    expect(loaded!.decisions).toEqual(['use exponential backoff']);
    expect(loaded!.questions).toEqual(['Which backoff base?']);
    expect(loaded!.nextSteps).toEqual(['dispatch add-retry']);
    expect(loaded!.status).toBe('planned');
  });

  it('returns null when no intake was ever persisted', async () => {
    expect(await loadAutoIntake('missing')).toBeNull();
  });

  it('appends decisions/questions/steps without dropping other runtime sections', async () => {
    await saveAutoIntake({
      id: 'intake-1',
      request: 'Add retry',
      requirements: [],
      decisions: [],
      questions: [],
      nextSteps: [],
      status: 'awaiting-plan',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    await persistPendingQuestion({
      jobId: 'job-1',
      jobName: 'alpha',
      taskSummary: 'do things',
      partId: 'p1',
      callID: 'c1',
      remoteSessionID: 'ses_x',
      port: 14100,
      question: 'Proceed?',
      options: [],
      detectedAt: Date.now(),
    });

    await appendAutoDecision('intake-1', 'keep touchSet narrow');
    await appendAutoQuestion('intake-1', 'Which base?');
    await setAutoNextSteps('intake-1', ['answer the question', 'dispatch']);
    await setAutoIntakeStatus('intake-1', 'running');

    const loaded = await loadAutoIntake('intake-1');
    expect(loaded!.decisions).toEqual(['keep touchSet narrow']);
    expect(loaded!.questions).toEqual(['Which base?']);
    expect(loaded!.nextSteps).toEqual(['answer the question', 'dispatch']);
    expect(loaded!.status).toBe('running');

    // The question section survived the intake writes (no lost-update).
    const snapshot = await loadRuntimeSnapshot();
    expect(snapshot!.pendingQuestions).toHaveLength(1);
  });

  it('rejects appends to an unknown intake instead of forking state', async () => {
    await expect(appendAutoDecision('ghost', 'x')).rejects.toThrow(/no intake/i);
    await expect(appendAutoQuestion('ghost', 'x')).rejects.toThrow(/no intake/i);
  });

  it('survives unrelated runtime writes (lost-update guard)', async () => {
    await saveAutoIntake({
      id: 'intake-1',
      request: 'Add retry',
      requirements: [{ id: 'r1', text: 't', acceptance: ['a'] }],
      decisions: ['d1'],
      questions: [],
      nextSteps: ['s1'],
      status: 'planned',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    // A question arriving from a worker must not wipe the intake record.
    await persistPendingQuestion({
      jobId: 'job-9',
      jobName: 'beta',
      taskSummary: 't',
      partId: 'p9',
      callID: 'c9',
      remoteSessionID: 'ses_y',
      port: 14101,
      question: 'Q?',
      options: [],
      detectedAt: Date.now(),
    });
    const loaded = await loadAutoIntake('intake-1');
    expect(loaded!.request).toBe('Add retry');
    expect(loaded!.decisions).toEqual(['d1']);
  });
});
