import { resolve, dirname, relative, join, isAbsolute } from 'path';
import { realpathSync, lstatSync } from 'fs';
import type { V2PermissionRule } from './sdk-client.js';

export type PermissionPolicyDecision = 'auto-approve' | 'deny' | 'ask-user';

export type PolicyScopedRule = {
  insideWorktree: PermissionPolicyDecision;
  outsideWorktree: PermissionPolicyDecision;
};

export type PermissionPolicyConfig = {
  permissions: {
    fileEdit: PolicyScopedRule;
    shellCommand: PolicyScopedRule;
    networkAccess: PermissionPolicyDecision;
    installPackages: PermissionPolicyDecision;
    mcpTools: PermissionPolicyDecision;
  };
};

export type PermissionPolicyRequest = {
  type: 'file_operation' | 'shell_command' | 'network' | 'mcp' | 'other';
  path?: string;
  description?: string;
  action?: string;
  target?: string;
  /**
   * Explicit human authorization carried in the request (e.g. the user
   * approved this exact push/PR/deploy). Publishing actions are never
   * auto-approved without it — see requiresHumanAuth().
   */
  humanAuth?: boolean;
};

export type PermissionJobContext = {
  worktreePath: string;
};

export type PermissionPolicyLogEntry = {
  timestamp: string;
  permissionType: keyof PermissionPolicyConfig['permissions'] | 'unknown';
  action: string;
  target: string;
  policyDecision: PermissionPolicyDecision;
  reason: string;
};

export type PermissionPolicySources = {
  jobPolicy?: PermissionPolicyConfig;
  planPolicy?: PermissionPolicyConfig;
  globalPolicy?: PermissionPolicyConfig;
};

/**
 * Non-bypassable floor for normal mode: the product installs/verifies the
 * necessary policy BEFORE execution. A global/job/plan policy that silently
 * approves reserved actions (outside-worktree writes, outside shell,
 * network, installs) would let the worker act without a decisor — fail
 * closed here with an actionable message instead of executing at will.
 * Legitimate in-worktree approvals + operator questions (ask-user) pass;
 * only silent `auto-approve` of reserved scope is refused.
 */
export function policyFloorViolations(policy: PermissionPolicyConfig | undefined): string[] {
  if (!policy) return [];
  const violations: string[] = [];
  const perms = policy.permissions;
  if (perms.fileEdit.outsideWorktree !== 'deny') {
    violations.push(
      `fileEdit.outsideWorktree must be 'deny' (got '${perms.fileEdit.outsideWorktree}') — writes outside the worktree are reserved and never silently approved`,
    );
  }
  if (perms.shellCommand.outsideWorktree === 'auto-approve') {
    violations.push(
      `shellCommand.outsideWorktree must not be 'auto-approve' — outside shell stays ask-user/deny so the operator decides`,
    );
  }
  if ((perms.networkAccess as string) === 'auto-approve') {
    violations.push(
      `networkAccess must not be 'auto-approve' — network stays deny/ask-user (fail-closed)`,
    );
  }
  if ((perms.installPackages as string) === 'auto-approve') {
    violations.push(
      `installPackages must not be 'auto-approve' — installs stay ask-user/deny so the operator decides`,
    );
  }
  return violations;
}

/** Throw fail-closed when the effective policy would silently approve reserved scope. */
export function assertPolicyFloorCompliant(
  policy: PermissionPolicyConfig | undefined,
  source = 'global',
): void {
  const violations = policyFloorViolations(policy);
  if (violations.length > 0) {
    throw new Error(
      `[MC] Refusing launch: permission policy (${source}) is permissive and would allow reserved actions without a decisor — ${violations.join('; ')}. ` +
        `Set fileEdit.outsideWorktree='deny', shellCommand.outsideWorktree='ask-user'/'deny', networkAccess='deny'/'ask-user', installPackages='ask-user'/'deny' (see PermissionPolicy.getDefaultPolicy()).`,
    );
  }
}

function normalizePathForComparison(path: string): string {
  return resolve(path.replace(/\\/g, '/')).replace(/\\/g, '/');
}

function lexicallyInsideWorktree(normalizedPath: string, normalizedWorktree: string): boolean {
  if (normalizedPath === normalizedWorktree) {
    return true;
  }

  const suffix = normalizedWorktree.endsWith('/') ? '' : '/';
  return normalizedPath.startsWith(`${normalizedWorktree}${suffix}`);
}

