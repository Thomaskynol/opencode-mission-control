import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { join } from 'path';
import { tmpdir } from 'os';
import { detectOMO } from '../../src/lib/omo';

// Isolation contract (cross-file regression fix): this file must not touch
// the shared module registry. It imports NOTHING from the app graph except
// omo.ts (os/path/fs only — immune to the known vi.mock(paths) leak that
// replaces src/lib/paths with { getDataDir: vi.fn() } for the whole bun
// test process). No spyOn/mock, no chdir, no getDataDir patching:
// - OMO unit tests use absolute fixture paths.
// - Handoff legibility runs the real CLI in a CHILD process (fresh registry)
//   with MC_XDG_DATA_DIR isolation, asserting on its stdout.
describe('OMO JSONC detection (exp-8 false-negative)', () => {
  let testDir = '';

  beforeEach(() => {
    const fs = require('fs') as typeof import('fs');
    testDir = fs.mkdtempSync(join(tmpdir(), 'omo-jsonc-'));
  });

  afterEach(() => {
    try {
      (require('fs') as typeof import('fs')).rmSync(testDir, { recursive: true, force: true });
    } catch {}
  });

  async function writeConfig(name: string, content: string): Promise<string> {
    const file = join(testDir, name);
    await Bun.write(file, content);
    return file;
  }

  it('detects oh-my-opencode-slim in JSONC with //, /* */ and trailing commas', async () => {
    const file = await writeConfig(
      'opencode.json',
      `{
  // global opencode config with comments
  "plugin": [
    "oh-my-opencode-slim", // slim variant
    /* block comment */ "opencode-mission-control",
  ],
  "default_agent": "orchestrator",
}`,
    );
    const status = await detectOMO(file, '/nonexistent/global.json');
    expect(status.detected).toBe(true);
    expect(status.configSource).toBe('local');
  });

  it('detects versioned slim entry under "plugins" (real ~/.config shape)', async () => {
    const file = await writeConfig(
      'opencode.json',
      `{
  "$schema": "https://opencode.ai/config.json",
  // plugins with pinned version
  "plugins": [
    "oh-my-opencode-slim@3.0.4",
  ],
}`,
    );
    const status = await detectOMO(file, '/nonexistent/global.json');
    expect(status.detected).toBe(true);
    expect(status.configSource).toBe('local');
  });

  it('does not mistake http:// inside strings for comments', async () => {
    const file = await writeConfig(
      'opencode.json',
      `{
  "plugins": [
    // slim below
    "oh-my-opencode-slim",
  ],
  "provider": { "x": { "options": { "baseURL": "http://127.0.0.1:8080/v1" } } },
}`,
    );
    const status = await detectOMO(file, '/nonexistent/global.json');
    expect(status.detected).toBe(true);
  });

  it('fail-closed: malformed JSONC stays detected:false without throwing', async () => {
    const file = await writeConfig('opencode.json', '{ "plugin": [ "oh-my-opencode-slim",, ');
    const status = await detectOMO(file, '/nonexistent/global.json');
    expect(status.detected).toBe(false);
    expect(status.configSource).toBeNull();
  });
});

