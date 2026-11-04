import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { join } from 'path';
import { tmpdir } from 'os';
import * as paths from '../../src/lib/paths';
import { addPendingQuestion, clearPendingQuestionsForJob } from '../../src/lib/question-relay';
import { ensureBaseReady } from '../../src/lib/auto-plan';
import { answerQuestion } from '../../src/orchestrator-cli/forms';
import { dispatchCommand, type HumanControls } from '../../src/orchestrator-cli/commands';
import { loadAutoIntake } from '../../src/lib/durable-state';

let testBaseDir: string;
let testStateDir: string;
let restoreDataDir: () => void = () => {};

/**
 * Point getDataDir at the temp dir. When another suite already replaced the
 * paths record with a shared mock (vi.mock), patch the fn object itself so
 * early-bound holders (durable-state) see it; otherwise spy the export.
 */
function stubDataDir(dir: string): void {
  const current = paths.getDataDir as unknown as {
    mockResolvedValue?: (v: string) => void;
    mockReset?: () => void;
  };
  if (current && typeof current.mockResolvedValue === 'function') {
    current.mockResolvedValue(dir);
    restoreDataDir = () => current.mockReset?.();
  } else {
    const spy = spyOn(paths, 'getDataDir').mockResolvedValue(dir);
    restoreDataDir = () => spy.mockRestore();
  }
}

async function tempDir(prefix: string): Promise<string> {
  const fs = await import('fs');
  return fs.promises.mkdtemp(join(tmpdir(), prefix));
}

function fakeControls(log: string[] = []): HumanControls {
  return {
    pause: async (name) => `paused ${name}`,
    resume: async (name) => `resumed ${name}`,
    cancel: async (name) => {
      log.push(`cancel:${name}`);
      return `canceled ${name}`;
    },
    answer: async (name, response) => `answered ${name}:${response}`,
    launch: async (prompt) => `launch ready (${prompt.length} chars)`,
  };
}

beforeEach(async () => {
  testBaseDir = await tempDir('mc-auto-cli-test-');
  testStateDir = join(testBaseDir, 'state');
  const fs = await import('fs');
  fs.mkdirSync(testStateDir, { recursive: true });
  stubDataDir(testStateDir);
});

afterEach(async () => {
  clearPendingQuestionsForJob('auto-job-1');
  restoreDataDir();
  const fs = await import('fs');
  if (testBaseDir && fs.existsSync(testBaseDir)) fs.rmSync(testBaseDir, { recursive: true, force: true });
});

describe('autonomous intake commands (public NL path)', () => {
  it('start captures NL-only input and persists a resumable intake', async () => {
    const out = await dispatchCommand(
      'start Add retry to sync tool --branch feat/retry',
      fakeControls(),
    );
    expect(out).toMatch(/intake/i);
    expect(out).toMatch(/Add retry to sync tool/);
    // Full copyable resume path, never an abbreviated .../index.ts form.
    expect(out).toContain('orchestrator-cli/index.ts');
    expect(out).not.toContain('.../index.ts');

    const idMatch = out.match(/Intake (\S+) persisted/);
    expect(idMatch).not.toBeNull();
    const loaded = await loadAutoIntake(idMatch![1]);
    expect(loaded).not.toBeNull();
    expect(loaded!.request).toBe('Add retry to sync tool');
    expect(loaded!.targetBranch).toBe('feat/retry');
    expect(loaded!.status).toBe('awaiting-plan');
  });

  it('complement extends the persisted request without rebuilding it', async () => {
    const started = await dispatchCommand('start Add retry', fakeControls());
    const id = started.match(/Intake (\S+) persisted/)![1];
    const out = await dispatchCommand(`complement --intake ${id} Also cover timeouts`, fakeControls());
    expect(out).toMatch(/recorded|complement/i);
    const loaded = await loadAutoIntake(id);
    expect(loaded!.request).toContain('Also cover timeouts');
  });

  it('auto-plan validates model output into dispatchable tasks', async () => {
    const started = await dispatchCommand('start Add retry', fakeControls());
    const id = started.match(/Intake (\S+) persisted/)![1];
    const planFile = join(testBaseDir, 'plan.json');
    await Bun.write(
      planFile,
      JSON.stringify({
        requirements: [{ id: 'r1', text: 'retry works', acceptance: ['bun test passes'] }],
        tasks: [
          { name: 'add-retry', prompt: 'Implement backoff', acceptance: ['bun test passes'] },
        ],
        decisions: ['use backoff'],
        questions: [],
        nextSteps: [],
      }),
    );
    const out = await dispatchCommand(
      `auto-plan --intake ${id} --plan-file ${planFile}`,
      fakeControls(),
    );
    expect(out).toMatch(/add-retry/);
    const loaded = await loadAutoIntake(id);
    expect(loaded!.status).toBe('planned');
    expect(loaded!.decisions).toContain('use backoff');
  });

  it('close detaches the follow view without canceling the run', async () => {
    const log: string[] = [];
    const out = await dispatchCommand('close', fakeControls(log));
    expect(log).toEqual([]);
    expect(out).toMatch(/coordinator|reconciler/i);
    expect(out).toMatch(/record/i);
    expect(out).not.toMatch(/cancel/i);
  });
});

