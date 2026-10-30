import { join } from 'path';
import { writeFile, unlink, mkdir } from 'fs/promises';
import { spawnSync } from 'bun';
import { quoteShellPath } from './sdk-client.js';

const PROMPT_FILENAME = '.mc-prompt.txt';
const LAUNCHER_FILENAME = '.mc-launch.sh';

function resolveOpencodePath(): string {
  const result = spawnSync(['which', 'opencode'], { stderr: 'pipe' });
  if (result.exitCode === 0) {
    const resolved = result.stdout.toString().trim();
    if (resolved) return resolved;
  }
  return 'opencode';
}

export async function writePromptFile(
  worktreePath: string,
  prompt: string,
): Promise<string> {
  const filePath = join(worktreePath, PROMPT_FILENAME);
  await mkdir(worktreePath, { recursive: true });
  await writeFile(filePath, prompt, 'utf-8');
  return filePath;
}

export function cleanupPromptFile(filePath: string, delayMs = 5000): void {
  setTimeout(() => {
    unlink(filePath).catch(() => {});
  }, delayMs);
}

export async function writeLauncherScript(
  worktreePath: string,
  promptFilePath: string,
  model?: string | { providerID: string; id: string; variant?: string },
): Promise<string> {
  const launcherPath = join(worktreePath, LAUNCHER_FILENAME);
  const opencodeBin = resolveOpencodePath();
  // F06/R03 supported pinning matrix (verified against the installed CLI):
  // - `opencode run --standalone --model provider/id#variant` PINS the triple
  //   (planner slot uses this form; variant preserved end to end).
  // - TUI root (`opencode --prompt ...`) has NO -m/--model flag in v2.1.4
  //   (`Unrecognized flag: -m`, exit 1), so the TUI launcher MUST NOT emit -m:
  //   it inherits the session default and records the effective triple below
  //   explicitly instead of faking a pin. Never silently keep a default.
  // - serve/SDK paths pin the full triple programmatically (verified live:
  //   POST /api/session {model} echoes the triple, GET returns it unchanged).
  const cliModel = typeof model === 'string' ? model : model ? `${model.providerID}/${model.id}` : undefined;
  const variant = typeof model === 'object' ? model.variant : undefined;
  const triple = [cliModel, variant ? `#${variant}` : ''].join('');
  const modelNote = triple
    ? `# effective model: ${triple} (not pinned: TUI root has no -m/--model in v2.1.4; inherits default)\n`
    : '# effective model: none tracked (TUI default)\n';
  const script = `#!/bin/bash\n${modelNote}exec ${opencodeBin} --prompt "$(cat ${quoteShellPath(promptFilePath)})"\n`;
  await writeFile(launcherPath, script, { mode: 0o755 });
  return launcherPath;
}

/**
 * TUI root cannot pin a model (verified: `opencode -m` exits 1 with
 * "Unrecognized flag: -m"). A requested triple is recorded in the launcher
 * comment, NEVER applied. Worker sessions that must run under a pinned
 * triple have exactly one supported path: serve mode
 * (POST /api/session {model}, verified back via GET).
 */
export const TUI_MODEL_BLOCKADE =
  'TUI root (opencode --prompt) has no -m/--model in v2.1.4: the requested model is recorded, NOT applied — workers inherit the session default. Use serve mode (POST /api/session {model}) for a pinned, verified triple.';

export interface TuiModelPinDescription {
  pinned: false;
  requested?: string;
  /** TUI root has no pinning mechanism: always 'none'. */
  mechanism: 'none';
  blockade: string;
}

/** Explicit TUI pin declaration: always unpinned, with the reason attached. */
export function describeTuiModelPin(
  model?: string | { providerID: string; id: string; variant?: string },
): TuiModelPinDescription {
  const triple =
    typeof model === 'string'
      ? model
      : model
        ? `${model.providerID}/${model.id}${model.variant ? `#${model.variant}` : ''}`
        : undefined;
  return {
    pinned: false,
    ...(triple ? { requested: triple } : {}),
    mechanism: 'none',
    blockade: TUI_MODEL_BLOCKADE,
  };
}

export function cleanupLauncherScript(worktreePath: string, delayMs = 5000): void {
  const launcherPath = join(worktreePath, LAUNCHER_FILENAME);
  setTimeout(() => {
    unlink(launcherPath).catch(() => {});
  }, delayMs);
}

export async function writeServeLauncherScript(
  worktreePath: string,
  port: number,
  password?: string,
): Promise<string> {
  const launcherPath = join(worktreePath, LAUNCHER_FILENAME);
  const opencodeBin = resolveOpencodePath();
  const envLine = password
    ? `export OPENCODE_SERVER_PASSWORD="${password}"\n`
    : '';
  const script = `#!/bin/bash\n${envLine}exec ${opencodeBin} serve --port ${port} --hostname 127.0.0.1\n`;
  await writeFile(launcherPath, script, { mode: 0o755 });
  return launcherPath;
}
