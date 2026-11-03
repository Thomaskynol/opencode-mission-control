/**
 * P1 — the effective permission decision (job > plan > global) must travel
 * from the monitor into the relay. An `ask-user`/`deny` ceiling is never
 * re-approved by type/path heuristics; `auto-approve` allowlist hits keep
 * flowing without new questions.
 */
import { describe, it, expect, beforeEach, afterEach, spyOn, mock } from 'bun:test';
import type { Job } from '../../src/lib/job-state';
import * as configMod from '../../src/lib/config';
import * as planStateMod from '../../src/lib/plan-state';
import { PermissionPolicy, type PermissionPolicyConfig } from '../../src/lib/permission-policy';
import { JobMonitor } from '../../src/lib/monitor';

function askUserShellPolicy(): PermissionPolicyConfig {
  return {
    permissions: {
      fileEdit: { insideWorktree: 'auto-approve', outsideWorktree: 'deny' },
      shellCommand: { insideWorktree: 'ask-user', outsideWorktree: 'ask-user' },
      networkAccess: 'deny',
      installPackages: 'ask-user',
      mcpTools: 'auto-approve',
    },
  };
}

function baseJob(overrides: Partial<Job> = {}): Job {
  return {
    id: 'job-p1',
    name: 'P1 Job',
    worktreePath: '/tmp/wt',
    branch: 'main',
    tmuxTarget: 'mc-p1',
    placement: 'session',
    status: 'running',
    prompt: 'Do work',
    mode: 'vanilla',
    createdAt: new Date().toISOString(),
    port: 8099,
    remoteSessionID: 'ses-1',
    ...overrides,
  };
}

function shellEvent(path: string) {
  return { properties: { id: 'p-shell', type: 'shell_exec', path, title: 'exec', description: 'run build' } };
}

function mcpEvent() {
  return { properties: { id: 'p-mcp', type: 'mcp_tool', description: 'execute mcp tool' } };
}

function fileEvent(path: string) {
  return { properties: { id: 'p-file', type: 'file_edit', path, title: 'edit', description: 'edit file' } };
}

