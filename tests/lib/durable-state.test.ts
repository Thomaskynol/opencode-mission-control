import { describe, it, expect, beforeEach, afterEach, vi, spyOn } from 'bun:test';
import { join } from 'path';
import { tmpdir } from 'os';
import * as paths from '../../src/lib/paths';
import {
  saveRuntimeSnapshot,
  loadRuntimeSnapshot,
  reconcileOnBoot,
  updateRuntimeSnapshot,
  type RuntimeSnapshot,
} from '../../src/lib/durable-state';

let testStateDir: string;

async function createTempDir(): Promise<string> {
  const fs = await import('fs');
  return fs.promises.mkdtemp(join(tmpdir(), 'mc-durable-state-test-'));
}

function makeJob(id: string, name: string, status = 'running') {
  return {
    id,
    name,
    worktreePath: `/path/${id}`,
    branch: 'main',
    tmuxTarget: `mc-${id}`,
    placement: 'session',
    status,
    prompt: `Prompt for ${name}`,
    mode: 'vanilla',
    createdAt: new Date().toISOString(),
  };
}

describe('durable-state', () => {
  let getDataDirSpy: ReturnType<typeof spyOn>;

  beforeEach(async () => {
    testStateDir = await createTempDir();
    getDataDirSpy = spyOn(paths, 'getDataDir').mockResolvedValue(testStateDir);
  });

  afterEach(async () => {
    getDataDirSpy.mockRestore();
    const fs = await import('fs');
    if (fs.existsSync(testStateDir)) {
      fs.rmSync(testStateDir, { recursive: true, force: true });
    }
  });

  it('should round-trip a runtime snapshot through an atomic sidecar file', async () => {
    await saveRuntimeSnapshot({
      pendingQuestions: [
        {
          jobId: 'job-1',
          jobName: 'Job 1',
          taskSummary: 'do things',
          partId: 'part-1',
          callID: 'call-1',
          remoteSessionID: 'ses_abc',
          port: 14100,
          question: 'Proceed?',
          options: [{ label: 'Yes' }],
          detectedAt: Date.now(),
        },
      ],
      messageBus: {
        'Job 1': [{ from: 'Job 2', to: 'Job 1', context: { finding: 'f' }, timestamp: new Date().toISOString() }],
      },
      accumulators: {
        'job-1': { filesEdited: ['a.ts'], lastActivityAt: Date.now(), eventCount: 3 },
      },
    });

    const loaded = await loadRuntimeSnapshot();
    expect(loaded).not.toBeNull();
    expect(loaded!.version).toBe(1);
    expect(loaded!.pendingQuestions).toHaveLength(1);
    expect(loaded!.pendingQuestions[0].question).toBe('Proceed?');
    expect(loaded!.messageBus['Job 1']).toHaveLength(1);
    expect(loaded!.accumulators['job-1'].eventCount).toBe(3);

    // Atomic write must not leave temp files behind.
    const fs = await import('fs');
    const leftovers = fs.readdirSync(testStateDir).filter((f) => f.endsWith('.tmp'));
    expect(leftovers).toEqual([]);
  });

  it('should return null when no snapshot was ever persisted', async () => {
    expect(await loadRuntimeSnapshot()).toBeNull();
  });

  it('updateRuntimeSnapshot should merge without dropping concurrent sections (lost-update guard)', async () => {
    await saveRuntimeSnapshot({
      messageBus: {
        'Job 1': [{ from: 'Job 2', to: 'Job 1', context: { finding: 'f' }, timestamp: new Date().toISOString() }],
      },
    });

    // A read-modify-write done via load+save would overwrite messageBus with
    // {}; the atomic updater preserves sections it does not touch.
    await updateRuntimeSnapshot((current) => ({
      pendingQuestions: [],
      messageBus: current.messageBus,
      accumulators: { 'job-1': { filesEdited: [], lastActivityAt: Date.now(), eventCount: 1 } },
      sseCursor: current.sseCursor,
    }));

    const loaded = await loadRuntimeSnapshot();
    expect(loaded!.messageBus['Job 1']).toHaveLength(1);
    expect(loaded!.accumulators['job-1'].eventCount).toBe(1);
  });

  it('should dedupe jobs and prune stale runtime entries on reconcile (kill -9 resume)', async () => {
    // Simulate two processes appending concurrently without a lock (crash-consistent mess).
    const job = makeJob('job-1', 'Job 1');
    const duplicated = {
      version: 3,
      jobs: [job, { ...job }, makeJob('job-2', 'Job 2')],
      updatedAt: new Date().toISOString(),
    };
    await Bun.write(join(testStateDir, 'jobs.json'), JSON.stringify(duplicated));

    // Sidecar references a job that no longer exists (stale) plus live ones.
    await saveRuntimeSnapshot({
      pendingQuestions: [
        {
          jobId: 'job-1', jobName: 'Job 1', taskSummary: 't', partId: 'p1',
          callID: 'c1', remoteSessionID: 'ses_x', port: 14100,
          question: 'Q?', options: [], detectedAt: Date.now(),
        },
        {
          jobId: 'ghost', jobName: 'Ghost', taskSummary: 't', partId: 'p9',
          callID: 'c9', remoteSessionID: 'ses_y', port: 14101,
          question: 'Stale?', options: [], detectedAt: Date.now(),
        },
      ],
      messageBus: {
        'Job 1': [{ from: 'Job 2', to: 'Job 1', context: { finding: 'live' }, timestamp: new Date().toISOString() }],
        'Ghost': [{ from: 'X', to: 'Ghost', context: { finding: 'stale' }, timestamp: new Date().toISOString() }],
      },
      accumulators: {
        'job-1': { filesEdited: [], lastActivityAt: Date.now(), eventCount: 1 },
        'ghost': { filesEdited: [], lastActivityAt: Date.now(), eventCount: 1 },
      },
    } satisfies Partial<RuntimeSnapshot>);

    const report = await reconcileOnBoot();

    expect(report.dedupedJobs).toBe(1);
    expect(report.droppedPending).toBe(1);
    expect(report.droppedMessages).toBe(1);
    expect(report.droppedAccumulators).toBe(1);

    // jobs.json is valid and deduplicated — no duplication, no resurrection.
    const reloaded = JSON.parse(await Bun.file(join(testStateDir, 'jobs.json')).text());
    expect(reloaded.jobs.map((j: { id: string }) => j.id).sort()).toEqual(['job-1', 'job-2']);

    // Sidecar only references live jobs — stale entries are dropped, never re-delivered.
    const snapshot = await loadRuntimeSnapshot();
    expect(snapshot!.pendingQuestions.map((q) => q.jobId)).toEqual(['job-1']);
    expect(Object.keys(snapshot!.messageBus)).toEqual(['Job 1']);
    expect(Object.keys(snapshot!.accumulators)).toEqual(['job-1']);

    // Idempotent: second reconcile is a no-op.
    const second = await reconcileOnBoot();
    expect(second.dedupedJobs).toBe(0);
    expect(second.droppedPending).toBe(0);
    expect(second.droppedMessages).toBe(0);
  });

  it('should quarantine a corrupted sidecar instead of failing boot', async () => {
    await Bun.write(join(testStateDir, 'runtime-state.json'), '{invalid json');
    const report = await reconcileOnBoot();
    expect(report.quarantined).toBe(true);
    expect(await loadRuntimeSnapshot()).toBeNull();
  });
});
