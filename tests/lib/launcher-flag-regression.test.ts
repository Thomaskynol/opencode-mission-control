import { describe, it, expect } from 'vitest';
import { join } from 'path';
import { tmpdir } from 'os';
import { writeLauncherScript } from '../../src/lib/prompt-file';
import { createRunPlannerGenerate } from '../../src/lib/auto-plan';

async function createTempDir(): Promise<string> {
  const fs = await import('fs');
  return fs.promises.mkdtemp(join(tmpdir(), 'mc-launcher-flag-test-'));
}

async function readScript(worktreePath: string): Promise<string> {
  const fs = await import('fs');
  return fs.promises.readFile(join(worktreePath, '.mc-launch.sh'), 'utf-8');
}

describe('launcher-flag regression (TUI opencode 2.1.4 has no -m)', () => {
  it('TUI launcher with string model emits no -m/--model flag', async () => {
    const fs = await import('fs');
    const base = await createTempDir();
    try {
      const promptPath = join(base, '.mc-prompt.txt');
      await fs.promises.writeFile(promptPath, 'hi', 'utf-8');
      await writeLauncherScript(base, promptPath, 'opencode-go/muse-spark-1.3-contributor');
      const script = await readScript(base);
      const execLine = script.split('\n').filter((l) => l.startsWith('exec ')).join('\n');
      expect(execLine).not.toMatch(/(^|\s)(-m|--model)(\s|=|$)/);
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it('TUI launcher with object model (variant) emits no -m flag', async () => {
    const fs = await import('fs');
    const base = await createTempDir();
    try {
      const promptPath = join(base, '.mc-prompt.txt');
      await fs.promises.writeFile(promptPath, 'hi', 'utf-8');
      await writeLauncherScript(base, promptPath, {
        providerID: 'opencode-go',
        id: 'muse-spark-1.3-contributor',
        variant: 'max',
      });
      const script = await readScript(base);
      const execLine = script.split('\n').filter((l) => l.startsWith('exec ')).join('\n');
      expect(execLine).not.toMatch(/(^|\s)(-m|--model)(\s|=|$)/);
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it('TUI launcher records the effective triple explicitly (fail-closed, no silent pin)', async () => {
    const fs = await import('fs');
    const base = await createTempDir();
    try {
      const promptPath = join(base, '.mc-prompt.txt');
      await fs.promises.writeFile(promptPath, 'hi', 'utf-8');
      await writeLauncherScript(base, promptPath, {
        providerID: 'opencode-go',
        id: 'muse-spark-1.3-contributor',
        variant: 'max',
      });
      const script = await readScript(base);
      // Effective triple stays observable even though the TUI cannot pin it.
      expect(script).toContain('opencode-go/muse-spark-1.3-contributor');
      expect(script).toContain('max');
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it('planner still pins via supported `run --standalone --model` form', async () => {
    const seen: string[][] = [];
    const draft = {
      requirements: [{ id: 'r1', text: 't', acceptance: ['a'] }],
      tasks: [{ name: 't1', prompt: 'do it', acceptance: ['done'] }],
      decisions: [],
      questions: [],
      nextSteps: [],
    };
    const generate = createRunPlannerGenerate({
      model: 'opencode-go/muse-spark-1.3-contributor',
      run: async (args: string[], _prompt: string) => {
        seen.push(args);
        return JSON.stringify(draft);
      },
    });
    await generate('draft a plan');
    expect(seen).toHaveLength(1);
    expect(seen[0]!.slice(0, 4)).toEqual([
      'run',
      '--standalone',
      '--model',
      'opencode-go/muse-spark-1.3-contributor',
    ]);
  });
});
