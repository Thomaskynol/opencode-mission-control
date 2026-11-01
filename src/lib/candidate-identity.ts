import { createHash } from 'crypto';
import { chmodSync, lstatSync, mkdtempSync, readFileSync, readlinkSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { isAbsolute, join } from 'path';

/**
 * Candidate-input protection (§4 TOCTOU A→B→A).
 *
 * Legacy observation (protectInputsDuringRun): snapshot SHA-256 hashes of
 * the scope inputs, harden them read-only while the run executes (except
 * allowlisted outputs), re-hash DURING the run on a short poll, and compare
 * hash+mtime afterwards so a restore still leaves a trace. Kept for existing
 * callers; its poll is a best-effort tripwire, not proof (see shortcut note
 * at the poll timer).
 *
 * Stronger observation (runTestsOnImmutableSnapshot): materialize
 * `git archive jobHead` (else a hash-verified working-tree copy) in a tmp
 * dir, execute the test command THERE (cwd=snapshotDir), then compare that
 * the ORIGINAL inputs were untouched via hash+mtime+ctime+size. A mutation
 * of the original during the run — including a sync swap+restore with forged
 * mtime — is a FAIL; outputs written inside the copy never contaminate the
 * verdict. No privileges, no kernel deps: ctime cannot be forged back with
 * utimes (every write/chmod/utimes bumps it), so the after-compare is
 * airtight without any during-run polling.
 *
 * Capabilities: executed bytes are the committed (or hash-verified copied)
 * bytes even under concurrent mutation of the original; any touch of a
 * protected original — content change, restore, timestamp/mode forgery,
 * appear/disappear — fails the verdict; legit builds writing untracked
 * dist/build, coverage/tmp/logs outputs inside the snapshot pass.
 * Limits: a DIRTY working tree at snapshot time still snapshots committed
 * bytes via git archive (copy fallback snapshots working bytes and fails on
 * a raced copy); the original is watched, not locked — a test that reaches
 * it via absolute path or `..` and MUTATES it is DETECTED (fail), not
 * prevented; a read-only reach with no concurrent mutation passes harmlessly
 * (same bytes), with a concurrent mutation it still fails via ctime; system
 * clock tampering is out of scope.
 *
 * Integrator plug (orchestrator.ts runScopeSnapshot → gatherScopeEvidence):
 * run the test command via runTestsOnImmutableSnapshot —
 *   const r = await runTestsOnImmutableSnapshot({ dir, scopePaths, testCommand: cmd, timeoutMs, jobHead });
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
    const st = lstatSync(join(dir, rel));
    if (st.isSymbolicLink()) {
      let target = '';
      try {
        target = readlinkSync(join(dir, rel));
      } catch {
        return { identity: missing, mode: 0 };
      }
      return {
        identity: { hash: sha256Hex(Buffer.from(`symlink:${target}`)), mtimeMs: st.mtimeMs, size: st.size, exists: true },
        mode: st.mode & 0o777,
      };
    }
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
  // shortcut: interval poll misses same-event-loop sync swap/restore and
  // sub-interval restores (same-uid chmod bypass restores mode too); upgrade
  // to runTestsOnImmutableSnapshot (snapshot copy + ctime after-compare) when
  // attribution must survive active tampering.
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

export interface ImmutableSnapshotOptions {
  dir: string;
  scopePaths: string[];
  /** Shell command executed with cwd=snapshotDir (same form as merge-train runTestCommand). */
  testCommand: string;
  timeoutMs?: number;
  isTracked?: (rel: string) => boolean;
  /** Commit whose bytes are executed; defaults to `git rev-parse HEAD` in dir. */
  jobHead?: string;
  /** Keep the snapshot dir for inspection (tests); default removes it. */
  keepSnapshotDir?: boolean;
  /** Optional setup commands run INSIDE the snapshot copy (shared prepareTestEnv). */
  setupCommands?: string[];
}

