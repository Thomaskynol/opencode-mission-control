import { describe, it, expect, afterEach } from 'vitest';
import { mock, spyOn } from 'bun:test';
import { EventEmitter } from 'events';
import { join } from 'path';
import { tmpdir } from 'os';
import { mkdtemp, readFile, mkdir } from 'fs/promises';
import { rmSync } from 'fs';
import {
  generateServePassword,
  resolveServePassword,
  writeServeLauncherScript,
} from '../../src/lib/prompt-file';
import { v2WaitForServer } from '../../src/lib/sdk-client';
import { redactSecrets } from '../../src/lib/coordinator';
import { Orchestrator } from '../../src/lib/orchestrator';
import * as planStateMod from '../../src/lib/plan-state';
import * as jobStateMod from '../../src/lib/job-state';
import { resolveJobPassword } from '../../src/lib/job-state';
import * as tmuxMod from '../../src/lib/tmux';
import * as portAllocMod from '../../src/lib/port-allocator';
import * as sdkClientMod from '../../src/lib/sdk-client';
import * as modelTrackerMod from '../../src/lib/model-tracker';
import * as promptFileMod from '../../src/lib/prompt-file';

async function createTempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'mc-serve-password-test-'));
}

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  mock.restore();
});

/** Emulates `opencode serve` auth: Basic opencode:<password>, 401 otherwise. */
function stubServeAuth(expectedPassword: string): void {
  const expected = 'Basic ' + Buffer.from('opencode:' + expectedPassword).toString('base64');
  globalThis.fetch = (async (url: unknown, init?: unknown) => {
    const headers = (init as RequestInit | undefined)?.headers as Record<string, string> | undefined;
    const seen = headers?.['Authorization'] ?? (headers as unknown as Headers)?.get?.('authorization');
    if (String(url).endsWith('/api/info') && seen === expected) {
      return new Response(JSON.stringify({ data: { ok: true } }), { status: 200 });
    }
    return new Response('unauthorized', { status: 401 });
  }) as typeof fetch;
}

