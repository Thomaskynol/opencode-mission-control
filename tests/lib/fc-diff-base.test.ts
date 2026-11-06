import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { join } from 'path';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import * as jobState from '../../src/lib/job-state';
import * as paths from '../../src/lib/paths';
import type { Job } from '../../src/lib/job-state';
import { syncWorktree } from '../../src/lib/worktree';
import { validateTouchSet } from '../../src/lib/merge-train';
import {
  createIntegrationBranch,
  refreshIntegrationFromMain,
} from '../../src/lib/integration';

const { mc_diff } = await import('../../src/tools/diff');

const mockContext = {
  sessionID: 'test-session',
  messageID: 'test-message',
  agent: 'test-agent',
  directory: '/test/dir',
  worktree: '/test/worktree',
  abort: new AbortController().signal,
  metadata: vi.fn(),
  ask: vi.fn(),
} as any;

function git(args: string[], cwd: string) {
  const proc = Bun.spawn(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  return (async () => {
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const exitCode = await proc.exited;
    return { stdout: stdout.trim(), stderr: stderr.trim(), exitCode };
  })();
}

async function mustGit(args: string[], cwd: string): Promise<void> {
  const r = await git(args, cwd);
  if (r.exitCode !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
}

async function initRepo(dir: string, branch: string): Promise<void> {
  mkdirSync(dir, { recursive: true });
  await mustGit(['init', '-b', branch], dir);
  await mustGit(['config', 'user.email', 't@t.t'], dir);
  await mustGit(['config', 'user.name', 'T'], dir);
}

function mockJob(overrides: Partial<Job>): void {
  vi.spyOn(jobState, 'getJobByName').mockResolvedValue({
    id: 'fc-job',
    name: 'fc-job',
    worktreePath: '/unused',
    branch: 'feat',
    tmuxTarget: 'mc-fc',
    placement: 'session',
    status: 'running',
    prompt: 'fc',
    mode: 'vanilla',
    createdAt: new Date().toISOString(),
    ...overrides,
  } as Job);
}

describe('lane FC: mc_diff base correta', () => {
  let root: string;
  let originalCwd: string;

  beforeEach(() => {
    originalCwd = process.cwd();
    root = mkdtempSync(join(tmpdir(), 'mc-fc-test-'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    try {
      process.chdir(originalCwd);
    } catch {}
    rmSync(root, { recursive: true, force: true });
  });

  it('sem remote usa base local em vez de falhar com exit 128', async () => {
    const repo = join(root, 'noremote');
    await initRepo(repo, 'main');
    writeFileSync(join(repo, 'f.txt'), 'base\n');
    await mustGit(['add', '.'], repo);
    await mustGit(['commit', '-m', 'init'], repo);
    await mustGit(['checkout', '-b', 'feat'], repo);
    writeFileSync(join(repo, 'f.txt'), 'changed\n');
    await mustGit(['commit', '-am', 'feat'], repo);

    mockJob({ worktreePath: repo, branch: 'feat' });
    const out = await mc_diff.execute({ name: 'fc-job' }, mockContext);
    expect(out).toContain('changed');
  });

  it('default≠main (master) resolve certo sem remote', async () => {
    const repo = join(root, 'masterdef');
    await initRepo(repo, 'master');
    writeFileSync(join(repo, 'f.txt'), 'base\n');
    await mustGit(['add', '.'], repo);
    await mustGit(['commit', '-m', 'init'], repo);
    await mustGit(['checkout', '-b', 'feat'], repo);
    writeFileSync(join(repo, 'f.txt'), 'feat-change\n');
    await mustGit(['commit', '-am', 'feat'], repo);

    mockJob({ worktreePath: repo, branch: 'feat' });
    const out = await mc_diff.execute({ name: 'fc-job' }, mockContext);
    expect(out).toContain('feat-change');
  });

  it('destino explícito (job.baseBranch) é respeitado', async () => {
    const repo = join(root, 'explicit');
    await initRepo(repo, 'main');
    writeFileSync(join(repo, 'a.txt'), 'a\n');
    await mustGit(['add', '.'], repo);
    await mustGit(['commit', '-m', 'init'], repo);
    await mustGit(['checkout', '-b', 'trunk'], repo);
    writeFileSync(join(repo, 'b.txt'), 'trunk-only\n');
    await mustGit(['add', '.'], repo);
    await mustGit(['commit', '-m', 'trunk'], repo);
    await mustGit(['checkout', '-b', 'feat', 'trunk'], repo);
    writeFileSync(join(repo, 'c.txt'), 'feat-only\n');
    await mustGit(['add', '.'], repo);
    await mustGit(['commit', '-m', 'feat'], repo);

    mockJob({ worktreePath: repo, branch: 'feat', baseBranch: 'trunk' });
    const out = await mc_diff.execute({ name: 'fc-job' }, mockContext);
    expect(out).toContain('c.txt');
    expect(out).not.toContain('b.txt');
  });

  it('ambiguidade (base inexistente) → erro explícito, nunca escolha silenciosa', async () => {
    const repo = join(root, 'ambiguous');
    await initRepo(repo, 'trunk');
    writeFileSync(join(repo, 'f.txt'), 'x\n');
    await mustGit(['add', '.'], repo);
    await mustGit(['commit', '-m', 'init'], repo);
    await mustGit(['checkout', '-b', 'feat'], repo);

    // Base explícita inexistente: erro deve nomear a base.
    mockJob({ worktreePath: repo, branch: 'feat', baseBranch: 'no-such-base' });
    await expect(mc_diff.execute({ name: 'fc-job' }, mockContext)).rejects.toThrow(
      /no-such-base/,
    );

    // Sem base e sem main/master/remote: nada a adivinhar — erro claro, não diff vazio.
    mockJob({ worktreePath: repo, branch: 'feat' });
    await expect(mc_diff.execute({ name: 'fc-job' }, mockContext)).rejects.toThrow(
      /base/i,
    );
  });

  it('syncWorktree: sem remote + source padrão usa base local (sem fetch)', async () => {
    const repo = join(root, 'synclocal');
    await initRepo(repo, 'main');
    writeFileSync(join(repo, 'f.txt'), 'base\n');
    await mustGit(['add', '.'], repo);
    await mustGit(['commit', '-m', 'init'], repo);
    await mustGit(['checkout', '-b', 'feat'], repo);
    writeFileSync(join(repo, 'f.txt'), 'feat\n');
    await mustGit(['commit', '-am', 'feat'], repo);

    const result = await syncWorktree(repo, 'rebase', 'main');
    expect(result.success).toBe(true);
  });

  it('syncWorktree: default branch resolvido no repo alvo, não no cwd', async () => {
    const cwdRepo = join(root, 'cwdrepo');
    await initRepo(cwdRepo, 'main');
    writeFileSync(join(cwdRepo, 'f.txt'), 'x\n');
    await mustGit(['add', '.'], cwdRepo);
    await mustGit(['commit', '-m', 'init'], cwdRepo);

    const target = join(root, 'targetrepo');
    await initRepo(target, 'master');
    writeFileSync(join(target, 'f.txt'), 'base\n');
    await mustGit(['add', '.'], target);
    await mustGit(['commit', '-m', 'init'], target);
    await mustGit(['checkout', '-b', 'feat'], target);
    writeFileSync(join(target, 'f.txt'), 'feat\n');
    await mustGit(['commit', '-am', 'feat'], target);

    process.chdir(cwdRepo);
    const result = await syncWorktree(target, 'rebase');
    expect(result.success).toBe(true);
  });

  it('refreshIntegrationFromMain: sem remote usa base local', async () => {
    const repo = join(root, 'refreshlocal');
    await initRepo(repo, 'main');
    writeFileSync(join(repo, 'f.txt'), 'v1\n');
    await mustGit(['add', '.'], repo);
    await mustGit(['commit', '-m', 'init'], repo);

    const xdg = join(root, '.xdg');
    mkdirSync(xdg, { recursive: true });
    vi.spyOn(paths, 'getProjectId').mockResolvedValue('fc-proj');
    vi.spyOn(paths, 'getXdgDataDir').mockReturnValue(xdg);

    const planId = 'fc-plan-1';
    const created = await createIntegrationBranch(planId, undefined, undefined, repo);

    writeFileSync(join(repo, 'f.txt'), 'v2\n');
    await mustGit(['commit', '-am', 'main moves'], repo);

    const result = await refreshIntegrationFromMain(planId, repo);
    expect(result.success).toBe(true);
    expect(readFileSync(join(created.worktreePath, 'f.txt'), 'utf-8')).toContain('v2');
  });

  it('validateTouchSet: base vazia → violação explícita, nunca diff silencioso', async () => {
    const repo = join(root, 'touchset');
    await initRepo(repo, 'main');
    writeFileSync(join(repo, 'f.txt'), 'x\n');
    await mustGit(['add', '.'], repo);
    await mustGit(['commit', '-m', 'init'], repo);
    await mustGit(['checkout', '-b', 'feat'], repo);

    const result = await validateTouchSet('feat', '', ['src/**'], { cwd: repo });
    expect(result.valid).toBe(false);
    expect(result.violations!.join('\n')).toMatch(/explicit/i);
  });
});
