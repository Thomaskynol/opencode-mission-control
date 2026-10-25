/**
 * Durable runtime state: disk sidecar for in-memory-only data.
 *
 * jobs.json / plan.json cover jobs and plans, but pendingQuestions,
 * the inter-job messageBus, monitor event accumulators and SSE cursors
 * live only in memory — a kill -9 loses them and boot cannot tell a
 * stale entry from a live one.
 *
 * This module persists a `runtime-state.json` sidecar next to the other
 * state files (atomic write under the inter-process file lock) and
 * reconciles it on boot:
 *
 * - jobs.json is deduplicated by job id (two processes appending
 *   concurrently must never duplicate a job);
 * - sidecar entries referencing unknown jobs are dropped, never
 *   re-delivered (no reintegration of stale questions/messages);
 * - a corrupted sidecar is quarantined aside so boot always proceeds.
 */

import { join } from 'path';
import fs from 'node:fs';
import { getDataDir } from './paths';
import { atomicWrite } from './utils';
import { acquireFileLock, lockPathFor } from './file-lock';
import { migrateJobState } from './job-state';
import { JobStateSchema } from './schemas';
import type { PendingQuestion } from './question-relay';
import type { RelayMessage } from './job-comms';

export interface AccumulatorSnapshot {
  filesEdited: string[];
  currentTool?: string;
  currentFile?: string;
  lastActivityAt: number;
  eventCount: number;
}

export interface RuntimeSnapshot {
  version: 1;
  updatedAt: string;
  pendingQuestions: PendingQuestion[];
  messageBus: Record<string, RelayMessage[]>;
  accumulators: Record<string, AccumulatorSnapshot>;
  sseCursor: Record<string, { lastActivityAt: number; lastEventId?: string }>;
}

export interface ReconcileReport {
  jobs: number;
  dedupedJobs: number;
  droppedPending: number;
  droppedMessages: number;
  droppedAccumulators: number;
  quarantined: boolean;
}

const RUNTIME_FILE = 'runtime-state.json';
const JOBS_FILE = 'jobs.json';

function emptySnapshot(): RuntimeSnapshot {
  return {
    version: 1,
    updatedAt: new Date().toISOString(),
    pendingQuestions: [],
    messageBus: {},
    accumulators: {},
    sseCursor: {},
  };
}

async function getRuntimeFilePath(): Promise<string> {
  const dataDir = await getDataDir();
  return join(dataDir, RUNTIME_FILE);
}

async function getJobsFilePath(): Promise<string> {
  const dataDir = await getDataDir();
  return join(dataDir, JOBS_FILE);
}

/**
 * Persist a runtime snapshot atomically (rename) under the file lock.
 * Partial input fills missing sections with empty defaults.
 */
export async function saveRuntimeSnapshot(
  partial: Partial<Omit<RuntimeSnapshot, 'version' | 'updatedAt'>>,
): Promise<void> {
  const filePath = await getRuntimeFilePath();
  const release = await acquireFileLock(lockPathFor(filePath));
  try {
    const snapshot: RuntimeSnapshot = {
      ...emptySnapshot(),
      ...partial,
      version: 1,
      updatedAt: new Date().toISOString(),
    };
    await atomicWrite(filePath, JSON.stringify(snapshot, null, 2));
  } finally {
    await release();
  }
}

/**
 * Read-modify-write the runtime snapshot atomically under the file lock.
 * Use this (not load + save) whenever the new snapshot derives from the
 * current one — otherwise two processes interleave and one update is lost.
 * A corrupted sidecar is quarantined aside and treated as empty so boot
 * always proceeds.
 */
export async function updateRuntimeSnapshot(
  mutator: (current: RuntimeSnapshot) => Partial<Omit<RuntimeSnapshot, 'version' | 'updatedAt'>>,
): Promise<void> {
  const filePath = await getRuntimeFilePath();
  const release = await acquireFileLock(lockPathFor(filePath));
  try {
    let current = emptySnapshot();
    const file = Bun.file(filePath);
    if (await file.exists()) {
      try {
        const parsed = JSON.parse(await file.text());
        if (parsed?.version === 1) {
          current = { ...emptySnapshot(), ...parsed, version: 1 };
        }
      } catch {
        const quarantine = `${filePath}.corrupt-${Date.now()}`;
        try {
          fs.renameSync(filePath, quarantine);
        } catch {
          // Best effort: original stays, next update retries quarantine.
        }
      }
    }
    const partial = mutator(current);
    const snapshot: RuntimeSnapshot = {
      ...emptySnapshot(),
      ...partial,
      version: 1,
      updatedAt: new Date().toISOString(),
    };
    await atomicWrite(filePath, JSON.stringify(snapshot, null, 2));
  } finally {
    await release();
  }
}

/**
 * Load the runtime snapshot. Returns null when never persisted.
 * A corrupted sidecar is quarantined to `<file>.corrupt-<ts>` and
 * treated as absent so boot always proceeds.
 */
