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
    if (stripPushQuotes(tokens[i]).toLowerCase() !== 'git') continue;
    let j = i + 1;
    while (j < tokens.length) {
      const low = stripPushQuotes(tokens[j]).toLowerCase();
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
    if (j < tokens.length && stripPushQuotes(tokens[j]).toLowerCase() === 'push') {
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
 */
export function referencesOutsideWorktree(commandText: string, worktreePath: string): boolean {
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
  if (isGitPushText(haystack)) return true;
  const lower = haystack.toLowerCase();
  return PUBLISH_PATTERNS.some((pattern) => pattern.test(lower));
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
        const rawPath = permissionRequest.path ?? jobContext.worktreePath;
        // Shell permission resources carry COMMAND TEXT (v2 `resources`,
        // e.g. "cat probe-secret.txt" — observed live on 2.2.5), not a
        // path. The server runs shell in the session cwd (the worktree),
        // so bare commands are worktree-scoped — but the whole command
        // string always joins inside the worktree lexically, so explicit
        // escapes (absolute outside paths, `..`, `~`, remote targets) must
        // veto FIRST. Publishing already forced ask-user above.
        const inWorktree = !referencesOutsideWorktree(rawPath, jobContext.worktreePath)
          && isInsideWorktree(rawPath, jobContext.worktreePath);
        policyDecision = inWorktree
          ? this.policy.permissions.shellCommand.insideWorktree
          : this.policy.permissions.shellCommand.outsideWorktree;
        reason = inWorktree
          ? 'Shell command target is inside worktree'
          : 'Shell command target is outside worktree';
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
