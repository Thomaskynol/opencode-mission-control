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

export interface AutoIntakeRequirement {
  id: string;
  text: string;
  acceptance: string[];
}

export type AutoIntakeStatus = 'awaiting-plan' | 'planned' | 'running';

/**
 * Autonomous intake record: the original NL request plus everything the
 * model derived from it (requirements, decisions, questions, next steps).
 * Kept in the sidecar (not plan.json) so intake survives before a plan
 * exists and across restarts without manual reconstruction.
 */
export interface AutoIntakeRecord {
  id: string;
  request: string;
  repo?: string;
  targetBranch?: string;
  ceiling?: { maxParallel?: number; testCommand?: string };
  requirements: AutoIntakeRequirement[];
  decisions: string[];
  questions: string[];
  nextSteps: string[];
  status: AutoIntakeStatus;
  createdAt: string;
  updatedAt: string;
  /** F07: durable intake↔plan linkage (which plan this intake produced). */
  planId?: string;
  /** F06: effective model once per execution (provider/model + variant when pinned). */
  effectiveModel?: string;
  effectiveVariant?: string;
  /** F11: original --context (prompt docs + loaded refs for resume). */
  docs?: string[];
  contextDocs?: Array<{ ref: string; content: string; hash: string; scope: string }>;
}

export interface RuntimeSnapshot {
  version: 1;
  updatedAt: string;
  pendingQuestions: PendingQuestion[];
  messageBus: Record<string, RelayMessage[]>;
  accumulators: Record<string, AccumulatorSnapshot>;
  sseCursor: Record<string, { lastActivityAt: number; lastEventId?: string }>;
  autoIntake: AutoIntakeRecord | null;
  /**
   * F09: conserved merge/test evidence per job (product-observed).
   * Keyed by job name; survives restarts so the final report can list
   * real commands, outputs, commits and changed files instead of empties.
   */
  mergeEvidence: Record<string, MergeEvidenceRecord>;
}

/**
 * F09: product-observed integration evidence for one job.
 * Persisted right after a successful merge; read back by the final
 * report (never invented, never dropped silently).
 */