export interface ImmutableSnapshotResult extends IdentityVerdict {
  /** Test command outcome inside the snapshot (independent of the verdict). */
  success: boolean;
  output: string;
  timedOut: boolean;
  snapshotDir: string;
  protectedPaths: string[];
}

interface StrictSnapshot {
  identity: FileIdentity;
  /** Change time: every write/chmod/utimes bumps it and utimes cannot forge
   * it back, so a content-identical restore with forged mtime still differs. */
  ctimeMs: number;
}

function snapshotStrict(dir: string, rel: string): StrictSnapshot {
  const missing: StrictSnapshot = {
    identity: { hash: '', mtimeMs: 0, size: -1, exists: false },
    ctimeMs: -1,
  };
  try {
    const st = lstatSync(join(dir, rel));
    if (st.isSymbolicLink()) {
      let target = '';
      try {
        target = readlinkSync(join(dir, rel));
      } catch {
        return missing;
      }
      return {
        identity: { hash: sha256Hex(Buffer.from(`symlink:${target}`)), mtimeMs: st.mtimeMs, size: st.size, exists: true },
        ctimeMs: typeof st.ctimeMs === 'number' ? st.ctimeMs : -1,
      };
    }
    if (!st.isFile()) return missing;
    const bytes = readFileSync(join(dir, rel));
    return {
      identity: { hash: sha256Hex(bytes), mtimeMs: st.mtimeMs, size: st.size, exists: true },
      ctimeMs: typeof st.ctimeMs === 'number' ? st.ctimeMs : -1,
    };
  } catch {
    return missing;
  }
}

function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

async function runShellCommand(
  cwd: string,
  command: string,
  timeoutMs: number,
): Promise<{ success: boolean; output: string; timedOut: boolean; exitCode: number }> {
  const proc = Bun.spawn(['sh', '-c', command], { cwd, stdout: 'pipe', stderr: 'pipe' });
  const stdoutPromise = new Response(proc.stdout).text();
  const stderrPromise = new Response(proc.stderr).text();
  let timedOut = false;
  const timeoutHandle = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, timeoutMs);
  let exitCode = 1;
  try {
    exitCode = await proc.exited;
  } finally {
    clearTimeout(timeoutHandle);
  }
  const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
  const output = [stdout.trim(), stderr.trim()].filter(Boolean).join('\n');
  return { success: !timedOut && exitCode === 0, output, timedOut, exitCode };
}

function isSafeHead(head: string): boolean {
  return /^[0-9a-f]{4,64}$/i.test(head.trim());
}

