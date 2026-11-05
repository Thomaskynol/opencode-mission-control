import { homedir } from 'os';
import { dirname, join } from 'path';
import { existsSync } from 'fs';

export interface OMOStatus {
  detected: boolean;
  configSource: 'local' | 'global' | null;
  sisyphusPath: string | null;
  /**
   * Carregado segue sempre 'unknown': o runtime não expõe GET /config nem
   * inventário de plugins por sessão — config detectada não prova carregado.
   */
  loaded: 'unknown';
  /**
   * Utilizado segue sempre false: detecção nunca é uso (sem
   * messages[].agent por worker, load por sessão segue desconhecido).
   */
  used: false;
}

/**
 * Limitação canônica do runtime: disponibilidade vem de config (detectOMO),
 * mas carregado por sessão segue desconhecido — o runtime não expõe
 * GET /config nem messages[].agent por worker. Informe, não invente.
 */
export const OMO_RUNTIME_LIMITATION =
  'OMO load por sessão segue desconhecido: runtime sem GET /config nem messages[].agent por worker — detecção (config) nunca prova carregado nem utilizado.';

/**
 * Linha canônica disponível/carregado/utilizado a partir de um OMOStatus.
 * Detecção (config) ≠ carregado (sem evidência runtime) ≠ utilizado (não).
 */
export function describeOmoAvailability(status: OMOStatus): string {
  const available = status.detected
    ? `detectado em config ${status.configSource ?? 'unknown'}`
    : 'não detectado';
  return `OMO (disponível: ${available}; carregado: sem evidência runtime; utilizado: não — detection is not use).`;
}

/**
 * Detect if Oh-My-OpenCode (OMO) is installed by checking opencode.json
 * Checks both local (./opencode.json) and global (~/.config/opencode/opencode.json)
 * for an oh-my-opencode plugin entry (oh-my-opencode, -slim, @version pins)
 */
export async function detectOMO(
  localPath: string = './opencode.json',
  globalPath: string = join(homedir(), '.config', 'opencode', 'opencode.json'),
): Promise<OMOStatus> {
  const basePath = dirname(localPath);

  // Check local config first
  const localStatus = await checkConfigFile(localPath);
  if (localStatus.detected) {
    return {
      detected: true,
      configSource: 'local',
      sisyphusPath: await getSisyphusPath(basePath),
      loaded: 'unknown',
      used: false,
    };
  }

  // Check global config
  const globalStatus = await checkConfigFile(globalPath);
  if (globalStatus.detected) {
    return {
      detected: true,
      configSource: 'global',
      sisyphusPath: await getSisyphusPath(basePath),
      loaded: 'unknown',
      used: false,
    };
  }

  return {
    detected: false,
    configSource: null,
    sisyphusPath: null,
    loaded: 'unknown',
    used: false,
  };
}

/**
 * Strip JSONC affordances (// line comments, block comments, trailing
 * commas) with string awareness, so values like "http://..." survive.
 * Malformed input still fails at JSON.parse -> fail-closed upstream.
 */
function stripJsonc(text: string): string {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  let out = '';
  let i = 0;
  const n = src.length;
  let inStr = false;
  while (i < n) {
    const c = src[i];
    if (inStr) {
      out += c;
      if (c === '\\' && i + 1 < n) {
        out += src[i + 1];
        i += 2;
        continue;
      }
      if (c === '"') inStr = false;
      i++;
      continue;
    }
    if (c === '"') {
      inStr = true;
      out += c;
      i++;
      continue;
    }
    if (c === '/' && i + 1 < n) {
      const d = src[i + 1];
      if (d === '/') {
        i += 2;
        while (i < n && src[i] !== '\n') i++;
        continue;
      }
      if (d === '*') {
        i += 2;
        while (i < n && !(src[i] === '*' && i + 1 < n && src[i + 1] === '/')) i++;
        i += 2;
        continue;
      }
    }
    if (c === ',') {
      // trailing comma: skip when only whitespace precedes } or ]
      let j = i + 1;
      while (j < n && /\s/.test(src[j]!)) j++;
      if (j < n && (src[j] === '}' || src[j] === ']')) {
        i++;
        continue;
      }
    }
    out += c;
    i++;
  }
  return out;
}

/**
 * Match OMO plugin entries: "oh-my-opencode" (+ "-slim" etc. variants) and
 * its successor "oh-my-openagent", ignoring a "@version" pin suffix.
 */
function isOmoEntry(entry: unknown): boolean {
  if (typeof entry !== 'string') return false;
  const base = entry.split('@')[0] ?? '';
  return (
    base === 'oh-my-opencode' ||
    base.startsWith('oh-my-opencode-') ||
    base === 'oh-my-openagent' ||
    base.startsWith('oh-my-openagent-')
  );
}

/**
 * Check if a config file contains an OMO plugin entry. Accepts both
 * "plugin" and "plugins" keys (real ~/.config uses "plugins").
 */
function hasOmoPlugin(config: unknown): boolean {
  if (!config || typeof config !== 'object') return false;
  const rec = config as Record<string, unknown>;
  for (const key of ['plugin', 'plugins']) {
    const list = rec[key];
    const arr = Array.isArray(list) ? list : typeof list === 'string' ? [list] : null;
    if (!arr) continue;
    if (arr.some(isOmoEntry)) return true;
  }
  return false;
}

async function checkConfigFile(filePath: string): Promise<{ detected: boolean }> {
  try {
    const file = Bun.file(filePath);
    const exists = await file.exists();

    if (!exists) {
      return { detected: false };
    }

    const content = await file.text();
    // Tolerate JSONC (comments/trailing commas); malformed stays fail-closed.
    const config: unknown = JSON.parse(stripJsonc(content));

    return { detected: hasOmoPlugin(config) };
  } catch {
    // File doesn't exist or is invalid JSON
    return { detected: false };
  }
}

/**
 * Get the .sisyphus path if it exists in the current directory
 */
async function getSisyphusPath(basePath: string = '.'): Promise<string | null> {
  try {
    const sisyphusPath = join(basePath, '.sisyphus');
    const exists = existsSync(sisyphusPath);
    return exists ? sisyphusPath : null;
  } catch {
    return null;
  }
}
