import { join, dirname } from 'path';
import { homedir } from 'os';
import { existsSync, readFileSync, readdirSync, statSync, type Dirent } from 'node:fs';
import { z } from 'zod';
import { getDataDir } from './paths';
import { MCConfigSchema, PartialMCConfigSchema } from './schemas';
import { PermissionPolicy } from './permission-policy';
import { atomicWrite } from './utils';
import { detectOMO } from './omo';

export type WorktreeSetup = {
  copyFiles?: string[];
  symlinkDirs?: string[];
  commands?: string[];
};

export type MCConfig = z.infer<typeof MCConfigSchema>;

const DEFAULT_CONFIG: MCConfig = {
  defaultPlacement: 'session',
  pollInterval: 10000,
  idleThreshold: 300000,
  worktreeBasePath: join(homedir(), '.local', 'share', 'opencode-mission-control'),
  maxParallel: 3,
  autoCommit: true,
  testTimeout: 600000,
  mergeStrategy: 'squash',
  useServeMode: true,
  portRangeStart: 14100,
  portRangeEnd: 14199,
  fixBeforeRollbackTimeout: 120000,
  defaultPermissionPolicy: PermissionPolicy.getDefaultPolicy(),
  omo: {
    enabled: false,
    defaultMode: 'vanilla',
  },
};

const CONFIG_FILE = 'config.json';

export async function getConfigPath(): Promise<string> {
  const dataDir = await getDataDir();
  return join(dataDir, CONFIG_FILE);
}



export async function loadConfig(): Promise<MCConfig> {
  const filePath = await getConfigPath();
  const file = Bun.file(filePath);
  const exists = await file.exists();

  if (!exists) {
    return { ...DEFAULT_CONFIG };
  }

  try {
    const content = await file.text();
    const fileConfig = PartialMCConfigSchema.parse(JSON.parse(content));
    const result: MCConfig = {
      ...DEFAULT_CONFIG,
      ...fileConfig,
      omo: {
        ...DEFAULT_CONFIG.omo,
        ...(fileConfig.omo || {}),
      },
    };
    return result;
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new Error(`Invalid config in ${filePath}: ${error.issues.map(e => `${e.path.join('.')}: ${e.message}`).join(', ')}`);
    }
    throw new Error(`Failed to load config from ${filePath}: ${error}`);
  }
}

export async function saveConfig(config: MCConfig): Promise<void> {
  const filePath = await getConfigPath();

  try {
    const configToSave = Object.fromEntries(
      Object.entries(config).filter(([, value]) => value !== undefined)
    ) as MCConfig;
    const data = JSON.stringify(configToSave, null, 2);
    await atomicWrite(filePath, data);
  } catch (error) {
    throw new Error(`Failed to save config to ${filePath}: ${error}`);
  }
}

/* ------------------------------------------------------------------ */
/* Dispatch pre-flight: dist pronto + OMO disponível (fail-fast antes  */
/* de qualquer worktree). Chamado pelo plugin init (src/index.ts) e    */
/* pelo preflight de mc_launch/mc_plan (antes de createWorktree).      */
/* ------------------------------------------------------------------ */

