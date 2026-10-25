import { describe, it, expect } from 'bun:test';

import {
  clampMaxParallel,
  classifyOutcome,
  decideNextJobs,
  evaluateFanoutGuard,
  assertNoPush,
  isGitPushArgs,
  buildWorkerPrompt,
  redactSecrets,
  shouldContinueSession,
  type PlanJobView,
} from '../../src/lib/coordinator';

const JOBS: PlanJobView[] = [
  { name: 'a', status: 'queued', mergeOrder: 0 },
  { name: 'b', status: 'waiting_deps', dependsOn: ['a'], mergeOrder: 1 },
  { name: 'c', status: 'queued', mergeOrder: 2 },
];

describe('clampMaxParallel', () => {
  it('defaults to 4 and clamps to 4..8', () => {
    expect(clampMaxParallel(undefined)).toBe(4);
    expect(clampMaxParallel(2)).toBe(4);
    expect(clampMaxParallel(6)).toBe(6);
    expect(clampMaxParallel(99)).toBe(8);
  });

  it('treats non-finite input as unset and floors fractions', () => {
    expect(clampMaxParallel(NaN)).toBe(4);
    expect(clampMaxParallel(5.9)).toBe(5);
  });

  it('accepts a custom window instead of the 4..8 default', () => {
    // No mandatory minimum 4, no permanent ceiling 8: callers pass bounds.
    expect(clampMaxParallel(undefined, { min: 1, max: 16 })).toBe(1);
    expect(clampMaxParallel(3, { min: 1, max: 16 })).toBe(3);
    expect(clampMaxParallel(99, { min: 1, max: 16 })).toBe(16);
    expect(clampMaxParallel(undefined, { min: 2, max: 6, defaultValue: 2 })).toBe(2);
    expect(clampMaxParallel(NaN, { min: 2, max: 6, defaultValue: 5 })).toBe(5);
  });
});

describe('decideNextJobs', () => {
  it('picks only deps-satisfied jobs within the parallel budget', () => {
    // 'a' eligible, 'b' blocked on 'a', 'c' eligible; budget 1 → only first by mergeOrder.
    const picked = decideNextJobs(JOBS, 3, 4);
    expect(picked.map((j) => j.name)).toEqual(['a']);
  });

  it('respects the cap with a mocked running count', () => {
    const picked = decideNextJobs(JOBS, 2, 4);
    expect(picked.map((j) => j.name)).toEqual(['a', 'c']);
  });

  it('unblocks dependents once deps merged', () => {
    const merged: PlanJobView[] = [
      { name: 'a', status: 'merged', mergeOrder: 0 },
      { name: 'b', status: 'waiting_deps', dependsOn: ['a'], mergeOrder: 1 },
    ];
    expect(decideNextJobs(merged, 0, 4).map((j) => j.name)).toEqual(['b']);
  });
});

describe('evaluateFanoutGuard', () => {
  it('throws when requesting more than the budget', () => {
    expect(() => evaluateFanoutGuard(3, 2)).toThrow(/fanout/i);
    expect(() => evaluateFanoutGuard(2, 2)).not.toThrow();
  });
});

