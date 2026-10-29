import { homedir } from 'os';
import { basename, join, resolve, dirname, isAbsolute } from 'path';
import { realpathSync } from 'node:fs';
import { AsyncLocalStorage } from 'node:async_hooks';
import { gitCommand } from './git';

const XDG_DATA_DIR = join(
  homedir(),
  '.local',
  'share',
  'opencode-mission-control',
);

export function getXdgDataDir(): string {
  // Test override: MC_XDG_DATA_DIR points state at a temp dir without mocking.
  const override = process.env.MC_XDG_DATA_DIR?.trim();
  if (override) return override;
  return XDG_DATA_DIR;
}

/**
 * Explicit repo-root scope for the whole run (F02).
 * All state helpers (getProjectId/getDataDir) and all git helpers that
 * accept a cwd must resolve through this scope first, so starting from a
 * third folder with --repo A never touches the launcher's state/branches.
 * AsyncLocalStorage keeps concurrent runs isolated without chdir/global.
 */
const repoRootStore = new AsyncLocalStorage<string>();

export function getActiveRepoRoot(): string | undefined {
  return repoRootStore.getStore();
}

export async function withRepoRoot<T>(repoRoot: string | undefined, fn: () => Promise<T> | T): Promise<T> {
  const normalized = repoRoot ? canonicalizePath(repoRoot) : undefined;
  if (!normalized) return await fn();
  return await repoRootStore.run(normalized, fn);
}

export function canonicalizePath(p: string): string {
  const absolute = isAbsolute(p) ? p : resolve(process.cwd(), p);
  try {
    // realpath resolves symlinks (/tmp on macOS, etc.) so the same repo
    // always maps to the same canonical path regardless of entry.
    return realpathSync(absolute);
  } catch {
    return resolve(absolute);
  }
}

/** Resolve --repo (or active scope, or cwd) to a canonical absolute path. */
export function resolveRepoRoot(input?: string): string {
  const raw = input ?? getActiveRepoRoot() ?? process.cwd();
  return canonicalizePath(raw);
}

function projectIdForCanonical(canonical: string, base: string): string {
  // Bun.hash is deterministic (no crypto mock interference in workflow tests).
  const hash = Bun.hash(canonical).toString(16).padStart(16, '0').slice(0, 12);
  const safeBase = base.replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 64) || 'repo';
  return `${safeBase}-${hash}`;
}

export async function getProjectId(cwd?: string): Promise<string> {
  // Explicit repo scope first (F02): cwd param wins, then active scope, then process cwd.
  // Never depend on bare cwd when a --repo was given.
  const effective = cwd ?? getActiveRepoRoot() ?? process.cwd();
  // --git-common-dir returns the shared .git dir across all worktrees,
  // so we always resolve to the same project ID regardless of which worktree we're in.
  // In worktrees it returns a path like: /repo/.git/worktrees/<name> (absolute or relative)
  // In the main worktree it returns: .git (or /repo/.git)
  const commonDirResult = await gitCommand(['rev-parse', '--git-common-dir'], { cwd: effective });

  if (commonDirResult.exitCode === 0) {
    let commonDir = commonDirResult.stdout;

    if (!commonDir.startsWith('/')) {
      const toplevelResult = await gitCommand(['rev-parse', '--show-toplevel'], { cwd: effective });
      if (toplevelResult.exitCode === 0) {
        commonDir = resolve(toplevelResult.stdout, commonDir);
      }
    }

    // Strip /worktrees/<name> suffix for linked worktrees, then go up from .git to repo root
    const gitDir = commonDir.replace(/\/worktrees\/[^/]+$/, '');
    const repoRoot = dirname(gitDir);
    const canonical = canonicalizePath(repoRoot);
    // Collision-resistant: canonical path hash, not only basename.
    return projectIdForCanonical(canonical, basename(canonical));
  }

  const result = await gitCommand(['rev-parse', '--show-toplevel'], { cwd: effective });

  if (result.exitCode !== 0) {
    const canonical = canonicalizePath(effective);
    return projectIdForCanonical(canonical, basename(canonical));
  }

  const canonical = canonicalizePath(result.stdout);
  return projectIdForCanonical(canonical, basename(canonical));
}

export async function getDataDir(cwd?: string): Promise<string> {
  const effective = cwd ?? getActiveRepoRoot() ?? process.cwd();
  const projectId = await getProjectId(effective);
  const dir = join(getXdgDataDir(), projectId, 'state');
  const fs = await import('fs');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