// Handoff legibility in a child process: fresh module registry (immune to
// the parent suite's vi.mock(paths) leak), real CLI path, MC_XDG_DATA_DIR
// isolation. The child prints OUTPUT-BEGIN/END around the handoff output;
// the parent only asserts parseable fencing evidence on stdout.
// Token nonce is never dumped — `token-verified` proves the token/epoch
// fencing match passed (fail-closed otherwise).
describe('handoff legibility (epoch/token/heartbeat parseable)', () => {
  let xdgDir = '';
  let repoDir = '';
  const SRC = new URL('../../src', import.meta.url).pathname;

  beforeEach(async () => {
    const fs = await import('fs');
    xdgDir = await fs.promises.mkdtemp(join(tmpdir(), 'mc-omo-xdg-'));
    repoDir = await fs.promises.mkdtemp(join(tmpdir(), 'mc-omo-repo-'));
  });

  afterEach(() => {
    for (const dir of [xdgDir, repoDir]) {
      if (!dir) continue;
      try {
        (require('fs') as typeof import('fs')).rmSync(dir, { recursive: true, force: true });
      } catch {}
    }
    xdgDir = '';
    repoDir = '';
  });

  async function runDriver(script: string): Promise<string> {
    const proc = Bun.spawn([process.execPath, '-e', script], {
      cwd: repoDir,
      env: { ...process.env, MC_XDG_DATA_DIR: xdgDir },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [stdout, stderr, exit] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (exit !== 0) {
      throw new Error('driver exited ' + exit + '\nstderr:\n' + stderr.slice(-2000) + '\nstdout:\n' + stdout.slice(-2000));
    }
    const body = stdout.split('OUTPUT-BEGIN\n')[1]?.split('\nOUTPUT-END')[0];
    if (body === undefined) {
      throw new Error('driver missing OUTPUT markers\nstderr:\n' + stderr.slice(-2000));
    }
    return body;
  }

  function driverPrelude(): string {
    return (
      "const SRC = " + JSON.stringify(SRC) + ";\n" +
      "const { dispatchCommand } = await import(SRC + '/orchestrator-cli/commands.ts');\n" +
      "const controls = { pause: async (n) => 'paused ' + n, resume: async (n) => 'resumed ' + n, cancel: async (n) => 'canceled ' + n, answer: async (n, r) => 'answered', launch: async (p) => 'launch ready' };\n" +
      "const started = await dispatchCommand('start Handoff work here --max-parallel 1 --test-command \"node check.mjs\"', controls);\n" +
      "const id = started.match(/Intake (\\S+) persisted/)[1];\n"
    );
  }

  function buildDriver(body: string): string {
    return (
      'try {\n' +
      driverPrelude() +
      body +
      "console.log('OUTPUT-BEGIN');\n" +
      'console.log(out);\n' +
      "console.log('OUTPUT-END');\n" +
      '} catch (e) {\n' +
      "  console.error('DRIVER-ERROR: ' + (e && e.stack ? e.stack : String(e)));\n" +
      '  process.exit(1);\n' +
      '}\n'
    );
  }

  it('approve output carries epoch + token-verified + heartbeat + workers live/total', async () => {
    const body =
      "const { savePlan } = await import(SRC + '/lib/plan-state.ts');\n" +
      "const { Orchestrator } = await import(SRC + '/lib/orchestrator.ts');\n" +
      "const { spawn } = await import('node:child_process');\n" +
      'Orchestrator.prototype.resumePlan = async function () { this.isRunning = true; };\n' +
      'Orchestrator.prototype.shutdown = function () {};\n' +
      "await savePlan({ id: 'plan-handoff-1', name: 'handoff work', mode: 'autopilot', status: 'paused', jobs: [{ id: 'j1', name: 'task-a', prompt: 'do a', status: 'failed', error: 'tests failed' }], integrationBranch: 'mc/integration-x', integrationWorktree: '/tmp/mc-x', baseCommit: 'abc123', createdAt: new Date().toISOString(), checkpoint: 'on_error', checkpointContext: { jobName: 'task-a', failureKind: 'test_failure' } }, undefined);\n" +
      'let holder = 0;\n' +
      'let out = "";\n' +
      'try {\n' +
      "  out = await dispatchCommand('approve --intake ' + id + ' --retry task-a', controls, {\n" +
      '    verifyWorkers: async () => ({ live: 1, total: 1 }),\n' +
      '    spawnConductor: async (intakeId) => {\n' +
      "      const child = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' });\n" +
      '      child.unref();\n' +
      "      const st = await import(SRC + '/lib/plan-state.ts');\n" +
      '      const plan = await st.loadPlan().catch(() => null);\n' +
      "      if (plan) await st.claimConductorLease(plan.id, child.pid, 'resume --intake ' + intakeId, 'test-driver:' + child.pid);\n" +
      '      holder = child.pid;\n' +
      "      return { pid: child.pid, command: 'resume --intake ' + intakeId };\n" +
      '    },\n' +
      '  });\n' +
      '} finally { try { if (holder) process.kill(holder, "SIGKILL"); } catch (e) {} }\n';
    const out = await runDriver(buildDriver(body));
    expect(out).toMatch(/workers live 1\/1/);
    expect(out).toMatch(/epoch \d+/);
    expect(out).toMatch(/token-verified/);
    expect(out).toMatch(/heartbeat \S+/);
  }, 90000);

  it('resume output carries epoch + heartbeat + conductor live', async () => {
    const body =
      "const { savePlan } = await import(SRC + '/lib/plan-state.ts');\n" +
      "await savePlan({ id: 'plan-handoff-1', name: 'handoff work', mode: 'autopilot', status: 'running', jobs: [{ id: 'j1', name: 'task-a', prompt: 'do a', status: 'running' }], integrationBranch: 'mc/integration-x', integrationWorktree: '/tmp/mc-x', baseCommit: 'abc123', createdAt: new Date().toISOString() }, undefined);\n" +
      "const out = await dispatchCommand('resume --intake ' + id, controls, { resumeAutonomous: async () => 'progress probe ok' });\n";
    const out = await runDriver(buildDriver(body));
    expect(out).toMatch(/conductor live/);
    expect(out).toMatch(/epoch \d+/);
    expect(out).toMatch(/heartbeat \S+/);
  }, 90000);
});
