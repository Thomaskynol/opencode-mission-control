import { existsSync, lstatSync, rmSync } from 'fs';
import { join } from 'path';

/**
 * Shared test-env preparation (F): one helper used by review-snapshot
 * materialization AND merge-train ensureTestDependencies.
 *
 * Deps are installed/symlinked into a copy, never mutating the attributed
 * original (symlink FROM source TO snapshot; installs run INSIDE the copy).
 * Impossible preparation returns status 'env-failure' with the fixed
 * ENV-UNPREPARED diagnostic that fails closed in both paths (never pass/skip).
 * Never versions node_modules (untracked, gitignored); env errors never pass.
 */
export const ENV_UNPREPARED =
  'ENV-UNPREPARED: test dependencies cannot be prepared (missing node_modules, no lockfile/install command or install failed/offline) — failing closed, never pass/skip';

export type EnvPreparation =
  | { status: 'ready'; commands: string[]; output: string }
  | { status: 'failed'; commands: string[]; output: string }
  | { status: 'env-failure'; commands: string[]; output: string };

const INSTALL_COMMAND_BY_LOCKFILE = [
  { file: 'bun.lockb', command: 'bun install --frozen-lockfile' },
  { file: 'bun.lock', command: 'bun install --frozen-lockfile' },
  { file: 'pnpm-lock.yaml', command: 'pnpm install --frozen-lockfile' },
  { file: 'yarn.lock', command: 'yarn install --frozen-lockfile' },
  { file: 'package-lock.json', command: 'npm ci' },
  { file: 'npm-shrinkwrap.json', command: 'npm ci' },
] as const;

function hasNodeModules(dir: string): boolean {
  try {
    return existsSync(join(dir, 'node_modules'));
  } catch {
    return false;
  }
}

function isSameDir(a: string, b: string): boolean {
  try {
    const { realpathSync } = require('fs') as typeof import('fs');
    return realpathSync(a) === realpathSync(b);
  } catch {
    return a === b;
  }
}

async function runShell(cwd: string, command: string, timeoutMs: number): Promise<{ success: boolean; output: string; timedOut: boolean }> {
  const proc = Bun.spawn(['sh', '-c', command], { cwd, stdout: 'pipe', stderr: 'pipe' });
  const outP = new Response(proc.stdout).text();
  const errP = new Response(proc.stderr).text();
  let timedOut = false;
  const t = setTimeout(() => { timedOut = true; try { proc.kill(); } catch {} }, timeoutMs);
  const code = await proc.exited;
  clearTimeout(t);
  const [out, err] = await Promise.all([outP, errP]);
  const output = [out.trim(), err.trim()].filter(Boolean).join('\n');
  return { success: !timedOut && code === 0, output, timedOut };
}

async function detectInstall(snapshotDir: string): Promise<string | null> {
  try {
    for (const entry of INSTALL_COMMAND_BY_LOCKFILE) {
      if (await Bun.file(join(snapshotDir, entry.file)).exists()) return entry.command;
    }
    const pkgFile = Bun.file(join(snapshotDir, 'package.json'));
    if (!(await pkgFile.exists())) return null;
    const pkg = JSON.parse(await pkgFile.text()) as { packageManager?: string };
    const pm = (pkg.packageManager ?? '').toLowerCase();
    if (pm.startsWith('bun@')) return 'bun install';
    if (pm.startsWith('pnpm@')) return 'pnpm install';
    if (pm.startsWith('yarn@')) return 'yarn install';
    return null;
  } catch {
    return null;
  }
}

/**
 * Prepare deps for running tests in snapshotDir, sourced from sourceDir.
 * Never mutates sourceDir (symlink FROM source, installs INSIDE snapshot).
 * Returns ready when snapshot can run (has node_modules or install ok),
 * else env-failure with ENV-UNPREPARED (fail-closed, never pass/skip).
 */
