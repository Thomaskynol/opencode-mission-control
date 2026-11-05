import { describe, expect, it } from 'bun:test';
import {
  PermissionPolicy,
  buildWorktreePermissions,
  isGitPushText,
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
});
