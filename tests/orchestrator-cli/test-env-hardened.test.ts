import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// R6b hardened: inherited test env never disables guarantees silently.
// - env without --allow-test-env => refuse (even with MC_ALLOW_TEST_ENV=1)
// - --allow-test-env => allow + audited
// - clean env => normal
// All via real bun subprocesses, never isolated-function only.

const WT_ROOT = new URL('../../', import.meta.url).pathname.replace(/\/$/, '');
const CLI = join(WT_ROOT, 'src/orchestrator-cli/index.ts');
const SRC_LIB = new URL('../../src/lib/', import.meta.url).pathname;

async function runCli(args: string[], env: Record<string, string | undefined>, cwd: string) {
  const fullEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) fullEnv[k] = v;
  }
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete fullEnv[k];
    else fullEnv[k] = v;
  }
  const proc = Bun.spawn([process.execPath, CLI, ...args], {
    stdout: 'pipe', stderr: 'pipe', env: fullEnv, cwd,
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
  ]);
  return { out, err, code, combined: `${out}\n${err}` };
}

function cleanEnv(xdg: string): Record<string, string | undefined> {
  return { NODE_ENV: undefined, VITEST: undefined, MC_ALLOW_TEST_ENV: undefined, MC_XDG_DATA_DIR: xdg };
}
function testEnv(xdg: string, extra: Record<string, string> = {}): Record<string, string | undefined> {
  return { ...cleanEnv(xdg), NODE_ENV: 'test', ...extra };
}

let dirs: string[] = [];
function track(d: string): string { dirs.push(d); return d; }
beforeEach(() => { dirs = []; });
afterEach(() => { for (const d of dirs) { try { rmSync(d, { recursive: true, force: true }); } catch {} } });

