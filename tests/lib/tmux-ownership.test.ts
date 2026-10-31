import { describe, it, expect } from 'vitest';

import {
  MC_JOB_TAG_OPTION,
  MC_SESSION_PREFIX,
  buildOwnedKillList,
  filterOwnedKillTargets,
  formatExecTag,
  isMcSessionName,
  isOwnedSessionForExecTag,
  isOwnedTmuxTarget,
  parseTaggedWindowTargets,
  sessionNameForJob,
} from '../../src/lib/tmux';

// Pure ownership helpers for the kill guard (revisão §7). No tmux calls here:
// TEST_LIVE is never required — these run on every lane.
describe('tmux ownership helpers (pure, kill guard)', () => {
  it('exposes the job-tag option and session prefix', () => {
    expect(MC_JOB_TAG_OPTION).toBe('@mc_job_id');
    expect(MC_SESSION_PREFIX).toBe('mc-');
  });

  it('isMcSessionName is naming only, never ownership', () => {
    expect(isMcSessionName('mc-total')).toBe(true);
    expect(isMcSessionName('other')).toBe(false);
    expect(isMcSessionName('mc-')).toBe(false);
  });

  it('isOwnedTmuxTarget requires strict equality with the recorded target', () => {
    expect(isOwnedTmuxTarget('mc-total-abc123', 'mc-total-abc123')).toBe(true);
    expect(isOwnedTmuxTarget('my-session:total', 'my-session:total')).toBe(true);
    // Same-name foreign session is NOT owned by prefix similarity.
    expect(isOwnedTmuxTarget('mc-total', 'mc-total-recorded-owner')).toBe(false);
    expect(isOwnedTmuxTarget('mc-total', undefined)).toBe(false);
    expect(isOwnedTmuxTarget(undefined, 'mc-total')).toBe(false);
    expect(isOwnedTmuxTarget('', 'mc-total')).toBe(false);
  });

  it('filterOwnedKillTargets keeps only the recorded predecessor', () => {
    expect(filterOwnedKillTargets(['mc-total', 'mc-total-recorded-owner'], 'mc-total-recorded-owner')).toEqual([
      'mc-total-recorded-owner',
    ]);
    expect(filterOwnedKillTargets(['mc-total'], 'mc-total-recorded-owner')).toEqual([]);
    expect(filterOwnedKillTargets(['mc-total'], undefined)).toEqual([]);
    // Deduplicates without widening.
    expect(filterOwnedKillTargets(['a', 'a'], 'a')).toEqual(['a']);
  });

  it('buildOwnedKillList never presumes legacy ownership by similarity', () => {
    // Recorded predecessor wins; legacy bare name is ignored.
    expect(
      buildOwnedKillList({ previousTarget: 'mc-total-recorded-owner', legacySessionName: 'mc-total' }),
    ).toEqual(['mc-total-recorded-owner']);
    // No record + no opt-in → no kills (foreign mc-total survives).
    expect(buildOwnedKillList({ legacySessionName: 'mc-total' })).toEqual([]);
    expect(buildOwnedKillList({})).toEqual([]);
    // Explicit migration opt-in only when there is no recorded predecessor.
    expect(
      buildOwnedKillList({
        legacySessionName: 'mc-total',
        allowLegacyFallback: true,
      }),
    ).toEqual(['mc-total']);
  });

  it('scopes sessions per execution via execTag', () => {
    const tag = formatExecTag('plan-12345678', 'job-abcdef12');
    expect(tag).toBe('plan-123-job-abcd');
    expect(sessionNameForJob('total', tag)).toBe(`mc-total-${tag}`);
    expect(sessionNameForJob('total')).toBe('mc-total');
    expect(isOwnedSessionForExecTag(`mc-total-${tag}`, tag)).toBe(true);
    expect(isOwnedSessionForExecTag('mc-total', tag)).toBe(false);
  });

  it('parses tagged windows by jobId for possession check', () => {
    const out = 'mc-a:0 job-1\nmc-a:1 job-2\nmc-b:0 job-1\n';
    expect(parseTaggedWindowTargets(out, 'job-1')).toEqual(['mc-a:0', 'mc-b:0']);
    expect(parseTaggedWindowTargets(out, 'missing')).toEqual([]);
    expect(parseTaggedWindowTargets('', 'job-1')).toEqual([]);
  });
});