export async function loadRuntimeSnapshot(): Promise<RuntimeSnapshot | null> {
  const filePath = await getRuntimeFilePath();
  const file = Bun.file(filePath);
  if (!(await file.exists())) {
    return null;
  }
  try {
    const parsed = JSON.parse(await file.text());
    if (parsed?.version !== 1) {
      return null;
    }
    return { ...emptySnapshot(), ...parsed, version: 1 } as RuntimeSnapshot;
  } catch {
    const quarantine = `${filePath}.corrupt-${Date.now()}`;
    try {
      fs.renameSync(filePath, quarantine);
    } catch {
      // Best effort: original stays, next boot retries quarantine.
    }
    return null;
  }
}

/**
 * Reconcile state after an unclean shutdown (kill -9):
 * dedupe jobs.json by id (last occurrence wins) and prune sidecar
 * entries for jobs that no longer exist. Idempotent.
 */
export async function reconcileOnBoot(): Promise<ReconcileReport> {
  const report: ReconcileReport = {
    jobs: 0,
    dedupedJobs: 0,
    droppedPending: 0,
    droppedMessages: 0,
    droppedAccumulators: 0,
    quarantined: false,
  };

  // 1. Dedupe jobs.json.
  const jobsPath = await getJobsFilePath();
  const jobsRelease = await acquireFileLock(lockPathFor(jobsPath));
  let liveIds = new Set<string>();
  let liveNames = new Set<string>();
  try {
    const file = Bun.file(jobsPath);
    if (await file.exists()) {
      const raw = JSON.parse(await file.text());
      const state = migrateJobState(raw);
      const seen = new Map<string, (typeof state.jobs)[number]>();
      for (const job of state.jobs) {
        seen.set(job.id, job);
      }
      report.dedupedJobs = state.jobs.length - seen.size;
      const deduped = [...seen.values()];
      report.jobs = deduped.length;
      liveIds = new Set(deduped.map((j) => j.id));
      liveNames = new Set(deduped.map((j) => j.name));
      if (report.dedupedJobs > 0) {
        const validated = JobStateSchema.parse({
          ...state,
          jobs: deduped,
          updatedAt: new Date().toISOString(),
        });
        await atomicWrite(jobsPath, JSON.stringify(validated, null, 2));
      }
    }
  } finally {
    await jobsRelease();
  }

  // 2. Prune the sidecar to live jobs only (never re-deliver stale entries).
  const runtimePath = await getRuntimeFilePath();
  const runtimeRelease = await acquireFileLock(lockPathFor(runtimePath));
  try {
    const file = Bun.file(runtimePath);
    if (!(await file.exists())) {
      return report;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(await file.text());
    } catch {
      const quarantine = `${runtimePath}.corrupt-${Date.now()}`;
      try {
        fs.renameSync(runtimePath, quarantine);
      } catch {
        // Best effort (see loadRuntimeSnapshot).
      }
      report.quarantined = true;
      return report;
    }
    if ((parsed as { version?: number })?.version !== 1) {
      return report;
    }
    const snapshot = { ...emptySnapshot(), ...(parsed as object) } as RuntimeSnapshot;

    const keptPending = snapshot.pendingQuestions.filter((q) => liveIds.has(q.jobId));
    report.droppedPending = snapshot.pendingQuestions.length - keptPending.length;

    const keptBus: Record<string, RelayMessage[]> = {};
    for (const [name, messages] of Object.entries(snapshot.messageBus)) {
      if (liveNames.has(name)) {
        keptBus[name] = messages;
      } else {
        report.droppedMessages += messages.length;
      }
    }

    const keptAccumulators: Record<string, AccumulatorSnapshot> = {};
    for (const [jobId, acc] of Object.entries(snapshot.accumulators)) {
      if (liveIds.has(jobId)) {
        keptAccumulators[jobId] = acc;
      } else {
        report.droppedAccumulators += 1;
      }
    }

    const keptCursor: Record<string, { lastActivityAt: number; lastEventId?: string }> = {};
    for (const [jobId, cursor] of Object.entries(snapshot.sseCursor)) {
      if (liveIds.has(jobId)) {
        keptCursor[jobId] = cursor;
      }
    }

    if (
      report.droppedPending > 0 ||
      report.droppedMessages > 0 ||
      report.droppedAccumulators > 0 ||
      Object.keys(snapshot.sseCursor).length !== Object.keys(keptCursor).length
    ) {
      await atomicWrite(
        runtimePath,
        JSON.stringify(
          {
            ...snapshot,
            pendingQuestions: keptPending,
            messageBus: keptBus,
            accumulators: keptAccumulators,
            sseCursor: keptCursor,
            updatedAt: new Date().toISOString(),
          },
          null,
          2,
        ),
      );
    }
  } finally {
    await runtimeRelease();
  }

  return report;
}