describe('R6b — hardened test-env gate (CLI real processes)', () => {
  it('start/resume/approve refuse inherited test env without flag (even with MC_ALLOW_TEST_ENV=1)', async () => {
    const xdg = track(mkdtempSync(join(tmpdir(), 'mc-r6b-xdg-')));
    for (const verb of ['start', 'resume', 'approve'] as const) {
      const args = verb === 'start' ? [verb, '--request', 'probe'] : [verb, '--intake', 'nope'];
      // plain test env
      let r = await runCli(args, testEnv(xdg), WT_ROOT);
      expect(r.code).not.toBe(0);
      expect(r.combined).toMatch(/--allow-test-env/);
      // inherited MC_ALLOW_TEST_ENV=1 alone still refuses (hardened)
      r = await runCli(args, testEnv(xdg, { MC_ALLOW_TEST_ENV: '1' }), WT_ROOT);
      expect(r.code).not.toBe(0);
      expect(r.combined).toMatch(/--allow-test-env/);
      expect(r.combined).toMatch(/MC_ALLOW_TEST_ENV.*(alone|no longer|insufficient)/i);
    }
  }, 60000);

  it('explicit --allow-test-env permits test-env run and audits it', async () => {
    const xdg = track(mkdtempSync(join(tmpdir(), 'mc-r6b-xdg-')));
    // approve/resume with flag under test env: gate passes (audits), dispatch fails fast for missing intake — never gate refusal.
    // Use approve (no model invocation) to avoid the 60s autonomous model timeout.
    const r = await runCli(
      ['approve', '--intake', 'nope-missing', '--allow-test-env'],
      testEnv(xdg),
      WT_ROOT,
    );
    // Must NOT be a gate refusal. Gate refusal mentions Refusing + NODE_ENV.
    const isGateRefusal = /Refusing cli approve/i.test(r.combined) && /NODE_ENV/.test(r.combined);
    expect(isGateRefusal).toBe(false);
    // Downstream failure is missing intake, not test-env.
    expect(r.combined).toMatch(/No intake|No active intake|nope-missing/i);
    const auditFile = join(xdg, 'test-env-override-audit.jsonl');
    // Give async audit a moment (gate audits sync, but dispatch may take time)
    const deadline = Date.now() + 5000;
    let found = false;
    while (Date.now() < deadline) {
      try {
        if (existsSync(auditFile) && readFileSync(auditFile, 'utf8').includes('test-env-override')) { found = true; break; }
      } catch {}
      await new Promise((res) => setTimeout(res, 100));
    }
    expect(found).toBe(true);
    const auditText = readFileSync(auditFile, 'utf8');
    expect(auditText).toMatch(/cli approve/);
    expect(auditText).toMatch(/--allow-test-env/);
  }, 60000);

  it('clean env stays normal (no flag, no refusal)', async () => {
    const xdg = track(mkdtempSync(join(tmpdir(), 'mc-r6b-xdg-')));
    // Use a read-only verb that never needs a model: help must work clean.
    const r = await runCli(['help'], cleanEnv(xdg), WT_ROOT);
    expect(r.code).toBe(0);
    expect(r.combined).not.toMatch(/Refusing/);
  }, 30000);

  it('plugin/monitor equivalent: hardened gate refuses without flag, allows with flag + audits (subprocess)', async () => {
    const xdg = track(mkdtempSync(join(tmpdir(), 'mc-r6b-xdg-')));
    const probeSrc = track(mkdtempSync(join(tmpdir(), 'mc-r6b-probe-'))) + '/probe.ts';
    writeFileSync(probeSrc, [
      `import { assertHardenedRealEntry, hasExplicitTestEnvFlag } from '${SRC_LIB}monitor.ts';`,
      `import { isTestEnvPresent } from '${SRC_LIB}plan-state.ts';`,
      `const mode = Bun.argv[2];`,
      `if (mode === 'refuse') {`,
      `  assertHardenedRealEntry('plugin mc_launch');`,
      `  console.log('ALLOWED');`,
      `} else if (mode === 'allow') {`,
      `  assertHardenedRealEntry('plugin mc_launch');`,
      `  console.log('ALLOWED');`,
      `} else if (mode === 'monitor-short-ok') {`,
      `  const { JobMonitor } = await import('${SRC_LIB}monitor.ts');`,
      `  new JobMonitor({ pollInterval: 50 });`,
      `  console.log(JSON.stringify({ testEnv: isTestEnvPresent(), flag: hasExplicitTestEnvFlag() }));`,
      `}`,
    ].join('\n'));
    async function runProbe(mode: string, env: Record<string, string | undefined>, extraArgs: string[] = []) {
      const fullEnv: Record<string, string> = {};
      for (const [k, v] of Object.entries(process.env)) { if (v !== undefined) fullEnv[k] = v; }
      for (const [k, v] of Object.entries(env)) { if (v === undefined) delete fullEnv[k]; else fullEnv[k] = v; }
      const proc = Bun.spawn([process.execPath, probeSrc, mode, ...extraArgs], {
        stdout: 'pipe', stderr: 'pipe', env: fullEnv, cwd: WT_ROOT,
      });
      const [out, err, code] = await Promise.all([
        new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
      ]);
      return { out: out.trim(), err: err.trim(), code, combined: `${out}\n${err}` };
    }
    // inherited test env without flag => refuse
    let r = await runProbe('refuse', testEnv(xdg));
    expect(r.code).not.toBe(0);
    expect(r.combined).toMatch(/--allow-test-env/);
    // MC_ALLOW_TEST_ENV=1 alone still refuses
    r = await runProbe('refuse', testEnv(xdg, { MC_ALLOW_TEST_ENV: '1' }));
    expect(r.code).not.toBe(0);
    expect(r.combined).toMatch(/--allow-test-env/);
    // explicit flag allows + audits (argv carries --allow-test-env)
    r = await runProbe('allow', testEnv(xdg), ['--allow-test-env']);
    // probe passes extraArgs after mode, but hasExplicitTestEnvFlag reads process.argv.slice(2) which includes mode;
    // to carry the flag, spawn with flag in argv: use extraArgs as part of argv (mode + flag). hasExplicit checks all argv, so found.
    expect(r.code).toBe(0);
    expect(r.out).toBe('ALLOWED');
    const auditFile = join(xdg, 'test-env-override-audit.jsonl');
    expect(existsSync(auditFile)).toBe(true);
    expect(readFileSync(auditFile, 'utf8')).toMatch(/plugin mc_launch/);
    // monitor short-interval unit fake still works under test env (does not drive guarantees)
    r = await runProbe('monitor-short-ok', testEnv(xdg));
    expect(r.code).toBe(0);
    const report = JSON.parse(r.out);
    expect(report.testEnv).toBe(true);
  }, 60000);

  it('wrapped plugin mc_launch refuses before side-effects without flag (subprocess, real MissionControl)', async () => {
    const xdg = track(mkdtempSync(join(tmpdir(), 'mc-r6b-xdg-')));
    const probeSrc = track(mkdtempSync(join(tmpdir(), 'mc-r6b-probe-'))) + '/wrap-launch.ts';
    writeFileSync(probeSrc, [
      `import { MissionControl } from '${WT_ROOT}/src/index.ts';`,
      `const mockClient = {`,
      `  session: { list: async () => [], get: async () => ({}), prompt: async () => {} },`,
      `  config: { get: async () => ({ data: {} }) },`,
      `  tui: { showToast: async () => {} },`,
      `};`,
      `const plugin = await MissionControl({ client: mockClient } as any);`,
      `const tool = (plugin as any).tool['mc_launch'];`,
      `if (!tool) { console.error('MISSING mc_launch'); process.exit(2); }`,
      `try {`,
      `  await tool.execute({ name: 'r6b-probe', prompt: 'probe' }, { sessionID: 'ses_probe', directory: process.cwd(), worktree: process.cwd(), abort: new AbortController().signal, metadata: () => {}, ask: async () => {} });`,
      `  console.log('ALLOWED');`,
      `} catch (e) { console.error(e instanceof Error ? e.message : String(e)); process.exit(1); }`,
      // Ensure the process exits (monitor interval from MissionControl would linger).
      `process.exit(0);`,
    ].join('\n'));
    async function runWrapped(env: Record<string, string | undefined>, extraArgs: string[] = []) {
      const fullEnv: Record<string, string> = {};
      for (const [k, v] of Object.entries(process.env)) { if (v !== undefined) fullEnv[k] = v; }
      for (const [k, v] of Object.entries(env)) { if (v === undefined) delete fullEnv[k]; else fullEnv[k] = v; }
      const proc = Bun.spawn([process.execPath, probeSrc, ...extraArgs], {
        stdout: 'pipe', stderr: 'pipe', env: fullEnv, cwd: WT_ROOT,
      });
      const [out, err, code] = await Promise.all([
        new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
      ]);
      return { out: out.trim(), err: err.trim(), code, combined: `${out}\n${err}` };
    }
    // Without flag under test env => refused by hardened gate before tmux/worktree.
    let r = await runWrapped(testEnv(xdg));
    expect(r.code).not.toBe(0);
    expect(r.combined).toMatch(/--allow-test-env/);
    expect(r.combined).toMatch(/plugin mc_launch/);
    // MC_ALLOW_TEST_ENV=1 alone still refused.
    r = await runWrapped(testEnv(xdg, { MC_ALLOW_TEST_ENV: '1' }));
    expect(r.code).not.toBe(0);
    expect(r.combined).toMatch(/--allow-test-env/);
    // NOTE (mc_launch real side-effects NÃO COMPROVADO in sandbox): with the flag the gate
    // allows and the real launch would proceed to tmux/worktree/model. Exercising that path
    // here would create worktrees/branches/tmux sessions as side-effects, so we stop at the
    // refusal proof above and mark full launch NÃO COMPROVADO (see evidence table).
  }, 60000);

  it('monitor production still refuses short pollInterval in clean env (subprocess)', async () => {
    const xdg = track(mkdtempSync(join(tmpdir(), 'mc-r6b-xdg-')));
    const probeSrc = track(mkdtempSync(join(tmpdir(), 'mc-r6b-probe-'))) + '/mon-prod.ts';
    writeFileSync(probeSrc, [
      `import { JobMonitor } from '${SRC_LIB}monitor.ts';`,
      `try { new JobMonitor({ pollInterval: 5000 }); console.log('NO-THROW'); }`,
      `catch (e) { console.log('THREW:' + (e instanceof Error ? e.message : String(e))); }`,
    ].join('\n'));
    const fullEnv: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) { if (v === undefined) continue; if (k === 'NODE_ENV' || k === 'VITEST' || k === 'MC_ALLOW_TEST_ENV') continue; fullEnv[k] = v; }
    fullEnv['MC_XDG_DATA_DIR'] = xdg;
    const proc = Bun.spawn([process.execPath, probeSrc], { stdout: 'pipe', stderr: 'pipe', env: fullEnv, cwd: WT_ROOT });
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
    ]);
    expect(code).toBe(0);
    expect(out).toMatch(/THREW:Poll interval must be at least/);
    expect(err).toBe('');
  }, 30000);
});