describe('JobMonitor permission policy passthrough (P1)', () => {
  beforeEach(() => {
    (globalThis as any).__testGlobalPolicy = undefined;
    (globalThis as any).__testPlan = null;
    spyOn(configMod, 'loadConfig').mockImplementation(
      async () => ({ defaultPermissionPolicy: (globalThis as any).__testGlobalPolicy }) as any,
    );
    spyOn(planStateMod, 'loadPlan').mockImplementation(async () => (globalThis as any).__testPlan);
  });

  afterEach(() => {
    mock.restore();
  });

  function monitored() {
    const monitor = new JobMonitor();
    const relay = (monitor as any).questionRelay;
    relay.respondToPermission = mock(async () => {});
    relay.handlePermissionRequest = mock(async () => ({
      approved: false,
      autoApproved: false,
      reason: 'relayed for user approval',
    }));
    return { monitor, relay };
  }

  it('global ask-user for shell inside worktree is relayed with the decision (not auto-approved)', async () => {
    (globalThis as any).__testGlobalPolicy = askUserShellPolicy();
    const { monitor, relay } = monitored();
    try {
      await (monitor as any).handlePermissionUpdate(baseJob(), shellEvent('/tmp/wt/run.sh'));
      expect(relay.handlePermissionRequest).toHaveBeenCalledTimes(1);
      expect((relay.handlePermissionRequest as any).mock.calls[0][3]).toBe('ask-user');
      expect(relay.respondToPermission).not.toHaveBeenCalled();
    } finally {
      monitor.stop();
    }
  });

  it('global ask-user for MCP is relayed with the decision (not auto-approved)', async () => {
    (globalThis as any).__testGlobalPolicy = {
      ...askUserShellPolicy(),
      permissions: { ...askUserShellPolicy().permissions, mcpTools: 'ask-user' as const },
    };
    const { monitor, relay } = monitored();
    try {
      await (monitor as any).handlePermissionUpdate(baseJob(), mcpEvent());
      expect(relay.handlePermissionRequest).toHaveBeenCalledTimes(1);
      expect((relay.handlePermissionRequest as any).mock.calls[0][3]).toBe('ask-user');
      expect(relay.respondToPermission).not.toHaveBeenCalled();
    } finally {
      monitor.stop();
    }
  });

  it('job-level deny overrides global auto-approve and blocks', async () => {
    (globalThis as any).__testGlobalPolicy = PermissionPolicy.getDefaultPolicy();
    (globalThis as any).__testPlan = {
      id: 'plan-1',
      jobs: [
        {
          name: 'P1 Job',
          permissionPolicy: {
            permissions: {
              fileEdit: { insideWorktree: 'auto-approve', outsideWorktree: 'deny' },
              shellCommand: { insideWorktree: 'deny', outsideWorktree: 'deny' },
              networkAccess: 'deny',
              installPackages: 'deny',
              mcpTools: 'auto-approve',
            },
          },
        },
      ],
    };
    const { monitor, relay } = monitored();
    try {
      await (monitor as any).handlePermissionUpdate(baseJob({ planId: 'plan-1' } as Partial<Job>), shellEvent('/tmp/wt/run.sh'));
      expect(relay.respondToPermission).toHaveBeenCalledTimes(1);
      expect((relay.respondToPermission as any).mock.calls[0][2]).toBe(false);
      expect(relay.handlePermissionRequest).not.toHaveBeenCalled();
    } finally {
      monitor.stop();
    }
  });

  it('plan-level ask-user applies when the job has no policy', async () => {
    (globalThis as any).__testGlobalPolicy = PermissionPolicy.getDefaultPolicy();
    (globalThis as any).__testPlan = {
      id: 'plan-1',
      permissionPolicy: askUserShellPolicy(),
      jobs: [{ name: 'P1 Job' }],
    };
    const { monitor, relay } = monitored();
    try {
      await (monitor as any).handlePermissionUpdate(baseJob({ planId: 'plan-1' } as Partial<Job>), shellEvent('/tmp/wt/run.sh'));
      expect(relay.handlePermissionRequest).toHaveBeenCalledTimes(1);
      expect((relay.handlePermissionRequest as any).mock.calls[0][3]).toBe('ask-user');
      expect(relay.respondToPermission).not.toHaveBeenCalled();
    } finally {
      monitor.stop();
    }
  });

  it('job-level auto-approve wins over plan-level ask-user (positive)', async () => {
    (globalThis as any).__testGlobalPolicy = PermissionPolicy.getDefaultPolicy();
    (globalThis as any).__testPlan = {
      id: 'plan-1',
      permissionPolicy: askUserShellPolicy(),
      jobs: [{ name: 'P1 Job', permissionPolicy: PermissionPolicy.getDefaultPolicy() }],
    };
    const { monitor, relay } = monitored();
    try {
      await (monitor as any).handlePermissionUpdate(baseJob({ planId: 'plan-1' } as Partial<Job>), shellEvent('/tmp/wt/run.sh'));
      expect(relay.respondToPermission).toHaveBeenCalledTimes(1);
      expect((relay.respondToPermission as any).mock.calls[0][2]).toBe(true);
      expect(relay.handlePermissionRequest).not.toHaveBeenCalled();
    } finally {
      monitor.stop();
    }
  });

  it('global auto-approve still auto-approves shell inside worktree (positive)', async () => {
    (globalThis as any).__testGlobalPolicy = PermissionPolicy.getDefaultPolicy();
    const { monitor, relay } = monitored();
    try {
      await (monitor as any).handlePermissionUpdate(baseJob(), shellEvent('/tmp/wt/run.sh'));
      expect(relay.respondToPermission).toHaveBeenCalledTimes(1);
      expect((relay.respondToPermission as any).mock.calls[0][2]).toBe(true);
      expect(relay.handlePermissionRequest).not.toHaveBeenCalled();
    } finally {
      monitor.stop();
    }
  });

  it('file outside worktree is denied by default policy (negative)', async () => {
    (globalThis as any).__testGlobalPolicy = PermissionPolicy.getDefaultPolicy();
    const { monitor, relay } = monitored();
    try {
      await (monitor as any).handlePermissionUpdate(baseJob(), fileEvent('/etc/passwd'));
      expect(relay.respondToPermission).toHaveBeenCalledTimes(1);
      expect((relay.respondToPermission as any).mock.calls[0][2]).toBe(false);
      expect(relay.handlePermissionRequest).not.toHaveBeenCalled();
    } finally {
      monitor.stop();
    }
  });
});
