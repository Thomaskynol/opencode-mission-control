import { createHash } from 'crypto';
import { chmodSync, readFileSync, statSync } from 'fs';
import { isAbsolute, join } from 'path';

/**
 * Candidate-input protection (§4 TOCTOU A→B→A).
 *
 * Before/after content comparison alone cannot see a test that swaps an
 * input file, executes the swapped bytes, then restores the original:
 * content, HEAD and `git status` all look clean afterwards. This module
 * closes that hole: it snapshots SHA-256 hashes of the scope inputs,
 * hardens them read-only while the run executes (except allowlisted
 * outputs), re-hashes DURING the run on a short poll, and compares
 * hash+mtime afterwards so a restore still leaves a trace.
 *
 * Integrator plug (orchestrator.ts gatherScopeEvidence): wrap the
 * runTestCommand call as runFn —
 *   const r = await protectInputsDuringRun({ dir, scopePaths, runFn: () => runTestCommand(dir, cmd, timeout) });
 *   if (r.verdict === 'fail') → identity refused, never attribute to jobHead.
 * `decideIdentityVerdict` is the pure core for reuse once before/after
 * snapshots are captured by other means.
 */

// Copy of orchestrator ALLOWED_TEST_ARTIFACT_PATTERNS (orchestrator.ts:111-118):
// coverage/tmp/logs are always writable outputs, never protected inputs.
const ALLOWED_TEST_ARTIFACT_PATTERNS: RegExp[] = [
  /^coverage\//,
  /^\.nyc_output\//,
  /^tmp\//,
  /^\.coverage/,
  /\.lcov$/,
  /\.log$/,
];

const DIST_BUILD_PREFIX = /^(dist|build)\//;
const ENFORCED_MODE = 0o444;

function normalizeRel(relPath: string): string {
  return relPath.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^"+|"+$/g, '').trim();
}

/** True when a repo-relative path is a permitted test artifact (writable output). */
export function isAllowedTestArtifactPath(relPath: string): boolean {
  const normalized = normalizeRel(relPath);
  if (!normalized) return false;
  return ALLOWED_TEST_ARTIFACT_PATTERNS.some((re) => re.test(normalized));
}

/**
 * True when a normalized, dir-local rel path is a protected input.
 * dist/build outputs are writable only when never versioned (parity with
 * orchestrator filterRelevantDirtyEntries): pass isTracked from
 * `git ls-files` — unknown tracking fails closed (protected).
 */
export function isProtectedInput(relPath: string, isTracked?: (rel: string) => boolean): boolean {
  if (isAllowedTestArtifactPath(relPath)) return false;
  const normalized = normalizeRel(relPath);
  if (DIST_BUILD_PREFIX.test(normalized)) {
    if (isTracked !== undefined) return isTracked(normalized);
    return true;
  }
  return true;
}

/** Scope entries that are actually protected (normalized, dir-local, deduped). */
export function protectedScopePaths(
  scopePaths: string[],
  isTracked?: (rel: string) => boolean,
): string[] {
  const out: string[] = [];
  for (const raw of scopePaths) {
    const normalized = normalizeRel(raw);
    if (!normalized || normalized.includes('..') || isAbsolute(normalized)) continue;
    if (!isProtectedInput(normalized, isTracked)) continue;
    if (!out.includes(normalized)) out.push(normalized);
  }
  return out;
}

export interface FileIdentity {
  hash: string;
  mtimeMs: number;
  size: number;
  exists: boolean;
}

export interface IdentityVerdict {
  verdict: 'pass' | 'fail';
  reason?: string;
}

/**
 * Pure identity decision over before/after snapshots plus transient hits
 * observed during the run. A content-identical file with changed mtime/size
 * is an A→B→A restore: fail.
 */
export function decideIdentityVerdict(
  before: Record<string, FileIdentity>,
  after: Record<string, FileIdentity>,
  transientHits: string[] = [],
): IdentityVerdict {
  if (transientHits.length > 0) {
    const names = [...transientHits].sort().join(', ');
    return {
      verdict: 'fail',
      reason: `identity refused: input changed during run (${names}) — executed bytes may differ from committed bytes`,
    };
  }
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const key of keys) {
    const b = before[key];
    const a = after[key];
    if (b === undefined || a === undefined) {
      return {
        verdict: 'fail',
        reason: `identity refused: scope changed during run (${key} appeared/disappeared) — not attributable to the reviewed commit`,
      };
    }
    if (b.exists !== a.exists) {
      return {
        verdict: 'fail',
        reason: `identity refused: input ${b.exists ? 'deleted' : 'created'} during run (${key}) — not attributable to the reviewed commit`,
      };
    }
    if (!b.exists) continue;
    if (b.hash !== a.hash) {
      return {
        verdict: 'fail',
        reason: `identity refused: input mutated during run (${key}) — executed bytes differ from committed bytes`,
      };
    }
    if (b.mtimeMs !== a.mtimeMs || b.size !== a.size) {
      // shortcut: a restore inside one mtime tick or faster than the poll
      // could miss; upgrade to an overlayfs read-only mount or fs-tracing when needed.
      return {
        verdict: 'fail',
        reason: `identity refused: input restored after write during run (${key}, content identical but mtime/size changed — A→B→A restore detected)`,
      };
    }
  }
  return { verdict: 'pass' };
}

