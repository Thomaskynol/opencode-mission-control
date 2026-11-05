import type { PostCreateHook } from './providers/worktree-provider';
import type { WorktreeSetup } from './config';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export type CommandValidationResult = {
  safe: boolean;
  warnings: string[];
};

// Each entry: [regex pattern, human-readable warning message]
const DANGEROUS_PATTERNS: [RegExp, string][] = [
  [/`[^`]+`/, 'backtick command substitution'],
  [/\$\(/, 'dollar-paren command substitution'],
  [/\beval\b/, 'eval execution'],
  [/\bexec\b/, 'exec execution'],
  [/\|\s*(sh|bash|zsh|dash)\b/, 'pipe to shell interpreter'],
  [/\b(curl|wget)\b.*\|/, 'remote script piped to another command'],
  [/\brm\s+(-[a-zA-Z]*f[a-zA-Z]*\s+)?-[a-zA-Z]*r[a-zA-Z]*\s+\//, 'recursive delete from root'],
  [/\brm\s+(-[a-zA-Z]*r[a-zA-Z]*\s+)?-[a-zA-Z]*f[a-zA-Z]*\s+\//, 'recursive force-delete from root'],
  [/\brm\s+-rf\s+\//, 'rm -rf /'],
  [/>\s*\/etc\//, 'redirect to /etc/'],
  [/>\s*\/usr\//, 'redirect to /usr/'],
  [/>\s*\/sys\//, 'redirect to /sys/'],
  [/>\s*\/proc\//, 'redirect to /proc/'],
  [/;/, 'semicolon-chained commands'],
  [/&&/, 'chained commands (&&)'],
  [/\|(?!\|)/, 'pipe operator'],
];

const SAFE_COMMAND_PATTERNS: RegExp[] = [
  /^(npm|npx)\s+(install|ci|run\s+\S+|test|build|start|exec)\b/,
  /^bun\s+(install|add|remove|run\s+\S+|test|build|x)\b/,
  /^yarn(\s+(install|add|remove|run\s+\S+|test|build))?$/,
  /^pnpm\s+(install|add|remove|run\s+\S+|test|build)\b/,
  /^pip\s+install\b/,
  /^cargo\s+(build|test|run|check|clippy|fmt)\b/,
  /^make(\s+\w+)?$/,
  /^go\s+(build|test|mod\s+\w+)\b/,
  /^mvn\s+/,
  /^gradle\s+/,
  /^dotnet\s+(build|test|restore|run)\b/,
  /^composer\s+(install|update|require)\b/,
  /^bundle\s+(install|exec)\b/,
  /^gem\s+install\b/,
  /^mix\s+(deps\.get|compile|test)\b/,
  /^poetry\s+(install|build|run)\b/,
  /^cmake\b/,
];

export function validateCommand(command: string): CommandValidationResult {
  const trimmed = command.trim();
  const warnings: string[] = [];

  if (trimmed.length === 0) {
    return { safe: false, warnings: ['empty command'] };
  }

  for (const pattern of SAFE_COMMAND_PATTERNS) {
    if (pattern.test(trimmed)) {
      return { safe: true, warnings: [] };
    }
  }

  for (const [pattern, description] of DANGEROUS_PATTERNS) {
    if (pattern.test(trimmed)) {
      warnings.push(description);
    }
  }

  return {
    safe: warnings.length === 0,
    warnings,
  };
}

export function validateCommands(
  commands: string[],
): { command: string; result: CommandValidationResult }[] {
  return commands.map((command) => ({
    command,
    result: validateCommand(command),
  }));
}

const BUILTIN_SYMLINKS = ['.opencode'];

/**
 * Fail-closed guard for the inherited `.opencode` symlink (lane-policy):
 * the worker inherits the main worktree's `.opencode` (agents/skills) AND
 * any opencode.json permission config reachable from it. A permissive
 * `permission: { "*"/edit/bash: "allow" }` there would let the server allow
 * reserved actions WITHOUT asking the monitor — the monitor would never see
 * a `permission.asked` event, so text analysis downstream cannot contain it.
 * Scan the small candidate files as TEXT (JSONC-tolerant) before launch and
 * refuse with an actionable message instead of executing at will.
 * `lsp: allow` alone is benign (read-only) and does NOT trigger.
 */
export function isPermissiveOpencodePermissionText(text: string): boolean {
  if (!text || !text.includes('permission')) return false;
  if (!text.includes('allow')) return false;
  // Blanket `"permission": "allow"` (whole surface allowed).
  if (/"permission"\s*:\s*"allow"/.test(text)) return true;
  // Scoped allows that bypass the monitor for reserved scope.
  // `lsp` is intentionally absent here (read-only, benign).
  return /"(edit|bash|shell|write|\*|webfetch|fetch|network|all)"\s*:\s*"allow"/.test(text);
}

export function permissiveOpencodeConfigFiles(mainPath: string): string[] {
  const candidates = [
    join(mainPath, '.opencode', 'opencode.json'),
    join(mainPath, '.opencode', 'opencode.jsonc'),
    join(mainPath, 'opencode.json'),
    join(mainPath, 'opencode.jsonc'),
  ];
  const hits: string[] = [];
  for (const file of candidates) {
    try {
      if (!existsSync(file)) continue;
      const text = readFileSync(file, 'utf-8');
      if (isPermissiveOpencodePermissionText(text)) hits.push(file);
    } catch {
      // Unreadable candidate fails closed at launch (below) only when it
      // looks permissive; read errors here are ignored (no evidence).
    }
  }
  return hits;
}

/** Throw fail-closed listing the permissive files (launch pre-flight). */
export function assertNoPermissiveOpencodeConfig(mainPath: string): void {
  const hits = permissiveOpencodeConfigFiles(mainPath);
  if (hits.length > 0) {
    throw new Error(
      `[MC] Refusing launch: permissive opencode permission config inherited via worktree (${hits.join(', ')}) would allow reserved actions without asking the monitor. ` +
        `Remove the \`"permission": { "*"/edit/bash: "allow" }\` allow (lsp:allow is fine) or launch with a clean config — never executes at will.`,
    );
  }
}

