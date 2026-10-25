import { describe, it, expect } from 'bun:test';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  normalizeRequest,
  buildPlannerPrompt,
  parsePlannerOutput,
  extractPlannerText,
  assertSafeDestinations,
  assertAuthorizedActions,
  assertLocalWorkerPrompts,
  sanitizeWorkerPrompt,
  validateRuntimeDecision,
  requiresUserReview,
  nextStepsFor,
  runAutoIntake,
  ensureBaseReady,
  type AutoPlanDraft,
} from '../../src/lib/auto-plan';
import { validateModelDispatch, detectGaps } from '../../src/lib/coordinator';

function validDraft(): AutoPlanDraft {
  return {
    requirements: [
      { id: 'r1', text: 'Add retry to sync tool', acceptance: ['retry works after failure'] },
    ],
    tasks: [
      {
        name: 'add-retry',
        prompt: 'Implement exponential backoff in the sync tool',
        acceptance: ['bun test passes'],
      },
      {
        name: 'wire-report',
        prompt: 'Report retry metrics at each milestone',
        dependsOn: ['add-retry'],
        touchSet: ['src/tools/sync.ts'],
        acceptance: ['metrics visible in report'],
      },
    ],
    decisions: ['use exponential backoff'],
    questions: [],
    nextSteps: ['dispatch add-retry first'],
  };
}

describe('auto-plan intake (NL-only public entry)', () => {
  it('normalizes the NL request and rejects empties', () => {
    expect(normalizeRequest('  Add retry  ')).toBe('Add retry');
    expect(() => normalizeRequest('   ')).toThrow(/natural-language request/i);
  });

  it('builds a planner prompt for the configured model (no caller DAG)', () => {
    const prompt = buildPlannerPrompt({
      request: 'Add retry to sync tool',
      repo: '/tmp/demo',
      targetBranch: 'feat/retry',
      ceiling: { maxParallel: 3 },
    });
    expect(prompt).toContain('Add retry to sync tool');
    expect(prompt).toContain('feat/retry');
    expect(prompt).toMatch(/strict json/i);
    expect(prompt).toMatch(/never push/i);
  });

  it('parses model output as plain JSON or fenced blocks', () => {
    const raw = JSON.stringify(validDraft());
    expect(parsePlannerOutput(raw).tasks.map((t) => t.name)).toEqual(['add-retry', 'wire-report']);
    expect(parsePlannerOutput('```json\n' + raw + '\n```').requirements).toHaveLength(1);
  });

  it('rejects unparseable or shapeless model output explicitly', () => {
    expect(() => parsePlannerOutput('not json')).toThrow(/model output/i);
    expect(() => parsePlannerOutput(JSON.stringify({ tasks: [] }))).toThrow(/requirement/i);
    expect(() => parsePlannerOutput(JSON.stringify({ requirements: [], tasks: [] }))).toThrow(
      /requirement|task/i,
    );
  });

  it('rejects duplicate names, unknown deps, self-deps and cycles', () => {
    const dup = validDraft();
    dup.tasks[1].name = 'add-retry';
    expect(() => parsePlannerOutput(JSON.stringify(dup))).toThrow(/unique/i);

    const unknown = validDraft();
    unknown.tasks[1].dependsOn = ['ghost'];
    expect(() => parsePlannerOutput(JSON.stringify(unknown))).toThrow(/unknown job/i);

    const self = validDraft();
    self.tasks[0].dependsOn = ['add-retry'];
    expect(() => parsePlannerOutput(JSON.stringify(self))).toThrow(/circular|self/i);

    const cycle = validDraft();
    cycle.tasks[0].dependsOn = ['wire-report'];
    expect(() => parsePlannerOutput(JSON.stringify(cycle))).toThrow(/circular/i);
  });

  it('rejects tasks without prompt or acceptance (inconsistent result)', () => {
    const bad = validDraft();
    bad.tasks[0].prompt = '  ';
    expect(() => parsePlannerOutput(JSON.stringify(bad))).toThrow(/prompt/i);
    const bad2 = validDraft();
    bad2.tasks[0].acceptance = [];
    expect(() => parsePlannerOutput(JSON.stringify(bad2))).toThrow(/acceptance/i);
  });

  it('rejects destinations outside the repo (destino permitido)', () => {
    const bad = validDraft();
    bad.tasks[1].touchSet = ['/etc/passwd'];
    expect(() => assertSafeDestinations(bad)).toThrow(/destination/i);
    const escape = validDraft();
    escape.tasks[1].touchSet = ['../outside.ts'];
    expect(() => assertSafeDestinations(escape)).toThrow(/destination/i);
    expect(() => assertSafeDestinations(validDraft())).not.toThrow();
  });

  it('rejects publishing actions in model prompts (ação autorizada)', () => {
    const bad = validDraft();
    bad.tasks[0].prompt = 'Implement retry then git push origin main';
    expect(() => assertAuthorizedActions(bad)).toThrow(/push|publish|authorized/i);
    expect(() => assertAuthorizedActions(validDraft())).not.toThrow();
  });

  it('runs the full intake through the injected (configured) model', async () => {
    const seen: string[] = [];
    const { intake, draft } = await runAutoIntake(
      { request: 'Add retry', targetBranch: 'feat/retry' },
      async (plannerPrompt) => {
        seen.push(plannerPrompt);
        return JSON.stringify(validDraft());
      },
    );
    expect(intake.request).toBe('Add retry');
    expect(draft.tasks).toHaveLength(2);
    expect(seen[0]).toContain('Add retry');
  });

  it('treats model validation failures as explicit errors without side effects', async () => {
    await expect(
      runAutoIntake({ request: 'x' }, async () => 'garbage'),
    ).rejects.toThrow(/model output/i);
  });
});