/**
 * Resolve the longest existing prefix (a symlink itself counts as existing
 * via lstat) through realpath, then re-append the not-yet-existing remainder
 * lexically. Returns null when nothing resolves — broken symlinks,
 * unreadable components and dead roots are unresolvable (fail-closed).
 */
function resolveThroughExistingPrefix(absolutePath: string): string | null {
  let cur = absolutePath;
  while (true) {
    try {
      lstatSync(cur);
      break;
    } catch {
      const parent = dirname(cur);
      if (parent === cur) return null;
      cur = parent;
    }
  }
  let real: string;
  try {
    real = realpathSync(cur);
  } catch {
    return null;
  }
  const rest = relative(cur, absolutePath);
  return rest ? join(real, rest) : real;
}

/**
 * Real worktree containment shared by the policy and the relay.
 * Relative inputs anchor at the WORKTREE (never at the caller cwd): the
 * v2 server reports edit resources relative to the session cwd, which IS
 * the worktree (e.g. "probe-out2.txt" — observed live on 2.2.5), and
 * resolving them against a monitor/relay cwd misclassifies every
 * in-worktree request as outside. Lexical normalization (`..`, `.`,
 * separators, separator boundary) gates first, then the longest existing
 * prefix is resolved through realpath so a symlink escaping the worktree
 * is detected. Brand-new paths inside an existing worktree resolve through
 * their nearest existing ancestor and stay inside (pre-authorized
 * allowlist keeps working without asking); unresolvable paths (broken
 * symlinks, dead roots) return false.
 */
export function isPathContainedIn(path: string, worktreePath: string): boolean {
  if (typeof path !== 'string' || typeof worktreePath !== 'string') return false;
  if (!path || !worktreePath) return false;
  let normalizedPath: string;
  let normalizedWorktree: string;
  try {
    normalizedWorktree = normalizePathForComparison(worktreePath);
    // Session-relative input (v2 edit resources, shell command text):
    // anchor at the worktree the session runs in.
    normalizedPath = normalizePathForComparison(
      isAbsolute(path) ? path : join(normalizedWorktree, path),
    );
  } catch {
    return false;
  }
  if (!lexicallyInsideWorktree(normalizedPath, normalizedWorktree)) return false;
  const realPath = resolveThroughExistingPrefix(normalizedPath);
  const realWorktree = resolveThroughExistingPrefix(normalizedWorktree);
  if (!realPath || !realWorktree) return false;
  return lexicallyInsideWorktree(
    realPath.replace(/\\/g, '/'),
    realWorktree.replace(/\\/g, '/'),
  );
}

function isInsideWorktree(path: string, worktreePath: string): boolean {
  return isPathContainedIn(path, worktreePath);
}

function looksLikePackageInstall(input?: string): boolean {
  if (!input) {
    return false;
  }

  const normalized = input.toLowerCase();
  const installSignals = ['npm install', 'pnpm add', 'yarn add', 'bun add', 'pip install', 'apt install'];
  return installSignals.some((signal) => normalized.includes(signal));
}

/**
 * Publishing actions that must never run without explicit human
 * authorization: git push, PR creation/merge, deploys, package publishes.
 * Only command-like requests are inspected — file_operation paths are
 * excluded so editing a file named e.g. `deploy.sh` stays auto-approved.
 *
 * Real barrier for worker shell commands: `requiresHumanAuth` forces
 * `ask-user` even inside the worktree unless `humanAuth: true` rides in
 * the request. Operator push paths (`mc_pr`, `orchestrator.createPR`)
 * enforce the same via `requireHumanAuth` (`integration.ts`).
 * `assertNoPush` (`coordinator.ts`) is only an aid for contexts where a
 * push must never happen (prompts, internal merges).
 */
const PUBLISH_PATTERNS = [
  /\bgh\s+pr\s+(create|merge)\b/,
  /\bnpm\s+publish\b/,
  /\bdeploy\b/,
];

/**
 * De-obfuscate one shell word for *detection* (never for execution):
 * quote insertion (`g''it`, `"git"`, `gi't'`) and backslash escapes
 * (`g\it`) still execute as the bare word, so detection must see through
 * them. `$`-family expansions (`$X`, `${X}`, `$()`) are NOT normalized —
 * any command containing `$`/backtick is unauditable and fails closed to
 * ask-user via the simplicity gate instead.
 */
