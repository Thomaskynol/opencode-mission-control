import { describe, it, expect } from 'vitest';
import { join } from 'path';
import { tmpdir } from 'os';
import { writeLauncherScript } from '../../src/lib/prompt-file';

async function createTempDir(): Promise<string> {
  const fs = await import('fs');
  return fs.promises.mkdtemp(join(tmpdir(), 'mc-prompt-file-test-'));
}

describe('prompt-file shell quoting', () => {
  it('quotes worktree paths with spaces and single quotes', async () => {
    const fs = await import('fs');
    const base = await createTempDir();
    const worktreePath = join(base, `my dir` + `'s work`);
    fs.mkdirSync(worktreePath, { recursive: true });

    const launcherPath = await writeLauncherScript(
      worktreePath,
      join(worktreePath, '.mc-prompt.txt'),
      undefined,
    );

    const script = await fs.promises.readFile(launcherPath, 'utf-8');
    // The embedded prompt path must be single-quote escaped, never raw.
    expect(script).toContain(`'\\''`);
    expect(script).not.toContain(`'${join(worktreePath, '.mc-prompt.txt')}'`);

    fs.rmSync(base, { recursive: true, force: true });
  });
});
