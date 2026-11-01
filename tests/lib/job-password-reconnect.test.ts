import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { JobSchema, JobSpecSchema } from '../../src/lib/schemas';
import { resolveJobPassword } from '../../src/lib/job-state';
import { redactSecrets } from '../../src/lib/coordinator';
import { JobComms } from '../../src/lib/job-comms';
import type { JobSpec } from '../../src/lib/plan-types';
import type { Job } from '../../src/lib/job-state';
import * as sdkClientMod from '../../src/lib/sdk-client';
import * as configMod from '../../src/lib/config';
import * as jobStateMod from '../../src/lib/job-state';
import * as planStateMod from '../../src/lib/plan-state';
import { JobMonitor } from '../../src/lib/monitor';
import { Orchestrator } from '../../src/lib/orchestrator';

function makeJobSpec(name: string, overrides: Record<string, unknown> = {}): JobSpec {
  return {
    id: `${name}-id`,
    name,
    prompt: `do ${name}`,
    status: 'running',
    ...overrides,
  } as JobSpec;
}

function makeJob(id: string, overrides: Record<string, unknown> = {}): Job {
  return {
    id,
    name: id,
    worktreePath: `/tmp/wt-${id}`,
    branch: `mc/${id}`,
    tmuxTarget: `mc-${id}`,
    placement: 'session',
    status: 'running',
    prompt: `do ${id}`,
    mode: 'vanilla',
    createdAt: new Date().toISOString(),
    ...overrides,
  } as Job;
}

const basicAuth = (pw: string) => 'Basic ' + Buffer.from('opencode:' + pw).toString('base64');