describe('extractPlannerText (opencode run --format json)', () => {
  const draftJson = JSON.stringify(validDraft());

  it('returns strict JSON and fenced blocks verbatim', () => {
    expect(extractPlannerText(draftJson)).toBe(draftJson);
    expect(parsePlannerOutput(extractPlannerText('```json\n' + draftJson + '\n```'))).toBeDefined();
  });

  it('unwraps a single-JSON envelope', () => {
    const raw = JSON.stringify({ text: draftJson });
    expect(parsePlannerOutput(extractPlannerText(raw)).tasks).toHaveLength(2);
  });

  it('extracts the draft from JSONL step_start + text events', () => {
    const raw = [
      JSON.stringify({ type: 'step_start', part: { type: 'step-start' } }),
      JSON.stringify({ type: 'text', part: { type: 'text', text: draftJson } }),
      JSON.stringify({ type: 'step_finish', part: { type: 'step-finish' } }),
    ].join('\n');
    expect(parsePlannerOutput(extractPlannerText(raw)).tasks.map((t) => t.name)).toEqual([
      'add-retry',
      'wire-report',
    ]);
  });

  it('uses the last complete draft when several text events are present', () => {
    const other = JSON.stringify({
      ...validDraft(),
      tasks: [{ name: 'only', prompt: 'Do it', acceptance: ['done'] }],
    });
    const raw = [
      JSON.stringify({ type: 'text', part: { type: 'text', text: draftJson } }),
      JSON.stringify({ type: 'text', part: { type: 'text', text: other } }),
    ].join('\n');
    expect(parsePlannerOutput(extractPlannerText(raw)).tasks.map((t) => t.name)).toEqual(['only']);
  });

  it('reassembles a draft split across text events', () => {
    const mid = Math.floor(draftJson.length / 2);
    const raw = [
      JSON.stringify({ type: 'text', part: { type: 'text', text: draftJson.slice(0, mid) } }),
      JSON.stringify({ type: 'text', part: { type: 'text', text: draftJson.slice(mid) } }),
    ].join('\n');
    expect(parsePlannerOutput(extractPlannerText(raw)).tasks).toHaveLength(2);
  });

  it('still fails explicitly when no draft JSON is present', () => {
    const raw = [
      JSON.stringify({ type: 'step_start', part: { type: 'step-start' } }),
      JSON.stringify({ type: 'text', part: { type: 'text', text: 'thinking aloud, no json' } }),
    ].join('\n');
    expect(() => extractPlannerText(raw)).toThrow(/no strict-JSON draft/i);
    expect(() => extractPlannerText('blob is not json')).toThrow(/no strict-JSON draft/i);
    expect(() => extractPlannerText('   ')).toThrow(/empty output/i);
  });
});

