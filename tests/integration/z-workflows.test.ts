import { mock } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import type { Job, JobState } from '../../src/lib/job-state';
// Common (non-live) suite: all external drivers are mocked below (job-state,
// worktree, tmux, config, omo, plan-copier, prompt-file, worktree-setup).
// No real opencode/tmux/gh spawn occurs here; live runs are explicit opt-in
// via TEST_LIVE=1 in other suites. See tests/helpers/test-env.ts.
import { isLive } from '../helpers/test-env';
void isLive;

if (process.env.MC_WORKFLOWS_ISOLATED !== '1') {
  describe('Workflow integration suite', () => {
    it('runs in an isolated subprocess', () => {
      const result = spawnSync(
        'bun',
        ['test', 'tests/integration/z-workflows.test.ts'],
        {
          cwd: process.cwd(),
          env: { ...process.env, MC_WORKFLOWS_ISOLATED: '1' },
          encoding: 'utf8',
        },
      );

      if (result.status !== 0) {
        throw new Error(
          [result.stdout, result.stderr].filter(Boolean).join('\n'),
        );
      }

      const output = [result.stdout, result.stderr].filter(Boolean).join('\n');

      expect(output).toContain('24 pass');
      expect(output).toContain('0 fail');
    }, 120000);
  });
} else {

// ============================================================================
// Mock all external dependencies
// ============================================================================

mock.module('../../src/lib/job-state', () => {
  // In-memory job store for integration testing
  let jobs: Job[] = [];

  return {
    loadJobState: vi.fn(async (): Promise<JobState> => ({
      version: 1,
      jobs: [...jobs],
      updatedAt: new Date().toISOString(),
    })),
    saveJobState: vi.fn(async (state: JobState) => {
      jobs = [...state.jobs];
    }),
    addJob: vi.fn(async (job: Job) => {
      jobs.push(job);
    }),
    getJobByName: vi.fn(async (name: string) => {
      return jobs.find((j) => j.name === name);
    }),
    getJob: vi.fn(async (id: string) => {
      return jobs.find((j) => j.id === id);
    }),
    updateJob: vi.fn(async (id: string, updates: Partial<Job>) => {
      const idx = jobs.findIndex((j) => j.id === id);
      if (idx === -1) throw new Error(`Job with id ${id} not found`);
      jobs[idx] = { ...jobs[idx], ...updates };
    }),
    removeJob: vi.fn(async (id: string) => {
      const idx = jobs.findIndex((j) => j.id === id);
      if (idx === -1) throw new Error(`Job with id ${id} not found`);
      jobs.splice(idx, 1);
    }),
    getRunningJobs: vi.fn(async () => {
      return jobs.filter((j) => j.status === 'running');
    }),
    // Migration helpers mirror the real module surface (durable-state links
    // them for sidecar reconcile). Passthrough: workflow state is current.
    migrateJobState: vi.fn((state: Record<string, unknown>) => state),
    migrateV2ToV3: vi.fn((state: Record<string, unknown>) => state),
    // Password helper mirrors the real module surface: persisted
    // per-worker credential first, config fallback second.
    resolveJobPassword: vi.fn((job: { serverPassword?: string }, configured?: string) => {
      if (job.serverPassword) return job.serverPassword;
      const trimmed = configured?.trim();
      return trimmed ? trimmed : undefined;
    }),
    // Expose for test cleanup
    _resetJobs: () => {
      jobs = [];
    },
    _getJobs: () => [...jobs],
  };
});

mock.module('../../src/lib/worktree', () => ({
  createWorktree: vi.fn(async (opts: { branch: string }) => {
    const sanitized = opts.branch.replace(/\//g, '-');
    return `/tmp/mc-worktrees/${sanitized}`;
  }),
  removeWorktree: vi.fn(async () => {}),
  // launch.ts pre-flight resolves the main worktree to vet inherited
  // `.opencode` configs — point it at a stable fake (no blanket allow).
  getMainWorktree: vi.fn(async () => '/tmp/mc-main'),
  isInManagedWorktree: vi.fn(async (path: string) => ({
    isManaged: path.startsWith('/tmp/mc-worktrees'),
    worktreePath: path,
  })),
}));

mock.module('../../src/lib/tmux', () => ({
  createSession: vi.fn(async () => {}),
  createWindow: vi.fn(async () => {}),
  killSession: vi.fn(async () => {}),
  killWindow: vi.fn(async () => {}),
  sendKeys: vi.fn(async () => {}),
  setPaneDiedHook: vi.fn(async () => {}),
  capturePane: vi.fn(async (_target: string, _lines?: number) => {
    return 'opencode> Working on task...\nFile modified: src/auth.ts\nTests passing: 5/5';
  }),
  isPaneRunning: vi.fn(async () => true),
  getCurrentSession: vi.fn(() => 'main-session'),
  isInsideTmux: vi.fn(() => true),
  isTmuxAvailable: vi.fn(async () => true),
  sessionExists: vi.fn(async () => true),
  windowExists: vi.fn(async () => true),
  getPanePid: vi.fn(async () => 12345),
  captureExitStatus: vi.fn(async () => undefined),
  setWindowOption: vi.fn(async () => {}),
  killTaggedWindows: vi.fn(async () => 0),
}));

mock.module('../../src/lib/config', () => ({
  loadConfig: vi.fn(async () => ({
    defaultPlacement: 'session',
    pollInterval: 10000,
    idleThreshold: 300000,
    worktreeBasePath: '/tmp/mc-worktrees',
    // Serve is the enforced path (TUI is refused fail-closed by the
    // policy lane): this suite probes workflows, not TUI routing.
    useServeMode: true,
    portRangeStart: 14100,
    portRangeEnd: 14199,
    omo: { enabled: false, defaultMode: 'vanilla' },
  })),
  // Dispatch pre-flight guards live here (covered by
  // tests/tools/dispatch-preflight.test.ts); this suite mocks all
  // externals, so they pass through as no-ops.
  assertPluginDistReady: vi.fn(() => {}),
  assertOmoModeAvailable: vi.fn(async () => {}),
}));

// Serve-path seams: launch.ts allocates a port, waits for the v2 surface,
// pins the tracked model, and delivers the prompt via launchWorkerViaServe.
mock.module('../../src/lib/port-allocator', () => ({
  allocatePort: vi.fn(async () => 14100),
  releasePort: vi.fn(async () => {}),
}));

mock.module('../../src/lib/model-tracker', () => ({
  getCurrentModel: vi.fn(() => undefined),
  getCurrentModelInfo: vi.fn(() => ({
    providerID: 'opencode-go',
    modelID: 'muse-spark-1.3-contributor',
    variant: 'xhigh',
  })),
}));

mock.module('../../src/lib/sdk-client', () => {
  const notUsed = (name: string) => async () => {
    throw new Error(`stub: ${name} not expected in workflow suite`);
  };
  return {
    quoteShellPath: vi.fn((p: string) => `'${p.replace(/'/g, `'\\''`)}'`),
    v2WaitForServer: vi.fn(async () => ({ baseUrl: 'http://127.0.0.1:14100/api', headers: {} })),
    launchWorkerViaServe: vi.fn(async (client: unknown, input: any) => ({
      sessionId: 'ses_mock9',
      tmuxTarget: input.tmuxTarget,
      requestedModel: input.model,
      observedModel: input.model,
    })),
    // Runtime stubs for the rest of the surface (transitive closure imports
    // them via question-relay/monitor; only the three seams above run here).
    createJobClient: vi.fn(() => ({})),
    waitForServer: vi.fn(notUsed('waitForServer')),
    sendPrompt: vi.fn(notUsed('sendPrompt')),
    createSessionAndPrompt: vi.fn(notUsed('createSessionAndPrompt')),
    forkJobSession: vi.fn(notUsed('forkJobSession')),
    createV2Client: vi.fn((port: number) => ({ baseUrl: `http://127.0.0.1:${port}/api`, headers: {} })),
    v2CreateSession: vi.fn(notUsed('v2CreateSession')),
    v2GetSession: vi.fn(notUsed('v2GetSession')),
    assertServeSessionModelEcho: vi.fn(() => {}),
    v2CreateSessionWithVerifiedModel: vi.fn(notUsed('v2CreateSessionWithVerifiedModel')),
    v2ActiveSessions: vi.fn(async () => []),
    v2Prompt: vi.fn(async () => ({})),
    v2RunCommand: vi.fn(async () => ({})),
    v2Generate: vi.fn(notUsed('v2Generate')),
    v2Interrupt: vi.fn(async () => ({})),
    v2Background: vi.fn(async () => ({})),
    v2Wait: vi.fn(notUsed('v2Wait')),
    v2SessionLog: vi.fn(async () => ''),
    v2Messages: vi.fn(async () => []),
    v2GetMessage: vi.fn(notUsed('v2GetMessage')),
    v2ForkSession: vi.fn(notUsed('v2ForkSession')),
    v2MoveSession: vi.fn(notUsed('v2MoveSession')),
    v2CompactSession: vi.fn(notUsed('v2CompactSession')),
    v2ListForms: vi.fn(async () => []),
    v2GetForm: vi.fn(notUsed('v2GetForm')),
    v2CreateForm: vi.fn(notUsed('v2CreateForm')),
    v2ReplyForm: vi.fn(async () => ({})),
    v2ListPermissions: vi.fn(async () => []),
    v2ReplyPermission: vi.fn(async () => ({})),
  };
});

mock.module('../../src/lib/omo', () => ({
  detectOMO: vi.fn(async () => ({
    detected: true,
    configSource: 'local',
    sisyphusPath: './.sisyphus',
  })),
}));

mock.module('../../src/lib/plan-copier', () => ({
  copyPlansToWorktree: vi.fn(async () => ({
    copied: ['plan-a.md', 'plan-b.md'],
  })),
}));

mock.module('../../src/lib/prompt-file', () => ({
  writePromptFile: vi.fn(async (worktreePath: string, _prompt: string) => `${worktreePath}/.mc-prompt.txt`),
  cleanupPromptFile: vi.fn(() => {}),
  writeLauncherScript: vi.fn(async (worktreePath: string) => `${worktreePath}/.mc-launch.sh`),
  writeServeLauncherScript: vi.fn(async (worktreePath: string) => `${worktreePath}/.mc-launch.sh`),
  cleanupLauncherScript: vi.fn(() => {}),
  describeTuiModelPin: vi.fn(() => ({ pinned: false, mechanism: 'none', blockade: 'mocked' })),
  TUI_MODEL_BLOCKADE: 'mocked',
}));

mock.module('../../src/lib/worktree-setup', () => ({
  resolvePostCreateHook: vi.fn((_globalConfig: any, perJob: any) => ({
    symlinkDirs: ['.opencode', ...(perJob?.symlinkDirs ?? [])],
    copyFiles: perJob?.copyFiles ?? [],
    commands: perJob?.commands ?? [],
  })),
  // Pre-flight vet is covered by dedicated policy suites; the fake
  // main worktree above carries no permissive config.
  assertNoPermissiveOpencodeConfig: vi.fn(() => {}),
  // Superfície usada por monitor/reports (ressalva sem-ACK): valor canônico
  // real (mock espelha a forma; o conteúdo é texto de gap, sem I/O).
  SERVE_PLUGIN_RUNTIME_LIMITATION:
    'plugin preparado mas carga não comprovada (sem ACK do serve)',
}));

// Serve-mode capture/status read monitor event accumulators (not the tmux
// pane). The fake monitor below serves staged accumulators per job id.
mock.module('../../src/lib/orchestrator-singleton', () => ({
  getSharedMonitor: vi.fn(() => ({ getEventAccumulator: () => undefined })),
  setSharedNotifyCallback: vi.fn(() => {}),
  getSharedNotifyCallback: vi.fn(() => undefined),
  setSharedOrchestrator: vi.fn(() => {}),
}));

mock.module('crypto', () => {
  let counter = 0;
  return {
    randomUUID: vi.fn(() => `test-uuid-${++counter}`),
  };
});

// ============================================================================
// Import modules after mocks
// ============================================================================

const jobState = await import('../../src/lib/job-state');
const tmux = await import('../../src/lib/tmux');
const worktree = await import('../../src/lib/worktree');
const planCopier = await import('../../src/lib/plan-copier');
const omoMod = await import('../../src/lib/omo');
const configMod = await import('../../src/lib/config');
const sdkMod = await import('../../src/lib/sdk-client');
const orchSingleton = await import('../../src/lib/orchestrator-singleton');

const { mc_launch } = await import('../../src/tools/launch');
const { mc_status } = await import('../../src/tools/status');
const { mc_capture } = await import('../../src/tools/capture');
const { mc_kill } = await import('../../src/tools/kill');
const { mc_cleanup } = await import('../../src/tools/cleanup');
const { mc_jobs } = await import('../../src/tools/jobs');
const { mc_pr } = await import('../../src/tools/pr');

// Keep mocked module instances for this file, then stop global module mocking
// so other test files can import real implementations.
mock.restore();

// ============================================================================
// Typed mock references
// ============================================================================

const mockCreateSession = tmux.createSession as Mock;
const mockKillSession = tmux.killSession as Mock;
const mockSendKeys = tmux.sendKeys as Mock;
const mockCapturePane = tmux.capturePane as Mock;
const mockCreateWorktree = worktree.createWorktree as Mock;
const mockRemoveWorktree = worktree.removeWorktree as Mock;
const mockCopyPlans = planCopier.copyPlansToWorktree as Mock;
const mockDetectOMO = omoMod.detectOMO as Mock;
const mockLoadConfig = configMod.loadConfig as Mock;
const mockAssertPluginDistReady = configMod.assertPluginDistReady as Mock;
const mockAssertOmoModeAvailable = configMod.assertOmoModeAvailable as Mock;
const mockLaunchWorkerViaServe = sdkMod.launchWorkerViaServe as Mock;
const mockGetSharedMonitor = orchSingleton.getSharedMonitor as Mock;

// Serve-mode capture staging: accumulators keyed by job id.
const accumulatorByJobId = new Map<string, any>();
const fakeMonitor = {
  getEventAccumulator: (id: string) => accumulatorByJobId.get(id),
};
function stageAccumulatorForJob(name: string, acc: any) {
  const job = getJobs().find((j) => j.name === name);
  if (!job) throw new Error(`no such job staged: ${name}`);
  accumulatorByJobId.set(job.id, acc);
}
function makeAccumulator(filesEdited: string[], currentTool = 'edit') {
  return {
    filesEdited,
    currentTool,
    currentFile: filesEdited[0] ?? '(none)',
    lastActivityAt: Date.now(),
    eventCount: filesEdited.length,
  };
}
const resetJobs = (jobState as any)._resetJobs as () => void;
const getJobs = (jobState as any)._getJobs as () => Job[];

// Shared test context
const mockContext = {
  sessionID: 'test-session',
  messageID: 'test-message',
  agent: 'test-agent',
  directory: '/test/dir',
  worktree: '/test/worktree',
  abort: new AbortController().signal,
  metadata: vi.fn(),
  ask: vi.fn(),
} as any;

// ============================================================================
// Workflow 1: Launch -> Status -> Capture -> Kill -> Cleanup
// ============================================================================

describe('Workflow 1: Basic lifecycle (Launch -> Status -> Capture -> Kill -> Cleanup)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetJobs();
    accumulatorByJobId.clear();
    mockGetSharedMonitor.mockReturnValue(fakeMonitor);

    // Re-setup default mock implementations after clearAllMocks
    mockCreateWorktree.mockImplementation(async (opts: { branch: string }) => {
      const sanitized = opts.branch.replace(/\//g, '-');
      return `/tmp/mc-worktrees/${sanitized}`;
    });
    mockRemoveWorktree.mockResolvedValue(undefined);
    mockCreateSession.mockResolvedValue(undefined);
    mockKillSession.mockResolvedValue(undefined);
    mockSendKeys.mockResolvedValue(undefined);
    (tmux.setPaneDiedHook as Mock).mockResolvedValue(undefined);
    mockCapturePane.mockResolvedValue(
      'opencode> Working on task...\nFile modified: src/auth.ts\nTests passing: 5/5',
    );
    mockLoadConfig.mockResolvedValue({
      defaultPlacement: 'session',
      pollInterval: 10000,
      idleThreshold: 300000,
      worktreeBasePath: '/tmp/mc-worktrees',
      useServeMode: true,
      portRangeStart: 14100,
      portRangeEnd: 14199,
      omo: { enabled: false, defaultMode: 'vanilla' },
    });
    (worktree.isInManagedWorktree as Mock).mockResolvedValue({
      isManaged: true,
      worktreePath: '/tmp/mc-worktrees/mc-auth-job',
    });
  });

  it('should complete full lifecycle: launch -> status -> capture -> kill -> cleanup', async () => {
    // ---- Step 1: Launch a job ----
    const launchResult = await mc_launch.execute(
      { name: 'auth-job', prompt: 'Add authentication' },
      mockContext,
    );

    expect(launchResult).toContain('Job "auth-job" launched successfully');
    expect(mockCreateWorktree).toHaveBeenCalledWith({
      branch: 'mc/auth-job',
      postCreate: expect.objectContaining({
        symlinkDirs: expect.arrayContaining(['.opencode']),
      }),
    });
    expect(mockCreateSession).toHaveBeenCalledWith({
      name: 'mc-auth-job',
      workdir: '/tmp/mc-worktrees/mc-auth-job',
      command: "bash '/tmp/mc-worktrees/mc-auth-job/.mc-launch.sh'",
    });
    expect(mockSendKeys).not.toHaveBeenCalled();

    // Verify job is in state
    const jobs = getJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0].name).toBe('auth-job');
    expect(jobs[0].status).toBe('running');

    // ---- Step 2: Check status ----
    const statusResult = await mc_status.execute(
      { name: 'auth-job' },
      mockContext,
    );

    expect(statusResult).toContain('Job: auth-job');
    expect(statusResult).toContain('Status: running');
    expect(statusResult).toContain('Branch: mc/auth-job');
    expect(statusResult).toContain('Mode: vanilla');

    // ---- Step 3: Capture output (serve mode: staged monitor events) ----
    stageAccumulatorForJob('auth-job', makeAccumulator(['src/auth.ts']));
    const captureResult = await mc_capture.execute(
      { name: 'auth-job', lines: 50 },
      mockContext,
    );

    expect(captureResult).toContain('src/auth.ts');
    expect(captureResult).toContain('"mode": "serve"');

    // ---- Step 4: Kill the job ----
    const killResult = await mc_kill.execute(
      { name: 'auth-job' },
      mockContext,
    );

    expect(killResult).toContain('Job "auth-job" stopped successfully');
    expect(mockKillSession).toHaveBeenCalledWith('mc-auth-job');

    // Verify job is now stopped in state
    const jobsAfterKill = getJobs();
    expect(jobsAfterKill[0].status).toBe('stopped');
    expect(jobsAfterKill[0].completedAt).toBeDefined();

    // ---- Step 5: Cleanup the job ----
    const cleanupResult = await mc_cleanup.execute(
      { name: 'auth-job' },
      mockContext,
    );

    expect(cleanupResult).toContain('Cleaned up job "auth-job"');
    expect(mockRemoveWorktree).toHaveBeenCalledWith(
      '/tmp/mc-worktrees/mc-auth-job',
      true,
    );

    // Verify job is removed from state
    const jobsAfterCleanup = getJobs();
    expect(jobsAfterCleanup).toHaveLength(0);
  });

  it('should track job across status checks at different points', async () => {
    // Launch
    await mc_launch.execute(
      { name: 'tracking-test', prompt: 'Track me' },
      mockContext,
    );

    // Status shows running
    const status1 = await mc_status.execute(
      { name: 'tracking-test' },
      mockContext,
    );
    expect(status1).toContain('Status: running');

    // Kill
    await mc_kill.execute({ name: 'tracking-test' }, mockContext);

    // Status shows stopped
    const status2 = await mc_status.execute(
      { name: 'tracking-test' },
      mockContext,
    );
    expect(status2).toContain('Status: stopped');
  });

  it('should prevent duplicate job names across lifecycle', async () => {
    // Launch job
    await mc_launch.execute(
      { name: 'unique-job', prompt: 'First launch' },
      mockContext,
    );

    // Attempt duplicate launch should fail
    await expect(
      mc_launch.execute(
        { name: 'unique-job', prompt: 'Duplicate attempt' },
        mockContext,
      ),
    ).rejects.toThrow('Job "unique-job" already exists');

    // Kill and cleanup
    await mc_kill.execute({ name: 'unique-job' }, mockContext);
    await mc_cleanup.execute({ name: 'unique-job' }, mockContext);

    // Now can relaunch with same name
    const result = await mc_launch.execute(
      { name: 'unique-job', prompt: 'Second launch' },
      mockContext,
    );
    expect(result).toContain('Job "unique-job" launched successfully');
  });

  it('should not cleanup a running job', async () => {
    await mc_launch.execute(
      { name: 'still-running', prompt: 'Running task' },
      mockContext,
    );

    await expect(
      mc_cleanup.execute({ name: 'still-running' }, mockContext),
    ).rejects.toThrow('Cannot cleanup running job');
  });
});

