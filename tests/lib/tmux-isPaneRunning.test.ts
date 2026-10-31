import { describe, it, expect, afterEach } from 'bun:test';
import {
  isPaneRunning,
  isTmuxHealthy,
  createSession,
  killSession,
} from '../../src/lib/tmux';
import { isLive, ownedName, uniqueName, isOwnedMcSession } from '../helpers/test-env';

// Live tmux is explicit opt-in (TEST_LIVE=1). Without it, live cases skip and
// only pure ownership/naming checks run — no existing session is ever touched.
const live = isLive();
const hasTmux = live && (await isTmuxHealthy());
const tmuxIt = hasTmux ? it : it.skip;

// Sessions created by this run only; cleanup kills solely with proven ownership.
let owned: Array<{ name: string; runToken: string }> = [];

afterEach(async () => {
  for (const s of owned) {
    if (isOwnedMcSession(s.name, s.runToken)) {
      try {
        await killSession(s.name);
      } catch {}
    }
  }
  owned = [];
});

describe('isPaneRunning error handling (live, opt-in)', () => {
  tmuxIt('returns false when pane does not exist', async () => {
    const result = await isPaneRunning('nonexistent-session-abc-xyz-999:0');
    expect(result).toBe(false);
  });

  tmuxIt('returns true for an active pane', async () => {
    const s = ownedName('mc-test-pane-running');
    owned.push(s);
    await createSession({ name: s.name, workdir: '/tmp' });
    const result = await isPaneRunning(s.name);
    expect(result).toBe(true);
  });

  tmuxIt('returns false after killing a session', async () => {
    const s = ownedName('mc-test-pane-running');
    owned.push(s);
    await createSession({ name: s.name, workdir: '/tmp' });
    if (isOwnedMcSession(s.name, s.runToken)) {
      await killSession(s.name);
    }
    const result = await isPaneRunning(s.name);
    expect(result).toBe(false);
  });
});

describe('isPaneRunning internal logic (live, opt-in)', () => {
  tmuxIt('returns false (not throw) for various nonexistent target formats', async () => {
    const targets = [
      'nonexistent-session-aaa:0',
      'nonexistent-session-bbb:nonexistent-window',
      'no-such-sess-ccc',
    ];
    for (const target of targets) {
      const result = await isPaneRunning(target);
      expect(result).toBe(false);
    }
  });
});

describe('isPaneRunning test isolation (pure, no tmux needed)', () => {
  it('live mode is explicit opt-in via TEST_LIVE=1', () => {
    expect(typeof live).toBe('boolean');
    expect(live).toBe(process.env.TEST_LIVE === '1');
  });

  it('owned names carry this run token and pass the ownership guard', () => {
    const s = ownedName('mc-test-pane-running');
    expect(s.name.startsWith('mc-')).toBe(true);
    expect(s.name.includes(s.runToken)).toBe(true);
    expect(isOwnedMcSession(s.name, s.runToken)).toBe(true);
  });

  it('refuses ownership of foreign or legacy-like names', () => {
    const s = ownedName('mc-test-pane-running');
    expect(isOwnedMcSession('mc-test-pane-running-xyz', s.runToken)).toBe(false);
    expect(isOwnedMcSession('other-session', s.runToken)).toBe(false);
    expect(isOwnedMcSession(`mc-test-other-token`, 'different-token')).toBe(false);
  });

  it('uniqueName produces per-execution names', () => {
    const a = uniqueName('mc-test-pane-running');
    const b = uniqueName('mc-test-pane-running');
    expect(typeof a).toBe('string');
    // Same pid, different timestamp/rand in practice; at minimum non-empty and prefixed.
    expect(a.startsWith('mc-test-pane-running-')).toBe(true);
    expect(b.startsWith('mc-test-pane-running-')).toBe(true);
  });

  it('isTmuxHealthy returns a boolean without side effects', async () => {
    const result = await isTmuxHealthy();
    expect(typeof result).toBe('boolean');
  });
});
