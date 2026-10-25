import { describe, it, expect } from 'bun:test';

import {
  clampMaxParallel,
  classifyOutcome,
  decideNextJobs,
  evaluateFanoutGuard,
  assertNoPush,
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
