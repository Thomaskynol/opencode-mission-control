/**
 * R1 — escalated ask-user must NEVER approve by silence; path containment
 * must be real (separator boundary, `..`, symlinks, unresolvable = deny).
 *
 * Bun real fs + real timers + real policy/relay; only the SDK network call
 * is a fetch collector. Disposable dirs under os.tmpdir(); disposable state
 * via MC_XDG_DATA_DIR.
 */
import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { Job } from '../../src/lib/job-state';
import * as QR from '../../src/lib/question-relay';
import * as PP from '../../src/lib/permission-policy';
import { listPersistedQuestions, dropPersistedQuestion, loadRuntimeSnapshot } from '../../src/lib/durable-state';

const WT_NAME = 'wt-worker';

let root = '';
let wt = '';
let outside = '';

function setupFs() {
  root = mkdtempSync(join(tmpdir(), 'mc-r1-'));
  wt = join(root, WT_NAME);
  outside = join(root, 'outside');
  mkdirSync(wt, { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(outside, 'secret.txt'), 'top secret');
  writeFileSync(join(wt, 'keep.ts'), 'export const a = 1;');
  symlinkSync(outside, join(wt, 'esc-link'));
  symlinkSync(join(root, 'missing-target'), join(wt, 'broken-link'));
}

function teardownFs() {
  if (root) rmSync(root, { recursive: true, force: true });
  root = wt = outside = '';
}

let origFetch: typeof fetch;
let seen: Array<{ url: string; body: string }>;
let origXdg: string | undefined;

function mockFetch() {
  seen = [];
  origFetch = globalThis.fetch;
  (globalThis as any).fetch = (async (url: unknown, init?: unknown) => {
    seen.push({ url: String(url), body: JSON.stringify((init as any)?.body ?? {}) });
    return new Response('{}', { status: 200 });
  }) as typeof fetch;
}

function restoreFetch() {
  globalThis.fetch = origFetch;
}

function mkJob(over: Partial<Job> = {}): Job {
  return {
    id: 'r1-job',
    name: 'r1-job',
    worktreePath: wt,
    branch: 'main',
    tmuxTarget: 'mc-r1',
    placement: 'session',
    status: 'running',
    prompt: 'r1 probe task',
    mode: 'vanilla',
    createdAt: new Date().toISOString(),
    port: 18991,
    remoteSessionID: 'ses_r1',
    ...over,
  };
}

function replyFor(permissionId: string) {
  return seen.find((s) => s.url.includes(permissionId));
}

beforeEach(async () => {
  setupFs();
  origXdg = process.env.MC_XDG_DATA_DIR;
  process.env.MC_XDG_DATA_DIR = join(root, 'xdg');
  mockFetch();
});

afterEach(async () => {
  restoreFetch();
  if (origXdg === undefined) delete process.env.MC_XDG_DATA_DIR;
  else process.env.MC_XDG_DATA_DIR = origXdg;
  for (const id of ['r1-job', 'r1-restart']) QR.clearPendingQuestionsForJob(id);
  teardownFs();
});

describe('R1 containment — relay isPathInsideWorktree (real fs)', () => {
  it('rejects sibling-suffix paths (worker-OTHER)', () => {
    expect(QR.isPathInsideWorktree(`${wt}-OTHER/file`, wt)).toBe(false);
  });

  it('rejects raw `..` traversal strings', () => {
    expect(QR.isPathInsideWorktree(`${wt}/../../outside/secret.txt`, wt)).toBe(false);
  });

  it('rejects symlink escapes pointing outside', () => {
    expect(QR.isPathInsideWorktree(join(wt, 'esc-link', 'secret.txt'), wt)).toBe(false);
  });

  it('fail-closes on broken symlinks', () => {
    expect(QR.isPathInsideWorktree(join(wt, 'broken-link'), wt)).toBe(false);
  });

  it('still accepts a brand-new file inside an existing worktree (allowlist preserved)', () => {
    expect(QR.isPathInsideWorktree(join(wt, 'new-dir', 'new-file.ts'), wt)).toBe(true);
  });

  it('still accepts the worktree itself and real files inside', () => {
    expect(QR.isPathInsideWorktree(wt, wt)).toBe(true);
    expect(QR.isPathInsideWorktree(join(wt, 'keep.ts'), wt)).toBe(true);
  });
});

describe('R1 containment — policy evaluate (real fs)', () => {
  it('shell via symlink escape is ask-user, never auto-approve', () => {
    const policy = PP.PermissionPolicy.resolvePolicy({});
    const d = policy.evaluate(
      { type: 'shell_command', path: join(wt, 'esc-link', 'secret.txt'), description: 'read via link' },
      { worktreePath: wt },
    );
    expect(d).toBe('ask-user');
  });

  it('file edit via symlink escape is deny, never auto-approve', () => {
    const policy = PP.PermissionPolicy.resolvePolicy({});
    const d = policy.evaluate(
      { type: 'file_operation', path: join(wt, 'esc-link', 'secret.txt'), description: 'edit via link' },
      { worktreePath: wt },
    );
    expect(d).toBe('deny');
  });

  it('raw `..` traversal shell is ask-user', () => {
    const policy = PP.PermissionPolicy.resolvePolicy({});
    const d = policy.evaluate(
      { type: 'shell_command', path: `${wt}/../../outside/secret.txt`, description: 'escape' },
      { worktreePath: wt },
    );
    expect(d).toBe('ask-user');
  });

  it('sibling-suffix file edit is deny', () => {
    const policy = PP.PermissionPolicy.resolvePolicy({});
    const d = policy.evaluate(
      { type: 'file_operation', path: `${wt}-OTHER/file`, description: 'sibling' },
      { worktreePath: wt },
    );
    expect(d).toBe('deny');
  });

  it('pre-authorized allowlist still auto-approves inside the worktree (no new questions)', () => {
    const policy = PP.PermissionPolicy.resolvePolicy({});
    expect(
      policy.evaluate(
        { type: 'file_operation', path: join(wt, 'keep.ts'), description: 'edit inside' },
        { worktreePath: wt },
      ),
    ).toBe('auto-approve');
    expect(
      policy.evaluate(
        { type: 'shell_command', path: wt, description: 'build inside' },
        { worktreePath: wt },
      ),
    ).toBe('auto-approve');
  });
});

describe('R1 timeout NEVER approves (all categories fail-closed)', () => {
  // `extra` is a thunk: `outside`/`wt` only exist after beforeEach setupFs().
  const caseSpecs: Array<{ name: string; type: 'file_operation' | 'shell_command' | 'network' | 'other'; extra: () => object }> = [
    { name: 'file-outside', type: 'file_operation', extra: () => ({ path: outside, description: 'edit outside file' }) },
    { name: 'shell-outside', type: 'shell_command', extra: () => ({ path: outside, description: 'run outside command' }) },
    { name: 'network', type: 'network', extra: () => ({ description: 'fetch https://example.com' }) },
    { name: 'other', type: 'other', extra: () => ({ description: 'mystery op' }) },
    { name: 'publishing-push', type: 'shell_command', extra: () => ({ path: wt, description: 'git push origin main' }) },
  ];

  for (const { name, type, extra } of caseSpecs) {
    it(`timeout DENIES escalated ${name}`, async () => {
      const logSpy = spyOn(console, 'log').mockImplementation(() => {});
      try {
        const relay = new QR.QuestionRelay({ autoResponseTimeoutMs: 20 });
        try {
          const permId = `perm-r1-${type}-${Math.random().toString(36).slice(2, 8)}`;
          const result = await relay.handlePermissionRequest(mkJob(), { id: permId, type, ...extra() } as any);
          expect(result.autoApproved).toBe(false);
          // Visible as pending while awaiting the human.
          expect(QR.getPendingQuestionsForJob('r1-job').map((q) => q.partId)).toContain(`perm:${permId}`);
          await new Promise((r) => setTimeout(r, 120));
          const call = replyFor(permId);
          expect(call).toBeDefined();
          expect(call!.body).toMatch(/reject/);
          expect(call!.body).not.toMatch(/once/);
          // Settled: no longer pending anywhere.
          expect(QR.getPendingQuestionsForJob('r1-job').map((q) => q.partId)).not.toContain(`perm:${permId}`);
          const sidecar = await loadRuntimeSnapshot();
          expect((sidecar?.pendingQuestions ?? []).map((q) => q.partId)).not.toContain(`perm:${permId}`);
          // Audit trail: the timer decision is logged, never silent.
          const logged = logSpy.mock.calls.map((c) => String(c[0]));
          expect(logged.some((l) => l.includes('Auto-denied') && l.includes(permId))).toBe(true);
        } finally {
          relay.dispose();
        }
      } finally {
        logSpy.mockRestore();
      }
    });
  }

  it('neverAutoApprovesOnTimeout is true for EVERY category', () => {
    const samples: Array<Parameters<typeof QR.neverAutoApprovesOnTimeout>[0]> = [
      { type: 'file_operation', path: outside, description: 'edit' },
      { type: 'shell_command', path: outside, description: 'run' },
      { type: 'shell_command', path: wt, description: 'run inside' },
      { type: 'file_operation', path: join(wt, 'keep.ts'), description: 'edit inside' },
      { type: 'network', description: 'fetch' },
      { type: 'mcp', description: 'tool' },
      { type: 'other', description: '???' },
    ];
    for (const p of samples) {
      expect(QR.neverAutoApprovesOnTimeout(p)).toBe(true);
    }
  });
});

describe('R1 human response path (explicit approve / deny, timer cancelled)', () => {
  it('human "yes" approves once and no later timer reply fires', async () => {
    const relay = new QR.QuestionRelay({ autoResponseTimeoutMs: 40 });
    try {
      const permId = 'perm-r1-human-yes';
      await relay.handlePermissionRequest(mkJob(), {
        id: permId, type: 'shell_command', path: outside, description: 'run outside',
      });
      await relay.handleUserResponse(mkJob(), permId, 'yes');
      await new Promise((r) => setTimeout(r, 120));
      const calls = seen.filter((s) => s.url.includes(permId));
      expect(calls).toHaveLength(1);
      expect(calls[0].body).toMatch(/once/);
    } finally {
      relay.dispose();
    }
  });

  it('human "no" denies', async () => {
    const relay = new QR.QuestionRelay({ autoResponseTimeoutMs: 40 });
    try {
      const permId = 'perm-r1-human-no';
      await relay.handlePermissionRequest(mkJob(), {
        id: permId, type: 'shell_command', path: outside, description: 'run outside',
      });
      await relay.handleUserResponse(mkJob(), permId, 'no');
      const call = replyFor(permId);
      expect(call).toBeDefined();
      expect(call!.body).toMatch(/reject/);
    } finally {
      relay.dispose();
    }
  });
});

describe('R1 restart/recovery never approves persisted escalations', () => {
  it('a persisted perm: question survives restart with NO timer approval', async () => {
    const relay = new QR.QuestionRelay({ autoResponseTimeoutMs: 20 });
    const permId = 'perm-r1-restart-1';
    const job = mkJob({ id: 'r1-restart', name: 'r1-restart' });
    await relay.handlePermissionRequest(job, {
      id: permId, type: 'shell_command', path: outside, description: 'run outside',
    });
    // Simulate restart: drop in-memory relay state AND the memory question map.
    relay.dispose();
    QR.removePendingQuestion('r1-restart', `perm:${permId}`);
    const persisted = await listPersistedQuestions();
    // Still visible as pending for the operator…
    expect(persisted.filter((q) => q.partId === `perm:${permId}`)).toHaveLength(1);
    // …and nothing approves it without a human: no timer exists anymore.
    const before = seen.length;
    await new Promise((r) => setTimeout(r, 100));
    expect(seen.length).toBe(before);
    // Explicit human deny still works post-restart (fail-closed reply).
    const relay2 = new QR.QuestionRelay({ autoResponseTimeoutMs: 20 });
    try {
      await relay2.respondToPermission(job, permId, false, 'Denied by user after restart');
      const call = replyFor(permId);
      expect(call).toBeDefined();
      expect(call!.body).toMatch(/reject/);
    } finally {
      relay2.dispose();
    }
    await dropPersistedQuestion('r1-restart', `perm:${permId}`);
  });
});

describe('R1 monitor permission path (policy allowlist preserved, ask-user escalated)', () => {
  it('allowlisted file edit inside the worktree auto-approves with NO question', async () => {
    const config = await import('../../src/lib/config');
    const loadSpy = spyOn(config, 'loadConfig').mockResolvedValue({ defaultPermissionPolicy: undefined } as any);
    try {
      const { JobMonitor } = await import('../../src/lib/monitor');
      const monitor = new JobMonitor();
      try {
        const job = mkJob();
        await (monitor as any).handlePermissionUpdate(job, {
          properties: { id: 'mon-allow-1', type: 'file', path: join(wt, 'keep.ts'), description: 'edit inside' },
        });
        const call = replyFor('mon-allow-1');
        expect(call).toBeDefined();
        expect(call!.body).toMatch(/once/);
        expect(QR.getPendingQuestionsForJob('r1-job')).toHaveLength(0);
      } finally {
        (monitor as any).questionRelay.dispose();
      }
    } finally {
      loadSpy.mockRestore();
    }
  });

  it('ask-user shell outside the worktree becomes visible pending with NO decision sent', async () => {
    const config = await import('../../src/lib/config');
    const loadSpy = spyOn(config, 'loadConfig').mockResolvedValue({ defaultPermissionPolicy: undefined } as any);
    try {
      const { JobMonitor } = await import('../../src/lib/monitor');
      const monitor = new JobMonitor();
      try {
        const job = mkJob();
        await (monitor as any).handlePermissionUpdate(job, {
          properties: { id: 'mon-esc-1', type: 'shell', path: outside, description: 'run outside' },
        });
        // Escalated, not decided: no reply on the wire…
        expect(replyFor('mon-esc-1')).toBeUndefined();
        // …but visible as pending in memory and in the durable sidecar.
        expect(QR.getPendingQuestionsForJob('r1-job').map((q) => q.partId)).toContain('perm:mon-esc-1');
        const sidecar = await loadRuntimeSnapshot();
        expect((sidecar?.pendingQuestions ?? []).map((q) => q.partId)).toContain('perm:mon-esc-1');
      } finally {
        (monitor as any).questionRelay.dispose();
        QR.removePendingQuestion('r1-job', 'perm:mon-esc-1');
        await dropPersistedQuestion('r1-job', 'perm:mon-esc-1');
      }
    } finally {
      loadSpy.mockRestore();
    }
  });
});

describe('R1 publishing protection (independent of timeout)', () => {
  const pushes = [
    'git push origin main',
    'git -C "my dir" push origin main',
    'gh pr create --title x',
    'npm publish',
    'deploy to production',
  ];
  for (const text of pushes) {
    it(`publishing text never auto-approves: ${text.slice(0, 32)}`, () => {
      const r = QR.shouldAutoApprove(
        { id: 'p', type: 'shell_command', path: wt, description: text },
        wt,
      );
      expect(r.autoApproved).toBe(false);
      expect(r.approved).toBe(false);
      expect(QR.neverAutoApprovesOnTimeout({ type: 'shell_command', path: wt, description: text })).toBe(true);
    });
  }

  it('file_operation on a path named like publishing (deploy.sh) stays auto-approved inside', () => {
    const target = join(wt, 'deploy.sh');
    writeFileSync(target, '#!/bin/sh\necho hi\n');
    const r = QR.shouldAutoApprove(
      { id: 'p', type: 'file_operation', path: target, description: 'edit deploy script' },
      wt,
    );
    expect(r.autoApproved).toBe(true);
  });
});
