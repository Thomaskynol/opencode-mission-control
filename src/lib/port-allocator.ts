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
 * OS-level availability probe: can we actually bind this port right now?
 * Detects holders invisible to the lock file / job list (another XDG
 * instance, a leaked serve process, anything else on the machine).
 * A successful bind means free — the probe server is stopped immediately.
 */
async function isPortFree(port: number): Promise<boolean> {
  try {
    const server = Bun.serve({
      port,
      hostname: '127.0.0.1',
      fetch: () => new Response('mc-port-probe', { status: 404 }),
    });
    server.stop(true);
    return true;
  } catch {
    return false;
  }
}

/**
 * Allocate the next available port from the configured range.
 * Scans active jobs for used ports and checks the lock file to prevent races.
 * Before delivering a candidate, probes whether the OS will actually let us
 * bind it — ports held by foreign processes (other XDG instances, leaked
 * servers) are skipped instead of reallocated into a deterministic collision.
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
    const osOccupied: number[] = [];

    for (let port = rangeStart; port <= rangeEnd; port++) {
      if (usedPorts.has(port)) {
        continue;
      }
      if (!(await isPortFree(port))) {
        osOccupied.push(port);
        continue;
      }
      lockedPorts.push(port);
      await writeLockedPorts(lockedPorts);
      return port;
    }

    const osHint =
      osOccupied.length > 0
        ? ` ${osOccupied.length} port(s) held at OS level (${osOccupied.join(', ')})` +
          ` by another process or XDG instance — check listeners (ss -ltnp) or widen the range.`
        : '';
    throw new Error(
      `No available ports in range ${rangeStart}-${rangeEnd}. ` +
        `${usedPorts.size} ports in use.${osHint} Use mc_cleanup to free ports from completed jobs.`,
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
