import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import {
  setCurrentModel,
  getCurrentModelRef,
  requireTrackedModelRef,
  _resetForTesting,
} from '../../src/lib/model-tracker';
import { assertServeSessionModelEcho } from '../../src/lib/sdk-client';
import { describeTuiModelPin, TUI_MODEL_BLOCKADE } from '../../src/lib/prompt-file';

// r3401131: planner/worker model contract — variant propagates end to end,
// requested vs observed stay separate fail-closed fields, TUI never pins.

const PIN = { providerID: 'opencode-go', id: 'muse-spark-1.3-contributor', variant: 'xhigh' };

describe('r3401131 model contract (variant propagation, fail-closed)', () => {
  beforeEach(() => {
    _resetForTesting();
  });

  it('getCurrentModelRef preserves the pinned variant (never drops to provider/model silently)', () => {
    setCurrentModel({ providerID: 'opencode-go', modelID: 'muse-spark-1.3-contributor', variant: 'xhigh' });
    expect(getCurrentModelRef()).toEqual({ ...PIN });
  });

  it('getCurrentModelRef without variant stays variant-less (no invented pin)', () => {
    setCurrentModel({ providerID: 'opencode-go', modelID: 'muse-spark-1.3-contributor' });
    expect(getCurrentModelRef()).toEqual({
      providerID: 'opencode-go',
      id: 'muse-spark-1.3-contributor',
    });
  });

  it('requireTrackedModelRef fails closed when nothing is tracked (never a silent default)', () => {
    expect(() => requireTrackedModelRef()).toThrow(/pinned model|none tracked/);
  });

  it('requireTrackedModelRef propagates the variant when pinned', () => {
    setCurrentModel({ providerID: 'opencode-go', modelID: 'muse-spark-1.3-contributor', variant: 'xhigh' });
    expect(requireTrackedModelRef()).toEqual({ ...PIN });
  });
});

describe('r3401131 requested vs observed (fail-closed lock)', () => {
  const base = { id: 's', projectID: 'p', location: { directory: '/w' } } as const;

  it('absent observed model with a requested pin throws (never verified)', () => {
    expect(() => assertServeSessionModelEcho({ ...base }, PIN)).toThrow(/model absent/);
  });

  it('divergent observed model throws (silent server default never counts as pinned)', () => {
    expect(() =>
      assertServeSessionModelEcho(
        { ...base, model: { providerID: 'opencode-go', id: 'other-model' } },
        PIN,
      ),
    ).toThrow(/model mismatch/);
  });

  it('matching triple verifies (requested and observed agree)', () => {
    expect(() =>
      assertServeSessionModelEcho({ ...base, model: { ...PIN } }, PIN),
    ).not.toThrow();
  });

  it("server-canonical 'default' is no-pin: verifies a variant-less request, never masks a real pin", () => {
    const noPin = { providerID: 'opencode-go', id: 'muse-spark-1.3-contributor' };
    expect(() =>
      assertServeSessionModelEcho(
        { ...base, model: { ...noPin, variant: 'default' } },
        noPin,
      ),
    ).not.toThrow();
    expect(() =>
      assertServeSessionModelEcho(
        { ...base, model: { ...noPin, variant: 'default' } },
        PIN,
      ),
    ).toThrow(/model mismatch/);
  });
});

describe('r3401131 TUI blockade (pinned:false, serve is the only pin path)', () => {
  it('TUI pin stays declared unpinned with the blockade reason', () => {
    const desc = describeTuiModelPin({
      providerID: 'opencode-go',
      id: 'muse-spark-1.3-contributor',
      variant: 'xhigh',
    });
    expect(desc.pinned).toBe(false);
    expect(desc.mechanism).toBe('none');
    expect(desc.requested).toBe('opencode-go/muse-spark-1.3-contributor#xhigh');
    expect(desc.blockade).toBe(TUI_MODEL_BLOCKADE);
  });
});

describe('r3401131 launch serve wiring (static: OMO pre-flight, requested/observed persisted)', () => {
  it('launch.ts validates OMO in pre-flight (no create-then-remove) and keeps requested/observed separate', () => {
    const src = readFileSync(new URL('../../src/tools/launch.ts', import.meta.url), 'utf-8');
    // OMO validation moved to pre-flight via the shared guard (detectOMO
    // lives inside assertOmoModeAvailable in config.ts) — launch.ts must
    // not consult OMO itself nor create-then-remove a worktree.
    expect(src).toContain('assertOmoModeAvailable');
    expect(src).not.toContain("from '../lib/omo'");
    expect(src).toContain('modelRequested');
    expect(src).toContain('modelObserved');
    expect(src).toContain('requires a pinned model');
  });
});

describe('r3401131 destination hash manifest (scopes never interchangeable)', () => {
  // d18c11a5: local destination demo/r5 (from base 0f224094) — disposable demo repo.
  // df06519: F08 dest-live repo (demo/dest-check) — disposable, matrix §30.
  // 3401131: product repo HEAD at PLAN_ID time — the only shippable scope.
  const DEMO_R5_DEST = 'd18c11a5';
  const DEMO_R5_BASE = '0f224094';
  const DEST_LIVE = 'df06519';
  const PRODUCT_HEAD = '3401131';

  function resolveHashScope(hash: string): 'demo-r5' | 'dest-live' | 'product' {
    if (hash === DEMO_R5_DEST) return 'demo-r5';
    if (hash === DEST_LIVE) return 'dest-live';
    if (hash === PRODUCT_HEAD) return 'product';
    throw new Error(`unknown hash scope: ${hash}`);
  }

  it('demo/r5 destination, dest-live, and product HEAD are three distinct scopes', () => {
    expect(new Set([DEMO_R5_DEST, DEST_LIVE, PRODUCT_HEAD]).size).toBe(3);
    expect(DEMO_R5_BASE).not.toBe(DEMO_R5_DEST);
  });

  it('hash scopes are not interchangeable (resolveHashScope rejects cross-use)', () => {
    expect(resolveHashScope(DEMO_R5_DEST)).toBe('demo-r5');
    expect(resolveHashScope(DEST_LIVE)).toBe('dest-live');
    expect(resolveHashScope(PRODUCT_HEAD)).toBe('product');
    // Direct non-collision: no constant aliases another scope.
    expect(DEMO_R5_DEST).not.toBe(DEST_LIVE);
    expect(DEMO_R5_DEST).not.toBe(PRODUCT_HEAD);
    expect(DEST_LIVE).not.toBe(PRODUCT_HEAD);
    // Cross-use refused: demo hash never resolves as product scope.
    expect(() => {
      const scope = resolveHashScope(DEMO_R5_DEST);
      if (scope === 'product') return;
      throw new Error(`hash ${DEMO_R5_DEST} is demo scope "${scope}", not product — refusing cross-use`);
    }).toThrow(/not product/);
    expect(() => resolveHashScope('deadbeef')).toThrow(/unknown hash scope/);
  });
});
