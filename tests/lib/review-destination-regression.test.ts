import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { join } from 'path';
import { tmpdir } from 'os';

async function tempDir(prefix: string): Promise<string> {
  const fs = await import('fs');
  return fs.promises.mkdtemp(join(tmpdir(), prefix));
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const proc = Bun.spawn(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(`git ${args.join(' ')} failed: ${err}`);
  return out.trim();
}

async function mkRepo(prefix: string): Promise<string> {
  const d = await tempDir(prefix);
  await git(d, 'init', '-q');
  await git(d, 'branch', '-M', 'main');
  await git(d, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--allow-empty', '-m', 'init');
  return d;
}

describe('F01 review gate regression (public path, no harness)', () => {
  let repo: string;
  let xdgTmp: string;
  let prevXdg: string | undefined;

  beforeEach(async () => {
    prevXdg = process.env.MC_XDG_DATA_DIR;
    xdgTmp = await tempDir('mc-xdg-f01-');
    process.env.MC_XDG_DATA_DIR = xdgTmp;
    repo = await mkRepo('mc-f01-');
  });

  afterEach(async () => {
    if (prevXdg === undefined) delete process.env.MC_XDG_DATA_DIR;
    else process.env.MC_XDG_DATA_DIR = prevXdg;
    const fs = await import('fs');
    for (const d of [repo, xdgTmp]) try { if (d && fs.existsSync(d)) fs.rmSync(d, { recursive: true, force: true }); } catch {}
  });

  it('echo with anchor is NOT coverage (trivial echo must fail)', async () => {
    const { reviewJob } = await import('../../src/lib/reviewer');
    const verdict = reviewJob({
      jobName: 'echo-job',
      jobBranch: 'feature-echo',
      baseBranch: 'main',
      baseHead: 'base-1',
      jobHead: 'job-1',
      changedFiles: ['src/a.ts'],
      touchSet: ['src/**'],
      requirements: [{ id: 'REQ-1', description: 'does X', testAnchors: ['does X'] }],
      evidence: {
        command: 'echo "does X"',
        exitCode: 0,
        output: 'does X',
        testedCommit: 'job-1',
        environment: 'worktree:/tmp/x (product-executed)',
      },
      claimedPass: true,
    });
    expect(verdict.verdict).toBe('fail');
  });

  it('delivery without execution environment is NOT evidence', async () => {
    const { reviewJob } = await import('../../src/lib/reviewer');
    const verdict = reviewJob({
      jobName: 'noenv-job',
      jobBranch: 'feature-noenv',
      baseBranch: 'main',
      baseHead: 'base-1',
      jobHead: 'job-1',
      changedFiles: ['src/a.ts'],
      requirements: [{ id: 'REQ-1', description: 'does X', testAnchors: ['does X'] }],
      evidence: {
        command: 'bun test',
        exitCode: 0,
        output: 'pass: does X (12 tests)',
        testedCommit: 'job-1',
      } as never,
      claimedPass: true,
    });
    expect(verdict.verdict).toBe('fail');
    expect(verdict.reasons.join('\n')).toMatch(/environment/i);
  });

  it('in-scope delivery, green tests, omitted requirement → rejected', async () => {
    const { reviewJob } = await import('../../src/lib/reviewer');
    const verdict = reviewJob({
      jobName: 'omit-job',
      jobBranch: 'feature-omit',
      baseBranch: 'main',
      baseHead: 'base-1',
      jobHead: 'job-1',
      changedFiles: ['src/a.ts'],
      requirements: [
        { id: 'REQ-COVERED', description: 'covers A', testAnchors: ['covers A'] },
        { id: 'REQ-EMPTY', description: 'covers B', testAnchors: ['covers B'] },
      ],
      evidence: {
        command: 'bun test',
        exitCode: 0,
        output: 'pass: covers A (3 tests)',
        testedCommit: 'job-1',
        environment: 'worktree:/tmp/x (product-executed)',
      },
      claimedPass: true,
    });
    expect(verdict.verdict).toBe('fail');
    expect(verdict.reasons.join('\n')).toMatch(/REQ-EMPTY/);
  });

  it('strict merge-train without test command blocks (never success-skipped)', async () => {
    const fs = await import('fs');
    const { MergeTrain } = await import('../../src/lib/merge-train');
    // Real repo with a job branch and an integration worktree, but NO test command.
    await git(repo, 'checkout', '-b', 'feature-notest', 'main');
    fs.writeFileSync(join(repo, 'notest.txt'), 'x\n');
    await git(repo, 'add', 'notest.txt');
    await git(repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'notest');
    await git(repo, 'checkout', 'main');
    // Ensure no package.json so no test command can be detected.
    try { fs.rmSync(join(repo, 'package.json'), { force: true }); } catch {}
    await git(repo, 'branch', 'integration-f01');
    const wt = join(repo, '..', `mc-f01-wt-${Date.now()}`);
    await git(repo, 'worktree', 'add', wt, 'integration-f01');
    try {
      // Remove package.json from the worktree too (copied at creation).
      try { fs.rmSync(join(wt, 'package.json'), { force: true }); } catch {}
      const train = new MergeTrain(wt, { requireReviewPass: true, testTimeout: 10000 });
      train.enqueue({ id: 'n1', name: 'notest', prompt: 'do', status: 'ready_to_merge', branch: 'feature-notest' } as never);
      const res = await train.processNext({ verdict: 'pass', blocking: false, reasons: [], jobName: 'notest', reviewedCommit: await git(repo, 'rev-parse', 'feature-notest'), reviewedBase: await git(repo, 'rev-parse', 'HEAD', ) } as never).catch((e: unknown) => ({ success: false as const, type: 'review_blocked' as const, output: String(e) }));
      // Must NOT be success-skipped: strict mode blocks without test evidence.
      expect(res.success).toBe(false);
      if (!res.success) expect(res.type).toBe('review_blocked');
      const headAfter = await git(repo, 'rev-parse', 'integration-f01');
      const headWorktree = (await (async () => {
        const p = Bun.spawn(['git', 'rev-parse', 'HEAD'], { cwd: wt, stdout: 'pipe', stderr: 'pipe' });
        return (await new Response(p.stdout).text()).trim();
      })());
      expect(headWorktree).toBe(headAfter);
    } finally {
      await git(repo, 'worktree', 'remove', '--force', wt).catch(() => {});
    }
  });

  it('autonomous merge config is fail-closed (requireReviewPass default)', async () => {
    const { Orchestrator } = await import('../../src/lib/orchestrator');
    const { JobMonitor } = await import('../../src/lib/monitor');
    // Minimal inline config (no loadConfig): avoids cross-file module-mock
    // interference in the full suite; the flag is unconditional anyway.
    const orch = new Orchestrator(new JobMonitor(), {
      defaultPlacement: 'session',
      pollInterval: 10000,
      idleThreshold: 300000,
      worktreeBasePath: '/tmp',
      omo: { enabled: false, defaultMode: 'vanilla' },
    } as never);
    const cfg = (orch as unknown as { getMergeTrainConfig: () => { requireReviewPass?: boolean } }).getMergeTrainConfig();
    expect(cfg.requireReviewPass).toBe(true);
  });
});

describe('F08 local destination regression (public path, no PR)', () => {
  let repo: string;
  let xdgTmp: string;
  let prevXdg: string | undefined;

  beforeEach(async () => {
    prevXdg = process.env.MC_XDG_DATA_DIR;
    xdgTmp = await tempDir('mc-xdg-f08-');
    process.env.MC_XDG_DATA_DIR = xdgTmp;
    repo = await mkRepo('mc-f08-');
  });

  afterEach(async () => {
    if (prevXdg === undefined) delete process.env.MC_XDG_DATA_DIR;
    else process.env.MC_XDG_DATA_DIR = prevXdg;
    const fs = await import('fs');
    for (const d of [repo, xdgTmp]) try { if (d && fs.existsSync(d)) fs.rmSync(d, { recursive: true, force: true }); } catch {}
  });

  it('local destination receives integration without push/PR; dirty tree refuses', async () => {
    const fs = await import('fs');
    const { Orchestrator } = await import('../../src/lib/orchestrator');
    const { JobMonitor } = await import('../../src/lib/monitor');
    // Destination main at base; integration branch with one commit ahead.
    const base = await git(repo, 'rev-parse', 'HEAD');
    await git(repo, 'branch', 'mc/integration-f08');
    await git(repo, 'checkout', 'mc/integration-f08');
    fs.writeFileSync(join(repo, 'ship.txt'), 'v1\n');
    await git(repo, 'add', 'ship.txt');
    await git(repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'ship');
    const integrated = await git(repo, 'rev-parse', 'HEAD');
    await git(repo, 'checkout', 'main');
    expect(await git(repo, 'rev-parse', 'main')).toBe(base);

    const orch = new Orchestrator(new JobMonitor(), {
      defaultPlacement: 'session',
      pollInterval: 10000,
      idleThreshold: 300000,
      worktreeBasePath: '/tmp',
      omo: { enabled: false, defaultMode: 'vanilla' },
    } as never);
    (orch as unknown as { repoRoot: string }).repoRoot = repo;
    const plan = {
      id: 'plan-f08', name: 'f08', mode: 'autopilot', status: 'running',
      jobs: [], integrationBranch: 'mc/integration-f08', integrationWorktree: repo,
      baseCommit: base, baseBranch: 'main', createdAt: new Date().toISOString(),
    } as never;
    const done = await (orch as unknown as { completeLocalDestination: (p: unknown) => Promise<{ destinationBranch: string; destinationHead: string }> }).completeLocalDestination(plan);
    expect(done.destinationBranch).toBe('main');
    // Local merge creates a merge commit (not a fast-forward pointer move):
    // the destination must CONTAIN the integration, not equal it.
    const mainHead = await git(repo, 'rev-parse', 'main');
    expect(mainHead).not.toBe(base);
    const isAncestor = await (async () => {
      const p = Bun.spawn(['git', 'merge-base', '--is-ancestor', integrated, 'main'], { cwd: repo, stdout: 'pipe', stderr: 'pipe' });
      return (await p.exited) === 0;
    })();
    expect(isAncestor).toBe(true);
    expect(fs.existsSync(join(repo, 'ship.txt'))).toBe(true);

    // Dirty tree must refuse (protect preexisting changes).
    fs.writeFileSync(join(repo, 'dirty.txt'), 'uncommitted\n');
    await git(repo, 'checkout', '-b', 'mc/integration-f08b', 'main');
    await git(repo, 'checkout', 'main');
    const plan2 = { ...plan, integrationBranch: 'mc/integration-f08b' } as never;
    await expect((orch as unknown as { completeLocalDestination: (p: unknown) => Promise<unknown> }).completeLocalDestination(plan2)).rejects.toThrow(/dirty|uncommitted|working tree/i);
  });
});

describe('F09 report evidence regression (public path, no harness)', () => {
  it('final report carries real request/decisions/tests/verified, never empty-as-proof', async () => {
    const { buildFinalReportMarkdown } = await import('../../src/lib/reports');
    const md = buildFinalReportMarkdown({
      title: 'F09',
      request: 'REAL-REQUEST-12345: ship X to main',
      decisions: ['model chose A over B because latency'],
      tasks: [{ name: 'a', status: 'merged', detail: 'merged at 2026-01-01' }],
      files: ['src/a.ts'],
      branches: ['main', 'mc/integration-f09'],
      integration: { branch: 'main', merged: ['a'] },
      installUsage: ['bun install --frozen-lockfile'],
      tests: [{ command: 'bun test', result: 'passed', output: '3 pass' }],
      evidences: ['commit abc1234'],
      verified: ['a [merged] bun test passed'],
      limitations: ['local completion only; no push/PR without explicit humanAuth'],
    });
    for (const needle of ['REAL-REQUEST-12345', 'model chose A', 'src/a.ts', 'bun test', '3 pass', 'abc1234', 'local completion only']) {
      expect(md).toContain(needle);
    }
    const verifiedSection = md.split('## Verified')[1].split('## Gaps')[0];
    expect(verifiedSection).toContain('a [merged]');
  });
});