export function deobfuscateShellToken(token: string): string {
  return token.replace(/['"\\]/g, '');
}

function stripPushQuotes(s: string): string {
  if (s.length >= 2) {
    const first = s[0];
    const last = s[s.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return s.slice(1, -1);
    }
  }
  return s;
}

/** Shell-aware split: keeps `"a b"` / `'a b'` (and `k="a b"`) as one word. */
function splitShellWords(input: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (quote) {
      cur += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (cur) {
        out.push(cur);
        cur = '';
      }
      continue;
    }
    cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

/**
 * Effective git-push detector: `git` + any run of global flags
 * (`-C <dir>`, `-c k=v`, `--git-dir/--work-tree[=...]`, `--no-pager`, ...)
 * then `push`. Covers `git -C "my dir" push`, `git -c k=v push`,
 * `git --git-dir=<p> push` and `git -C` paths with spaces/quotes.
 * Raw-space argv paths (`git -C my dir push` via shell-free `gitCommand`)
 * never reach this free-text check — they execute without a shell and are
 * safe by construction, not a guard hole.
 */
export function isGitPushText(haystack: string): boolean {
  const tokens = splitShellWords(haystack);
  for (let i = 0; i < tokens.length; i++) {
    if (deobfuscateShellToken(tokens[i]).toLowerCase() !== 'git') continue;
    let j = i + 1;
    while (j < tokens.length) {
      const low = deobfuscateShellToken(tokens[j]).toLowerCase();
      if (
        low === '-c' ||
        low === '--git-dir' ||
        low === '--work-tree' ||
        low === '--namespace' ||
        low === '--super-prefix' ||
        low === '--config-env'
      ) {
        j += 2;
        continue;
      }
      if (
        low.startsWith('--git-dir=') ||
        low.startsWith('--work-tree=') ||
        low.startsWith('--namespace=') ||
        low.startsWith('--super-prefix=') ||
        low.startsWith('--config-env=')
      ) {
        j += 1;
        continue;
      }
      if (low.startsWith('-')) {
        j += 1;
        continue;
      }
      break;
    }
    if (j < tokens.length && deobfuscateShellToken(tokens[j]).toLowerCase() === 'push') {
      return true;
    }
  }
  return false;
}

/**
 * Explicit worktree escapes inside shell command text. The v2 server runs
 * shell in the session cwd (the worktree) and reports the COMMAND TEXT as
 * the permission resource, so a bare command is worktree-scoped — but a
 * command that names an outside location (`cat /etc/passwd`, `cd /tmp`,
 * `../x`, `~/x`, `curl https://…`) is not. Anything flagged here keeps
 * outside handling (ask, never silent allow); everything else is session
 * scoped. Conservative: unknown shapes fail toward ask, never approve.
 *
 * Architectural note: free shell text is undecidable in general (variable
 * expansion, command substitution, chaining, redirection can hide any
 * target), so this function fails closed on every such shape: `$`/backtick
 * (expansion/substitution — e.g. `cat "$HOME/.ssh/id_rsa"`), `;|&><`
 * (chaining/redirection — the visible prefix says nothing about the rest)
 * and `\` (escape obfuscation — e.g. `c\at /etc/passwd`) all count as
 * outside. The simplicity gate in `evaluate` additionally refuses to
 * auto-approve any non-trivial command text (globs, parens, unknown
 * binaries); this function stays focused on outside/undecidable references
 * so direct callers also fail closed.
 */
export function referencesOutsideWorktree(commandText: string, worktreePath: string): boolean {
  // Undecidable shapes: expansion/substitution, chaining/redirection,
  // escape obfuscation, multi-line scripts. Never provably inside.
  if (/[$`\\;|&><\r\n]/.test(commandText)) return true;
  for (const rawToken of splitShellWords(commandText)) {
    const candidates = [stripPushQuotes(rawToken)];
    // `KEY=/abs/path` assignments (e.g. GIT_DIR=/x): inspect the value too.
    const eq = rawToken.indexOf('=');
    if (eq >= 0) candidates.push(stripPushQuotes(rawToken.slice(eq + 1)));
    for (let token of candidates) {
      if (!token || token === '.') continue;
      token = token.replace(/^[()"']+|[()"']+$/g, '');
      if (!token) continue;
      if (token === '~' || token.startsWith('~/')) return true;
      if (token === '..' || token.startsWith('../') || token.includes('/../') || token.endsWith('/..')) {
        return true;
      }
      // Remote targets are never worktree-local (fetch/exfil shapes).
      if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(token)) return true;
      if (/^[^/\s]+@[^/\s]+:/.test(token)) return true; // scp-like user@host:path
      if (token.startsWith('/') && !isInsideWorktree(token, worktreePath)) return true;
    }
  }
  return false;
}

export function requiresHumanAuth(permissionRequest: PermissionPolicyRequest): boolean {
  if (permissionRequest.type === 'file_operation') {
    return false;
  }
  const haystack = [permissionRequest.action, permissionRequest.description, permissionRequest.target]
    .filter((part): part is string => typeof part === 'string')
    .join('\n');
  // De-obfuscation happens per-token inside `isGitPushText` (quote
  // insertion like `g''it` / `g\it` still executes as `git`), because
  // stripping quotes BEFORE splitting would break quoted paths
  // (`git -C "my dir" push` needs `"my dir"` to stay one token for the
  // flag-skip). `$`-family tricks (`$Xgit push`) need no normalization —
  // the `$` gate already forces those to ask-user. The regex patterns
  // below run on de-obfuscated text so `g''h pr create` still matches.
  if (isGitPushText(haystack)) return true;
  const lower = deobfuscateShellToken(haystack).toLowerCase();
  return PUBLISH_PATTERNS.some((pattern) => pattern.test(lower));
}

/**
 * Architectural containment for free shell text: arbitrary shell is
 * undecidable (expansion, substitution, interpreter flags like `node -e`
 * can reach anywhere regardless of visible text), so NO allowlist-shaped
 * regex decides safety. Instead, shell text auto-approves ONLY when it is
 * provably simple AND its binary is known-safe AND it names no secret AND
 * every path operand stays inside the worktree (symlink-aware). Anything
 * else fails closed to ask-user — never approve, never a growing denylist.
 *
 * - Simple: one line, no `$` `` ` `` `\` `;|&><` `(){}[]*?!~^` control/glob
 *   characters. (shortcut: globs like `*.ts` and `node -e "f(1)"` ask even
 *   when inside; approve once by the operator, or spell out paths.)
 * - Known-safe binary: bare first word (after `KEY=value` prefixes) in the
 *   list below. Unknown binaries — shells, ssh/curl/sudo, package
 *   managers-as-publishers, project tools not listed here — ask. Adding a
 *   binary here WIDENS auto-approve; never add shells, network, privilege
 *   or publish-capable tools.
 * - No secret: private keys, `.ssh/`, `.gnupg/`, `.aws/`, `.env` files.
 * - Inside operands: every non-flag path operand (and every `=` value)
 *   must resolve inside the worktree, so `cat esc-link/secret.txt` (a
 *   symlink escaping the worktree) asks instead of approving.
 */
const SHELL_AUTO_APPROVE_BINARIES: ReadonlySet<string> = new Set([
  // Runtimes / build / test (bare `node --test`, `bun test`, `npm test`…).
  'node', 'bun', 'deno', 'npm', 'pnpm', 'yarn', 'npx', 'tsx', 'tsc',
  'jest', 'vitest', 'pytest', 'python', 'python3', 'make',
  // Read-only VCS inspection (`git push` never reaches here: publishing
  // forces ask-user first, even obfuscated).
  'git',
  // Read-only inspection.
  'ls', 'cat', 'head', 'tail', 'wc', 'diff', 'file', 'stat', 'pwd',
  'echo', 'printf', 'true', 'false', 'test',
  // In-worktree search (operands still gated to inside, no secrets).
  'grep', 'rg', 'find', 'fd',
  // In-worktree file mutation (consistent with fileEdit inside-worktree
  // auto-approve; outside/secret operands still refuse).
  'mkdir', 'touch', 'cp', 'mv', 'rm',
  // Project CLIs observed in this repo (`rtk` is the installed helper).
  'rtk',
]);

/** Single-line, no shell metacharacters: `argv0 arg …` shapes only. */
export function isSimpleAuditableShellText(text: string): boolean {
  if (!text || /[\r\n\0]/.test(text)) return false;
  // `$` expansion, backtick substitution, `\` escapes, chaining
  // (`;|&`), redirection (`><`), subshells/groups (`(){}`), globs
  // (`*?[]`), negation/history (`!`), home (`~`), anchors (`^`).
  // Allowed: quotes (de-obfuscated for detection), `=`, `#`, `,`, `.`,
  // `:`, `/`, `-`, `+`, `%`, `@`, `_`, alphanumerics, whitespace.
  return !/[$`\\;|&><(){}[\]*?!~^]/.test(text);
}

const SECRET_BASENAMES: ReadonlySet<string> = new Set([
  'id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519', 'id_ecdsa_sk', 'id_ed25519_sk',
]);
const SECRET_EXTENSIONS = ['.pem', '.key', '.p12', '.pfx'];

/**
 * Secret reads never auto-approve (even inside the worktree, even when the
 * path is relative): private keys, `.ssh/`, `.gnupg/`, `.aws/`, `.env`
 * files. Precise basenames/segments only — a name merely containing
 * "secret" (e.g. `probe-secret.txt`) is NOT a secret.
 */
export function referencesSecretMaterial(commandText: string): boolean {
  for (const rawToken of splitShellWords(commandText)) {
    const candidates = [rawToken];
    const eq = rawToken.indexOf('=');
    if (eq >= 0) candidates.push(rawToken.slice(eq + 1));
    for (let token of candidates) {
      token = deobfuscateShellToken(token).toLowerCase();
      token = token.replace(/^[()"']+|[()"']+$/g, '');
      if (!token) continue;
      const segments = token.split('/');
      const base = segments[segments.length - 1];
      if (SECRET_BASENAMES.has(base)) return true;
      if (SECRET_EXTENSIONS.some((ext) => base.endsWith(ext))) return true;
      if (segments.some((seg) => seg === '.ssh' || seg === '.gnupg' || seg === '.aws')) return true;
      if (base === '.env' || (/^\.env\./.test(base) && base !== '.env.example' && base !== '.env.sample' && base !== '.env.template')) {
        return true;
      }
      if (base === 'credentials.json' || base === '.netrc' || base === '_netrc') return true;
    }
  }
  return false;
}

function firstCommandWord(tokens: string[]): string | null {
  for (const raw of tokens) {
    const token = deobfuscateShellToken(raw);
    // `KEY=value` env prefixes are not the binary (`FOO=1 npm test`).
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) continue;
    if (!token) continue;
    return token;
  }
  return null;
}

/**
 * Null = provably simple/safe/inside: may auto-approve. String = human-
 * readable refusal reason: must ask-user. Single-token inputs that are
 * already known-inside paths (plain worktree directories, the R1 `path: wt`
 * shape) skip the binary check — there is no binary to check.
 */
function shellAutoApproveRefusal(commandText: string, worktreePath: string): string | null {
  const trimmed = commandText.trim();
  if (!trimmed) return 'empty shell command text';
  const tokens = splitShellWords(trimmed);
  const hasWhitespace = tokens.length > 1;
  if (!hasWhitespace) {
    // Single token + already verified inside (caller checked): path context,
    // not command text. Secrets still never auto-approve.
    if (referencesSecretMaterial(trimmed)) {
      return 'shell target references secret material (keys/.env) and requires human review';
    }
    return null;
  }
  if (!isSimpleAuditableShellText(trimmed)) {
    return 'shell command is not simple/auditable (expansion, chaining, redirection, glob or quoting trick) and requires human review';
  }
  const argv0 = firstCommandWord(tokens);
  if (!argv0 || argv0.includes('/')) {
    return 'shell command has no auditable binary name and requires human review';
  }
  if (!SHELL_AUTO_APPROVE_BINARIES.has(argv0.toLowerCase())) {
    return `shell binary "${argv0}" is not in the auto-approve allowlist and requires human review`;
  }
  if (referencesSecretMaterial(trimmed)) {
    return 'shell command references secret material (keys/.env) and requires human review';
  }
  for (const raw of tokens.slice(1)) {
    const token = deobfuscateShellToken(raw);
    if (!token || token === '-' || token === '.' || token === '..') continue;
    if (token.startsWith('-') && !token.includes('=')) continue; // flags
    const candidates = [token];
    const eq = token.indexOf('=');
    // `KEY=value` env prefixes: the KEY is not a path, the value may be.
    if (eq >= 0 && /^[A-Za-z_][A-Za-z0-9_]*=$/.test(token.slice(0, eq + 1))) {
      candidates.length = 0;
      candidates.push(token.slice(eq + 1));
    } else if (eq >= 0 && token.startsWith('-')) {
      candidates.length = 0;
      candidates.push(token.slice(eq + 1));
    }
    for (let candidate of candidates) {
      candidate = candidate.replace(/^[()"']+|[()"']+$/g, '');
      if (!candidate || candidate === '.' || candidate === '-') continue;
      // Bare words that cannot name a path (branch names, subcommand
      // verbs, `origin`, `main`, counts) trivially resolve inside via
      // their nearest existing ancestor — the containment check below
      // passes them; symlink escapes and outside paths fail it.
      if (!isPathContainedIn(candidate, worktreePath)) {
        return `shell operand "${candidate}" escapes the worktree and requires human review`;
      }
    }
  }
  return null;
}

/**
 * Session ruleset for one worker: allow read/write/shell inside its own
 * worktree so internal paths never ask; anything outside stays under the
 * default policy (ask-user/deny via the monitor). Pass to
 * `session.create` as `permissions`.
 *
 * Action names are the v2 canonical tool names: the server emits
 * `action: "shell"` for shell calls (observed live on 2.2.5) — `bash` is
 * only an alias for settings-file keys and never matches a session
 * permission request. (The server matches `resource` against command text
 * for shell and against session-relative paths for edits, so these
 * path-scoped rules cover path-resource requests; command-text and
 * relative-resource requests are scoped worktree-side by the policy
 * evaluation below instead of stalling headless workers.)
 */
const WORKTREE_RULE_ACTIONS = ['read', 'edit', 'write', 'shell'] as const;

export function buildWorktreePermissions(worktreePath: string): V2PermissionRule[] {
  const base = worktreePath.endsWith('/') ? worktreePath.slice(0, -1) : worktreePath;
  return WORKTREE_RULE_ACTIONS.map((action) => ({
    action,
    resource: `${base}/**`,
    effect: 'allow' as const,
  }));
}

export class PermissionPolicy {
  private readonly policy: PermissionPolicyConfig;
  private readonly decisionLog: PermissionPolicyLogEntry[] = [];

  constructor(policy: PermissionPolicyConfig = PermissionPolicy.getDefaultPolicy()) {
    this.policy = policy;
  }

  static loadPolicy(config?: PermissionPolicyConfig | null): PermissionPolicy {
    if (!config) {
      return new PermissionPolicy(PermissionPolicy.getDefaultPolicy());
    }
    return new PermissionPolicy(config);
  }

  static resolvePolicy(sources: PermissionPolicySources = {}): PermissionPolicy {
    return PermissionPolicy.loadPolicy(
      sources.jobPolicy
      ?? sources.planPolicy
      ?? sources.globalPolicy
      ?? PermissionPolicy.getDefaultPolicy(),
    );
  }

  static getDefaultPolicy(): PermissionPolicyConfig {
    return {
      permissions: {
        fileEdit: { insideWorktree: 'auto-approve', outsideWorktree: 'deny' },
        shellCommand: { insideWorktree: 'auto-approve', outsideWorktree: 'ask-user' },
        networkAccess: 'deny',
        installPackages: 'ask-user',
        mcpTools: 'auto-approve',
      },
    };
  }

  evaluate(
    permissionRequest: PermissionPolicyRequest,
    jobContext: PermissionJobContext,
  ): PermissionPolicyDecision {
    // Publishing actions require explicit human authorization carried in
    // the request. Without it, force human review even inside the worktree.
    if (requiresHumanAuth(permissionRequest) && permissionRequest.humanAuth !== true) {
      const action = permissionRequest.action ?? permissionRequest.description ?? permissionRequest.type;
      const target = permissionRequest.target ?? permissionRequest.path ?? '(unknown target)';
      this.decisionLog.push({
        timestamp: new Date().toISOString(),
        permissionType: this.resolvePermissionType(permissionRequest),
        action,
        target,
        policyDecision: 'ask-user',
        reason: 'Publishing action (push/PR/deploy) requires explicit human authorization',
      });
      return 'ask-user';
    }

    const permissionType = this.resolvePermissionType(permissionRequest);

    let policyDecision: PermissionPolicyDecision;
    let reason: string;

    switch (permissionType) {
      case 'fileEdit': {
        const targetPath = permissionRequest.path;
        if (!targetPath) {
          policyDecision = 'ask-user';
          reason = 'File edit request is missing path context';
          break;
        }

        const inWorktree = isInsideWorktree(targetPath, jobContext.worktreePath);
        policyDecision = inWorktree
          ? this.policy.permissions.fileEdit.insideWorktree
          : this.policy.permissions.fileEdit.outsideWorktree;
        reason = inWorktree
          ? 'File edit target is inside worktree'
          : 'File edit target is outside worktree';
        break;
      }

      case 'shellCommand': {
        // Fail-closed: a shell permission without command text is
        // unauditable — never silently approve (decisor duplo fix: the
        // relay had the same hole for `!path`). The v2 server always sends
        // command text in `resources` for real shell asks; absence means an
        // unknown shape, not an inside approval.
        if (!permissionRequest.path) {
          policyDecision = 'ask-user';
          reason = 'Shell command is missing command text and requires human review';
          break;
        }
        const rawPath = permissionRequest.path;
        // Shell permission resources carry COMMAND TEXT (v2 `resources`,
        // e.g. "cat probe-secret.txt" — observed live on 2.2.5), not a
        // path. The server runs shell in the session cwd (the worktree),
        // so bare commands are worktree-scoped — but the whole command
        // string always joins inside the worktree lexically, so explicit
        // escapes (absolute outside paths, `..`, `~`, remote targets,
        // expansion/substitution, chaining, redirection) veto FIRST.
        // Publishing already forced ask-user above. Command text may ride
        // in description/action/target too — any outside reference in the
        // full haystack keeps outside handling (ask, never silent allow).
        const haystack = [
          permissionRequest.path,
          permissionRequest.description,
          permissionRequest.action,
          permissionRequest.target,
        ];
        const escapes = haystack.some(
          (field) => typeof field === 'string' && field.length > 0 && referencesOutsideWorktree(field, jobContext.worktreePath),
        );
        const inWorktree = !escapes
          && !referencesOutsideWorktree(rawPath, jobContext.worktreePath)
          && isInsideWorktree(rawPath, jobContext.worktreePath);
        if (!inWorktree) {
          policyDecision = this.policy.permissions.shellCommand.outsideWorktree;
          reason = 'Shell command target is outside worktree';
          break;
        }
        // Inside-looking text auto-approves ONLY when provably simple,
        // allowlisted, secret-free and operand-contained (see
        // `shellAutoApproveRefusal`). Everything else — obfuscated push
        // spellings, `$HOME` expansions, globs, unknown binaries, secret
        // reads, symlink-escaping operands — fails closed to ask-user.
        const refusal = shellAutoApproveRefusal(rawPath, jobContext.worktreePath);
        if (refusal) {
          policyDecision = 'ask-user';
          reason = refusal;
          break;
        }
        policyDecision = this.policy.permissions.shellCommand.insideWorktree;
        reason = 'Shell command target is inside worktree';
        break;
      }

      case 'installPackages':
        policyDecision = this.policy.permissions.installPackages;
        reason = 'Package installation request';
        break;

      case 'networkAccess':
        policyDecision = this.policy.permissions.networkAccess;
        reason = 'Network access request';
        break;

      case 'mcpTools':
        policyDecision = this.policy.permissions.mcpTools;
        reason = 'MCP tool request';
        break;

      default:
        policyDecision = 'ask-user';
        reason = 'Unknown permission type';
        break;
    }

    const action = permissionRequest.action ?? permissionRequest.description ?? permissionRequest.type;
    const target = permissionRequest.target ?? permissionRequest.path ?? '(unknown target)';

    this.decisionLog.push({
      timestamp: new Date().toISOString(),
      permissionType,
      action,
      target,
      policyDecision,
      reason,
    });

    return policyDecision;
  }

  getDecisionLog(): readonly PermissionPolicyLogEntry[] {
    return this.decisionLog;
  }

  private resolvePermissionType(
    permissionRequest: PermissionPolicyRequest,
  ): keyof PermissionPolicyConfig['permissions'] | 'unknown' {
    if (permissionRequest.type === 'mcp') {
      return 'mcpTools';
    }

    if (permissionRequest.type === 'network') {
      return 'networkAccess';
    }

    if (permissionRequest.type === 'file_operation') {
      return 'fileEdit';
    }

    if (permissionRequest.type === 'shell_command') {
      const packageInstall =
        looksLikePackageInstall(permissionRequest.description) ||
        looksLikePackageInstall(permissionRequest.action);
      return packageInstall ? 'installPackages' : 'shellCommand';
    }

    return 'unknown';
  }
}
