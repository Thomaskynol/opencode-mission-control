import { describe, it, expect } from 'vitest';
import { join } from 'path';
import { tmpdir } from 'os';

import {
  describeTuiModelPin,
  TUI_MODEL_BLOCKADE,
  writeLauncherScript,
} from '../../src/lib/prompt-file';

async function createTempDir(): Promise<string> {
  const fs = await import('fs');
  return fs.promises.mkdtemp(join(tmpdir(), 'mc-tui-blockade-test-'));
}

describe('TUI model blockade (R03: TUI root cannot pin, declared explicitly)', () => {
  it('declares the TUI pin as blocked and points at serve mode', () => {
    const desc = describeTuiModelPin({
      providerID: 'opencode-go',
      id: 'muse-spark-1.3-contributor',
      variant: 'xhigh',
    });
    expect(desc.pinned).toBe(false);
    expect(desc.requested).toBe('opencode-go/muse-spark-1.3-contributor#xhigh');
    expect(desc.mechanism).toBe('none');
    expect(desc.blockade).toBe(TUI_MODEL_BLOCKADE);
    expect(TUI_MODEL_BLOCKADE).toMatch(/serve/);
  });

  it('TUI launcher never emits -m/--model and records the requested triple as NOT pinned', async () => {
    const fs = await import('fs');
    const base = await createTempDir();
    try {
      const promptPath = join(base, '.mc-prompt.txt');
      await fs.promises.writeFile(promptPath, 'hi', 'utf-8');
      await writeLauncherScript(base, promptPath, {
        providerID: 'opencode-go',
        id: 'muse-spark-1.3-contributor',
        variant: 'xhigh',
      });
      const script = await fs.promises.readFile(join(base, '.mc-launch.sh'), 'utf-8');
      const execLine = script.split('\n').filter((l) => l.startsWith('exec ')).join('\n');
      // PROHIBITED: re-adding the rejected flag (TUI root rejects -m: exit 1,
      // revalidated natively on 2.2.5; also true on 2.1.4).
      expect(execLine).not.toMatch(/(^|\s)(-m|--model)(\s|=|$)/);
      // The requested triple stays observable, explicitly marked as not pinned.
      expect(script).toContain('opencode-go/muse-spark-1.3-contributor#xhigh');
      expect(script).toMatch(/not pinned/i);
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it('TUI launcher accepts the legacy string form unchanged (caller contract)', async () => {
    const fs = await import('fs');
    const base = await createTempDir();
    try {
      const promptPath = join(base, '.mc-prompt.txt');
      await fs.promises.writeFile(promptPath, 'hi', 'utf-8');
      await writeLauncherScript(base, promptPath, 'opencode-go/muse-spark-1.3-contributor');
      const script = await fs.promises.readFile(join(base, '.mc-launch.sh'), 'utf-8');
      const execLine = script.split('\n').filter((l) => l.startsWith('exec ')).join('\n');
      expect(execLine).not.toMatch(/(^|\s)(-m|--model)(\s|=|$)/);
      expect(script).toContain('opencode-go/muse-spark-1.3-contributor');
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it('TUI is explicitly not the model contract path: the pinned triple lives only on serve (why this file never emits -m)', async () => {
    // Contract anchor: the autonomous launcher must use a verified serve
    // session (launchWorkerViaServe), never the TUI root. This test pins the
    // reason so a future -m re-add (rejected by the TUI root with exit 1,
    // revalidated on 2.2.5) cannot
    // slip back in as a silent "fix": the TUI exec line stays `opencode
    // --prompt ...` with the triple recorded only as a NOT-pinned comment.
    const fs = await import('fs');
    const base = await createTempDir();
    try {
      const promptPath = join(base, '.mc-prompt.txt');
      await fs.promises.writeFile(promptPath, 'hi', 'utf-8');
      const desc = describeTuiModelPin({
        providerID: 'opencode-go',
        id: 'muse-spark-1.3-contributor',
        variant: 'xhigh',
      });
      expect(desc.pinned).toBe(false);
      expect(desc.mechanism).toBe('none');
      await writeLauncherScript(base, promptPath, {
        providerID: 'opencode-go',
        id: 'muse-spark-1.3-contributor',
        variant: 'xhigh',
      });
      const script = await fs.promises.readFile(join(base, '.mc-launch.sh'), 'utf-8');
      const execLine = script.split('\n').filter((l) => l.startsWith('exec ')).join('\n');
      expect(execLine).toMatch(/^exec \S+ --prompt /);
      expect(execLine).not.toMatch(/(^|\s)(-m|--model)(\s|=|$)/);
      expect(script).toMatch(/not pinned/i);
      expect(script).toContain('opencode-go/muse-spark-1.3-contributor#xhigh');
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });
});