async function resolveHead(dir: string, jobHead?: string): Promise<string | undefined> {
  if (jobHead !== undefined) {
    const h = jobHead.trim();
    return h !== '' && isSafeHead(h) ? h : undefined;
  }
  try {
    const r = await runShellCommand(dir, 'git rev-parse HEAD', 15000);
    const h = (r.output.trim().split('\n', 1)[0] ?? '').trim();
    return isSafeHead(h) ? h : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Run testCommand in a tmp snapshot of the committed (or hash-verified
 * copied) inputs and refuse attribution when the original OR the executed
 * snapshot copy was touched during the run. The snapshot dir is removed
 * afterwards unless keepSnapshotDir.
 *
 * A: snapshot-local swap+restore (write evil, import it, restore) changes
 * ctime even when hash+mtime are forged back, so it fails instead of
 * passing. Snapshot protected inputs are hardened read-only best-effort;
 * a chmod bypass still bumps ctime and fails. Untracked dist/build/coverage
 * outputs stay writable (not in protectedPaths). Missing node_modules in
 * the copy is a test failure (success false), never a PASS.
 */
export async function runTestsOnImmutableSnapshot(
  options: ImmutableSnapshotOptions,
): Promise<ImmutableSnapshotResult> {
  if (options.testCommand.trim() === '') throw new Error('testCommand must not be empty');
  const protectedPaths = protectedScopePaths(options.scopePaths, options.isTracked);
  const before = new Map<string, StrictSnapshot>();
  for (const rel of protectedPaths) before.set(rel, snapshotStrict(options.dir, rel));

  const snapshotDir = mkdtempSync(join(tmpdir(), 'mc-snap-'));
  const cleanup = (): void => {
    if (options.keepSnapshotDir === true) return;
    try {
      rmSync(snapshotDir, { recursive: true, force: true });
    } catch {
      // Best-effort temp cleanup; the verdict is already decided.
    }
  };

  let test: { success: boolean; output: string; timedOut: boolean };
  let racedCopy: string | undefined;
  const snapBefore = new Map<string, StrictSnapshot>();
  try {
    const head = await resolveHead(options.dir, options.jobHead);
    let materialized = false;
    if (head !== undefined) {
      // Committed bytes: working-tree dirt present before/during the run
      // cannot taint the executed tree.
      const archived = await runShellCommand(
        options.dir,
        `git archive ${head} | tar -x -C ${shQuote(snapshotDir)}`,
        120000,
      );
      materialized = archived.success;
    }
    if (!materialized) {
      const copied = await runShellCommand(
        options.dir,
        `cp -a ${shQuote(options.dir)}/. ${shQuote(snapshotDir)}/ && rm -rf ${shQuote(snapshotDir)}/.git`,
        180000,
      );
      if (!copied.success) throw new Error(`immutable snapshot copy failed: ${copied.output}`);
      // Copy of the inputs with hash: fail when the copy raced a mutation.
      for (const rel of protectedPaths) {
        const b = before.get(rel);
        if (b === undefined || !b.identity.exists) continue;
        const liveSrc = snapshotStrict(options.dir, rel);
        const liveSnap = snapshotStrict(snapshotDir, rel);
        if (liveSnap.identity.hash !== b.identity.hash || liveSrc.identity.hash !== b.identity.hash) {
          racedCopy = rel;
          break;
        }
      }
    }
    // Harden executed inputs read-only best-effort (defense in depth; the
    // ctime after-compare below is the proof, even as root or after chmod).
    for (const rel of protectedPaths) {
      try {
        chmodSync(join(snapshotDir, rel), ENFORCED_MODE);
      } catch {
        // Best-effort: missing/allowed outputs stay as-is; detection applies.
      }
    }
    for (const rel of protectedPaths) snapBefore.set(rel, snapshotStrict(snapshotDir, rel));
    // Shared env prep (F): deps symlinked/installed INTO the copy, never
    // mutating the attributed original. Impossible prep → env-failure that
    // fails closed (success false, ENV-UNPREPARED), never pass/skip.
    // Never versions node_modules (symlink only, no git add).
    let envPrep: { status: 'ready' | 'failed' | 'env-failure'; commands: string[]; output: string } | null = null;
    try {
      const { prepareTestEnv } = await import('./test-env.js');
      envPrep = await prepareTestEnv({
        snapshotDir,
        sourceDir: options.dir,
        ...(options.setupCommands ? { setupCommands: options.setupCommands } : {}),
        timeoutMs: options.timeoutMs ?? 120000,
      });
    } catch {
      envPrep = null;
    }
    test =
      racedCopy !== undefined
        ? { success: false, output: '', timedOut: false }
        : envPrep !== null && (envPrep.status === 'env-failure' || envPrep.status === 'failed')
          ? { success: false, output: envPrep.output, timedOut: false }
          : await runShellCommand(snapshotDir, options.testCommand, options.timeoutMs ?? 120000);
    // F parity: undeclared missing dep (no manifest entry, no lockfile to
    // install from) surfaces as MODULE_NOT_FOUND after the run. Convert to
    // env-failure with ENV-UNPREPARED (fail-closed, never pass/skip), preserving
    // toctou-style tests that need no deps (their output is identity-based).
    // Only bare (external) specifiers convert: relative/absolute requires are
    // genuine code bugs and stay test failures.
    if (test.success === false && test.timedOut === false && test.output) {
      const missingDep = /Cannot find module|MODULE_NOT_FOUND/i.test(test.output);
      if (missingDep) {
        try {
          const { ENV_UNPREPARED, isExternalMissingModule } = await import('./test-env.js');
          if (!test.output.includes('ENV-UNPREPARED') && isExternalMissingModule(test.output)) {
            test = { success: false, output: `${ENV_UNPREPARED}\n${test.output}`, timedOut: false };
          }
        } catch {}
      }
    }
  } catch (err) {
    cleanup();
    throw err;
  }

  const beforeIds: Record<string, FileIdentity> = {};
  const afterIds: Record<string, FileIdentity> = {};
  const ctimeHits: string[] = [];
  for (const rel of protectedPaths) {
    const b = before.get(rel);
    if (b === undefined) continue;
    beforeIds[rel] = b.identity;
    const live = snapshotStrict(options.dir, rel);
    afterIds[rel] = live.identity;
    if (
      b.identity.exists &&
      live.identity.exists &&
      b.ctimeMs >= 0 &&
      live.ctimeMs >= 0 &&
      b.ctimeMs !== live.ctimeMs
    ) {
      ctimeHits.push(rel);
    }
  }
  const snapBeforeIds: Record<string, FileIdentity> = {};
  const snapAfterIds: Record<string, FileIdentity> = {};
  const snapCtimeHits: string[] = [];
  for (const rel of protectedPaths) {
    const b = snapBefore.get(rel);
    if (b === undefined) continue;
    const liveSnap = snapshotStrict(snapshotDir, rel);
    // Unversioned dist/build outputs are writable: a file absent from the
    // committed snapshot (not in git archive) that appears afterwards is a
    // legit build output, never a protected input. Versioned dist/build
    // exists in snapBefore, so it stays protected and blocks attribution.
    // shortcut: when tracking is unknown (isTracked undefined) archive
    // absence is the versioned proof; upgrade to explicit isTracked when
    // stricter fail-closed is needed.
    if (!b.identity.exists && DIST_BUILD_PREFIX.test(rel)) continue;
    snapBeforeIds[rel] = b.identity;
    snapAfterIds[rel] = liveSnap.identity;
    if (
      b.identity.exists &&
      liveSnap.identity.exists &&
      b.ctimeMs >= 0 &&
      liveSnap.ctimeMs >= 0 &&
      b.ctimeMs !== liveSnap.ctimeMs
    ) {
      snapCtimeHits.push(rel);
    }
  }
  const decideWithCtime = (
    bIds: Record<string, FileIdentity>,
    aIds: Record<string, FileIdentity>,
    hits: string[],
    where: 'original' | 'snapshot',
  ): IdentityVerdict => {
    if (hits.length > 0) {
      const contentVerdict = decideIdentityVerdict(bIds, aIds, []);
      if (contentVerdict.verdict === 'fail') return contentVerdict;
      const names = [...hits].sort().join(', ');
      return {
        verdict: 'fail',
        reason: `identity refused: ${where} input restored after write during run (${names}, content identical but ctime changed — A→B→A with mtime forgery detected)`,
      };
    }
    return decideIdentityVerdict(bIds, aIds, []);
  };
  let decided: IdentityVerdict;
  if (racedCopy !== undefined) {
    decided = {
      verdict: 'fail',
      reason: `identity refused: snapshot copy raced a concurrent mutation (${racedCopy}) — executed bytes may differ from snapshotted bytes`,
    };
  } else {
    const snapDecided = decideWithCtime(snapBeforeIds, snapAfterIds, snapCtimeHits, 'snapshot');
    if (snapDecided.verdict === 'fail') {
      decided = snapDecided;
    } else {
      decided = decideWithCtime(beforeIds, afterIds, ctimeHits, 'original');
    }
  }
  cleanup();
  return {
    ...decided,
    success: test.success,
    output: test.output,
    timedOut: test.timedOut,
    snapshotDir,
    protectedPaths,
  };
}
