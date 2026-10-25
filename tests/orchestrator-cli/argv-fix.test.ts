import { describe, it, expect } from 'bun:test';
import { dispatchCommand } from '../../src/orchestrator-cli/commands';
import { dispatchArgv } from '../../src/orchestrator-cli/commands';
import type { AutoIntakeInput } from '../../src/lib/auto-plan';

function stubDeps(captured: { input?: AutoIntakeInput }) {
  return {
    startAutonomous: async (input: AutoIntakeInput) => {
      captured.input = input;
      return { intakeId: 'test-id', tasks: [] as string[], launched: false };
    },
    generate: async () => {
      throw new Error('should not call generate');
    },
  };
}

const controls = {
  pause: async (n: string) => `paused ${n}`,
  resume: async (n: string) => `resumed ${n}`,
  cancel: async (n: string) => `canceled ${n}`,
  answer: async (n: string, r: string) => `answered ${n}:${r}`,
  launch: async (p: string) => p,
};

describe('argv-fix: multi-word --request preservation', () => {
  it('dispatchArgv preserves quoted multi-word --request from raw argv', async () => {
    const captured: { input?: AutoIntakeInput } = {};
    // Shell already stripped quotes: single argv token with spaces
    await dispatchArgv(
      ['start', '--repo', '/tmp/r', '--branch', 'b', '--request', 'Preciso de dois helpers'],
      controls,
      stubDeps(captured),
    );
    expect(captured.input?.request).toBe('Preciso de dois helpers');
  });

  it('dispatchArgv supports --request=value form', async () => {
    const captured: { input?: AutoIntakeInput } = {};
    await dispatchArgv(
      ['start', '--repo=/tmp/r', '--branch=b', '--request=Preciso de X Y'],
      controls,
      stubDeps(captured),
    );
    expect(captured.input?.request).toBe('Preciso de X Y');
    expect(captured.input?.repo).toBe('/tmp/r');
    expect(captured.input?.targetBranch).toBe('b');
  });

  it('dispatchCommand preserves quoted --request/--context with spaces', async () => {
    const captured: { input?: AutoIntakeInput } = {};
    await dispatchCommand(
      'start --repo /tmp/r --branch b --request "Preciso de X Y" --context "doc um dois"',
      controls,
      stubDeps(captured),
    );
    expect(captured.input?.request).toBe('Preciso de X Y');
    expect(captured.input?.docs).toEqual(['doc um dois']);
  });

  it('dispatchCommand supports = form with quotes', async () => {
    const captured: { input?: AutoIntakeInput } = {};
    await dispatchCommand(
      'start --repo=/tmp/r --branch=b --request="Preciso de X Y"',
      controls,
      stubDeps(captured),
    );
    expect(captured.input?.request).toBe('Preciso de X Y');
    expect(captured.input?.repo).toBe('/tmp/r');
    expect(captured.input?.targetBranch).toBe('b');
  });

  it('dispatchCommand preserves unquoted multi-word --request spill', async () => {
    const captured: { input?: AutoIntakeInput } = {};
    // Simulates index.ts join bug: quotes lost, words split
    await dispatchCommand('start --request Preciso de X Y --repo /tmp/r', controls, stubDeps(captured));
    expect(captured.input?.request).toBe('Preciso de X Y');
    expect(captured.input?.repo).toBe('/tmp/r');
  });
});