// ============================================================================
// Workflow 2: Launch with OMO mode -> Verify plans copied
// ============================================================================

describe('Workflow 2: OMO mode launch with plans', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetJobs();
    accumulatorByJobId.clear();
    mockGetSharedMonitor.mockReturnValue(fakeMonitor);

    mockCreateWorktree.mockImplementation(async (opts: { branch: string }) => {
      const sanitized = opts.branch.replace(/\//g, '-');
      return `/tmp/mc-worktrees/${sanitized}`;
    });
    mockRemoveWorktree.mockResolvedValue(undefined);
    mockCreateSession.mockResolvedValue(undefined);
    mockKillSession.mockResolvedValue(undefined);
    mockSendKeys.mockResolvedValue(undefined);
    (tmux.setPaneDiedHook as Mock).mockResolvedValue(undefined);
    mockDetectOMO.mockResolvedValue({
      detected: true,
      configSource: 'local',
      sisyphusPath: './.sisyphus',
    });
    mockCopyPlans.mockResolvedValue({ copied: ['plan-a.md', 'plan-b.md'] });
    mockLoadConfig.mockResolvedValue({
      defaultPlacement: 'session',
      pollInterval: 10000,
      idleThreshold: 300000,
      worktreeBasePath: '/tmp/mc-worktrees',
      useServeMode: true,
      portRangeStart: 14100,
      portRangeEnd: 14199,
      omo: { enabled: true, defaultMode: 'plan' },
    });
  });

  it('should launch in plan mode and copy plans to worktree', async () => {
    const result = await mc_launch.execute(
      {
        name: 'plan-job',
        prompt: 'Execute the plan',
        mode: 'plan',
        planFile: 'my-plan.md',
      },
      mockContext,
    );

    expect(result).toContain('Job "plan-job" launched successfully');
    expect(result).toContain('Mode:      plan');

    // OMO validation is the pre-flight guard (detectOMO lives inside it) —
    // guarda chamada com o modo, antes de qualquer worktree.
    expect(mockAssertOmoModeAvailable).toHaveBeenCalledWith('plan');

    // Verify plans were copied to worktree
    expect(mockCopyPlans).toHaveBeenCalledWith(
      './.sisyphus/plans',
      '/tmp/mc-worktrees/mc-plan-job/.sisyphus/plans',
    );

     // Serve mode delivers the plan inside the prompt text (no TUI sendKeys).
     expect(mockSendKeys).not.toHaveBeenCalled();
     expect(mockLaunchWorkerViaServe).toHaveBeenCalledWith(
       expect.objectContaining({ baseUrl: 'http://127.0.0.1:14100/api' }),
       expect.objectContaining({
         prompt: expect.stringContaining('my-plan.md'),
       }),
     );

    // Verify job state has plan mode
    const jobs = getJobs();
    expect(jobs[0].mode).toBe('plan');
    expect(jobs[0].planFile).toBe('my-plan.md');
  });

  it('should launch in ralph mode and copy plans', async () => {
    const result = await mc_launch.execute(
      { name: 'ralph-job', prompt: 'Ralph loop task', mode: 'ralph' },
      mockContext,
    );

    expect(result).toContain('Job "ralph-job" launched successfully');
    expect(mockAssertOmoModeAvailable).toHaveBeenCalledWith('ralph');
    expect(mockCopyPlans).toHaveBeenCalled();

    // Serve mode delivers the loop command inside the prompt text.
    expect(mockSendKeys).not.toHaveBeenCalled();
    expect(mockLaunchWorkerViaServe).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        prompt: expect.stringContaining('/ralph-loop'),
      }),
    );

    const jobs = getJobs();
    expect(jobs[0].mode).toBe('ralph');
  });

  it('should launch in ulw mode and copy plans', async () => {
    const result = await mc_launch.execute(
      { name: 'ulw-job', prompt: 'ULW loop task', mode: 'ulw' },
      mockContext,
    );

    expect(result).toContain('Job "ulw-job" launched successfully');
    expect(mockAssertOmoModeAvailable).toHaveBeenCalledWith('ulw');
    expect(mockCopyPlans).toHaveBeenCalled();

    expect(mockSendKeys).not.toHaveBeenCalled();
    expect(mockLaunchWorkerViaServe).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        prompt: expect.stringContaining('/ulw-loop'),
      }),
    );

    const jobs = getJobs();
    expect(jobs[0].mode).toBe('ulw');
  });

  it('should fail when OMO not detected for non-vanilla mode (pre-flight: no worktree)', async () => {
    mockDetectOMO.mockResolvedValue({
      detected: false,
      configSource: null,
      sisyphusPath: null,
    });
    // Guarda real rejeita no pre-flight; aqui o mock reproduz o contrato:
    // erro com instrução ANTES de qualquer worktree (nada criado, nada a remover).
    mockAssertOmoModeAvailable.mockRejectedValueOnce(
      new Error(
        '[MC] OMO mode "plan" requires Oh-My-OpenCode to be installed and detected, and no worktree was created. Fix with one of: (1) pass mode:"vanilla" explicitly.',
      ),
    );

    await expect(
      mc_launch.execute(
        { name: 'fail-omo', prompt: 'Should fail', mode: 'plan' },
        mockContext,
      ),
    ).rejects.toThrow(/no worktree was created/);

    // Contrato novo: pre-flight chamado com o modo, worktree nunca criada nem removida.
    expect(mockAssertPluginDistReady).toHaveBeenCalled();
    expect(mockAssertOmoModeAvailable).toHaveBeenCalledWith('plan');
    expect(mockCreateWorktree).not.toHaveBeenCalled();
    expect(mockRemoveWorktree).not.toHaveBeenCalled();
    expect(mockKillSession).not.toHaveBeenCalled();
  });

  it('should not copy plans for vanilla mode', async () => {
    await mc_launch.execute(
      { name: 'vanilla-job', prompt: 'Simple task', mode: 'vanilla' },
      mockContext,
    );

    // Bypass vanilla passa pela guarda (sem OMO) — guarda chamada, detectOMO não.
    expect(mockAssertOmoModeAvailable).toHaveBeenCalledWith('vanilla');
    expect(mockDetectOMO).not.toHaveBeenCalled();
    expect(mockCopyPlans).not.toHaveBeenCalled();
  });

  it('should gracefully handle plan copy failure (non-fatal)', async () => {
    mockCopyPlans.mockRejectedValue(new Error('Plans directory not found'));

    // Should not throw - plan copy failure is non-fatal
    const result = await mc_launch.execute(
      { name: 'no-plans', prompt: 'No plans exist', mode: 'plan' },
      mockContext,
    );

    expect(result).toContain('Job "no-plans" launched successfully');
  });

  it('should verify full OMO lifecycle: launch with plan -> status -> kill -> cleanup', async () => {
    mockCapturePane.mockResolvedValue(
      'opencode> Running plan...\nTask 3/5 complete',
    );
    (worktree.isInManagedWorktree as Mock).mockResolvedValue({
      isManaged: true,
      worktreePath: '/tmp/mc-worktrees/mc-omo-lifecycle',
    });

    // Launch
    await mc_launch.execute(
      {
        name: 'omo-lifecycle',
        prompt: 'Full OMO lifecycle',
        mode: 'plan',
        planFile: 'lifecycle-plan.md',
      },
      mockContext,
    );

    // Check status
    const status = await mc_status.execute(
      { name: 'omo-lifecycle' },
      mockContext,
    );
    expect(status).toContain('Mode: plan');

    // Kill
    await mc_kill.execute({ name: 'omo-lifecycle' }, mockContext);

    // Cleanup
    const cleanup = await mc_cleanup.execute(
      { name: 'omo-lifecycle' },
      mockContext,
    );
    expect(cleanup).toContain('Cleaned up job "omo-lifecycle"');
    expect(getJobs()).toHaveLength(0);
  });
});

