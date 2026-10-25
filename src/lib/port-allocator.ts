import { join } from 'path';
import { getDataDir } from './paths';
import { withFileLock, lockPathFor } from './file-lock';
import { atomicWrite } from './utils';
import type { MCConfig } from './config';
import type { Job } from './job-state';

const LOCK_FILE = 'port.lock';

/**
 * Cross-process lock for port allocation (see file-lock.ts).
 * Serializes read-modify-write cycles on port.lock across processes so
 * two concurrent launches can never allocate the same port.
 */
async function withPortLock<T>(fn: () => Promise<T>): Promise<T> {
  const dataDir = await getDataDir();
  return withFileLock(lockPathFor(join(dataDir, LOCK_FILE)), fn);
}

async function getLockFilePath(): Promise<string> {
  const dataDir = await getDataDir();
  return join(dataDir, LOCK_FILE);
}

async function readLockedPorts(): Promise<number[]> {
  const filePath = await getLockFilePath();
  const file = Bun.file(filePath);
  const exists = await file.exists();

  if (!exists) {
    return [];
  }

  try {
    const content = await file.text();
    const parsed = JSON.parse(content);
    if (Array.isArray(parsed)) {
      return parsed.filter((p): p is number => typeof p === 'number');
    }
    return [];
  } catch {
    // Corrupted lock file — treat as empty
    return [];
  }
}

async function writeLockedPorts(ports: number[]): Promise<void> {
  const filePath = await getLockFilePath();
  await atomicWrite(filePath, JSON.stringify(ports));
}

/**
 * Allocate the next available port from the configured range.
 * Scans active jobs for used ports and checks the lock file to prevent races.
 */
export async function allocatePort(
  config: MCConfig,
  activeJobs: Job[],
): Promise<number> {
  return withPortLock(async () => {
    const rangeStart = config.portRangeStart ?? 14100;
    const rangeEnd = config.portRangeEnd ?? 14199;

    const jobPorts = new Set(
      activeJobs
        .map((j) => j.port)
        .filter((p): p is number => p !== undefined),
    );
    const lockedPorts = await readLockedPorts();
    const usedPorts = new Set([...jobPorts, ...lockedPorts]);

    for (let port = rangeStart; port <= rangeEnd; port++) {
      if (!usedPorts.has(port)) {
        lockedPorts.push(port);
        await writeLockedPorts(lockedPorts);
        return port;
      }
    }

    throw new Error(
      `No available ports in range ${rangeStart}-${rangeEnd}. ` +
        `${usedPorts.size} ports in use. Use mc_cleanup to free ports from completed jobs.`,
    );
  });
}

/**
 * Release a port back to the available pool.
 * Idempotent — no-op if port is not in the lock file.
 */
export async function releasePort(port: number): Promise<void> {
  await withPortLock(async () => {
    const lockedPorts = await readLockedPorts();
    const filtered = lockedPorts.filter((p) => p !== port);

    if (filtered.length !== lockedPorts.length) {
      await writeLockedPorts(filtered);
    }
  });
}