describe('serve per-worker password', () => {
  it('generates unique, shell-safe passwords', () => {
    const a = generateServePassword();
    const b = generateServePassword();
    expect(a.length).toBeGreaterThanOrEqual(32);
    expect(a).toMatch(/^[A-Za-z0-9]+$/);
    expect(a).not.toBe(b);
  });

  it('prefers the configured password (trimmed)', () => {
    expect(resolveServePassword('  s3cret  ')).toBe('s3cret');
  });

  it('generates a fresh password when none is configured', () => {
    const a = resolveServePassword(undefined);
    const b = resolveServePassword('');
    const c = resolveServePassword('   ');
    expect(a.length).toBeGreaterThanOrEqual(32);
    expect(new Set([a, b, c]).size).toBe(3);
  });

  it('fail-closes when generation is disabled and nothing is configured', () => {
    expect(() => resolveServePassword(undefined, { generate: false })).toThrow(
      /server password/i,
    );
    expect(() => resolveServePassword('', { generate: false })).toThrow(
      /server password/i,
    );
    expect(resolveServePassword('cfg-pw', { generate: false })).toBe('cfg-pw');
  });

  it('round-trips adversarial passwords through the launcher env', async () => {
    const base = await createTempDir();
    try {
      const { mkdirSync } = await import('fs');
      mkdirSync(base, { recursive: true });
      const password = `a"b$c\`d'e!f\\g`;
      const launcher = await writeServeLauncherScript(base, 14999, password);
      const script = await readFile(launcher, 'utf-8');
      expect(script).toContain('OPENCODE_SERVER_PASSWORD=');
      // Source ONLY the env line in a fresh bash (never exec opencode here:
      // the launcher embeds the absolute opencode path at write time).
      const exportLine = script.split('\n').find((l) => l.startsWith('export OPENCODE_SERVER_PASSWORD='));
      expect(exportLine).toBeDefined();
      const result = Bun.spawnSync(['bash', '-c', `${exportLine}\nprintf '%s' "$OPENCODE_SERVER_PASSWORD"`]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout.toString()).toBe(password);
      // Launcher carries env only — never prompt text.
      expect(script).not.toContain('CRITICAL — STATUS REPORTING REQUIRED');
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('omits the password export when no password is given', async () => {
    const base = await createTempDir();
    try {
      const { mkdirSync } = await import('fs');
      mkdirSync(base, { recursive: true });
      const launcher = await writeServeLauncherScript(base, 14998);
      const script = await readFile(launcher, 'utf-8');
      expect(script).not.toContain('OPENCODE_SERVER_PASSWORD');
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('authenticates /api/info with the generated password', async () => {
    const password = generateServePassword();
    stubServeAuth(password);
    const client = await v2WaitForServer(14997, { password, timeoutMs: 5000 });
    expect(client.baseUrl).toBe('http://127.0.0.1:14997/api');
    expect(client.headers['Authorization']).toBe(
      'Basic ' + Buffer.from('opencode:' + password).toString('base64'),
    );
  });

  it('never becomes ready without a password (fail-closed, no blind poll)', async () => {
    stubServeAuth(generateServePassword());
    await expect(v2WaitForServer(14996, { timeoutMs: 400 })).rejects.toThrow(
      /did not become ready/,
    );
  });

  it('never leaks the password through redactSecrets-covered forms', async () => {
    const password = generateServePassword();
    expect(redactSecrets(`OPENCODE_SERVER_PASSWORD=${password}`)).not.toContain(password);
    expect(redactSecrets(`password: ${password}`)).not.toContain(password);
    // Launcher file itself: password only inside the env export line.
    const base = await createTempDir();
    try {
      const { mkdirSync } = await import('fs');
      mkdirSync(base, { recursive: true });
      const launcher = await writeServeLauncherScript(base, 14995, password);
      const script = await readFile(launcher, 'utf-8');
      const occurrences = script.split(password).length - 1;
      expect(occurrences).toBe(1);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

describe('serve password persistence (mocked launchJob)', () => {
  it('persists the effective password on the job — same value as launcher + client', async () => {
    const base = await createTempDir();
    const workdir = join(base, 'work');
    await mkdir(workdir, { recursive: true });
    try {
      const plan = {
        id: 'plan-1',
        name: 'Plan One',
        mode: 'autopilot',
        status: 'running',
        jobs: [
          { id: 'job-1', name: 'job-a', prompt: 'do job-a', status: 'queued' },
        ],
        integrationBranch: 'mc/integration-plan-1',
        integrationWorktree: '/tmp/integration-plan-1',
        baseCommit: 'abc123',
        createdAt: '2026-01-01T00:00:00.000Z',
      };
      const updateJobCalls: Array<{ id: string; updates: Record<string, unknown> }> = [];
      const planJobCalls: Array<{ updates: Record<string, unknown> }> = [];
      let seenClientPassword: unknown;
      const logged: string[] = [];

      spyOn(planStateMod, 'loadPlan').mockImplementation(async () => structuredClone(plan) as never);
      spyOn(planStateMod, 'claimJobForDispatch').mockResolvedValue({ ok: true, status: 'running' } as never);
      spyOn(planStateMod, 'updatePlanJob').mockImplementation(
        async (_planId: string, _jobName: string, updates: Record<string, unknown>) => {
          planJobCalls.push({ updates: { ...updates } });
        },
      );
      spyOn(jobStateMod, 'getRunningJobs').mockImplementation(async () => []);
      spyOn(jobStateMod, 'addJob').mockResolvedValue();
      spyOn(jobStateMod, 'updateJob').mockImplementation(
        async (id: string, updates: Record<string, unknown>) => {
          updateJobCalls.push({ id, updates: { ...updates } });
        },
      );
      spyOn(jobStateMod, 'loadJobState').mockImplementation(
        async () => ({ version: 2, jobs: [], updatedAt: new Date().toISOString() }) as never,
      );
      spyOn(tmuxMod, 'createSession').mockResolvedValue();
      spyOn(tmuxMod, 'setPaneDiedHook').mockResolvedValue();
      spyOn(portAllocMod, 'allocatePort').mockResolvedValue(14201);
      spyOn(portAllocMod, 'releasePort').mockResolvedValue();
      spyOn(promptFileMod, 'cleanupLauncherScript').mockImplementation(() => {});
      spyOn(sdkClientMod, 'v2WaitForServer').mockImplementation(
        async (_port: number, options?: { password?: string }) => {
          seenClientPassword = options?.password;
          return { baseUrl: 'http://127.0.0.1:14201/api', headers: {} } as never;
        },
      );
      spyOn(sdkClientMod, 'launchWorkerViaServe').mockImplementation(
        async () =>
          ({
            sessionId: 'ses-1',
            requestedModel: { providerID: 'p', id: 'm' },
            observedModel: { providerID: 'p', id: 'm' },
          }) as never,
      );
      spyOn(modelTrackerMod, 'getCurrentModelRef').mockReturnValue({ providerID: 'p', id: 'm' });
      spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
        logged.push(args.map(String).join(' '));
      });
      spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
        logged.push(args.map(String).join(' '));
      });

      const orch = new Orchestrator(new EventEmitter() as never, {
        defaultPlacement: 'session',
        pollInterval: 10000,
        idleThreshold: 300000,
        worktreeBasePath: base,
        omo: { enabled: false, defaultMode: 'vanilla' },
      } as never);
      (orch as unknown as { activePlanId: string }).activePlanId = 'plan-1';
      spyOn(orch as never, 'createJobWorktree').mockResolvedValue(workdir);

      const ok = await (orch as unknown as { launchJob: (job: unknown) => Promise<boolean> }).launchJob({
        id: 'job-1',
        name: 'job-a',
        prompt: 'do job-a',
        status: 'queued',
      });
      expect(ok).toBe(true);

      const persisted = updateJobCalls.map((c) => c.updates['serverPassword']).find((v) => v !== undefined);
      expect(typeof persisted).toBe('string');
      expect((persisted as string).length).toBeGreaterThanOrEqual(32);
      // Same effective value feeds launcher env + v2 client.
      expect(persisted).toBe(seenClientPassword);
      const script = await readFile(join(workdir, '.mc-launch.sh'), 'utf-8');
      expect(script).toContain(`OPENCODE_SERVER_PASSWORD='${persisted}'`);
      // Same value reaches the plan job record (reconnects read it back).
      expect(planJobCalls.some((c) => c.updates['serverPassword'] === persisted)).toBe(true);
      // Reconnect path resolves without any configured password.
      expect(resolveJobPassword({ serverPassword: persisted as string }, undefined)).toBe(persisted);
      // Never logged.
      expect(logged.some((line) => line.includes(persisted as string))).toBe(false);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
