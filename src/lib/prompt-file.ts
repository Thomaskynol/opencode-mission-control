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
  // F06: CLI `-m` has no variant form — the string carries provider/model,
  // the pinned variant (when supported, e.g. serve triple) is preserved as an
  // explicit comment so planner/workers stay observably equal.
  const cliModel = typeof model === 'string' ? model : model ? `${model.providerID}/${model.id}` : undefined;
  const variant = typeof model === 'object' ? model.variant : undefined;
  const modelFlag = cliModel ? ` -m "${cliModel}"` : '';
  const variantNote = variant ? `# variant: ${variant} (pinned triple; CLI -m carries provider/model only)\n` : '';
  const script = `#!/bin/bash\n${variantNote}exec ${opencodeBin}${modelFlag} --prompt "$(cat ${quoteShellPath(promptFilePath)})"\n`;
  await writeFile(launcherPath, script, { mode: 0o755 });
  return launcherPath;
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