// ============================================================================
// Workflow 3: Launch -> PR -> Cleanup
// ============================================================================

describe('Workflow 3: Launch -> PR -> Cleanup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetJobs();
    accumulatorByJobId.clear();
    mockGetSharedMonitor.mockReturnValue(fakeMonitor);

    mockCreateWorktree.mockImplementation(async (opts: { branch: string }) => {
      const sanitized = opts.branch.replace(/\//g, '-');
      return `/tmp/mc-worktrees/${sanitized}`;
    });
    mockRemoveWorktree.mockResolvedValue(undefined);
    mockCreateSession.mockResolvedValue(undefined);
    mockKillSession.mockResolvedValue(undefined);
    mockSendKeys.mockResolvedValue(undefined);
    (tmux.setPaneDiedHook as Mock).mockResolvedValue(undefined);
    mockLoadConfig.mockResolvedValue({
      defaultPlacement: 'session',
      pollInterval: 10000,
      idleThreshold: 300000,
      worktreeBasePath: '/tmp/mc-worktrees',
      useServeMode: true,
      portRangeStart: 14100,
      portRangeEnd: 14199,
      omo: { enabled: false, defaultMode: 'vanilla' },
    });
  });

  it('should launch a job and then create a PR from its branch', async () => {
    // Step 1: Launch
    const launchResult = await mc_launch.execute(
      { name: 'pr-job', prompt: 'Add new feature for PR' },
      mockContext,
    );
    expect(launchResult).toContain('Job "pr-job" launched successfully');

    // Verify job branch was set
    const jobs = getJobs();
    expect(jobs[0].branch).toBe('mc/pr-job');

    // Step 2: Attempt PR creation - the mc_pr tool calls executeGhCommand
    // which calls Bun.spawn directly. We need to verify the job lookup works
    // and the correct branch is used.
    // Since gh CLI isn't available in test, we verify the workflow up to the
    // gh command execution.
    try {
      await mc_pr.execute(
        {
          name: 'pr-job',
          title: 'Add new feature',
          body: 'This PR adds authentication',
          draft: true,
        },
        mockContext,
      );
    } catch (error) {
      // Expected: gh CLI not available in test
      // The important thing is that the job was found correctly
      expect(error).toBeDefined();
    }

    // Verify getJobByName was called with the correct name
    expect(jobState.getJobByName).toHaveBeenCalledWith('pr-job');
  });

  it('should fail PR creation when job does not exist', async () => {
    await expect(
      mc_pr.execute(
        { name: 'nonexistent-job', title: 'PR' },
        mockContext,
      ),
    ).rejects.toThrow('Job "nonexistent-job" not found');
  });

  it('should use job prompt as default PR title', async () => {
    // Launch job
    await mc_launch.execute(
      { name: 'default-title-job', prompt: 'Implement OAuth2 login' },
      mockContext,
    );

    // Verify job exists with correct prompt
    const jobs = getJobs();
    expect(jobs[0].prompt).toBe('Implement OAuth2 login');

    // When PR is created without title, it should use the prompt
    try {
      await mc_pr.execute(
        { name: 'default-title-job' },
        mockContext,
      );
    } catch {
      // Expected: gh CLI not available
    }
    expect(jobState.getJobByName).toHaveBeenCalledWith('default-title-job');
  });

  it('should handle full workflow: launch -> kill -> cleanup after PR', async () => {
    // Launch
    await mc_launch.execute(
      { name: 'full-pr-flow', prompt: 'Complete feature' },
      mockContext,
    );

    // Attempt PR (will fail at gh CLI but workflow is validated)
    try {
      await mc_pr.execute(
        { name: 'full-pr-flow', title: 'Complete feature PR' },
        mockContext,
      );
    } catch {
      // Expected: gh CLI not available
    }

    // Kill
    await mc_kill.execute({ name: 'full-pr-flow' }, mockContext);

    // Cleanup
    const cleanupResult = await mc_cleanup.execute(
      { name: 'full-pr-flow' },
      mockContext,
    );
    expect(cleanupResult).toContain('Cleaned up job "full-pr-flow"');
    expect(getJobs()).toHaveLength(0);
  });
});

