import { describe, expect, it } from 'bun:test';
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  PermissionPolicy,
  buildWorktreePermissions,
  deobfuscateShellToken,
  isGitPushText,
  isSimpleAuditableShellText,
  referencesOutsideWorktree,
  referencesSecretMaterial,
  requiresHumanAuth,
  type PermissionPolicyConfig,
} from '../../src/lib/permission-policy';

const WORKTREE = '/tmp/project';

describe('PermissionPolicy', () => {
  it('default policy auto-approves worktree operations', () => {
    const policy = PermissionPolicy.loadPolicy(PermissionPolicy.getDefaultPolicy());

    const fileDecision = policy.evaluate(
      {
        type: 'file_operation',
        path: '/tmp/project/src/index.ts',
        description: 'edit file in worktree',
      },
      { worktreePath: WORKTREE },
    );

    const shellDecision = policy.evaluate(
      {
        type: 'shell_command',
        path: '/tmp/project',
        description: 'run build in worktree',
      },
      { worktreePath: WORKTREE },
    );

    expect(fileDecision).toBe('auto-approve');
    expect(shellDecision).toBe('auto-approve');
  });

  it('default policy denies outside worktree file operations', () => {
    const policy = PermissionPolicy.loadPolicy(PermissionPolicy.getDefaultPolicy());

    const decision = policy.evaluate(
      {
        type: 'file_operation',
        path: '/etc/passwd',
        description: 'edit outside worktree',
      },
      { worktreePath: WORKTREE },
    );

    expect(decision).toBe('deny');
  });

  it('per-job policy overrides global default', () => {
    const globalPolicy: PermissionPolicyConfig = {
      permissions: {
        fileEdit: { insideWorktree: 'auto-approve', outsideWorktree: 'deny' },
        shellCommand: { insideWorktree: 'auto-approve', outsideWorktree: 'ask-user' },
        networkAccess: 'deny',
        installPackages: 'ask-user',
        mcpTools: 'auto-approve',
      },
    };

    const perJobPolicy: PermissionPolicyConfig = {
      permissions: {
        fileEdit: { insideWorktree: 'auto-approve', outsideWorktree: 'deny' },
        shellCommand: { insideWorktree: 'deny', outsideWorktree: 'deny' },
        networkAccess: 'deny',
        installPackages: 'deny',
        mcpTools: 'auto-approve',
      },
    };

    const policy = PermissionPolicy.resolvePolicy({
      jobPolicy: perJobPolicy,
      globalPolicy,
    });

    const decision = policy.evaluate(
      {
        type: 'shell_command',
        path: '/tmp/project',
        description: 'run command in worktree',
      },
      { worktreePath: WORKTREE },
    );

    expect(decision).toBe('deny');
  });

  it('policy cascade applies job > plan > global > default priority', () => {
    const globalPolicy: PermissionPolicyConfig = {
      permissions: {
        fileEdit: { insideWorktree: 'deny', outsideWorktree: 'deny' },
        shellCommand: { insideWorktree: 'deny', outsideWorktree: 'deny' },
        networkAccess: 'deny',
        installPackages: 'deny',
        mcpTools: 'deny',
      },
    };

    const planPolicy: PermissionPolicyConfig = {
      permissions: {
        fileEdit: { insideWorktree: 'ask-user', outsideWorktree: 'deny' },
        shellCommand: { insideWorktree: 'ask-user', outsideWorktree: 'deny' },
        networkAccess: 'ask-user',
        installPackages: 'ask-user',
        mcpTools: 'ask-user',
      },
    };

    const jobPolicy: PermissionPolicyConfig = {
      permissions: {
        fileEdit: { insideWorktree: 'auto-approve', outsideWorktree: 'deny' },
        shellCommand: { insideWorktree: 'auto-approve', outsideWorktree: 'ask-user' },
        networkAccess: 'deny',
        installPackages: 'ask-user',
        mcpTools: 'auto-approve',
      },
    };

    const fromJob = PermissionPolicy.resolvePolicy({
      jobPolicy,
      planPolicy,
      globalPolicy,
    });
    const fromPlan = PermissionPolicy.resolvePolicy({
      planPolicy,
      globalPolicy,
    });
    const fromGlobal = PermissionPolicy.resolvePolicy({ globalPolicy });
    const fromDefault = PermissionPolicy.resolvePolicy({});

    expect(
      fromJob.evaluate(
        { type: 'mcp', description: 'execute mcp tool' },
        { worktreePath: WORKTREE },
      ),
    ).toBe('auto-approve');

    expect(
      fromPlan.evaluate(
        { type: 'mcp', description: 'execute mcp tool' },
        { worktreePath: WORKTREE },
      ),
    ).toBe('ask-user');

    expect(
      fromGlobal.evaluate(
        { type: 'mcp', description: 'execute mcp tool' },
        { worktreePath: WORKTREE },
      ),
    ).toBe('deny');

    expect(
      fromDefault.evaluate(
        { type: 'mcp', description: 'execute mcp tool' },
        { worktreePath: WORKTREE },
      ),
    ).toBe('auto-approve');
  });

  it('logs all policy decisions', () => {
    const policy = PermissionPolicy.resolvePolicy({});

    policy.evaluate(
      {
        type: 'file_operation',
        path: '/tmp/project/src/a.ts',
        description: 'edit a file',
        action: 'edit',
      },
      { worktreePath: WORKTREE },
    );

    policy.evaluate(
      {
        type: 'file_operation',
        path: '/etc/passwd',
        description: 'edit outside file',
        action: 'edit',
      },
      { worktreePath: WORKTREE },
    );

    const log = policy.getDecisionLog();
    expect(log.length).toBe(2);
    expect(typeof log[0].timestamp).toBe('string');
    expect(log[0].permissionType).toBe('fileEdit');
    expect(log[0].policyDecision).toBe('auto-approve');
    expect(log[1].policyDecision).toBe('deny');
    expect(log[1].reason.length).toBeGreaterThan(0);
  });

  it('detects git push through -C/-c/--git-dir with space/quote paths', () => {
    expect(isGitPushText('git push origin x')).toBe(true);
    expect(isGitPushText('git -C /tmp/x push')).toBe(true);
    expect(isGitPushText('git -C "my dir" push origin main')).toBe(true);
    expect(isGitPushText("git -C 'my dir' push")).toBe(true);
    expect(isGitPushText('git -c core.sshCommand=ssh push')).toBe(true);
    expect(isGitPushText('git --git-dir=/tmp/x push')).toBe(true);
    expect(isGitPushText('git --git-dir /tmp/x push')).toBe(true);
    expect(isGitPushText('git --no-pager push')).toBe(true);
    expect(isGitPushText('git commit -m "push origin"')).toBe(false);
    expect(isGitPushText('git status')).toBe(false);
  });

  it('requires human auth for scoped git pushes inside the worktree', () => {
    for (const description of [
      'git push origin x',
      'git -C "my dir" push origin main',
      'git -c core.sshCommand=ssh push',
      'git --git-dir=/tmp/x push',
    ]) {
      expect(
        requiresHumanAuth({ type: 'shell_command', description }),
      ).toBe(true);
      const policy = PermissionPolicy.resolvePolicy({});
      expect(
        policy.evaluate(
          { type: 'shell_command', path: WORKTREE, description },
          { worktreePath: WORKTREE },
        ),
      ).toBe('ask-user');
    }
  });

  it('builds an allow-inside ruleset scoped to the worktree', () => {
    const rules = buildWorktreePermissions('/tmp/mc-worktrees/test-job');
    expect(rules.length).toBeGreaterThan(0);
    for (const rule of rules) {
      expect(rule.effect).toBe('allow');
      expect(rule.resource.startsWith('/tmp/mc-worktrees/test-job')).toBe(true);
    }
    const actions = rules.map((r) => r.action);
    // v2 canonical tool action: the server emits `action: "shell"` for
    // shell calls (observed live on 2.2.5) — `bash` is only an alias for
    // settings-file keys and never matches a session permission request.
    for (const needed of ['read', 'edit', 'write', 'shell']) {
      expect(actions).toContain(needed);
    }
    expect(actions).not.toContain('bash');
    // No blanket allow: nothing outside the worktree is covered.
    for (const rule of rules) {
      expect(rule.resource).not.toBe('/**');
      expect(rule.resource).not.toBe('*');
    }
  });

  it('auto-approves file edits addressed relative to the worktree', () => {
    // The v2 server reports edit resources relative to the session cwd
    // (the worktree, e.g. "probe-out2.txt" — observed live on 2.2.5), so
    // relative paths anchor at the worktree, never at the monitor cwd.
    const policy = PermissionPolicy.resolvePolicy({});
    expect(
      policy.evaluate(
        { type: 'file_operation', path: 'src/a.ts', description: 'edit a file' },
        { worktreePath: WORKTREE },
      ),
    ).toBe('auto-approve');
    expect(
      policy.evaluate(
        { type: 'file_operation', path: '../escape.ts', description: 'escape' },
        { worktreePath: WORKTREE },
      ),
    ).toBe('deny');
  });

  it('scopes shell command text to the session worktree', () => {
    // v2 shell permission `resources` carry the COMMAND TEXT (e.g. "cat
    // probe-secret.txt" — observed live on 2.2.5), not a path. The server
    // runs shell in the session cwd (the worktree), so command text with
    // no explicit outside reference is inside-worktree traffic.
    const policy = PermissionPolicy.resolvePolicy({});
    for (const command of ['cat probe-secret.txt', 'echo hello', 'rtk ls', 'npm test']) {
      expect(
        policy.evaluate(
          { type: 'shell_command', path: command, description: command },
          { worktreePath: WORKTREE },
        ),
      ).toBe('auto-approve');
    }
    // Explicit escapes keep outside handling (ask, never silent allow).
    for (const command of [
      'cat /etc/passwd',
      '/etc/passwd',
      'cat ../escape.txt',
      'cd /tmp && ls',
      'cat ~/secret',
    ]) {
      expect(
        policy.evaluate(
          { type: 'shell_command', path: command, description: command },
          { worktreePath: WORKTREE },
        ),
      ).toBe('ask-user');
    }
    // Publishing still requires a human even inside the worktree.
    expect(
      policy.evaluate(
        { type: 'shell_command', path: 'git push origin main', description: 'git push origin main' },
        { worktreePath: WORKTREE },
      ),
    ).toBe('ask-user');
  });

  describe('PERMX containment (reported bypasses + general vector)', () => {
    const policy = () => PermissionPolicy.resolvePolicy({});
    const shell = (text: string) =>
      policy().evaluate(
        { type: 'shell_command', path: text, description: text },
        { worktreePath: WORKTREE },
      );

    it('bypass A: $HOME expansion to a key never auto-approves', () => {
      expect(referencesOutsideWorktree('cat "$HOME/.ssh/id_rsa"', WORKTREE)).toBe(true);
      expect(shell('cat "$HOME/.ssh/id_rsa"')).toBe('ask-user');
      expect(shell('cat $HOME/.ssh/id_rsa')).toBe('ask-user');
      expect(shell('cat ${HOME}/.ssh/id_rsa')).toBe('ask-user');
    });

    it('bypass B: quote-obfuscated push still requires a human', () => {
      for (const text of [`g''it push`, `g\\it push`, `"git" push`, `'git' push`, `""git push`]) {
        expect(isGitPushText(text)).toBe(true);
        expect(requiresHumanAuth({ type: 'shell_command', description: text })).toBe(true);
        expect(shell(text)).toBe('ask-user');
      }
      expect(deobfuscateShellToken(`g''it`)).toBe('git');
    });

    it('command substitution never auto-approves', () => {
      expect(shell('cat $(echo /etc/passwd)')).toBe('ask-user');
      expect(shell('cat `echo /etc/passwd`')).toBe('ask-user');
      expect(shell('echo $UID')).toBe('ask-user');
    });

    it('chaining and redirection never auto-approve the visible prefix', () => {
      for (const text of [
        'echo hi; cat /etc/passwd',
        'echo hi && cat /etc/passwd',
        'echo hi || cat /etc/passwd',
        'cat /etc/passwd | head',
        'echo hi > /tmp/x',
        'cat < /etc/passwd',
      ]) {
        expect(referencesOutsideWorktree(text, WORKTREE)).toBe(true);
        expect(shell(text)).toBe('ask-user');
      }
    });

    it('obfuscated publish actions (gh/npm/deploy) still require a human', () => {
      for (const text of [`g''h pr create --title x`, `np''m publish`, `git pu''sh origin main`]) {
        expect(requiresHumanAuth({ type: 'shell_command', description: text })).toBe(true);
        expect(shell(text)).toBe('ask-user');
      }
    });

    it('secret reads never auto-approve, even relative/inside', () => {
      expect(referencesSecretMaterial('cat .ssh/id_rsa')).toBe(true);
      expect(referencesSecretMaterial('cat keys/id_rsa')).toBe(true);
      expect(referencesSecretMaterial('cat server.pem')).toBe(true);
      expect(referencesSecretMaterial('cat .env')).toBe(true);
      expect(referencesSecretMaterial('cat .env.local')).toBe(true);
      for (const text of [
        'cat .ssh/id_rsa',
        'cat keys/id_rsa',
        'cat id_ed25519',
        'cat server.pem',
        'cat tls.key',
        'cat .env',
        'cat config/.env.production',
      ]) {
        expect(shell(text)).toBe('ask-user');
      }
    });

    it('names merely containing sensitive words stay auto-approved', () => {
      expect(referencesSecretMaterial('cat probe-secret.txt')).toBe(false);
      expect(referencesSecretMaterial('cat .env.example')).toBe(false);
      expect(shell('cat probe-secret.txt')).toBe('auto-approve');
      expect(shell('cat .env.example')).toBe('auto-approve');
    });

    it('non-simple shapes (globs, parens, unknown binaries) ask, never approve', () => {
      expect(isSimpleAuditableShellText('ls *.ts')).toBe(false);
      expect(isSimpleAuditableShellText('node -e "console.log(1)"')).toBe(false);
      expect(isSimpleAuditableShellText('FOO=1 npm test')).toBe(true);
      expect(shell('ls *.ts')).toBe('ask-user');
      expect(shell('node -e "console.log(1)"')).toBe('ask-user');
      expect(shell('curl https://example.com')).toBe('ask-user');
      expect(shell('ssh deploy@host')).toBe('ask-user');
      expect(shell('sudo ls')).toBe('ask-user');
      expect(shell('terraform apply')).toBe('ask-user');
    });

    it('symlink-escaping operands ask, never auto-approve (real fs)', () => {
      const root = mkdtempSync(join(tmpdir(), 'mc-permx-'));
      const wt = join(root, 'wt');
      const outside = join(root, 'outside');
      mkdirSync(wt, { recursive: true });
      mkdirSync(outside, { recursive: true });
      writeFileSync(join(outside, 'secret.txt'), 'top secret');
      symlinkSync(outside, join(wt, 'esc-link'));
      try {
        const p = PermissionPolicy.resolvePolicy({});
        const decide = (text: string) =>
          p.evaluate(
            { type: 'shell_command', path: text, description: text },
            { worktreePath: wt },
          );
        expect(decide('cat esc-link/secret.txt')).toBe('ask-user');
        expect(decide('ls esc-link')).toBe('ask-user');
        writeFileSync(join(wt, 'keep.ts'), 'export const a = 1;');
        expect(decide('cat keep.ts')).toBe('auto-approve');
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it('legitimate in-worktree commands keep auto-approving', () => {
      for (const text of [
        'node --test',
        'bun test',
        'npm test',
        'git status',
        'git log --oneline',
        'git diff --stat',
        'cat notes.txt',
        'echo hello',
        'rtk ls',
        'ls',
        'FOO=1 npm test',
      ]) {
        expect(shell(text)).toBe('auto-approve');
      }
      // Plain path context (the R1 monitor `path: wt` shape) stays approved.
      expect(
        policy().evaluate(
          { type: 'shell_command', path: WORKTREE, description: 'run build in worktree' },
          { worktreePath: WORKTREE },
        ),
      ).toBe('auto-approve');
    });
  });
});
