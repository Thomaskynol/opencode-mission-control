import { describe, it, expect, beforeEach, afterEach, spyOn, mock } from 'bun:test';
import { join } from 'path';
import { tmpdir } from 'os';
import * as paths from '../../src/lib/paths';
import { dispatchCommand, type HumanControls } from '../../src/orchestrator-cli/commands';
import { loadAutoIntake } from '../../src/lib/durable-state';

let testBaseDir: string;
let testStateDir: string;
let restoreDataDir: () => void = () => {};

function stubDataDir(dir: string): void {
  const current = paths.getDataDir as unknown as {
    mockResolvedValue?: (v: string) => void;
    mockReset?: () => void;
  };
  if (current && typeof current.mockResolvedValue === 'function') {
    current.mockResolvedValue(dir);
    restoreDataDir = () => current.mockReset?.();
  } else {
    const spy = spyOn(paths, 'getDataDir').mockResolvedValue(dir);
    restoreDataDir = () => spy.mockRestore();
  }
}

async function tempDir(prefix: string): Promise<string> {
  const fs = await import('fs');
  return fs.promises.mkdtemp(join(tmpdir(), prefix));
}

function fakeControls(): HumanControls {
  return {
    pause: async (name) => `paused ${name}`,
    resume: async (name) => `resumed ${name}`,
    cancel: async (name) => `canceled ${name}`,
    answer: async (name, response) => `answered ${name}:${response}`,
    launch: async (prompt) => `launch ready (${prompt.length} chars)`,
  };
}

beforeEach(async () => {
  testBaseDir = await tempDir('mc-approve-cli-test-');
  testStateDir = join(testBaseDir, 'state');
  const fs = await import('fs');
  fs.mkdirSync(testStateDir, { recursive: true });
  stubDataDir(testStateDir);
});

afterEach(async () => {
  restoreDataDir();
  const fs = await import('fs');
  if (testBaseDir && fs.existsSync(testBaseDir)) fs.rmSync(testBaseDir, { recursive: true, force: true });
});

/**
 * Gap2 TDD: public CLI approve that clears the on_error checkpoint /
 * approves retry|relaunch (mc_plan_approve is MCP-only). Must run via the
 * public CLI path (dispatchCommand), mapping to the same approve path with
 * the same validation/authorization.
 */
describe('gap2: public CLI approve clears checkpoint (no MCP-only path)', () => {
  it('approve --intake fails fail-closed when no paused plan exists (never silent)', async () => {
    const started = await dispatchCommand('start Add retry', fakeControls());
    const id = started.match(/Intake (\S+) persisted/)![1];

    // Fresh scope has an intake but no plan: approve must fail explicitly
    // (MCP parity), never return HELP and never claim success.
    await expect(dispatchCommand(`approve --intake ${id}`, fakeControls())).rejects.toThrow(
      /No active plan|not pending or paused/i,
    );
  });

  it('approve --intake rejects retry+relaunch together (same validation as MCP)', async () => {
    const started = await dispatchCommand('start Add retry', fakeControls());
    const id = started.match(/Intake (\S+) persisted/)![1];
    await expect(
      dispatchCommand(`approve --intake ${id} --retry a --relaunch b`, fakeControls()),
    ).rejects.toThrow(/retry.*relaunch|Cannot specify both/i);
  });

  it('approve requires an intake (fail-closed, never silent success)', async () => {
    await expect(dispatchCommand('approve --intake does-not-exist', fakeControls())).rejects.toThrow(
      /No intake|No active intake/i,
    );
  });

  it('approve --intake maps --retry to the retry path with validation', async () => {
    const started = await dispatchCommand('start Add retry', fakeControls());
    const id = started.match(/Intake (\S+) persisted/)![1];
    // No paused plan exists in this fresh scope: must fail explicitly
    // (missing retryable job / no paused plan), never claim success.
    await expect(dispatchCommand(`approve --intake ${id} --retry ghost-job`, fakeControls())).rejects.toThrow(
      /No active plan|not found|not in a retryable|paused/i,
    );
  });
});