describe('answer routing: free-text content is never an approve/deny', () => {
  const realFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  function contentQuestion() {
    addPendingQuestion({
      jobId: 'auto-job-1',
      jobName: 'auto-alpha',
      taskSummary: 'do things',
      partId: 'p1',
      callID: 'c1',
      remoteSessionID: 'ses_remote_auto',
      port: 14177,
      question: 'Which strategy?',
      options: [{ label: 'Retry' }, { label: 'Skip' }],
      detectedAt: Date.now(),
    });
  }

  function permissionQuestion() {
    addPendingQuestion({
      jobId: 'auto-job-1',
      jobName: 'auto-alpha',
      taskSummary: 'do things',
      partId: 'perm:req-1',
      callID: 'req-1',
      remoteSessionID: 'ses_remote_auto',
      port: 14177,
      question: 'Permission needed [shell_command]: run tests',
      options: [{ label: 'approve' }, { label: 'deny' }],
      detectedAt: Date.now(),
    });
  }

  it('routes "deny"-like free text on a content question as content, not a permission decision', async () => {
    const fetched: string[] = [];
    globalThis.fetch = (async (url: unknown) => {
      fetched.push(String(url));
      return new Response('', { status: 204 });
    }) as typeof fetch;

    contentQuestion();
    const sent: string[] = [];
    const result = await answerQuestion('auto-alpha', 'deny the cache and retry', async (_p, _s, text) => {
      sent.push(text);
    });
    expect(sent).toEqual(['deny the cache and retry']);
    expect(result).toMatch(/Answer sent to job "auto-alpha"/);
    expect(fetched).toEqual([]);
  });

  it('fail-closed: free-text on a permission question asks clarification (never once)', async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    globalThis.fetch = (async (url: unknown, init: unknown) => {
      calls.push({ url: String(url), body: JSON.parse(String((init as RequestInit)?.body)) });
      return new Response('', { status: 204 });
    }) as typeof fetch;

    permissionQuestion();
    let prompted = 0;
    await expect(
      answerQuestion('auto-alpha', 'use your best judgment to fix the build', async () => {
        prompted += 1;
      }),
    ).rejects.toThrow(/clarification/i);
    expect(prompted).toBe(0);
    expect(calls.filter((c) => c.url.includes('/permission/'))).toHaveLength(0);
  });
});

