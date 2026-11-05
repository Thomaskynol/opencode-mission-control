import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import {
  v1ToolToV2,
  buildV1ToolContext,
  resolveV2Directory,
  resolveV2Worktree,
} from '../src/index';
import type { ToolContext } from '@opencode-ai/plugin';

function makeHost(dir: string) {
  const controller = new AbortController();
  return {
    host: { directory: dir, worktree: dir, signal: controller.signal },
    controller,
  };
}

function makeProbe(seen: { ctx?: ToolContext }) {
  return {
    description: 'probe',
    args: {},
    execute: async (_args: never, ctx: ToolContext) => {
      seen.ctx = ctx;
      return `sess=${ctx.sessionID} dir=${ctx.directory} aborted=${ctx.abort.aborted}`;
    },
  };
}

describe('v2 host context propagation (R06)', () => {
  let probeDir = '';

  beforeEach(() => {
    probeDir = mkdtempSync(join(tmpdir(), 'mc-v2-host-'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (probeDir) rmSync(probeDir, { recursive: true, force: true });
  });

  it('forwards session/message/agent/directory/worktree per call (no fixed stub)', async () => {
    const { host } = makeHost(probeDir);
    const seen: { ctx?: ToolContext } = {};
    const wrapped = v1ToolToV2('probe', makeProbe(seen) as never, host);

    const callController = new AbortController();
    const out = await wrapped.execute(
      {},
      {
        sessionID: 'ses_hostctx123',
        messageID: 'msg_1',
        agent: 'agent_1',
        directory: probeDir,
        worktree: probeDir,
        abort: callController.signal,
      },
    );

    expect(seen.ctx).toBeDefined();
    expect(seen.ctx?.sessionID).toBe('ses_hostctx123');
    expect(seen.ctx?.messageID).toBe('msg_1');
    expect(seen.ctx?.agent).toBe('agent_1');
    expect(seen.ctx?.directory).toBe(probeDir);
    expect(seen.ctx?.worktree).toBe(probeDir);
    expect(out.content[0].text).toContain('ses_hostctx123');
  });

  it('falls back to setup host directory/worktree/signal when the call omits them', async () => {
    const { host, controller } = makeHost(probeDir);
    const seen: { ctx?: ToolContext } = {};
    const wrapped = v1ToolToV2('probe', makeProbe(seen) as never, host);

    await wrapped.execute({});
    expect(seen.ctx?.directory).toBe(probeDir);
    expect(seen.ctx?.worktree).toBe(probeDir);
    expect(seen.ctx?.abort).toBe(controller.signal);
  });

  it('observes a pre-aborted per-call signal (not a fresh stub)', async () => {
    const { host } = makeHost(probeDir);
    const seen: { ctx?: ToolContext } = {};
    const wrapped = v1ToolToV2('probe', makeProbe(seen) as never, host);

    const callController = new AbortController();
    callController.abort();
    await wrapped.execute({}, { sessionID: 'ses_abort1', abort: callController.signal });
    expect(seen.ctx?.abort.aborted).toBe(true);
  });

  it('observes a pre-aborted host signal when the call provides none', async () => {
    const { host, controller } = makeHost(probeDir);
    controller.abort();
    const seen: { ctx?: ToolContext } = {};
    const wrapped = v1ToolToV2('probe', makeProbe(seen) as never, host);

    await wrapped.execute({}, { sessionID: 'ses_abort2' });
    expect(seen.ctx?.abort.aborted).toBe(true);
  });

  it('buildV1ToolContext prefers explicit call directory over host directory', () => {
    const { host } = makeHost(probeDir);
    const other = mkdtempSync(join(tmpdir(), 'mc-v2-host-other-'));
    try {
      const ctx = buildV1ToolContext({ sessionID: 'ses_x', directory: other }, host);
      expect(ctx.directory).toBe(other);
      expect(ctx.worktree).toBe(probeDir);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  it('resolveV2Directory honours ctx.location.directory with cwd fallback', () => {
    expect(resolveV2Directory({ location: { directory: probeDir } })).toBe(probeDir);
    expect(resolveV2Directory({ directory: probeDir })).toBe(probeDir);
    expect(resolveV2Directory({})).toBe(process.cwd());
    expect(resolveV2Worktree({ location: { worktree: probeDir } }, '/fallback')).toBe(probeDir);
    expect(resolveV2Worktree({}, '/fallback')).toBe('/fallback');
  });
});

describe('v2 representative operation depending on host session (R06)', () => {
  it('V2-wrapped mc_launch persists the host sessionID as launchSessionID', async () => {
    const jobState = await import('../src/lib/job-state');
    const worktreeMod = await import('../src/lib/worktree');
    const tmux = await import('../src/lib/tmux');
    const configMod = await import('../src/lib/config');
    const promptFile = await import('../src/lib/prompt-file');
    const worktreeSetup = await import('../src/lib/worktree-setup');
    const portAllocator = await import('../src/lib/port-allocator');
    const sdkClient = await import('../src/lib/sdk-client');
    const modelTracker = await import('../src/lib/model-tracker');

    const probeDir = mkdtempSync(join(tmpdir(), 'mc-v2-launch-'));
    try {
      vi.spyOn(jobState, 'getJobByName').mockResolvedValue(undefined);
      const addJob = vi.spyOn(jobState, 'addJob').mockResolvedValue(undefined);
      vi.spyOn(jobState, 'getRunningJobs').mockResolvedValue([]);
      vi.spyOn(worktreeMod, 'createWorktree').mockResolvedValue(probeDir);
      vi.spyOn(worktreeMod, 'removeWorktree').mockResolvedValue(undefined);
      vi.spyOn(tmux, 'isTmuxAvailable').mockResolvedValue(true);
      vi.spyOn(tmux, 'createSession').mockResolvedValue(undefined);
      vi.spyOn(tmux, 'setPaneDiedHook').mockResolvedValue(undefined);
      vi.spyOn(configMod, 'loadConfig').mockResolvedValue({
        defaultPlacement: 'session',
        pollInterval: 10000,
        idleThreshold: 300000,
        worktreeBasePath: '/tmp/mc-worktrees',
        // Serve is the enforced path: TUI (useServeMode:false) is refused
        // fail-closed. This test probes launchSessionID persistence, not routing.
        useServeMode: true,
        portRangeStart: 14100,
        portRangeEnd: 14199,
        omo: { enabled: false, defaultMode: 'vanilla' },
      } as never);
      vi.spyOn(promptFile, 'writeServeLauncherScript').mockResolvedValue(join(probeDir, '.mc-launch.sh'));
      vi.spyOn(promptFile, 'cleanupLauncherScript').mockImplementation(() => {});
      vi.spyOn(worktreeSetup, 'resolvePostCreateHook').mockReturnValue({ symlinkDirs: ['.opencode'] } as never);
      vi.spyOn(portAllocator, 'allocatePort').mockResolvedValue(14100);
      vi.spyOn(portAllocator, 'releasePort').mockResolvedValue(undefined);
      vi.spyOn(modelTracker, 'getCurrentModelInfo').mockReturnValue({
        providerID: 'opencode-go',
        modelID: 'muse-spark-1.3-contributor',
        variant: 'xhigh',
      } as never);
      const fakeClient = { baseUrl: 'http://127.0.0.1:14100/api', headers: {} };
      vi.spyOn(sdkClient, 'v2WaitForServer').mockResolvedValue(fakeClient as never);
      vi.spyOn(sdkClient, 'v2CreateSession').mockResolvedValue({
        id: 'ses-v2-1',
        model: { providerID: 'opencode-go', id: 'muse-spark-1.3-contributor', variant: 'xhigh' },
      } as never);
      vi.spyOn(sdkClient, 'v2Prompt').mockResolvedValue({} as never);

      const { mc_launch } = await import('../src/tools/launch');
      const { host } = makeHost(probeDir);
      const wrapped = v1ToolToV2('mc_launch', mc_launch as never, host);

      const out = await wrapped.execute(
        { name: 'hostctx-job', prompt: 'Do host-context work' },
        { sessionID: 'ses_hostlaunch1', directory: probeDir, worktree: probeDir },
      );
      expect(out.content[0].text).toContain('hostctx-job');
      expect(addJob).toHaveBeenCalledTimes(1);
      const saved = addJob.mock.calls[0][0] as { launchSessionID?: string };
      expect(saved.launchSessionID).toBe('ses_hostlaunch1');
    } finally {
      vi.restoreAllMocks();
      rmSync(probeDir, { recursive: true, force: true });
    }
  });
});
