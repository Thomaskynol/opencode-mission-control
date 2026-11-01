import { join } from 'path';
import { z } from 'zod';
import { getDataDir } from './paths';
import { withFileLock, lockPathFor } from './file-lock';
import { isValidJobTransition, VALID_JOB_TRANSITIONS } from './plan-types';
import type { JobStatus } from './plan-types';
import { JobSchema, JobStateSchema } from './schemas';
import { atomicWrite } from './utils';

export type Job = z.infer<typeof JobSchema>;
export type JobState = z.infer<typeof JobStateSchema>;

/**
 * Effective serve password for a job: the persisted per-worker credential
 * first, config fallback second. Undefined when neither exists — callers
 * must fail closed (never poll unauthenticated, serve always 401s).
 */
export function resolveJobPassword(
  job: { serverPassword?: string },
  configured?: string,
): string | undefined {
  if (job.serverPassword) return job.serverPassword;
  const trimmed = configured?.trim();
  return trimmed ? trimmed : undefined;
}

export function migrateV2ToV3(state: Record<string, unknown>): JobState {
  const jobs = (state.jobs as Job[]) ?? [];
  const migrated = {
    version: 3 as const,
    jobs: jobs.map((job) => ({ ...job, launchSessionID: job.launchSessionID ?? undefined })),
    updatedAt: (state.updatedAt as string) ?? new Date().toISOString(),
  };
  return JobStateSchema.parse(migrated);
}

export function migrateJobState(state: Record<string, unknown>): JobState {
  const version = (state.version as number) ?? 1;

  if (version < 2) {
    const jobs = (state.jobs as Job[]) ?? [];
    const migrated = {
      version: 2 as const,
      jobs: jobs.map((job) => ({ ...job, planId: job.planId ?? undefined })),
      updatedAt: (state.updatedAt as string) ?? new Date().toISOString(),
    };
    // Continue to v3 migration
    return migrateV2ToV3(migrated as unknown as Record<string, unknown>);
  }

  if (version < 3) {
    return migrateV2ToV3(state);
  }

  return JobStateSchema.parse(state);
}

const STATE_FILE = 'jobs.json';

/**
 * Serialize read-modify-write cycles across processes via the lockfile
 * (`jobs.json.lock`). withFileLock also serializes same-process callers,
 * so concurrent addJob/updateJob/removeJob calls can neither lose updates
 * within one process nor race across processes. Stale locks left by a
 * kill -9 are broken after the stale timeout (see file-lock.ts).
 */
async function withStateLock<T>(fn: () => Promise<T>): Promise<T> {
  const filePath = await getStateFilePath();
  return withFileLock(lockPathFor(filePath), fn);
}

async function getStateFilePath(): Promise<string> {
  const dataDir = await getDataDir();
  return join(dataDir, STATE_FILE);
}



export async function loadJobState(): Promise<JobState> {
  const filePath = await getStateFilePath();
  const file = Bun.file(filePath);
  const exists = await file.exists();

  if (!exists) {
    return {
      version: 3,
      jobs: [],
      updatedAt: new Date().toISOString(),
    };
  }

  try {
    const content = await file.text();
    const parsed = JSON.parse(content);
    if (!parsed.version || parsed.version < 3) {
      return migrateJobState(parsed);
    }
    return JobStateSchema.parse(parsed);
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new Error(`Invalid job state in ${filePath}: ${error.issues.map(e => `${e.path.join('.')}: ${e.message}`).join(', ')}`);
    }
    throw new Error(`Failed to load job state from ${filePath}: ${error}`);
  }
}

export async function saveJobState(state: JobState): Promise<void> {
  const filePath = await getStateFilePath();
  const updatedState: JobState = {
    ...state,
    version: 3,
    updatedAt: new Date().toISOString(),
  };

  try {
    const data = JSON.stringify(updatedState, null, 2);
    await atomicWrite(filePath, data);
  } catch (error) {
    throw new Error(`Failed to save job state to ${filePath}: ${error}`);
  }
}

export async function addJob(job: Job): Promise<void> {
  await withStateLock(async () => {
    const state = await loadJobState();
    state.jobs.push(job);
    await saveJobState(state);
  });
}

export async function updateJob(
  id: string,
  updates: Partial<Job>
): Promise<void> {
  await withStateLock(async () => {
    const state = await loadJobState();
    const jobIndex = state.jobs.findIndex((j) => j.id === id);

    if (jobIndex === -1) {
      throw new Error(`Job with id ${id} not found`);
    }

    const job = state.jobs[jobIndex];
    if (updates.status && job.status !== updates.status) {
      const fromStatus = job.status as string;
      const toStatus = updates.status as string;
      if (fromStatus in VALID_JOB_TRANSITIONS && toStatus in VALID_JOB_TRANSITIONS) {
        if (!isValidJobTransition(fromStatus as JobStatus, toStatus as JobStatus)) {
          // Fail-closed: an invalid transition is a bug in the caller, never
          // a state to persist. Throw instead of writing a state the rest of
          // the pipeline (and the transition map) does not understand.
          throw new Error(`Invalid job transition: ${fromStatus} → ${toStatus} (job: ${job.name})`);
        }
      }
    }

    state.jobs[jobIndex] = {
      ...state.jobs[jobIndex],
      ...updates,
    };

    await saveJobState(state);
  });
}

export async function removeJob(id: string): Promise<void> {
  await withStateLock(async () => {
    const state = await loadJobState();
    const initialLength = state.jobs.length;
    state.jobs = state.jobs.filter((j) => j.id !== id);

    if (state.jobs.length === initialLength) {
      throw new Error(`Job with id ${id} not found`);
    }

    await saveJobState(state);
  });
}

export async function getJob(id: string): Promise<Job | undefined> {
  const state = await loadJobState();
  return state.jobs.find((j) => j.id === id);
}

export async function getJobByName(name: string): Promise<Job | undefined> {
  const state = await loadJobState();
  return state.jobs.find((j) => j.name === name);
}

export async function getRunningJobs(): Promise<Job[]> {
  const state = await loadJobState();
  return state.jobs.filter((j) => j.status === 'running');
}