describe('ensureBaseReady detached-HEAD fallback (lane worktrees)', () => {
  async function git(cwd: string, ...args: string[]): Promise<void> {
    const proc = Bun.spawn(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
    await proc.exited;
  }

  /** Isolated fixture: git init tmp + commit + branch -M main, then detach. */
  async function makeDetachedRepo(): Promise<string> {
    const fs = await import('fs');
    const dir = await fs.promises.mkdtemp(join(tmpdir(), 'mc-auto-detached-'));
    await git(dir, 'init', '-q');
    await git(
      dir,
      '-c',
      'user.email=t@t',
      '-c',
      'user.name=t',
      'commit',
      '--allow-empty',
      '-m',
      'init',
    );
    await git(dir, 'branch', '-M', 'main');
    await git(dir, 'checkout', '--detach', 'HEAD');
    return dir;
  }

  it('falls back to main/master instead of throwing "has no current branch"', async () => {
    const fs = await import('fs');
    const dir = await makeDetachedRepo();
    try {
      const ready = await ensureBaseReady(dir);
      expect(ready.baseBranch).toBe('main');
      expect(ready.createdBranch).toBe(false);
      expect(ready.baseCommit).toMatch(/^[0-9a-f]+$/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('stays fail-closed: no commits still throws, invalid branch still throws', async () => {
    const fs = await import('fs');
    const empty = await fs.promises.mkdtemp(join(tmpdir(), 'mc-auto-empty-'));
    try {
      await git(empty, 'init', '-q');
      await expect(ensureBaseReady(empty)).rejects.toThrow(/no commits|minimal preparation/i);
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
    }
    const dir = await makeDetachedRepo();
    try {
      await expect(ensureBaseReady(dir, 'bad name')).rejects.toThrow(/invalid destination/i);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('H1: refuses to guess when show-current fails while HEAD is attached', async () => {
    const fs = await import('fs');
    // Attached repo: show-current would normally print "main". The shim
    // breaks ONLY `branch --show-current`, so the old code silently fell back
    // to main; the fix must rethrow instead of masking the git failure.
    const dir = await fs.promises.mkdtemp(join(tmpdir(), 'mc-auto-attached-'));
    await git(dir, 'init', '-q');
    await git(
      dir,
      '-c',
      'user.email=t@t',
      '-c',
      'user.name=t',
      'commit',
      '--allow-empty',
      '-m',
      'init',
    );
    await git(dir, 'branch', '-M', 'main');
    // Shim git: fail ONLY `branch --show-current` (simulated broken git).
    // Bun resolves binaries via the startup PATH, so the shim must run in a
    // subprocess born with the shim first — in-process PATH mutation never
    // intercepts. The old code silently fell back to main here.
    const realGitProc = Bun.spawn(['sh', '-c', 'command -v git'], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const realGit = (await new Response(realGitProc.stdout).text()).trim();
    await realGitProc.exited;
    const shimDir = await fs.promises.mkdtemp(join(tmpdir(), 'mc-auto-shim-'));
    await Bun.write(
      join(shimDir, 'git'),
      `#!/bin/sh\nif [ "$1" = "branch" ] && [ "$2" = "--show-current" ]; then echo "simulated git breakage" >&2; exit 1; fi\nexec ${realGit} "$@"\n`,
    );
    const chmod = Bun.spawn(['chmod', '+x', join(shimDir, 'git')], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    await chmod.exited;
    const autoPlanPath = join(import.meta.dir, '..', '..', 'src', 'lib', 'auto-plan.ts');
    const code = [
      `import { ensureBaseReady } from ${JSON.stringify(autoPlanPath)};`,
      `try { const r = await ensureBaseReady(${JSON.stringify(dir)}); console.log('RESOLVED ' + r.baseBranch); }`,
      `catch (e) { console.log('REJECTED ' + (e as Error).message); }`,
    ].join('\n');
    const proc = Bun.spawn([process.execPath, '-e', code], {
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, PATH: `${shimDir}:${process.env.PATH ?? ''}` },
    });
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    try {
      expect(out).toMatch(/REJECTED.*show-current/i);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(shimDir, { recursive: true, force: true });
    }
  });
});