describe('persisted job serve password', () => {
  afterEach(() => {
    mock.restore();
  });

  describe('schemas', () => {
    it('JobSchema accepts and round-trips serverPassword', () => {
      const job = makeJob('a', { serverPassword: 'job-pw-1' });
      const parsed = JobSchema.parse(JSON.parse(JSON.stringify(job)));
      expect(parsed.serverPassword).toBe('job-pw-1');
    });

    it('JobSpecSchema accepts and round-trips serverPassword', () => {
      const spec = makeJobSpec('a', { serverPassword: 'job-pw-2' });
      const parsed = JobSpecSchema.parse(JSON.parse(JSON.stringify(spec)));
      expect((parsed as { serverPassword?: string }).serverPassword).toBe('job-pw-2');
    });

    it('password stays optional (old jobs without it still parse)', () => {
      expect(() => JobSchema.parse(makeJob('a'))).not.toThrow();
      expect(() => JobSpecSchema.parse(makeJobSpec('a'))).not.toThrow();
    });
  });

  describe('resolveJobPassword', () => {
    it('prefers the persisted job password over config', () => {
      expect(resolveJobPassword({ serverPassword: 'job-pw' }, 'cfg-pw')).toBe('job-pw');
    });

    it('falls back to the configured password (trimmed)', () => {
      expect(resolveJobPassword({}, '  cfg-pw  ')).toBe('cfg-pw');
    });

    it('treats empty job password as absent and falls back', () => {
      expect(resolveJobPassword({ serverPassword: '' }, 'cfg-pw')).toBe('cfg-pw');
    });

    it('returns undefined when neither job nor config has a password', () => {
      expect(resolveJobPassword({}, undefined)).toBeUndefined();
      expect(resolveJobPassword({}, '   ')).toBeUndefined();
    });
  });

  describe('redactSecrets covers the persisted field', () => {
    it('never leaks serverPassword assignments', () => {
      const pw = 'job-pw-secret-abcdef123456';
      expect(redactSecrets(`serverPassword=${pw}`)).not.toContain(pw);
      expect(redactSecrets(`serverPassword: ${pw}`)).not.toContain(pw);
    });
  });

  describe('job-comms reconnect', () => {
    let comms: JobComms;

    beforeEach(() => {
      comms = new JobComms();
    });

    it('uses the job password, not config, when both exist', async () => {
      spyOn(configMod, 'loadConfig').mockResolvedValue({ serverPassword: 'cfg-pw' } as any);
      const waitSpy = spyOn(sdkClientMod, 'v2WaitForServer').mockResolvedValue({ baseUrl: 'x', headers: {} } as any);
      spyOn(sdkClientMod, 'v2Prompt').mockResolvedValue(undefined as any);

      comms.relayFinding('src', 'target', { finding: 'hi' });
      const delivered = await comms.deliverMessages(
        makeJobSpec('target', { port: 14111, remoteSessionID: 'ses-r', serverPassword: 'job-pw' }),
      );

      expect(delivered).toBe(1);
      expect(waitSpy).toHaveBeenCalledWith(14111, { timeoutMs: 5000, password: 'job-pw' });
    });

    it('falls back to config password when the job has none', async () => {
      spyOn(configMod, 'loadConfig').mockResolvedValue({ serverPassword: 'cfg-pw' } as any);
      const waitSpy = spyOn(sdkClientMod, 'v2WaitForServer').mockResolvedValue({ baseUrl: 'x', headers: {} } as any);
      spyOn(sdkClientMod, 'v2Prompt').mockResolvedValue(undefined as any);

      comms.relayFinding('src', 'target', { finding: 'hi' });
      const delivered = await comms.deliverMessages(
        makeJobSpec('target', { port: 14112, remoteSessionID: 'ses-r' }),
      );

      expect(delivered).toBe(1);
      expect(waitSpy).toHaveBeenCalledWith(14112, { timeoutMs: 5000, password: 'cfg-pw' });
    });

    it('fail-closes without any password: no unauthenticated poll', async () => {
      spyOn(configMod, 'loadConfig').mockResolvedValue({} as any);
      const waitSpy = spyOn(sdkClientMod, 'v2WaitForServer').mockResolvedValue({ baseUrl: 'x', headers: {} } as any);

      comms.relayFinding('src', 'target', { finding: 'hi' });
      const delivered = await comms.deliverMessages(
        makeJobSpec('target', { port: 14113, remoteSessionID: 'ses-r' }),
      );

      expect(delivered).toBe(0);
      expect(waitSpy).not.toHaveBeenCalled();
      expect(comms.getMessagesForJob('target')).toHaveLength(1);
    });
  });

  describe('monitor poll reconnect', () => {
    it('subscribes with the job password, not config', async () => {
      spyOn(configMod, 'loadConfig').mockResolvedValue({ serverPassword: 'cfg-pw' } as any);
      globalThis.fetch = (async () => new Response('{}', { status: 404 })) as typeof fetch;

      const monitor = new JobMonitor();
      const job = makeJob('v2-pw', { port: 14211, serverUrl: 'http://127.0.0.1:14211', remoteSessionID: 'ses-r', serverPassword: 'job-pw' });
      await (monitor as any).subscribeToSSE(job);

      const sub = (monitor as any).sseSubscriptions.get('v2-pw');
      expect(sub).toBeDefined();
      expect(sub.client.headers['Authorization']).toBe(basicAuth('job-pw'));
      monitor.stop();
    });

    it('fail-closes without any password: no subscription, no unauthenticated fetch', async () => {
      spyOn(configMod, 'loadConfig').mockResolvedValue({} as any);
      let fetched = 0;
      globalThis.fetch = (async () => {
        fetched++;
        return new Response('{}', { status: 404 });
      }) as typeof fetch;

      const monitor = new JobMonitor();
      const job = makeJob('v2-nopw', { port: 14212, serverUrl: 'http://127.0.0.1:14212', remoteSessionID: 'ses-r' });
      await (monitor as any).subscribeToSSE(job);

      expect((monitor as any).sseSubscriptions.has('v2-nopw')).toBe(false);
      expect(fetched).toBe(0);
      monitor.stop();
    });
  });

  describe('fork reconnect', () => {
    function mockPlan(planJobs: JobSpec[]) {
      let plan: any = {
        id: 'plan-1',
        name: 'p',
        mode: 'autopilot',
        status: 'running',
        jobs: planJobs,
        integrationBranch: 'mc/integration',
        baseCommit: 'abc',
        createdAt: new Date().toISOString(),
      };
      spyOn(planStateMod, 'loadPlan').mockImplementation(async () => structuredClone(plan));
      spyOn(planStateMod, 'savePlan').mockImplementation(async (p: any) => {
        plan = structuredClone(p);
      });
      spyOn(planStateMod, 'updatePlanJob').mockImplementation(async (_id: string, name: string, updates: any) => {
        const j = plan.jobs.find((x: any) => x.name === name);
        if (j) Object.assign(j, updates);
      });
      spyOn(planStateMod, 'updatePlanFields').mockImplementation(async (_id: string, updates: any) => {
        Object.assign(plan, updates);
      });
      return () => plan;
    }

    function makeOrchestrator(configOverrides: Record<string, unknown> = {}) {
      const monitor = new JobMonitor();
      const orchestrator = new Orchestrator(monitor as any, {
        defaultPlacement: 'session',
        pollInterval: 10000,
        idleThreshold: 300000,
        worktreeBasePath: '/tmp',
        omo: { enabled: false, defaultMode: 'vanilla' },
        ...configOverrides,
      } as any);
      spyOn(orchestrator as any, 'reconcile').mockResolvedValue(undefined);
      spyOn(orchestrator as any, 'startReconciler').mockImplementation(() => {});
      return orchestrator;
    }

    it('forks with the source job password, not config', async () => {
      mockPlan([makeJobSpec('source', { status: 'running', port: 14121, remoteSessionID: 'src-remote', serverPassword: 'job-pw' })]);
      const forkSpy = spyOn(sdkClientMod, 'v2ForkSession').mockResolvedValue({ id: 'forked-session' } as any);
      spyOn(sdkClientMod, 'v2Prompt').mockResolvedValue(undefined as any);

      const orchestrator = makeOrchestrator({ serverPassword: 'cfg-pw' });
      await orchestrator.addJob({ name: 'forked', prompt: 'continue' }, { forkFrom: 'source' });

      expect(forkSpy).toHaveBeenCalledWith(
        expect.objectContaining({ headers: expect.objectContaining({ Authorization: basicAuth('job-pw') }) }),
        'src-remote',
      );
    });

    it('fail-closes without any password: no unauthenticated fork, add still succeeds', async () => {
      const getPlan = mockPlan([makeJobSpec('source', { status: 'running', port: 14122, remoteSessionID: 'src-remote' })]);
      const forkSpy = spyOn(sdkClientMod, 'v2ForkSession').mockResolvedValue({ id: 'forked-session' } as any);
      spyOn(sdkClientMod, 'v2Prompt').mockResolvedValue(undefined as any);

      const orchestrator = makeOrchestrator({});
      await orchestrator.addJob({ name: 'forked', prompt: 'continue' }, { forkFrom: 'source' });

      expect(forkSpy).not.toHaveBeenCalled();
      expect(getPlan().jobs).toHaveLength(2);
    });
  });
});