export interface ProtectInputsOptions {
  dir: string;
  scopePaths: string[];
  runFn: () => unknown | Promise<unknown>;
  pollIntervalMs?: number;
  isTracked?: (rel: string) => boolean;
}

export interface ProtectInputsResult extends IdentityVerdict {
  transientHits: string[];
  protectedPaths: string[];
}

function sha256Hex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function snapshotOne(dir: string, rel: string): { identity: FileIdentity; mode: number } {
  const missing: FileIdentity = { hash: '', mtimeMs: 0, size: -1, exists: false };
  try {
    const st = statSync(join(dir, rel));
    if (!st.isFile()) return { identity: missing, mode: 0 };
    const bytes = readFileSync(join(dir, rel));
    return {
      identity: { hash: sha256Hex(bytes), mtimeMs: st.mtimeMs, size: st.size, exists: true },
      mode: st.mode & 0o777,
    };
  } catch {
    return { identity: missing, mode: 0 };
  }
}

function isWriteDeniedError(err: unknown): boolean {
  if (err === null || typeof err !== 'object') return false;
  const code: unknown = (err as { code?: unknown }).code;
  return code === 'EACCES' || code === 'EPERM' || code === 'EROFS';
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * Run runFn with scope inputs protected: snapshot SHA-256 before, harden
 * read-only during (best-effort; detection still applies as root),
 * re-hash on a short poll during, compare hash+mtime after. Unrelated
 * runFn errors propagate (identity held); write-denied errors become a
 * fail verdict (the run attempted to modify reviewed bytes).
 */
export async function protectInputsDuringRun(options: ProtectInputsOptions): Promise<ProtectInputsResult> {
  const protectedPaths = protectedScopePaths(options.scopePaths, options.isTracked);
  const before: Record<string, FileIdentity> = {};
  const savedModes = new Map<string, number>();
  const enforced = new Set<string>();
  for (const rel of protectedPaths) {
    const snap = snapshotOne(options.dir, rel);
    before[rel] = snap.identity;
    if (snap.identity.exists) {
      savedModes.set(rel, snap.mode);
      try {
        chmodSync(join(options.dir, rel), ENFORCED_MODE);
        enforced.add(rel);
      } catch {
        // Best-effort hardening only; hash/mtime detection still applies.
      }
    }
  }

  const transientHits = new Set<string>();
  const checkLive = (): void => {
    for (const rel of protectedPaths) {
      if (transientHits.has(rel)) continue;
      const b = before[rel];
      if (b === undefined) continue;
      const live = snapshotOne(options.dir, rel);
      if (live.identity.hash !== b.hash || live.identity.exists !== b.exists || live.identity.mtimeMs !== b.mtimeMs) {
        transientHits.add(rel);
        continue;
      }
      if (enforced.has(rel) && live.mode !== ENFORCED_MODE) transientHits.add(rel);
    }
  };
  const timer = setInterval(checkLive, options.pollIntervalMs ?? 5);
  let runError: unknown;
  try {
    await options.runFn();
  } catch (err) {
    runError = err;
  } finally {
    clearInterval(timer);
  }

  const after: Record<string, FileIdentity> = {};
  const afterModes = new Map<string, number>();
  for (const rel of protectedPaths) {
    const snap = snapshotOne(options.dir, rel);
    after[rel] = snap.identity;
    afterModes.set(rel, snap.mode);
  }
  for (const [rel, mode] of savedModes) {
    try {
      chmodSync(join(options.dir, rel), mode);
    } catch {
      // Restore best-effort; a deleted file has nothing to restore.
    }
  }
  for (const rel of enforced) {
    const a = after[rel];
    if (a === undefined || !a.exists || transientHits.has(rel)) continue;
    if (afterModes.get(rel) !== ENFORCED_MODE) transientHits.add(rel);
  }

  const hits = [...transientHits].sort();
  const decided = decideIdentityVerdict(before, after, hits);
  if (decided.verdict === 'fail') {
    if (runError !== undefined) {
      return {
        verdict: 'fail',
        reason: `${decided.reason}; run also threw: ${errorMessage(runError)}`,
        transientHits: hits,
        protectedPaths,
      };
    }
    return { ...decided, transientHits: hits, protectedPaths };
  }
  if (runError !== undefined) {
    if (isWriteDeniedError(runError)) {
      return {
        verdict: 'fail',
        reason: `identity refused: write denied on protected input (${errorMessage(runError)}) — run attempted to modify reviewed bytes`,
        transientHits: hits,
        protectedPaths,
      };
    }
    throw runError;
  }
  return { verdict: 'pass', transientHits: hits, protectedPaths };
}
