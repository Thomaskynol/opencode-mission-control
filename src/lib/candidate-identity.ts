import { createHash } from 'crypto';
import { chmodSync, lstatSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, isAbsolute, join, resolve } from 'path';
import type { EnvPreparation } from './test-env.js';

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

interface ResolvedFile {
  bytes: Buffer;
  mtimeMs: number;
  ctimeMs: number;
  size: number;
}

/**
 * P3: bytes effectively executed through a symlink (null when the target is
 * not a readable regular file — dangling, dir, loop, permission). Callers
 * fall back to the target-string identity in that case (a dangling link
 * cannot execute bytes; a swapped target still changes link ctime).
 */
function readResolvedFile(absLink: string, target: string): ResolvedFile | null {
  try {
    const real = realpathSync(resolve(dirname(absLink), target));
    const rst = lstatSync(real);
    if (!rst.isFile()) return null;
    const bytes = readFileSync(real);
    return {
      bytes,
      mtimeMs: rst.mtimeMs,
      ctimeMs: typeof rst.ctimeMs === 'number' ? rst.ctimeMs : -1,
      size: rst.size,
    };
  } catch {
    return null;
  }
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
      // P3: bind the bytes effectively executed, not just the target string —
      // a write through the link into external bytes must change the identity.
      const eff = readResolvedFile(join(dir, rel), target);
      if (eff) {
        return {
          identity: { hash: sha256Hex(Buffer.concat([Buffer.from(`symlink:${target}\0`), eff.bytes])), mtimeMs: eff.mtimeMs, size: eff.size, exists: true },
          mode: st.mode & 0o777,
        };
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
  /**
   * Test-only seam: replaces the shared prepareTestEnv call so preparation
   * outcomes that cannot occur naturally (e.g. prepare throwing) can be
   * exercised. A throwing override fails closed exactly like a throwing
   * prepare. Production callers omit it.
   */
  envPrepOverride?: (opts: {
    snapshotDir: string;
    sourceDir: string;
    setupCommands?: string[];
    timeoutMs?: number;
  }) => Promise<EnvPreparation>;
}

export interface ImmutableSnapshotResult extends IdentityVerdict {
  /** Test command outcome inside the snapshot (independent of the verdict). */
  success: boolean;
  output: string;
  timedOut: boolean;
  snapshotDir: string;
  protectedPaths: string[];
  /**
   * Fingerprint of the executed dependency tree (snapshot node_modules
   * content + manifest/lockfile hashes). Binds the verdict to what actually
   * ran: adulterated deps at test time change the tree and refuse attribution.
   */
  depFingerprint: string;
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
      // P3: bind the bytes effectively executed (see snapshotOne). ctime is
      // the max of link and target: replacing the link or writing the target
      // both bump it, so a forged-mtime restore still differs.
      const eff = readResolvedFile(join(dir, rel), target);
      if (eff) {
        return {
          identity: { hash: sha256Hex(Buffer.concat([Buffer.from(`symlink:${target}\0`), eff.bytes])), mtimeMs: eff.mtimeMs, size: eff.size, exists: true },
          ctimeMs: Math.max(typeof st.ctimeMs === 'number' ? st.ctimeMs : -1, eff.ctimeMs),
        };
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

interface DepEntry {
  kind: 'file' | 'link' | 'other';
  hash: string;
  mtimeMs: number;
  ctimeMs: number;
  size: number;
  /** Absolute real path the link resolves to ('' when dangling/unreadable). */
  resolved?: string;
  /** Content fingerprint of the resolved file: the bytes effectively executed. */
  targetHash?: string;
  targetMtimeMs?: number;
  targetCtimeMs?: number;
  targetSize?: number;
}

/** Cap on files enumerated through a single dir link (absurd-tree guard). */
const MAX_DEP_LINK_FILES = 4000;

/**
 * P3: record one symlink's effective bytes. File targets bind content bytes
 * (+target times, so a forged-mtime restore still differs via target ctime).
 * Dir targets enumerate effective files under the link path (cycle-guarded,
 * capped) so a write through the link — inside or outside the tree — changes
 * the tree even when the link string itself is untouched.
 */
function recordDepLink(
  out: Map<string, DepEntry>,
  absLink: string,
  rel: string,
  seen: Set<string>,
  counter: { n: number },
): void {
  let target = '';
  try {
    target = readlinkSync(absLink);
  } catch {
    out.set(rel, { kind: 'link', hash: sha256Hex(Buffer.from('symlink:')), mtimeMs: 0, ctimeMs: -1, size: -1, resolved: '' });
    return;
  }
  let st;
  try {
    st = lstatSync(absLink);
  } catch {
    return;
  }
  const ctimeMs = typeof st.ctimeMs === 'number' ? st.ctimeMs : -1;
  const entry: DepEntry = {
    kind: 'link',
    hash: sha256Hex(Buffer.from(`symlink:${target}`)),
    mtimeMs: st.mtimeMs,
    ctimeMs,
    size: st.size,
  };
  let real = '';
  try {
    real = realpathSync(resolve(dirname(absLink), target));
    entry.resolved = real;
  } catch {
    entry.resolved = '';
    out.set(rel, entry);
    return;
  }
  let rst;
  try {
    rst = lstatSync(real);
  } catch {
    entry.resolved = '';
    out.set(rel, entry);
    return;
  }
  if (rst.isFile()) {
    try {
      const bytes = readFileSync(real);
      entry.targetHash = sha256Hex(bytes);
      entry.targetMtimeMs = rst.mtimeMs;
      entry.targetCtimeMs = typeof rst.ctimeMs === 'number' ? rst.ctimeMs : -1;
      entry.targetSize = rst.size;
    } catch {
      entry.resolved = '';
    }
    out.set(rel, entry);
    return;
  }
  out.set(rel, entry);
  if (!rst.isDirectory()) return;
  collectDepDir(out, real, rel, seen, counter);
}

function collectDepDir(
  out: Map<string, DepEntry>,
  absDir: string,
  prefix: string,
  seen: Set<string>,
  counter: { n: number },
): void {
  let real: string;
  try {
    real = realpathSync(absDir);
  } catch {
    return;
  }
  if (seen.has(real)) return;
  seen.add(real);
  let dirents: Array<{ name: string }>;
  try {
    dirents = readdirSync(absDir, { withFileTypes: true }) as Array<{ name: string }>;
  } catch {
    return;
  }
  for (const d of dirents) {
    if (counter.n > MAX_DEP_LINK_FILES) {
      out.set(`${prefix}/…truncated`, { kind: 'other', hash: `truncated:${counter.n}`, mtimeMs: 0, ctimeMs: -1, size: counter.n });
      return;
    }
    const sub = `${prefix}/${d.name}`;
    const full = join(absDir, d.name);
    try {
      const st = lstatSync(full);
      const ctimeMs = typeof st.ctimeMs === 'number' ? st.ctimeMs : -1;
      if (st.isSymbolicLink()) {
        recordDepLink(out, full, sub, seen, counter);
      } else if (st.isDirectory()) {
        collectDepDir(out, full, sub, seen, counter);
      } else if (st.isFile()) {
        counter.n += 1;
        out.set(sub, { kind: 'file', hash: sha256Hex(readFileSync(full)), mtimeMs: st.mtimeMs, ctimeMs, size: st.size });
      } else {
        out.set(sub, { kind: 'other', hash: '', mtimeMs: st.mtimeMs, ctimeMs, size: st.size });
      }
    } catch {
      // Unreadable entry: skip (absence/change surfaces via the rest).
    }
  }
}

/**
 * Snapshot the dependency tree under dir/node_modules (rel path → entry).
 * A content-identical restore still bumps ctime, so hash+mtime+ctime all
 * participate in the after-compare. Missing node_modules → empty map.
 */
function snapshotDepTree(dir: string): Map<string, DepEntry> {
  const out = new Map<string, DepEntry>();
  const base = join(dir, 'node_modules');
  try {
    const st = lstatSync(base);
    if (st.isSymbolicLink()) {
      let target = '';
      try {
        target = readlinkSync(base);
      } catch {}
      out.set('.', {
        kind: 'link',
        hash: sha256Hex(Buffer.from(`symlink:${target}`)),
        mtimeMs: st.mtimeMs,
        ctimeMs: typeof st.ctimeMs === 'number' ? st.ctimeMs : -1,
        size: st.size,
      });
      return out;
    }
    if (!st.isDirectory()) return out;
  } catch {
    return out;
  }
  const stack: string[] = [''];
  while (stack.length > 0) {
    const rel = stack.pop() as string;
    const full = rel === '' ? base : join(base, rel);
    let dirents: Array<{ name: string }>;
    try {
      dirents = readdirSync(full, { withFileTypes: true }) as Array<{ name: string }>;
    } catch {
      continue;
    }
    for (const d of dirents) {
      const r = rel === '' ? d.name : `${rel}/${d.name}`;
      const f = join(base, r);
      try {
        const st = lstatSync(f);
        const ctimeMs = typeof st.ctimeMs === 'number' ? st.ctimeMs : -1;
        if (st.isSymbolicLink()) {
          // P3: bind effective bytes, not just the target string (fresh
          // cycle guard per top-level link; loops resolve to dangling).
          recordDepLink(out, f, r, new Set<string>(), { n: 0 });
        } else if (st.isDirectory()) {
          stack.push(r);
        } else if (st.isFile()) {
          out.set(r, { kind: 'file', hash: sha256Hex(readFileSync(f)), mtimeMs: st.mtimeMs, ctimeMs, size: st.size });
        } else {
          out.set(r, { kind: 'other', hash: '', mtimeMs: st.mtimeMs, ctimeMs, size: st.size });
        }
      } catch {
        // Unreadable entry: skip (absence/change surfaces via the rest).
      }
    }
  }
  return out;
}

/** Compare two dep trees; returns changed rel paths (sorted, capped). */
function compareDepTrees(before: Map<string, DepEntry>, after: Map<string, DepEntry>, cap = 8): string[] {
  const hits: string[] = [];
  const keys = new Set([...before.keys(), ...after.keys()]);
  for (const key of keys) {
    const b = before.get(key);
    const a = after.get(key);
    if (b === undefined || a === undefined) {
      hits.push(key);
      continue;
    }
    // P3: resolved/target fields bind the bytes effectively executed — a
    // write through the link (even restored with forged mtime) differs via
    // target content/ctime; a swapped target differs via resolved.
    if (
      b.kind !== a.kind ||
      b.hash !== a.hash ||
      b.mtimeMs !== a.mtimeMs ||
      b.ctimeMs !== a.ctimeMs ||
      b.size !== a.size ||
      (b.resolved ?? '') !== (a.resolved ?? '') ||
      (b.targetHash ?? '') !== (a.targetHash ?? '') ||
      (b.targetMtimeMs ?? -1) !== (a.targetMtimeMs ?? -1) ||
      (b.targetCtimeMs ?? -1) !== (a.targetCtimeMs ?? -1) ||
      (b.targetSize ?? -1) !== (a.targetSize ?? -1)
    ) {
      hits.push(key);
    }
  }
  hits.sort();
  return hits.length > cap ? [...hits.slice(0, cap), `…+${hits.length - cap} more`] : hits;
}

/**
 * Fingerprint of what the test executed: manifest+lockfile bytes plus the
 * full snapshot node_modules tree (paths + content hashes + times). Recorded
 * on every run so a pass is bound to the executed bytes, not just the commit.
 */
function fingerprintDeps(dir: string, tree: Map<string, DepEntry>): string {
  const h = createHash('sha256');
  for (const name of ['package.json', 'bun.lockb', 'bun.lock', 'pnpm-lock.yaml', 'yarn.lock', 'package-lock.json', 'npm-shrinkwrap.json']) {
    try {
      h.update(`\0${name}\0`);
      h.update(readFileSync(join(dir, name)));
    } catch {
      h.update(`\0${name}:absent\0`);
    }
  }
  const keys = [...tree.keys()].sort();
  h.update(`\0tree:${keys.length}\0`);
  for (const k of keys) {
    const e = tree.get(k) as DepEntry;
    h.update(`\0${k}\0${e.kind}\0${e.hash}\0${e.mtimeMs}\0${e.ctimeMs}\0${e.size}\0${e.resolved ?? ''}\0${e.targetHash ?? ''}\0${e.targetMtimeMs ?? -1}\0${e.targetCtimeMs ?? -1}\0${e.targetSize ?? -1}\0`);
  }
  return h.digest('hex');
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
 * outputs stay writable (not in protectedPaths). Deps are a PHYSICAL COPY
 * (never a symlink to the origin); the executed tree is fingerprinted
 * (depFingerprint) and any change during the run — or any write leaking
 * into the ORIGINAL node_modules — refuses attribution. Inconclusive
 * preparation (exception/failed/timeout/missing dep) never runs the test
 * and yields success false + verdict fail with ENV-UNPREPARED.
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
  let envBlock: string | undefined;
  let originDepsBefore = new Map<string, DepEntry>();
  let snapDepsBefore = new Map<string, DepEntry>();
  let depFingerprint = '';
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
    // Shared env prep (F): deps COPIED/installed INTO the copy, never
    // mutating the attributed original and never linked to it. Inconclusive
    // preparation (exception, failed, timeout, missing dep with no install
    // path) is an explicit env-failure: the test does NOT run, success is
    // false, and the verdict is fail (R4 — never pass/skip).
    // Never versions node_modules (copy only, no git add).
    let envMarker = 'ENV-UNPREPARED';
    let envPrep: EnvPreparation | null = null;
    try {
      const mod = await import('./test-env.js');
      if (typeof mod.ENV_UNPREPARED === 'string' && (mod.ENV_UNPREPARED as string).length > 0) envMarker = mod.ENV_UNPREPARED;
      const prepFn = options.envPrepOverride ?? mod.prepareTestEnv;
      envPrep = await prepFn({
        snapshotDir,
        sourceDir: options.dir,
        ...(options.setupCommands ? { setupCommands: options.setupCommands } : {}),
        timeoutMs: options.timeoutMs ?? 120000,
      });
    } catch (err) {
      // R4: a throwing prepare used to zero envPrep and STILL run the test,
      // turning setup failure into PASS. Fail closed instead.
      envPrep = {
        status: 'env-failure',
        commands: [],
        output: `${envMarker}\nprepare threw: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    const prep = envPrep as EnvPreparation;
    const blockedOutput = prep.output.includes('ENV-UNPREPARED') ? prep.output : `${envMarker}\n${prep.output}`;
    // Fingerprint the ORIGINAL deps too: a test that escapes the snapshot
    // (self-made symlink to the origin) and writes there must refuse
    // attribution even when scope files look clean (R3).
    originDepsBefore = snapshotDepTree(options.dir);
    // What the test is about to execute: physical copy from prep (or a clean
    // install). Recorded even when blocked so the fingerprint binds the run.
    snapDepsBefore = racedCopy === undefined ? snapshotDepTree(snapshotDir) : new Map<string, DepEntry>();
    depFingerprint = fingerprintDeps(snapshotDir, snapDepsBefore);
    envBlock = prep.status !== 'ready' ? blockedOutput : undefined;
    // P3 override-proof gate: even with a custom envPrepOverride, never
    // execute when the snapshot deps escape the copy (absolute/escaping
    // links smuggle external bytes in). prepareTestEnv already refuses this
    // on its own paths; this covers seams that bypass it.
    if (envBlock === undefined && racedCopy === undefined) {
      try {
        const tmod = await import('./test-env.js');
        const bad = tmod.findInsecureDepSymlinks(snapshotDir);
        if (bad.length > 0) {
          envBlock = `${envMarker}\n${tmod.describeInsecureDepSymlinks(bad)}`;
        }
      } catch {}
    }
    test =
      racedCopy !== undefined
        ? { success: false, output: '', timedOut: false }
        : envBlock !== undefined
          ? { success: false, output: envBlock, timedOut: false }
          : await runShellCommand(snapshotDir, options.testCommand, options.timeoutMs ?? 120000);
    // F parity: undeclared missing dep (no manifest entry, no lockfile to
    // install from) surfaces as MODULE_NOT_FOUND after the run. Convert to
    // env-failure with ENV-UNPREPARED (fail-closed, never pass/skip), preserving
    // toctou-style tests that need no deps (their output is identity-based).
    // Only bare (external) specifiers convert: relative/absolute requires are
    // genuine code bugs and stay test failures.
    if (test.success === false && test.timedOut === false && test.output) {
      const missingDep = /Cannot find (?:module|package)|MODULE_NOT_FOUND/i.test(test.output);
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

  // Dep after-compare (R3): the test must not change what it executed
  // (snapshot tree) nor leak a write into the original (origin tree). A
  // content-identical restore still differs via ctime. Skipped only when no
  // test ran (env-block/raced copy already fail). Limit: a legit suite that
  // writes inside node_modules at test time (e.g. a test-runner cache) is
  // indistinguishable from tamper and refuses attribution.
  const snapDepsAfter = envBlock === undefined && racedCopy === undefined ? snapshotDepTree(snapshotDir) : new Map<string, DepEntry>();
  const originDepsAfter = envBlock === undefined && racedCopy === undefined ? snapshotDepTree(options.dir) : new Map<string, DepEntry>();
  const snapDepHits = envBlock === undefined && racedCopy === undefined ? compareDepTrees(snapDepsBefore, snapDepsAfter) : [];
  const originDepHits = envBlock === undefined && racedCopy === undefined ? compareDepTrees(originDepsBefore, originDepsAfter) : [];

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
  } else if (envBlock !== undefined) {
    // R4: preparation never completed, so there is nothing to attribute.
    decided = {
      verdict: 'fail',
      reason: `identity refused: test environment not prepared, test did not run (${envBlock.split('\n', 1)[0]}) — not attributable to the reviewed commit`,
    };
  } else if (originDepHits.length > 0) {
    decided = {
      verdict: 'fail',
      reason: `identity refused: original dependencies mutated during run (${originDepHits.join(', ')}) — pass not attributable to the reviewed commit; depFingerprint ${depFingerprint}`,
    };
  } else if (snapDepHits.length > 0) {
    decided = {
      verdict: 'fail',
      reason: `identity refused: executed dependencies changed during run (${snapDepHits.join(', ')}) — pass not attributable to the reviewed commit; depFingerprint ${depFingerprint}`,
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
    depFingerprint,
  };
}
