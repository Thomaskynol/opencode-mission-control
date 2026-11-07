import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as configMod from '../../src/lib/config';
import * as omo from '../../src/lib/omo';

const {
  assertPluginDistReady,
  assertOmoModeAvailable,
  resolvePluginRepoRoot,
} = configMod;

// dist ausente → erro com instrução reproduzível (bun install/build/ls).
describe('dispatch pre-flight: dist guard', () => {
  let root = '';
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'mc-dist-guard-'));
    process.env.MC_XDG_DATA_DIR = join(root, 'xdg');
  });
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.MC_XDG_DATA_DIR;
    if (root) rmSync(root, { recursive: true, force: true });
    root = '';
  });

  it('resolvePluginRepoRoot aponta para o repo com package.json canônico e dist', () => {
    const repoRoot = resolvePluginRepoRoot();
    const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
    expect(pkg.name).toBe('opencode-mission-control');
    expect(existsSync(join(repoRoot, 'dist', 'index.js'))).toBe(true);
  });

  it('sem raiz canônica → fail-closed com instrução (nunca adivinha dist)', () => {
    const orphan = join(root, 'orphan');
    mkdirSync(orphan, { recursive: true });
    expect(() => assertPluginDistReady(orphan)).toThrow(/raiz do plugin não localizada/);
    expect(() => assertPluginDistReady(orphan)).toThrow(/bun run build/);
  });

  it('dist ausente → throw com instrução (bun install/build/ls dist)', () => {
    const empty = join(root, 'empty-plugin');
    mkdirSync(empty, { recursive: true });
    writeFileSync(join(empty, 'package.json'), JSON.stringify({ name: 'opencode-mission-control' }));
    expect(() => assertPluginDistReady(empty)).toThrow(/bun run build/);
    expect(() => assertPluginDistReady(empty)).toThrow(/bun install/);
    expect(() => assertPluginDistReady(empty)).toThrow(/ls dist\/index\.js/);
    expect(() => assertPluginDistReady(empty)).toThrow(/dist\/index\.js não encontrado/);
  });

  it('src ilegível (sem .ts) → fail-closed com instrução', () => {
    const fake = join(root, 'fake-no-src');
    mkdirSync(join(fake, 'dist'), { recursive: true });
    writeFileSync(join(fake, 'package.json'), JSON.stringify({ name: 'opencode-mission-control' }));
    writeFileSync(join(fake, 'dist', 'index.js'), '// built');
    expect(() => assertPluginDistReady(fake)).toThrow(/ilegível ou sem \.ts/);
    expect(() => assertPluginDistReady(fake)).toThrow(/bun run build/);
  });

  it('src mais novo que dist → throw com rebuild pendente', () => {
    const fake = join(root, 'fake-plugin');
    mkdirSync(join(fake, 'src'), { recursive: true });
    mkdirSync(join(fake, 'dist'), { recursive: true });
    writeFileSync(join(fake, 'package.json'), JSON.stringify({ name: 'opencode-mission-control' }));
    writeFileSync(join(fake, 'dist', 'index.js'), '// built');
    writeFileSync(join(fake, 'src', 'index.ts'), '// newer');
    const old = new Date('2020-01-01');
    const now = new Date('2021-01-01');
    utimesSync(join(fake, 'dist', 'index.js'), old, old);
    utimesSync(join(fake, 'src', 'index.ts'), now, now);
    expect(() => assertPluginDistReady(join(fake, 'src', 'lib'))).toThrow(/rebuild pendente/);
    expect(() => assertPluginDistReady(join(fake, 'src', 'lib'))).toThrow(/bun run build/);
  });

  it('dist mais novo que src → não lança', () => {
    const fake = join(root, 'fake-plugin-ok');
    mkdirSync(join(fake, 'src'), { recursive: true });
    mkdirSync(join(fake, 'dist'), { recursive: true });
    writeFileSync(join(fake, 'package.json'), JSON.stringify({ name: 'opencode-mission-control' }));
    writeFileSync(join(fake, 'src', 'index.ts'), '// older');
    writeFileSync(join(fake, 'dist', 'index.js'), '// built');
    const old = new Date('2020-01-01');
    const now = new Date('2021-01-01');
    utimesSync(join(fake, 'src', 'index.ts'), old, old);
    utimesSync(join(fake, 'dist', 'index.js'), now, now);
    expect(() => assertPluginDistReady(join(fake, 'src', 'lib'))).not.toThrow();
  });

  it('mtime igual → stale (fail-closed, >=)', () => {
    const fake = join(root, 'fake-plugin-same');
    mkdirSync(join(fake, 'src'), { recursive: true });
    mkdirSync(join(fake, 'dist'), { recursive: true });
    writeFileSync(join(fake, 'package.json'), JSON.stringify({ name: 'opencode-mission-control' }));
    writeFileSync(join(fake, 'src', 'index.ts'), '// same tick');
    writeFileSync(join(fake, 'dist', 'index.js'), '// built');
    const same = new Date('2021-06-01');
    utimesSync(join(fake, 'src', 'index.ts'), same, same);
    utimesSync(join(fake, 'dist', 'index.js'), same, same);
    expect(() => assertPluginDistReady(join(fake, 'src', 'lib'))).toThrow(/rebuild pendente/);
  });

  it('modo vanilla nunca exige OMO', async () => {
    const spy = vi.spyOn(omo, 'detectOMO');
    await assertOmoModeAvailable('vanilla');
    expect(spy).not.toHaveBeenCalled();
  });

  it('modo OMO sem OMO → throw com correção antes de qualquer despacho', async () => {
    vi.spyOn(omo, 'detectOMO').mockResolvedValue({
      detected: false,
      configSource: null,
      sisyphusPath: null,
      loaded: 'unknown',
      used: false,
    } as any);
    await expect(assertOmoModeAvailable('ralph')).rejects.toThrow(/no worktree was created/);
    await expect(assertOmoModeAvailable('ralph')).rejects.toThrow(/mode:"vanilla"/);
  });

  it('modo desconhecido/undefined → rejeita com mensagem clara', async () => {
    await expect(assertOmoModeAvailable('turbo' as any)).rejects.toThrow(/desconhecido.*vanilla, plan, ralph, ulw/);
    await expect(assertOmoModeAvailable(undefined)).rejects.toThrow(/desconhecido/);
  });
});