describe('runtime decision validation (adaptive loop guard)', () => {
  const ctx = { taskNames: ['add-retry', 'wire-report'], mergedTasks: ['add-retry'] };

  it('dispatches routine technical changes autonomously', () => {
    const route = validateRuntimeDecision(
      {
        action: 'add_task',
        task: { name: 'add-metrics', prompt: 'Record attempts', acceptance: ['counter increments'] },
        reason: 'retry loop needs observability',
      },
      ctx,
    );
    expect(route).toBe('autonomous');
  });

  it('routes scope changes to the user instead of dispatching', () => {
    const route = validateRuntimeDecision(
      {
        action: 'add_task',
        task: {
          name: 'ship-it',
          prompt: 'Publish the package to the registry',
          acceptance: ['published'],
        },
        reason: 'publish the new retry support',
      },
      ctx,
    );
    expect(route).toBe('needs-user');
  });

  it('rejects unknown tasks, missing deps and cycles without dispatching', () => {
    expect(() =>
      validateRuntimeDecision(
        {
          action: 'adjust_deps',
          dependsOn: { ghost: [] },
          reason: 'reorder',
        },
        ctx,
      ),
    ).toThrow(/known task/i);
    expect(() =>
      validateRuntimeDecision(
        {
          action: 'add_task',
          task: { name: 'x', prompt: 'do', dependsOn: ['ghost'], acceptance: ['done'] },
          reason: 'gap',
        },
        ctx,
      ),
    ).toThrow(/unknown job|unknown dep/i);
    expect(() =>
      validateRuntimeDecision({ action: 'add_task', reason: 'no task' }, ctx),
    ).toThrow(/task/i);
  });

  it('rejects disallowed destinations and publishing actions at runtime', () => {
    expect(() =>
      validateRuntimeDecision(
        {
          action: 'add_task',
          task: { name: 'x', prompt: 'do', touchSet: ['/etc/x'], acceptance: ['done'] },
          reason: 'gap',
        },
        ctx,
      ),
    ).toThrow(/destination/i);
    expect(() =>
      validateRuntimeDecision(
        {
          action: 'add_task',
          task: { name: 'x', prompt: 'git push origin main', acceptance: ['done'] },
          reason: 'ship',
        },
        ctx,
      ),
    ).toThrow(/push|publish|authorized/i);
  });

  it('classifies user-visible changes vs routine technique', () => {
    expect(requiresUserReview('retry with backoff')).toBe(false);
    expect(requiresUserReview('change the target branch to main')).toBe(true);
    expect(requiresUserReview('publish the package')).toBe(true);
    expect(requiresUserReview('ask which retry policy the user prefers')).toBe(true);
  });

  it('derives next steps from questions and dispatch order', () => {
    const steps = nextStepsFor({ ...validDraft(), questions: ['Which backoff?'] });
    expect(steps.join('\n')).toMatch(/Which backoff\?/);
    expect(steps.join('\n')).toMatch(/add-retry/);
  });
});

describe('prompt-permission-fix (worktree-local worker prompts)', () => {
  // Real leak from single-3 evidence (jobs.json): the planner echoed the
  // absolute origin repo + destination branch into the task prompt, so the
  // worker tried to write /tmp/opencode/single-3/* from its own worktree
  // and blocked on "Access external directory".
  const LEAKED = 'No repo /tmp/opencode/single-3, branch single/demo-3: criar src/isEven.js com function isEven(numero) em JS puro (retorna numero % 2 === 0)';

  it('planner prompt marks repo/branch as context-only and demands relative-only tasks', () => {
    const prompt = buildPlannerPrompt({
      request: 'Add retry',
      repo: '/tmp/demo',
      targetBranch: 'feat/retry',
    });
    expect(prompt).toMatch(/context-only|do not copy/i);
    expect(prompt).toMatch(/relative.*only|relative paths only/i);
    expect(prompt).toMatch(/never.*absolute/i);
  });

  it('sanitizes the leaked origin/branch prefix into a worktree-local prompt', () => {
    const clean = sanitizeWorkerPrompt(LEAKED, '/tmp/opencode/single-3');
    expect(clean).not.toContain('/tmp/opencode/single-3');
    expect(clean).not.toMatch(/branch single\/demo-3:\s*criar/i);
    expect(clean).toContain('src/isEven.js');
    expect(clean).toMatch(/current worktree|relative paths/i);
  });

  it('strips stray absolute paths and outside-worktree cd', () => {
    const clean = sanitizeWorkerPrompt('Write /etc/config.json then cd /tmp/other and cd .. up');
    expect(clean).not.toContain('/etc/config.json');
    expect(clean).not.toContain('/tmp/other');
    expect(clean).not.toMatch(/cd \.\./);
    expect(clean).toMatch(/current worktree|relative paths/i);
  });

  it('rejects surviving absolute paths before they become work', () => {
    const bad = validDraft();
    bad.tasks[0].prompt = 'Edit /tmp/demo/src/a.ts now';
    expect(() => assertLocalWorkerPrompts(bad)).toThrow(/absolute|worktree-local/i);
    expect(() => assertLocalWorkerPrompts(validDraft())).not.toThrow();
  });

  it('runAutoIntake never lets an absolute repo path reach the draft', async () => {
    const { draft } = await runAutoIntake(
      { request: 'Add retry', repo: '/tmp/demo', targetBranch: 'feat/retry' },
      async () => {
        const d = validDraft();
        d.tasks[0].prompt = 'No repo /tmp/demo, branch feat/retry: implement retry in src/sync.ts';
        return JSON.stringify(d);
      },
    );
    expect(draft.tasks[0].prompt).not.toContain('/tmp/demo');
    expect(draft.tasks[0].prompt).toContain('src/sync.ts');
    expect(() => assertLocalWorkerPrompts(draft)).not.toThrow();
  });

  it('runtime add_task with an absolute path fails closed', () => {
    const ctx = { taskNames: ['a'], mergedTasks: [] as string[] };
    expect(() =>
      validateRuntimeDecision(
        {
          action: 'add_task',
          task: { name: 'x', prompt: 'Edit /tmp/demo/src/a.ts', acceptance: ['done'] },
          reason: 'gap',
        },
        ctx,
      ),
    ).toThrow(/absolute|worktree-local/i);
  });
});