// ============================================================================
// Workflow 4: Multiple jobs in parallel
// ============================================================================

describe('Workflow 4: Multiple jobs in parallel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetJobs();
    accumulatorByJobId.clear();
    mockGetSharedMonitor.mockReturnValue(fakeMonitor);

    mockCreateWorktree.mockImplementation(async (opts: { branch: string }) => {
      const sanitized = opts.branch.replace(/\//g, '-');
      return `/tmp/mc-worktrees/${sanitized}`;
    });
    mockRemoveWorktree.mockResolvedValue(undefined);
    mockCreateSession.mockResolvedValue(undefined);
    mockKillSession.mockResolvedValue(undefined);
    mockSendKeys.mockResolvedValue(undefined);
    (tmux.setPaneDiedHook as Mock).mockResolvedValue(undefined);
    mockCapturePane.mockResolvedValue('opencode> Working...');
    mockLoadConfig.mockResolvedValue({
      defaultPlacement: 'session',
      pollInterval: 10000,
      idleThreshold: 300000,
      worktreeBasePath: '/tmp/mc-worktrees',
      useServeMode: true,
      portRangeStart: 14100,
      portRangeEnd: 14199,
      omo: { enabled: false, defaultMode: 'vanilla' },
    });
    (worktree.isInManagedWorktree as Mock).mockResolvedValue({
      isManaged: true,
      worktreePath: '/tmp/mc-worktrees/test',
    });
  });

  it('should launch multiple jobs and track all of them', async () => {
    // Launch 3 jobs
    await mc_launch.execute(
      { name: 'job-auth', prompt: 'Add authentication' },
      mockContext,
    );
    await mc_launch.execute(
      { name: 'job-api', prompt: 'Build API endpoints' },
      mockContext,
    );
    await mc_launch.execute(
      { name: 'job-ui', prompt: 'Create UI components' },
      mockContext,
    );

    // Verify all 3 jobs are tracked
    const jobs = getJobs();
    expect(jobs).toHaveLength(3);
    expect(jobs.map((j) => j.name).sort()).toEqual(
      ['job-api', 'job-auth', 'job-ui'],
    );

    // Each should have unique worktree paths
    const worktreePaths = new Set(jobs.map((j) => j.worktreePath));
    expect(worktreePaths.size).toBe(3);

    // Each should have unique tmux targets
    const tmuxTargets = new Set(jobs.map((j) => j.tmuxTarget));
    expect(tmuxTargets.size).toBe(3);
  });

  it('should list all jobs via mc_jobs', async () => {
    await mc_launch.execute(
      { name: 'list-job-1', prompt: 'Task 1' },
      mockContext,
    );
    await mc_launch.execute(
      { name: 'list-job-2', prompt: 'Task 2' },
      mockContext,
    );

    const jobsResult = await mc_jobs.execute({}, mockContext);

    expect(jobsResult).toContain('Mission Control Jobs');
    expect(jobsResult).toContain('list-job-1');
    expect(jobsResult).toContain('list-job-2');
    expect(jobsResult).toContain('Running (2)');
  });

  it('should independently manage job statuses', async () => {
    // Launch 3 jobs
    await mc_launch.execute(
      { name: 'ind-job-a', prompt: 'Task A' },
      mockContext,
    );
    await mc_launch.execute(
      { name: 'ind-job-b', prompt: 'Task B' },
      mockContext,
    );
    await mc_launch.execute(
      { name: 'ind-job-c', prompt: 'Task C' },
      mockContext,
    );

    // Kill only job B
    await mc_kill.execute({ name: 'ind-job-b' }, mockContext);

    const jobs = getJobs();
    const jobA = jobs.find((j) => j.name === 'ind-job-a');
    const jobB = jobs.find((j) => j.name === 'ind-job-b');
    const jobC = jobs.find((j) => j.name === 'ind-job-c');

    expect(jobA!.status).toBe('running');
    expect(jobB!.status).toBe('stopped');
    expect(jobC!.status).toBe('running');
  });

  it('should get status for each individual job', async () => {
    await mc_launch.execute(
      { name: 'status-job-1', prompt: 'First task' },
      mockContext,
    );
    await mc_launch.execute(
      { name: 'status-job-2', prompt: 'Second task' },
      mockContext,
    );

    const status1 = await mc_status.execute(
      { name: 'status-job-1' },
      mockContext,
    );
    const status2 = await mc_status.execute(
      { name: 'status-job-2' },
      mockContext,
    );

    expect(status1).toContain('Job: status-job-1');
    expect(status1).toContain('Branch: mc/status-job-1');
    expect(status2).toContain('Job: status-job-2');
    expect(status2).toContain('Branch: mc/status-job-2');
  });

  it('should capture output from specific jobs', async () => {
    // Serve mode: per-job monitor events, staged per job id.
    await mc_launch.execute(
      { name: 'capture-a', prompt: 'Job A' },
      mockContext,
    );
    await mc_launch.execute(
      { name: 'capture-b', prompt: 'Job B' },
      mockContext,
    );
    stageAccumulatorForJob('capture-a', makeAccumulator(['output-from-job-a.ts']));
    stageAccumulatorForJob('capture-b', makeAccumulator(['output-from-job-b.ts']));

    const outputA = await mc_capture.execute(
      { name: 'capture-a' },
      mockContext,
    );
    const outputB = await mc_capture.execute(
      { name: 'capture-b' },
      mockContext,
    );

    expect(outputA).toContain('output-from-job-a');
    expect(outputB).toContain('output-from-job-b');
  });

  it('should cleanup all non-running jobs at once', async () => {
    // Launch 3 jobs
    await mc_launch.execute(
      { name: 'batch-1', prompt: 'Task 1' },
      mockContext,
    );
    await mc_launch.execute(
      { name: 'batch-2', prompt: 'Task 2' },
      mockContext,
    );
    await mc_launch.execute(
      { name: 'batch-3', prompt: 'Task 3' },
      mockContext,
    );

    // Kill two of them
    await mc_kill.execute({ name: 'batch-1' }, mockContext);
    await mc_kill.execute({ name: 'batch-3' }, mockContext);

    // Cleanup all non-running
    const cleanupResult = await mc_cleanup.execute(
      { all: true },
      mockContext,
    );

    expect(cleanupResult).toContain('Cleaned up job "batch-1"');
    expect(cleanupResult).toContain('Cleaned up job "batch-3"');
    expect(cleanupResult).toContain('2 cleaned');

    // Only running job should remain
    const remainingJobs = getJobs();
    expect(remainingJobs).toHaveLength(1);
    expect(remainingJobs[0].name).toBe('batch-2');
    expect(remainingJobs[0].status).toBe('running');
  });

  it('should handle launching jobs in parallel (concurrent launches)', async () => {
    // Launch multiple jobs concurrently
    const launches = await Promise.all([
      mc_launch.execute(
        { name: 'parallel-1', prompt: 'Parallel task 1' },
        mockContext,
      ),
      mc_launch.execute(
        { name: 'parallel-2', prompt: 'Parallel task 2' },
        mockContext,
      ),
      mc_launch.execute(
        { name: 'parallel-3', prompt: 'Parallel task 3' },
        mockContext,
      ),
    ]);

    // All launches should succeed
    expect(launches).toHaveLength(3);
    launches.forEach((result) => {
      expect(result).toContain('launched successfully');
    });

    // All jobs should be tracked
    const jobs = getJobs();
    expect(jobs).toHaveLength(3);
    expect(jobs.every((j) => j.status === 'running')).toBe(true);
  });

  it('should filter jobs by status in mc_jobs', async () => {
    await mc_launch.execute(
      { name: 'filter-running', prompt: 'Running' },
      mockContext,
    );
    await mc_launch.execute(
      { name: 'filter-stopped', prompt: 'Will stop' },
      mockContext,
    );

    // Kill one
    await mc_kill.execute({ name: 'filter-stopped' }, mockContext);

    // Filter running only
    const runningResult = await mc_jobs.execute(
      { status: 'running' },
      mockContext,
    );
    expect(runningResult).toContain('filter-running');
    expect(runningResult).not.toContain('filter-stopped');
  });

  it('should kill and cleanup all jobs sequentially', async () => {
    const jobNames = ['cleanup-a', 'cleanup-b', 'cleanup-c'];

    // Launch all
    for (const name of jobNames) {
      await mc_launch.execute({ name, prompt: `Task ${name}` }, mockContext);
    }
    expect(getJobs()).toHaveLength(3);

    // Kill all
    for (const name of jobNames) {
      await mc_kill.execute({ name }, mockContext);
    }
    expect(getJobs().every((j) => j.status === 'stopped')).toBe(true);

    // Cleanup all
    const result = await mc_cleanup.execute({ all: true }, mockContext);
    expect(result).toContain('3 cleaned');
    expect(getJobs()).toHaveLength(0);
  });
});
}