export interface MergeEvidenceRecord {
  jobName: string;
  mergedAt: string;
  reviewedCommit?: string;
  reviewedBase?: string;
  changedFiles?: string[];
  testCommand?: string;
  testStatus: 'passed' | 'failed' | 'skipped';
  testOutput?: string;
  setupCommands?: string[];
  setupStatus?: 'passed' | 'failed' | 'skipped';
  /**
   * R05: which verification produced this record. Task-scoped evidence comes
   * from the per-task review (scoped test run on the candidate); integration
   * evidence comes from the repo-wide post-merge gate. Only task-scoped
   * passes verify a job — a global smoke never promotes jobs to Verified.
   */
  scope?: 'task' | 'integration';
  /**
   * Manual-plan fallback: the reviewed prompt carried no `- [ ]` acceptance
   * lines, so no coverage anchor existed to judge against. The merge was
   * allowed on product-observed test evidence alone (never on diff alone)
   * and this job must stay out of Verified — the report lists it under Gaps
   * as "merged without acceptance criteria".
   */
  acceptanceLess?: boolean;
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
    autoIntake: null,
    mergeEvidence: {},
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
 * Persist a question to the sidecar without dropping other runtime sections.
 * Atomic read-modify-write under the file lock: a load-then-save here would
 * lose a concurrent process's update.
 */
export async function persistPendingQuestion(q: PendingQuestion): Promise<void> {
  await updateRuntimeSnapshot((current) => ({
    pendingQuestions: [
      ...(current.pendingQuestions ?? []).filter(
        (p) => !(p.jobId === q.jobId && p.partId === q.partId),
      ),
      q,
    ],
    messageBus: current.messageBus ?? {},
    accumulators: current.accumulators ?? {},
    sseCursor: current.sseCursor ?? {},
    autoIntake: current.autoIntake ?? null,
    mergeEvidence: current.mergeEvidence ?? {},
  }));
}

export async function dropPersistedQuestion(jobId: string, partId: string): Promise<void> {
  // Atomic read-modify-write under the file lock (see above). No-op when
  // no sidecar exists yet.
  await updateRuntimeSnapshot((current) => ({
    pendingQuestions: (current.pendingQuestions ?? []).filter(
      (p) => !(p.jobId === jobId && p.partId === partId),
    ),
    messageBus: current.messageBus ?? {},
    accumulators: current.accumulators ?? {},
    sseCursor: current.sseCursor ?? {},
    autoIntake: current.autoIntake ?? null,
    mergeEvidence: current.mergeEvidence ?? {},
  }));
}

export async function listPersistedQuestions(): Promise<PendingQuestion[]> {
  const snapshot = await loadRuntimeSnapshot();
  return snapshot?.pendingQuestions ?? [];
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

// ---------------------------------------------------------------------------
// Autonomous intake record (NL request → model plan, resumable).
// Single active intake: one autonomous run at a time, like one active plan.
// ---------------------------------------------------------------------------

/** Persist (or replace) the autonomous intake record. */
export async function saveAutoIntake(record: AutoIntakeRecord): Promise<void> {
  await updateRuntimeSnapshot((current) => ({
    pendingQuestions: current.pendingQuestions ?? [],
    messageBus: current.messageBus ?? {},
    accumulators: current.accumulators ?? {},
    sseCursor: current.sseCursor ?? {},
    autoIntake: record,
    mergeEvidence: current.mergeEvidence ?? {},
  }));
}

/** Load the intake record by id (null when absent or a different id). */
export async function loadAutoIntake(id: string): Promise<AutoIntakeRecord | null> {
  const snapshot = await loadRuntimeSnapshot();
  if (!snapshot?.autoIntake || snapshot.autoIntake.id !== id) return null;
  return snapshot.autoIntake;
}

async function mutateAutoIntake(
  id: string,
  mutate: (record: AutoIntakeRecord) => AutoIntakeRecord,
): Promise<AutoIntakeRecord> {
  let updated: AutoIntakeRecord | null = null;
  await updateRuntimeSnapshot((current) => {
    const record = current.autoIntake;
    if (!record || record.id !== id) {
      throw new Error(`No intake "${id}" persisted — start one before appending.`);
    }
    updated = mutate({ ...record, updatedAt: new Date().toISOString() });
    return {
      pendingQuestions: current.pendingQuestions ?? [],
      messageBus: current.messageBus ?? {},
      accumulators: current.accumulators ?? {},
      sseCursor: current.sseCursor ?? {},
      autoIntake: updated,
      mergeEvidence: current.mergeEvidence ?? {},
    };
  });
  return updated!;
}

/** Append a coordinator/model decision (preserved across restarts). */
export async function appendAutoDecision(id: string, decision: string): Promise<void> {
  await mutateAutoIntake(id, (record) => ({
    ...record,
    decisions: [...record.decisions, decision],
  }));
}

/** Append a user-facing question (answered via free text, never lost). */
export async function appendAutoQuestion(id: string, question: string): Promise<void> {
  await mutateAutoIntake(id, (record) => ({
    ...record,
    questions: [...record.questions, question],
  }));
}

/** Replace the next-steps list (derived from the latest validated draft). */
export async function setAutoNextSteps(id: string, nextSteps: string[]): Promise<void> {
  await mutateAutoIntake(id, (record) => ({ ...record, nextSteps: [...nextSteps] }));
}

/** Advance the intake lifecycle without rebuilding the request. */
export async function setAutoIntakeStatus(id: string, status: AutoIntakeStatus): Promise<void> {
  await mutateAutoIntake(id, (record) => ({ ...record, status }));
}

// ---------------------------------------------------------------------------
// F09: conserved merge/test evidence (product-observed, never invented).
// Written right after each successful merge; read back by the final
// report so tests/verified/files carry real commands, outputs, commits
// and changed files instead of empties.
// ---------------------------------------------------------------------------

/** Persist one job's merge evidence, merging fields (never replace). */
export async function saveMergeEvidence(record: MergeEvidenceRecord): Promise<void> {
  await updateRuntimeSnapshot((current) => {
    const prev = current.mergeEvidence?.[record.jobName] ?? {};
    // Merge by field, skipping undefined: a later global-integration write
    // must never erase reviewedCommit/reviewedBase/changedFiles from the
    // earlier task-scoped review (R05: no field loss on save).
    const defined = Object.fromEntries(
      Object.entries(record).filter(([, v]) => v !== undefined),
    ) as Partial<MergeEvidenceRecord>;
    // R05 trail: a task-scoped pass is immutable verification. A later
    // `skipped` write (per-merge success path with skipTest) or a global
    // `integration` write must never downgrade it or flip its scope.
    const prevPassedTask = prev.testStatus === 'passed' && prev.scope === 'task';
    let next: MergeEvidenceRecord;
    if (prevPassedTask) {
      const incomingDowngrades =
        defined.testStatus === 'skipped' ||
        (defined.scope !== undefined && defined.scope !== 'task');
      if (incomingDowngrades) {
        const { testStatus: _ts, scope: _sc, testCommand: _tc, testOutput: _to, setupCommands: _shc, setupStatus: _shs, ...rest } = defined;
        void _ts; void _sc; void _tc; void _to; void _shc; void _shs;
        next = { ...prev, ...rest, jobName: record.jobName } as MergeEvidenceRecord;
      } else {
        next = { ...prev, ...defined, jobName: record.jobName } as MergeEvidenceRecord;
      }
      // Belt-and-braces: never let a merge preserve a skipped status over a
      // proven pass, even when the incoming scope was also 'task'.
      if (next.testStatus !== 'passed') next.testStatus = 'passed';
      if (next.scope !== 'task') next.scope = 'task';
    } else {
      // General monotonicity: a proven pass is never replaced by skipped.
      if (prev.testStatus === 'passed' && defined.testStatus === 'skipped') {
        const { testStatus: _ts, ...rest } = defined;
        void _ts;
        next = { ...prev, ...rest, jobName: record.jobName } as MergeEvidenceRecord;
      } else {
        next = { ...prev, ...defined, jobName: record.jobName } as MergeEvidenceRecord;
      }
    }
    return {
      pendingQuestions: current.pendingQuestions ?? [],
      messageBus: current.messageBus ?? {},
      accumulators: current.accumulators ?? {},
      sseCursor: current.sseCursor ?? {},
      autoIntake: current.autoIntake ?? null,
      mergeEvidence: {
        ...(current.mergeEvidence ?? {}),
        [record.jobName]: next,
      },
    };
  });
}

/** Load all conserved merge evidence (empty when none persisted yet). */
export async function loadMergeEvidence(): Promise<Record<string, MergeEvidenceRecord>> {
  const snapshot = await loadRuntimeSnapshot().catch(() => null);
  return snapshot?.mergeEvidence ?? {};
}