// OMO sem OMO → mc_launch falha ANTES de createWorktree.
describe('mc_launch pre-flight OMO (antes de createWorktree)', () => {
  let mockCreateWorktree: any;
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

  beforeEach(async () => {
    vi.clearAllMocks();
    const tmux = await import('../../src/lib/tmux');
    const jobState = await import('../../src/lib/job-state');
    const worktree = await import('../../src/lib/worktree');
    const setup = await import('../../src/lib/worktree-setup');
    vi.spyOn(tmux, 'isTmuxAvailable').mockResolvedValue(true);
    vi.spyOn(jobState, 'getJobByName').mockResolvedValue(undefined as any);
    vi.spyOn(configMod, 'loadConfig').mockResolvedValue({
      defaultPlacement: 'session',
      useServeMode: true,
      portRangeStart: 14100,
      portRangeEnd: 14199,
      omo: { enabled: false, defaultMode: 'vanilla' },
    } as any);
    // Guarda dist tem cobertura própria acima; aqui isola OMO sem depender do frescor do worktree.
    vi.spyOn(configMod, 'assertPluginDistReady').mockImplementation(() => {});
    vi.spyOn(setup, 'assertNoPermissiveOpencodeConfig').mockImplementation(() => undefined as any);
    vi.spyOn(omo, 'detectOMO').mockResolvedValue({
      detected: false,
      configSource: null,
      sisyphusPath: null,
      loaded: 'unknown',
      used: false,
    } as any);
    mockCreateWorktree = vi.spyOn(worktree, 'createWorktree').mockResolvedValue('/tmp/mc-x' as any);
    process.env.MC_XDG_DATA_DIR = mkdtempSync(join(tmpdir(), 'mc-launch-pre-'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.MC_XDG_DATA_DIR;
  });

  it('mode ralph sem OMO → rejeita sem criar worktree', async () => {
    const { mc_launch } = await import('../../src/tools/launch');
    await expect(
      mc_launch.execute({ name: 'x', prompt: 'Do', mode: 'ralph' }, mockContext),
    ).rejects.toThrow(/OMO mode "ralph"/);
    expect(mockCreateWorktree).not.toHaveBeenCalled();
  });
});

// OMO sem OMO → mc_plan falha ANTES do despacho (startPlan/savePlan).
describe('mc_plan pre-flight OMO (antes do despacho)', () => {
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

  beforeEach(async () => {
    vi.clearAllMocks();
    const planState = await import('../../src/lib/plan-state');
    const git = await import('../../src/lib/git');
    const setup = await import('../../src/lib/worktree-setup');
    vi.spyOn(planState, 'loadPlan').mockResolvedValue(null);
    vi.spyOn(planState, 'savePlan').mockResolvedValue(undefined);
    vi.spyOn(planState, 'validateGhAuth').mockResolvedValue(true);
    vi.spyOn(git, 'gitCommand').mockResolvedValue({ stdout: 'abc', stderr: '', exitCode: 0 });
    vi.spyOn(configMod, 'loadConfig').mockResolvedValue({
      defaultPlacement: 'session',
      useServeMode: true,
      omo: { enabled: false, defaultMode: 'vanilla' },
    } as any);
    // Guarda dist tem cobertura própria acima; aqui isola OMO sem depender do frescor do worktree.
    vi.spyOn(configMod, 'assertPluginDistReady').mockImplementation(() => {});
    vi.spyOn(setup, 'assertNoPermissiveOpencodeConfig').mockImplementation(() => undefined as any);
    vi.spyOn(omo, 'detectOMO').mockResolvedValue({
      detected: false,
      configSource: null,
      sisyphusPath: null,
      loaded: 'unknown',
      used: false,
    } as any);
    process.env.MC_XDG_DATA_DIR = mkdtempSync(join(tmpdir(), 'mc-plan-pre-'));
    vi.spyOn(omo, 'detectOMO').mockResolvedValue({
      detected: false,
      configSource: null,
      sisyphusPath: null,
      loaded: 'unknown',
      used: false,
    } as any);
    process.env.MC_XDG_DATA_DIR = mkdtempSync(join(tmpdir(), 'mc-plan-pre-'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.MC_XDG_DATA_DIR;
  });

  it('job plan sem OMO → rejeita sem startPlan e sem savePlan', async () => {
    const orchestrator = await import('../../src/lib/orchestrator');
    const mockStartPlan = vi.fn().mockResolvedValue(undefined);
    vi.spyOn(orchestrator, 'Orchestrator').mockImplementation(
      () => ({ startPlan: mockStartPlan, setPlanModelSnapshot: vi.fn() }) as any,
    );
    const { mc_plan } = await import('../../src/tools/plan');
    const planState = await import('../../src/lib/plan-state');
    await expect(
      mc_plan.execute(
        { name: 'p', jobs: [{ name: 'a', prompt: 'do', mode: 'plan' }] },
        mockContext,
      ),
    ).rejects.toThrow(/OMO mode "plan"/);
    expect(mockStartPlan).not.toHaveBeenCalled();
    expect(planState.savePlan).not.toHaveBeenCalled();
  });
});
