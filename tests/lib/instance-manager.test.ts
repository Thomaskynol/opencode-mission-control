import { describe, it, expect } from 'vitest';

import {
  assertProfileEquivalence,
  resolveModelFallback,
  evaluateDepthGuard,
  readInstanceDepth,
  InstanceManager,
  type InstanceProfile,
  type V2SessionSnapshot,
} from '../../src/lib/instance-manager';

const PROFILE: InstanceProfile = {
  model: { providerID: 'anthropic', id: 'claude-sonnet-4-20250514' },
  agent: 'build',
  directory: '/tmp/m2-work',
  projectID: 'proj-1',
  permissions: [{ action: 'edit', resource: '/tmp/m2-work/**', effect: 'allow' }],
};

function snapshotOf(overrides: Partial<V2SessionSnapshot> = {}): V2SessionSnapshot {
  return {
    id: 'ses_1',
    projectID: 'proj-1',
    agent: 'build',
    model: { providerID: 'anthropic', id: 'claude-sonnet-4-20250514' },
    location: { directory: '/tmp/m2-work' },
    permissions: [{ action: 'edit', resource: '/tmp/m2-work/**', effect: 'allow' }],
    ...overrides,
  };
}

describe('assertProfileEquivalence', () => {
  it('is equivalent when triple, agent, directory, projectID and permissions match', () => {
    const result = assertProfileEquivalence(PROFILE, snapshotOf());
    expect(result.equivalent).toBe(true);
    expect(result.mismatches).toEqual([]);
  });

  it('flags model id mismatch', () => {
    const result = assertProfileEquivalence(
      PROFILE,
      snapshotOf({ model: { providerID: 'anthropic', id: 'other-model' } }),
    );
    expect(result.equivalent).toBe(false);
    expect(result.mismatches.join(' ')).toMatch(/model/i);
  });

  it('flags provider mismatch', () => {
    const result = assertProfileEquivalence(
      PROFILE,
      snapshotOf({ model: { providerID: 'openai', id: 'claude-sonnet-4-20250514' } }),
    );
    expect(result.equivalent).toBe(false);
    expect(result.mismatches.join(' ')).toMatch(/provider/i);
  });

  it('flags variant mismatch only when a variant was pinned', () => {
    const pinned: InstanceProfile = {
      ...PROFILE,
      model: { ...PROFILE.model, variant: 'max' },
    };
    const drifted = assertProfileEquivalence(
      pinned,
      snapshotOf({ model: { ...PROFILE.model, variant: undefined } }),
    );
    expect(drifted.equivalent).toBe(false);

    const unpinned = assertProfileEquivalence(PROFILE, snapshotOf());
    expect(unpinned.equivalent).toBe(true);
  });

  it('flags agent mismatch', () => {
    const result = assertProfileEquivalence(PROFILE, snapshotOf({ agent: 'plan' }));
    expect(result.equivalent).toBe(false);
    expect(result.mismatches.join(' ')).toMatch(/agent/i);
  });

  it('ignores a trailing slash on directory', () => {
    const result = assertProfileEquivalence(
      PROFILE,
      snapshotOf({ location: { directory: '/tmp/m2-work/' } }),
    );
    expect(result.equivalent).toBe(true);
  });

  it('flags directory mismatch', () => {
    const result = assertProfileEquivalence(
      PROFILE,
      snapshotOf({ location: { directory: '/other/dir' } }),
    );
    expect(result.equivalent).toBe(false);
    expect(result.mismatches.join(' ')).toMatch(/director/i);
  });

  it('flags projectID mismatch', () => {
    const result = assertProfileEquivalence(PROFILE, snapshotOf({ projectID: 'proj-2' }));
    expect(result.equivalent).toBe(false);
    expect(result.mismatches.join(' ')).toMatch(/project/i);
  });

  it('flags permission drift', () => {
    const result = assertProfileEquivalence(PROFILE, snapshotOf({ permissions: [] }));
    expect(result.equivalent).toBe(false);
    expect(result.mismatches.join(' ')).toMatch(/permission/i);
  });

  it('flags missing model on the live session', () => {
    const result = assertProfileEquivalence(PROFILE, snapshotOf({ model: undefined }));
    expect(result.equivalent).toBe(false);
    expect(result.mismatches.join(' ')).toMatch(/model/i);
  });
});