function normalizePath(p: string): string {
  return p.replace(/\/+$/, '').replace(/^\.\//, '');
}

function isUnsafePath(p: string): boolean {
  const normalized = normalizePath(p);
  return normalized.startsWith('/') || normalized.startsWith('..') || normalized.includes('/../');
}

function dedup(items: string[]): string[] {
  return [...new Set(items.map(normalizePath))];
}

export function resolvePostCreateHook(
  configDefaults?: WorktreeSetup,
  overrides?: WorktreeSetup,
): PostCreateHook {
  const allCopyFiles = [
    ...(configDefaults?.copyFiles ?? []),
    ...(overrides?.copyFiles ?? []),
  ].filter((f) => !isUnsafePath(f));

  const allSymlinkDirs = [
    ...BUILTIN_SYMLINKS,
    ...(configDefaults?.symlinkDirs ?? []),
    ...(overrides?.symlinkDirs ?? []),
  ].filter((d) => !isUnsafePath(d));

  const allCommands = [
    ...(configDefaults?.commands ?? []),
    ...(overrides?.commands ?? []),
  ];

  const hook: PostCreateHook = {};

  const dedupedCopy = dedup(allCopyFiles);
  if (dedupedCopy.length > 0) {
    hook.copyFiles = dedupedCopy;
  }

  const dedupedSymlinks = dedup(allSymlinkDirs);
  if (dedupedSymlinks.length > 0) {
    hook.symlinkDirs = dedupedSymlinks;
  }

  const dedupedCommands = [...new Set(allCommands)];
  if (dedupedCommands.length > 0) {
    hook.commands = dedupedCommands;
  }

  return hook;
}

/* ------------------------------------------------------------------ */
/* Serve worker plugin (mc_report/mc_status no serve).                 */
/* O serve (`opencode serve --port`, cwd=worktree) só expõe tools do   */
/* plugin carregado no projeto. Sem plugin no worktree, o prompt exige */
/* mc_report mas a tool não existe (global só tem dcp/ponytail/OMO).   */
/* Mecanismo já usado pelo codebase: plugin por projeto em            */
/* `.opencode/plugins/<dir>/index.js` (validado: 0 failed loads, sem   */
/* tocar perfil global) — `.opencode/` é gitignored, nunca commitado.  */
/* ------------------------------------------------------------------ */

/** Per-project plugin dir/file que o serve carrega sem tocar global. */
export const MC_SERVE_PLUGIN_DIR = '.opencode/plugins/mc-mission-control';
export const MC_SERVE_PLUGIN_FILE = 'index.js';

export interface EnsureServePluginResult {
  ok: boolean;
  pluginPath?: string;
  /** Bundle copiado (dist) ou null quando ausente (fail-open com warn). */
  source?: string | null;
  reason?: string;
}

/**
 * Localiza o bundle do plugin (dist/index.js) sem reinventar resolução:
 * - self quando já roda do bundle (dist/index.js);
 * - ../../dist/index.js a partir de src/lib (dev/bun test);
 * - ./dist/index.js a partir do cwd (repo root);
 * - walk-up até package.json `opencode-mission-control` + dist/index.js.
 * Retorna null quando não há bundle (fail-open: warn, gap explícito).
 */
export function resolveHostPluginBundle(): string | null {
  const candidates: string[] = [];
  try {
    const self = fileURLToPath(import.meta.url);
    // Self é o bundle quando termina em dist/index.js.
    if (self.endsWith('dist/index.js') && existsSync(self)) return self;
    candidates.push(join(dirname(self), '..', '..', 'dist', 'index.js'));
  } catch {}
  try {
    candidates.push(join(process.cwd(), 'dist', 'index.js'));
  } catch {}
  // Walk-up: encontra a raiz do pacote e checa dist/index.js lá.
  try {
    let dir = dirname(fileURLToPath(import.meta.url));
    for (let i = 0; i < 6; i++) {
      const pkg = join(dir, 'package.json');
      try {
        if (existsSync(pkg)) {
          const raw = readFileSync(pkg, 'utf-8');
          if (raw.includes('"opencode-mission-control"')) {
            const dist = join(dir, 'dist', 'index.js');
            candidates.push(dist);
            break;
          }
        }
      } catch {}
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {}
  for (const c of candidates) {
    try {
      if (c && existsSync(c)) return c;
    } catch {}
  }
  return null;
}

/**
 * Garante `.opencode/plugins/mc-mission-control/index.js` no worktree.
 * Idempotente; fail-open (nunca throw por plugin ausente — o monitor
 * registra o gap como missing distinto de invalid, sem bloquear merges).
 * Se `.opencode` for symlink (herdado do main), converte em dir real com
 * cópia do conteúdo + plugin (não polui o main; `.opencode/` é ignored).
 */
export async function ensureServePluginConfig(
  worktreePath: string,
): Promise<EnsureServePluginResult> {
  const { lstatSync, mkdirSync, readlinkSync, unlinkSync, cpSync, copyFileSync } = await import('node:fs');
  const pluginDir = join(worktreePath, MC_SERVE_PLUGIN_DIR);
  const pluginPath = join(pluginDir, MC_SERVE_PLUGIN_FILE);
  try {
    const dotOpencode = join(worktreePath, '.opencode');
    try {
      const st = lstatSync(dotOpencode);
      if (st.isSymbolicLink()) {
        let target: string | null = null;
        try {
          target = readlinkSync(dotOpencode);
        } catch {
          target = null;
        }
        // Resolve relativo ao worktree quando necessário.
        const absTarget = target
          ? (target.startsWith('/') ? target : join(worktreePath, target))
          : null;
        unlinkSync(dotOpencode);
        mkdirSync(dotOpencode, { recursive: true });
        if (absTarget && existsSync(absTarget)) {
          try {
            cpSync(absTarget, dotOpencode, { recursive: true, force: false });
          } catch {
            // Best-effort: plugin abaixo ainda é garantido.
          }
        }
      }
    } catch {
      // Sem .opencode: segue para mkdir.
    }
    mkdirSync(pluginDir, { recursive: true });
    // Idempotente: bundle já materializado com tamanho > 0.
    try {
      const st = (await import('node:fs')).statSync(pluginPath);
      if (st.isFile() && st.size > 0) {
        return { ok: true, pluginPath, source: 'cached' };
      }
    } catch {}
    const bundle = resolveHostPluginBundle();
    if (!bundle) {
      console.warn(
        '[MC] serve plugin bundle (dist/index.js) não encontrado — worker segue sem mc_report/mc_status; ' +
          'gap renderiza como missing (distinto de invalid), sem bloquear merges.',
      );
      return { ok: false, reason: 'bundle-not-found' };
    }
    copyFileSync(bundle, pluginPath);
    return { ok: true, pluginPath, source: bundle };
  } catch (error) {
    console.warn(
      `[MC] ensureServePluginConfig falhou (fail-open, gap explícito): ${error instanceof Error ? error.message : String(error)}`,
    );
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}