/** Localiza a raiz do repo do plugin subindo até o package.json canônico. */
export function resolvePluginRepoRoot(fromDir: string = import.meta.dir): string {
  let dir = fromDir;
  for (let i = 0; i < 6; i++) {
    try {
      const pkgPath = join(dir, 'package.json');
      if (existsSync(pkgPath)) {
        const parsed: unknown = JSON.parse(readFileSync(pkgPath, 'utf8'));
        if (typeof parsed === 'object' && parsed !== null && (parsed as { name?: unknown }).name === 'opencode-mission-control') {
          return dir;
        }
      }
    } catch {
      // ilegível/inválido: continua subindo
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Sem raiz canônica: fail-closed com instrução (nunca adivinhar dist).
  throw new Error(`${distFixInstructions(fromDir)} — raiz do plugin não localizada a partir de ${fromDir}.`);
}

function scanSrcMtime(srcDir: string, acc: { newest: number; count: number }): void {
  let entries: Dirent[];
  try {
    entries = readdirSync(srcDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(srcDir, entry.name);
    if (entry.isDirectory()) {
      scanSrcMtime(full, acc);
    } else if (entry.name.endsWith('.ts')) {
      try {
        const m = statSync(full).mtimeMs;
        if (m > acc.newest) acc.newest = m;
        acc.count++;
      } catch {
        // ignore
      }
    }
  }
}

function newestSrcMtime(srcDir: string, repoRoot: string): number {
  const acc = { newest: 0, count: 0 };
  scanSrcMtime(srcDir, acc);
  // src/ ilegível ou sem .ts → fail-closed, nunca presumir dist ok.
  if (acc.count === 0) {
    throw new Error(`${distFixInstructions(repoRoot)} — src/ ilegível ou sem .ts em ${srcDir}.`);
  }
  return acc.newest;
}

/** Instrução reproduzível de correção (dist ausente ou desatualizado). */
export function distFixInstructions(repoRoot: string): string {
  return (
    `[MC] plugin build ausente ou desatualizado (repo: ${repoRoot}). ` +
    `Corrija e reinicie: cd ${repoRoot} && bun install && bun run build && ls dist/index.js && restart OpenCode`
  );
}

/**
 * Fail-fast: dist/index.js ausente OU qualquer .ts em src/ mais novo que
 * dist → throw com instrução reproduzível. Nunca deixa a missão terminar
 * sem o recurso para só então informar.
 */
export function assertPluginDistReady(fromDir?: string): void {
  const repoRoot = resolvePluginRepoRoot(fromDir);
  const distPath = join(repoRoot, 'dist', 'index.js');
  let distMtime = 0;
  try {
    distMtime = statSync(distPath).mtimeMs;
  } catch {
    throw new Error(
      `${distFixInstructions(repoRoot)} — dist/index.js não encontrado.`,
    );
  }
  const srcNewest = newestSrcMtime(join(repoRoot, 'src'), repoRoot);
  // >= : mesma granularidade de mtime após edição+build imediatos conta como stale (fail-closed).
  if (srcNewest >= distMtime) {
    throw new Error(
      `${distFixInstructions(repoRoot)} — src/ mais novo que dist/index.js (rebuild pendente).`,
    );
  }
}

// Espelha o z.enum de mode em schemas.ts (launch/plan/defaultMode).
const EXECUTION_MODES = ['vanilla', 'plan', 'ralph', 'ulw'] as const;

/**
 * Fail-fast OMO: modo != vanilla sem OMO detectado → throw ANTES de criar
 * worktree, com correção (mode:"vanilla" explícito ou omo.defaultMode no
 * config do projeto, sem tocar no perfil global ~/.config/opencode).
 */
export async function assertOmoModeAvailable(mode: string | undefined): Promise<void> {
  if (mode === undefined || !(EXECUTION_MODES as readonly string[]).includes(mode)) {
    throw new Error(
      `[MC] modo de execução desconhecido: ${String(mode)} — use um de: ${EXECUTION_MODES.join(', ')}. Nenhuma worktree foi criada.`,
    );
  }
  if (mode === 'vanilla') return;
  const omo = await detectOMO();
  if (omo.detected) return;
  const configPath = await getConfigPath();
  throw new Error(
    `[MC] OMO mode "${mode}" requires Oh-My-OpenCode to be installed and detected, ` +
      `and no worktree was created. Fix with one of: (1) pass mode:"vanilla" explicitly; ` +
      `(2) set omo.defaultMode:"vanilla" in the project config ${configPath} ` +
      `(project-scoped, never touches the global ~/.config/opencode profile); ` +
      `(3) install Oh-My-OpenCode so detectOMO finds it in opencode.json.`,
  );
}