describe('assertNoPush', () => {
  it('blocks push/remote writes', () => {
    expect(() => assertNoPush(['git', 'push', 'origin', 'x'])).toThrow(/push/i);
    expect(() => assertNoPush(['git', 'commit', '-m', 'feat: x'])).not.toThrow();
  });

  it('blocks push through flags, package-manager publishes and gh merges', () => {
    expect(() => assertNoPush(['git', '-C', '/tmp/x', 'push', 'origin', 'main'])).toThrow(/push/i);
    expect(() => assertNoPush(['gh', 'pr', 'merge', '123'])).toThrow();
    expect(() => assertNoPush(['pnpm', 'publish'])).toThrow();
    expect(() => assertNoPush(['yarn', 'publish', '--tag', 'latest'])).toThrow();
    expect(() => assertNoPush(['npm', 'publish', '--dry-run'])).toThrow();
    expect(() => assertNoPush(['gh', 'pr', 'create', '--title', 'x'])).toThrow();
    expect(() => assertNoPush(['npm', 'install'])).not.toThrow();
    expect(() => assertNoPush(['git', 'status'])).not.toThrow();
  });

  it('blocks push with quoted -C paths containing spaces', () => {
    // Shell-string callers quote the path; argv execution is shell-free
    // and safe by construction, but the guard must still catch the quoted form.
    expect(() => assertNoPush(['git', '-C', '"my dir"', 'push', 'origin', 'main'])).toThrow(/push/i);
    expect(() => assertNoPush(['git', '-C', "'my dir'", 'push'])).toThrow(/push/i);
    expect(() => assertNoPush(['git', 'commit', '-m', 'x'])).not.toThrow();
  });

  it('blocks publish with package-manager flags, before or after', () => {
    expect(() => assertNoPush(['pnpm', '--filter', 'foo', 'publish'])).toThrow();
    expect(() => assertNoPush(['npm', '--prefix', '/tmp/x', 'publish'])).toThrow();
    expect(() => assertNoPush(['npm', 'run', 'publish'])).not.toThrow();
    expect(() => assertNoPush(['git', 'commit', '-m', 'push origin'])).not.toThrow();
  });

  it('blocks git push through -c / --git-dir / --work-tree scoped flags', () => {
    expect(isGitPushArgs(['git', '-c', 'core.sshCommand=ssh -i key', 'push'])).toBe(true);
    expect(isGitPushArgs(['git', '--git-dir=/tmp/x', 'push'])).toBe(true);
    expect(isGitPushArgs(['git', '--git-dir', '/tmp/x', 'push'])).toBe(true);
    expect(isGitPushArgs(['git', '--work-tree=/tmp/x', 'push'])).toBe(true);
    expect(isGitPushArgs(['git', '--no-pager', 'push'])).toBe(true);
    expect(() => assertNoPush(['git', '-c', 'a=b', 'push', 'origin', 'x'])).toThrow(/push/i);
    expect(() => assertNoPush(['git', '--git-dir=/tmp/x', 'push'])).toThrow(/push/i);
    expect(() => assertNoPush(['git', 'commit', '-m', 'x'])).not.toThrow();
  });

  it('blocks git -C push with space/quote paths in argv form', () => {
    // Shell-free argv: single token with a space (no shell quoting).
    expect(isGitPushArgs(['git', '-C', 'my dir', 'push', 'origin', 'main'])).toBe(true);
    // Shell-string callers keep the quotes inside the token.
    expect(isGitPushArgs(['git', '-C', '"my dir"', 'push'])).toBe(true);
    expect(isGitPushArgs(['git', '-C', "'my dir'", 'push'])).toBe(true);
    expect(() => assertNoPush(['git', '-C', 'my dir', 'push'])).toThrow(/push/i);
    expect(() => assertNoPush(['git', '-C', '"my dir"', 'push'])).toThrow(/push/i);
  });
});

describe('classifyOutcome', () => {
  it('distinguishes idle process from terminated model response', () => {
    expect(classifyOutcome({ paneAlive: true, modelTerminated: false }).state).toBe('process-idle');
    expect(classifyOutcome({ paneAlive: true, modelTerminated: true }).state).toBe(
      'response-terminated',
    );
  });

  it('keeps concluded-without-tests apart from verified and integrated', () => {
    expect(
      classifyOutcome({ paneAlive: false, modelTerminated: true, testsPassed: undefined }).state,
    ).toBe('concluded-no-tests');
    expect(
      classifyOutcome({ paneAlive: false, modelTerminated: true, testsPassed: true }).state,
    ).toBe('verified');
    expect(
      classifyOutcome({ paneAlive: false, modelTerminated: true, testsPassed: true, merged: true })
        .state,
    ).toBe('integrated');
  });

  it('reports failed tests as failed, never idle or concluded', () => {
    expect(
      classifyOutcome({ paneAlive: true, modelTerminated: false, testsPassed: false }).state,
    ).toBe('failed');
    expect(
      classifyOutcome({ paneAlive: false, modelTerminated: true, testsPassed: false }).state,
    ).toBe('failed');
  });
});

describe('redactSecrets', () => {
  it('judges each long token by its own context, not the first occurrence', () => {
    const token = 'A1B2C3D4E5F6071829ABCD';
    // Same token twice: first next to "password", second far from any
    // keyword. indexOf-based context would treat both like the first.
    const filler = 'lorem ipsum dolor sit amet consectetur adipiscing elit sed do';
    const text = `password ${token} ${filler} ${token} end`;
    const redacted = redactSecrets(text);
    expect(redacted.startsWith('password [REDACTED]')).toBe(true);
    expect(redacted.endsWith(`${token} end`)).toBe(true);
  });
});

describe('buildWorkerPrompt', () => {
  it('carries request, constraints, decisions, base and acceptance — no history dump', () => {
    const prompt = buildWorkerPrompt({
      request: 'Add retry to sync tool',
      constraints: ['touch only src/tools/sync.ts'],
      decisions: ['use exponential backoff'],
      baseRef: 'abc123',
      acceptance: ['bun test passes'],
    });
    for (const needle of [
      'Add retry',
      'src/tools/sync.ts',
      'exponential backoff',
      'abc123',
      'bun test passes',
    ]) {
      expect(prompt).toContain(needle);
    }
    expect(prompt).not.toMatch(/history/i);
  });

  it('never embeds secrets', () => {
    const prompt = buildWorkerPrompt({
      request: 'x',
      constraints: [],
      decisions: [],
      baseRef: 'abc123',
      acceptance: ['y'],
      extraNotes: 'Authorization: Bearer SECRET-TOKEN-123',
    });
    expect(prompt).not.toContain('SECRET-TOKEN-123');
  });
});

describe('shouldContinueSession', () => {
  it('continues the same work for corrections, new session for distinct tasks', () => {
    expect(shouldContinueSession(true)).toBe(true);
    expect(shouldContinueSession(false)).toBe(false);
  });
});
