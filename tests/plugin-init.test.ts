import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const mockState = { isManaged: false };
import * as tmux from '../src/lib/tmux';
import * as worktree from '../src/lib/worktree';
import * as orchestrator from '../src/lib/orchestrator-singleton';
import * as notifications from '../src/hooks/notifications';
import * as planState from '../src/lib/plan-state';

const mockMonitor = {
  start: vi.fn(),
  on: vi.fn(),
};

const createMockClient = () => ({
  session: {
    list: vi.fn().mockResolvedValue([]),
    prompt: vi.fn().mockResolvedValue(undefined),
  },
  config: {
    get: vi.fn().mockResolvedValue({ data: {} }),
  },
  tui: {
    showToast: vi.fn().mockResolvedValue(undefined),
  },
});

describe('plugin initialization', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(tmux, 'isTmuxAvailable').mockResolvedValue(true);
    vi.spyOn(worktree, 'isInManagedWorktree').mockImplementation(() =>
      Promise.resolve({ isManaged: mockState.isManaged }),
    );
    vi.spyOn(orchestrator, 'getSharedMonitor').mockReturnValue(mockMonitor as any);
    vi.spyOn(orchestrator, 'setSharedNotifyCallback').mockImplementation(() => {});
    vi.spyOn(orchestrator, 'getSharedNotifyCallback').mockReturnValue(null);
    vi.spyOn(orchestrator, 'setSharedOrchestrator').mockImplementation(() => {});
    vi.spyOn(notifications, 'setupNotifications').mockImplementation(() => {});
    vi.spyOn(planState, 'loadPlan').mockResolvedValue(null);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('job agent context', () => {
    it('tool object has only mc_report and mc_status', async () => {
      mockState.isManaged = true;
      vi.spyOn(worktree, 'isInManagedWorktree').mockResolvedValue({ isManaged: true });
      
      const { MissionControl } = await import('../src/index');
      const mockClient = createMockClient();
      const plugin = await MissionControl({ client: mockClient } as any);
      
      const toolKeys = Object.keys(plugin.tool || {});
      expect(toolKeys).toHaveLength(2);
      expect(toolKeys).toContain('mc_report');
      expect(toolKeys).toContain('mc_status');
    });

    it('job agent has no mc_report_final (command-center only, registered once)', async () => {
      mockState.isManaged = true;
      vi.spyOn(worktree, 'isInManagedWorktree').mockResolvedValue({ isManaged: true });

      const { MissionControl } = await import('../src/index');
      const mockClient = createMockClient();
      const plugin = await MissionControl({ client: mockClient } as any);

      expect(Object.keys(plugin.tool || {})).not.toContain('mc_report_final');
    });

    it('monitor.start() is not called', async () => {
      mockState.isManaged = true;
      vi.spyOn(worktree, 'isInManagedWorktree').mockResolvedValue({ isManaged: true });
      
      const { MissionControl } = await import('../src/index');
      const mockClient = createMockClient();
      await MissionControl({ client: mockClient } as any);
      
      const mockMonitor = orchestrator.getSharedMonitor();
      expect(mockMonitor.start).not.toHaveBeenCalled();
    });

    it('setupNotifications is not called', async () => {
      mockState.isManaged = true;
      vi.spyOn(worktree, 'isInManagedWorktree').mockResolvedValue({ isManaged: true });
      
      const { MissionControl } = await import('../src/index');
      const mockClient = createMockClient();
      await MissionControl({ client: mockClient } as any);
      
      expect(notifications.setupNotifications).not.toHaveBeenCalled();
    });

    it('setSharedNotifyCallback is not called', async () => {
      mockState.isManaged = true;
      vi.spyOn(worktree, 'isInManagedWorktree').mockResolvedValue({ isManaged: true });
      
      const { MissionControl } = await import('../src/index');
      const mockClient = createMockClient();
      await MissionControl({ client: mockClient } as any);
      
      expect(orchestrator.setSharedNotifyCallback).not.toHaveBeenCalled();
    });

    it('loadPlan is not called', async () => {
      mockState.isManaged = true;
      vi.spyOn(worktree, 'isInManagedWorktree').mockResolvedValue({ isManaged: true });
      
      const { MissionControl } = await import('../src/index');
      const mockClient = createMockClient();
      await MissionControl({ client: mockClient } as any);
      
      expect(planState.loadPlan).not.toHaveBeenCalled();
    });

    it('registerCommands is not called in config hook', async () => {
      mockState.isManaged = true;
      vi.spyOn(worktree, 'isInManagedWorktree').mockResolvedValue({ isManaged: true });
      
      const { MissionControl } = await import('../src/index');
      const mockClient = createMockClient();
      const plugin = await MissionControl({ client: mockClient } as any);
      
      const mockConfig = { commands: [] } as any;
      if (plugin.config) {
        await plugin.config(mockConfig);
      }
      
      expect(mockConfig.commands.length).toBe(0);
    });
  });

  describe('command center context', () => {
    it('tool object has all 21 tools', async () => {
      mockState.isManaged = false;
      vi.spyOn(worktree, 'isInManagedWorktree').mockResolvedValue({ isManaged: false });
      
      const { MissionControl } = await import('../src/index');
      const mockClient = createMockClient();
      const plugin = await MissionControl({ client: mockClient } as any);
      
      const toolKeys = Object.keys(plugin.tool || {});
      expect(toolKeys).toHaveLength(21);
      // Registered once, never duplicated: mc_report_final appears exactly
      // once and is a distinct tool from mc_report.
      expect(toolKeys.filter((k) => k === 'mc_report_final')).toHaveLength(1);
      expect(plugin.tool.mc_report).not.toBe(plugin.tool.mc_report_final);
      expect(toolKeys).toContain('mc_launch');
      expect(toolKeys).toContain('mc_jobs');
      expect(toolKeys).toContain('mc_status');
      expect(toolKeys).toContain('mc_diff');
      expect(toolKeys).toContain('mc_pr');
      expect(toolKeys).toContain('mc_merge');
      expect(toolKeys).toContain('mc_sync');
      expect(toolKeys).toContain('mc_cleanup');
      expect(toolKeys).toContain('mc_kill');
      expect(toolKeys).toContain('mc_attach');
      expect(toolKeys).toContain('mc_capture');
      expect(toolKeys).toContain('mc_plan');
      expect(toolKeys).toContain('mc_plan_status');
      expect(toolKeys).toContain('mc_plan_cancel');
      expect(toolKeys).toContain('mc_plan_approve');
      expect(toolKeys).toContain('mc_report');
      expect(toolKeys).toContain('mc_report_final');
      expect(toolKeys).toContain('mc_overview');
      expect(toolKeys).toContain('mc_answer');
      expect(toolKeys).toContain('mc_job_pause');
      expect(toolKeys).toContain('mc_job_resume');
    });

    it('monitor.start() is called', async () => {
      mockState.isManaged = false;
      vi.spyOn(worktree, 'isInManagedWorktree').mockResolvedValue({ isManaged: false });
      
      const { MissionControl } = await import('../src/index');
      const mockClient = createMockClient();
      await MissionControl({ client: mockClient } as any);
      
      const mockMonitor = orchestrator.getSharedMonitor();
      expect(mockMonitor.start).toHaveBeenCalled();
    });

    it('setupNotifications is called', async () => {
      mockState.isManaged = false;
      vi.spyOn(worktree, 'isInManagedWorktree').mockResolvedValue({ isManaged: false });
      
      const { MissionControl } = await import('../src/index');
      const mockClient = createMockClient();
      await MissionControl({ client: mockClient } as any);
      
      expect(notifications.setupNotifications).toHaveBeenCalled();
    });

    it('setSharedNotifyCallback is called', async () => {
      mockState.isManaged = false;
      vi.spyOn(worktree, 'isInManagedWorktree').mockResolvedValue({ isManaged: false });
      
      const { MissionControl } = await import('../src/index');
      const mockClient = createMockClient();
      await MissionControl({ client: mockClient } as any);
      
      expect(orchestrator.setSharedNotifyCallback).toHaveBeenCalled();
    });

    it('loadPlan is called', async () => {
      mockState.isManaged = false;
      vi.spyOn(worktree, 'isInManagedWorktree').mockResolvedValue({ isManaged: false });
      
      const { MissionControl } = await import('../src/index');
      const mockClient = createMockClient();
      await MissionControl({ client: mockClient } as any);
      
      expect(planState.loadPlan).toHaveBeenCalled();
    });
  });

  describe('v2 entrypoint (OpenCode 2.1.4)', () => {
    it('default export is a v2 definition with id and setup', async () => {
      const mod = await import('../src/index');
      expect(mod.default).toMatchObject({ id: 'opencode-mission-control' });
      expect(typeof (mod.default as any).setup).toBe('function');
    });

    it('v2 setup registers v1 tools via transform', async () => {
      mockState.isManaged = false;
      vi.spyOn(worktree, 'isInManagedWorktree').mockResolvedValue({ isManaged: false });
      const mod = await import('../src/index');
      const added: any[] = [];
      const mockCtx = {
        location: { directory: process.cwd() },
        client: createMockClient(),
        tool: {
          transform: vi.fn(async (fn: any) => {
            fn({ add: (t: any) => added.push(t) });
          }),
          hook: vi.fn(async () => {}),
        },
        event: { subscribe: () => (async function* () {})() },
        session: { hook: vi.fn(async () => {}) },
      };
      await (mod.default as any).setup(mockCtx);
      const names = added.map((t) => t.name);
      expect(names).toContain('mc_launch');
      expect(names).toContain('mc_status');
      expect(names).toHaveLength(21);
      // V2 execute returns structured content, not a bare string.
      const status = added.find((t) => t.name === 'mc_status');
      expect(status.input).toMatchObject({ type: 'object' });
    });
  });
});