describe('resolveModelFallback', () => {
  it('never silently swaps the model: pauses and asks the operator', () => {
    const outcome = resolveModelFallback(
      { providerID: 'anthropic', id: 'claude-sonnet-4-20250514' },
      [{ providerID: 'anthropic', id: 'other-model' }],
      'model unavailable from provider',
    );
    expect(outcome.action).toBe('pause');
    expect(outcome.swappedModel).toBeUndefined();
    expect(outcome.question).toMatch(/claude-sonnet-4-20250514/);
    expect(outcome.question).toMatch(/other-model/);
  });
});

describe('evaluateDepthGuard', () => {
  it('allows depth below the max', () => {
    expect(() => evaluateDepthGuard(0, 1)).not.toThrow();
  });

  it('throws when a worker would start a nested managed run', () => {
    expect(() => evaluateDepthGuard(1, 1)).toThrow(/recursion|nested|depth/i);
  });

  it('reads depth from the environment', () => {
    expect(readInstanceDepth({ MC_INSTANCE_DEPTH: '2' })).toBe(2);
    expect(readInstanceDepth({})).toBe(0);
    expect(readInstanceDepth({ MC_INSTANCE_DEPTH: 'nope' })).toBe(0);
  });
});

describe('InstanceManager', () => {
  it('launches a session and verifies profile equivalence', async () => {
    const calls: string[] = [];
    const ops = {
      create: async () => {
        calls.push('create');
        return { sessionID: 'ses_1' };
      },
      get: async () => {
        calls.push('get');
        return snapshotOf();
      },
      interrupt: async () => {
        calls.push('interrupt');
      },
      wait: async () => {
        calls.push('wait');
      },
    };
    const manager = new InstanceManager(PROFILE, ops);
    const launched = await manager.launch();
    expect(launched.sessionID).toBe('ses_1');
    expect(launched.equivalent).toBe(true);
    expect(calls).toEqual(['create', 'get']);
  });

  it('pauses (never launches mismatched work) when the live session drifts', async () => {
    const ops = {
      create: async () => ({ sessionID: 'ses_1' }),
      get: async () => snapshotOf({ agent: 'plan' }),
      interrupt: async () => {},
      wait: async () => {},
    };
    const manager = new InstanceManager(PROFILE, ops);
    const launched = await manager.launch();
    expect(launched.equivalent).toBe(false);
    expect(launched.status).toBe('paused');
    expect(launched.mismatches.join(' ')).toMatch(/agent/i);
  });

  it('refuses to launch from inside a nested managed run', async () => {
    const ops = {
      create: async () => ({ sessionID: 'ses_1' }),
      get: async () => snapshotOf(),
      interrupt: async () => {},
      wait: async () => {},
    };
    const manager = new InstanceManager(PROFILE, ops, { env: { MC_INSTANCE_DEPTH: '1' } });
    await expect(manager.launch()).rejects.toThrow(/recursion|nested|depth/i);
  });

  it('pause interrupts and resume waits for idle', async () => {
    const calls: string[] = [];
    const ops = {
      create: async () => {
        calls.push('create');
        return { sessionID: 'ses_1' };
      },
      get: async () => {
        calls.push('get');
        return snapshotOf();
      },
      interrupt: async () => {
        calls.push('interrupt');
      },
      wait: async () => {
        calls.push('wait');
      },
    };
    const manager = new InstanceManager(PROFILE, ops);
    await manager.launch();
    await manager.pause();
    await manager.resume();
    expect(calls).toEqual(['create', 'get', 'interrupt', 'wait']);
  });
});
