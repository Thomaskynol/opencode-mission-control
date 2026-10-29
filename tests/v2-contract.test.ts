import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import * as tmux from '../src/lib/tmux';
import * as worktree from '../src/lib/worktree';
import * as orchestrator from '../src/lib/orchestrator-singleton';
import * as notifications from '../src/hooks/notifications';
import * as planState from '../src/lib/plan-state';

const EXPECTED_TOOLS = [
  'mc_launch',
  'mc_jobs',
  'mc_status',
  'mc_diff',
  'mc_pr',
  'mc_merge',
  'mc_sync',
  'mc_cleanup',
  'mc_kill',
  'mc_attach',
  'mc_capture',
  'mc_plan',
  'mc_plan_status',
  'mc_plan_cancel',
  'mc_plan_approve',
  'mc_report',
  'mc_report_final',
  'mc_overview',
  'mc_answer',
  'mc_job_pause',
  'mc_job_resume',
];

const mockMonitor = { start: vi.fn(), on: vi.fn() };

const createMockClient = () => ({
  session: {
    list: vi.fn().mockResolvedValue([]),
    prompt: vi.fn().mockResolvedValue(undefined),
  },
  config: { get: vi.fn().mockResolvedValue({ data: {} }) },
  tui: { showToast: vi.fn().mockResolvedValue(undefined) },
});

async function getV2Tools() {
  const mod = await import('../src/index');
  const added: any[] = [];
  const mockCtx: any = {
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
  const cleanup = await (mod.default as any).setup(mockCtx);
  if (typeof cleanup === 'function') {
    try {
      cleanup();
    } catch {}
  }
  return added;
}

describe('v2 contract: 21 tools registered via adapter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(tmux, 'isTmuxAvailable').mockResolvedValue(true);
    vi.spyOn(worktree, 'isInManagedWorktree').mockResolvedValue({ isManaged: false } as any);
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

  it('registers exactly the 21 expected tools', async () => {
    const added = await getV2Tools();
    const names = added.map((t) => t.name).sort();
    expect(names).toEqual([...EXPECTED_TOOLS].sort());
    expect(added).toHaveLength(21);
  });

  it.each(EXPECTED_TOOLS)('%s has name, description, object input and execute function', async (name) => {
    const added = await getV2Tools();
    const t = added.find((x) => x.name === name);
    expect(t).toBeDefined();
    expect(typeof t.description).toBe('string');
    expect(t.description.length).toBeGreaterThan(0);
    expect(t.input).toMatchObject({ type: 'object' });
    expect(typeof t.execute).toBe('function');
  });

  it('v2 input properties match v1 args keys per tool', async () => {
    const added = await getV2Tools();
    const v1: Record<string, any> = await import('../src/index').then(async () => {
      // Import v1 tools directly to compare arg keys.
      const mods: Record<string, string> = {
        mc_launch: '../src/tools/launch',
        mc_jobs: '../src/tools/jobs',
        mc_status: '../src/tools/status',
        mc_diff: '../src/tools/diff',
        mc_pr: '../src/tools/pr',
        mc_merge: '../src/tools/merge',
        mc_sync: '../src/tools/sync',
        mc_cleanup: '../src/tools/cleanup',
        mc_kill: '../src/tools/kill',
        mc_attach: '../src/tools/attach',
        mc_capture: '../src/tools/capture',
        mc_plan: '../src/tools/plan',
        mc_plan_status: '../src/tools/plan-status',
        mc_plan_cancel: '../src/tools/plan-cancel',
        mc_plan_approve: '../src/tools/plan-approve',
        mc_report: '../src/tools/report',
        mc_report_final: '../src/tools/report',
        mc_overview: '../src/tools/overview',
        mc_answer: '../src/tools/answer',
        mc_job_pause: '../src/tools/job-pause',
        mc_job_resume: '../src/tools/job-resume',
      };
      const out: Record<string, any> = {};
      for (const [toolName, path] of Object.entries(mods)) {
        const m: any = await import(path);
        out[toolName] = m[toolName];
      }
      return out;
    });
    for (const t of added) {
      const v1Tool = v1[t.name];
      expect(v1Tool, `${t.name} v1 exists`).toBeDefined();
      const v1Keys = Object.keys(v1Tool?.args ?? {}).sort();
      const v2Props = Object.keys((t.input as any)?.properties ?? {}).sort();
      expect(v2Props, `${t.name} input properties`).toEqual(v1Keys);
    }
  });
});

describe('v2 execution shape: read-only tools via adapter (harness local, sem LLM)', () => {
  let xdgDir = '';
  let probeDir = '';

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(tmux, 'isTmuxAvailable').mockResolvedValue(true);
    vi.spyOn(worktree, 'isInManagedWorktree').mockResolvedValue({ isManaged: false } as any);
    vi.spyOn(orchestrator, 'getSharedMonitor').mockReturnValue(mockMonitor as any);
    vi.spyOn(orchestrator, 'setSharedNotifyCallback').mockImplementation(() => {});
    vi.spyOn(orchestrator, 'getSharedNotifyCallback').mockReturnValue(null);
    vi.spyOn(orchestrator, 'setSharedOrchestrator').mockImplementation(() => {});
    vi.spyOn(notifications, 'setupNotifications').mockImplementation(() => {});
    xdgDir = mkdtempSync(join(tmpdir(), 'mc-v2-xdg-'));
    probeDir = mkdtempSync(join(tmpdir(), 'mc-v2-probe-'));
    process.env.MC_XDG_DATA_DIR = xdgDir;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.MC_XDG_DATA_DIR;
    if (xdgDir) rmSync(xdgDir, { recursive: true, force: true });
    if (probeDir) rmSync(probeDir, { recursive: true, force: true });
  });

  it('mc_overview executes via v2 wrapper and returns structured text content', async () => {
    const added = await getV2Tools();
    const t = added.find((x) => x.name === 'mc_overview');
    const prev = process.cwd();
    process.chdir(probeDir);
    try {
      const out: any = await t.execute({});
      expect(out).toHaveProperty('content');
      expect(out.content).toHaveLength(1);
      expect(out.content[0].type).toBe('text');
      expect(typeof out.content[0].text).toBe('string');
      expect(out.content[0].text).toContain('Mission Control Dashboard');
    } finally {
      process.chdir(prev);
    }
  });

  it('mc_jobs executes via v2 wrapper and returns structured text content', async () => {
    const added = await getV2Tools();
    const t = added.find((x) => x.name === 'mc_jobs');
    const prev = process.cwd();
    process.chdir(probeDir);
    try {
      const out: any = await t.execute({});
      expect(out.content[0].type).toBe('text');
      expect(out.content[0].text).toMatch(/Mission Control Jobs|No jobs found/);
    } finally {
      process.chdir(prev);
    }
  });

  it('mc_plan_status executes via v2 wrapper and returns structured text content', async () => {
    const added = await getV2Tools();
    const t = added.find((x) => x.name === 'mc_plan_status');
    const prev = process.cwd();
    process.chdir(probeDir);
    try {
      const out: any = await t.execute({});
      expect(out.content[0].type).toBe('text');
      expect(out.content[0].text).toMatch(/No active plan|Plan/);
    } finally {
      process.chdir(prev);
    }
  });
});