export async function prepareTestEnv(opts: {
  snapshotDir: string;
  sourceDir: string;
  setupCommands?: string[];
  timeoutMs?: number;
}): Promise<EnvPreparation> {
  const timeoutMs = opts.timeoutMs ?? 120000;
  const { snapshotDir, sourceDir } = opts;
  const setup = (opts.setupCommands ?? []).map((c) => c.trim()).filter(Boolean);
  // Explicit setup commands run first (legacy precedence): they prepare the
  // env themselves; node_modules presence does not skip them.
  // Setup failure is 'failed' (legacy, preserves existing assertions);
  // missing-dep impossibility below is 'env-failure' (F).
  if (setup.length > 0) {
    for (const cmd of setup) {
      const r = await runShell(snapshotDir, cmd, timeoutMs);
      if (!r.success) {
        const why = r.timedOut ? `Dependency setup command timed out after ${timeoutMs}ms` : 'Dependency setup command failed';
        return { status: 'failed', commands: setup, output: `${why} (${cmd})${r.output ? `\n${r.output}` : ''}` };
      }
    }
    return { status: 'ready', commands: setup, output: '' };
  }
  // Already ready in the copy.
  if (hasNodeModules(snapshotDir)) {
    return { status: 'ready', commands: [], output: '' };
  }
  // Symlink untracked deps FROM the original INTO the copy (never the reverse).
  // Never versions node_modules: symlink only, no git add, no copy of tracked bytes.
  if (!isSameDir(snapshotDir, sourceDir) && hasNodeModules(sourceDir)) {
    try {
      const src = join(sourceDir, 'node_modules');
      const dst = join(snapshotDir, 'node_modules');
      // Dangling link cleanup (defense: stale link from prior prep).
      try {
        const st = lstatSync(dst);
        if (st.isSymbolicLink()) rmSync(dst, { force: true });
      } catch {}
      const { symlinkSync } = await import('fs');
      symlinkSync(src, dst, 'dir');
      if (hasNodeModules(snapshotDir)) {
        return { status: 'ready', commands: [], output: '' };
      }
    } catch {
      // Fall through to install path; symlink failure is not a pass.
    }
  }
  const install = await detectInstall(snapshotDir);
  if (!install) {
    // No Node manifest → no deps to prepare (e.g. `true` smoke, mjs checks). Ready.
    // Has manifest but no declared deps → ready (test may not need node_modules;
    // undeclared missing deps surface as MODULE_NOT_FOUND after the run and are
    // converted to env-failure there, preserving toctou-style tests).
    // Only declared-but-missing deps with no install path are env-failure here.
    try {
      const pkgFile = Bun.file(join(snapshotDir, 'package.json'));
      if (!(await pkgFile.exists())) {
        return { status: 'ready', commands: [], output: '' };
      }
      const pkg = JSON.parse(await pkgFile.text()) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
        peerDependencies?: Record<string, string>;
        optionalDependencies?: Record<string, string>;
      };
      const hasDeclared =
        (pkg.dependencies && Object.keys(pkg.dependencies).length > 0) ||
        (pkg.devDependencies && Object.keys(pkg.devDependencies).length > 0) ||
        (pkg.peerDependencies && Object.keys(pkg.peerDependencies).length > 0) ||
        (pkg.optionalDependencies && Object.keys(pkg.optionalDependencies).length > 0);
      if (!hasDeclared) {
        return { status: 'ready', commands: [], output: '' };
      }
    } catch {
      return { status: 'ready', commands: [], output: '' };
    }
    return { status: 'env-failure', commands: [], output: ENV_UNPREPARED };
  }
  // Install INSIDE the copy (snapshotDir), never mutating sourceDir.
  const r = await runShell(snapshotDir, install, timeoutMs);
  if (r.success) {
    return { status: 'ready', commands: [install], output: r.output };
  }
  const why = r.timedOut ? `Dependency install timed out after ${timeoutMs}ms` : 'Dependency install failed';
  return { status: 'env-failure', commands: [install], output: `${ENV_UNPREPARED}\n${why} (${install})${r.output ? `\n${r.output}` : ''}` };
}