describe('coordinator runtime guards for model decisions', () => {
  const jobs = [
    { name: 'a', status: 'merged', mergeOrder: 0 },
    { name: 'b', status: 'queued', dependsOn: ['a'], mergeOrder: 1 },
  ];

  it('accepts known tasks with satisfied deps', () => {
    expect(validateModelDispatch({ name: 'b' }, jobs, ['a']).name).toBe('b');
  });

  it('rejects unknown tasks and unsatisfied deps explicitly', () => {
    expect(() => validateModelDispatch({ name: 'ghost' }, jobs, ['a'])).toThrow(/known task/i);
    expect(() => validateModelDispatch({ name: 'b' }, jobs, [])).toThrow(/dep/i);
  });

  it('detects gaps between requirements and deliveries', () => {
    const gaps = detectGaps(
      [
        { id: 'r1', text: 'retry' },
        { id: 'r2', text: 'metrics' },
      ],
      ['r1'],
    );
    expect(gaps.map((g) => g.id)).toEqual(['r2']);
  });
});

describe('ensureBaseReady (fresh repo / missing branch)', () => {
  async function git(cwd: string, ...args: string[]): Promise<void> {
    const proc = Bun.spawn(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
    await proc.exited;
  }

  async function makeRepo(withCommit: boolean): Promise<string> {
    const fs = await import('fs');
    const dir = await fs.promises.mkdtemp(join(tmpdir(), 'mc-auto-base-'));
    await git(dir, 'init', '-q');
    await git(dir, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--allow-empty', '-m', 'init');
    if (!withCommit) {
      // Recreate truly empty: remove the commit via a fresh repo without commits.
      await fs.promises.rm(dir, { recursive: true, force: true });
      await fs.promises.mkdir(dir, { recursive: true });
      await git(dir, 'init', '-q');
    }
    return dir;
  }

  it('instructs minimal preparation when the repo has no commits', async () => {
    const dir = await makeRepo(false);
    await expect(ensureBaseReady(dir, 'feat/x')).rejects.toThrow(/no commits|minimal preparation/i);
  });

  it('creates a missing destination branch locally (never pushes)', async () => {
    const dir = await makeRepo(true);
    const ready = await ensureBaseReady(dir, 'feat/from-nl');
    expect(ready.baseCommit).toMatch(/^[0-9a-f]+$/);
    expect(ready.createdBranch).toBe(true);
    const proc = Bun.spawn(['git', 'branch', '--list', 'feat/from-nl'], {
      cwd: dir,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    expect(out).toContain('feat/from-nl');
  });

  it('reuses an existing destination branch', async () => {
    const dir = await makeRepo(true);
    await git(dir, 'checkout', '-qb', 'feat/exists');
    const ready = await ensureBaseReady(dir, 'feat/exists');
    expect(ready.createdBranch).toBe(false);
    expect(ready.baseBranch).toBe('feat/exists');
  });

  it('fails closed on a missing repo path', async () => {
    await expect(ensureBaseReady(join(tmpdir(), 'mc-no-such-repo-xyz'), 'b')).rejects.toThrow(
      /repo not found|not a directory/i,
    );
  });
});
