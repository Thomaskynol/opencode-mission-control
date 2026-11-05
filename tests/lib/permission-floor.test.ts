import { describe, expect, it } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  PermissionPolicy,
  policyFloorViolations,
  assertPolicyFloorCompliant,
} from '../../src/lib/permission-policy';
import { shouldAutoApprove } from '../../src/lib/question-relay';
import {
  isPermissiveOpencodePermissionText,
  assertNoPermissiveOpencodeConfig,
} from '../../src/lib/worktree-setup';

const WT = '/tmp/wt-floor';

function permissiveGlobal() {
  return {
    permissions: {
      fileEdit: { insideWorktree: 'auto-approve', outsideWorktree: 'auto-approve' },
      shellCommand: { insideWorktree: 'auto-approve', outsideWorktree: 'auto-approve' },
      networkAccess: 'auto-approve',
      installPackages: 'auto-approve',
      mcpTools: 'auto-approve',
    },
  } as never;
}

describe('policy floor (lane-policy)', () => {
  it('flags permissive global (outside auto-approve) as violations', () => {
    const violations = policyFloorViolations(permissiveGlobal());
    expect(violations.length).toBeGreaterThan(0);
    expect(() => assertPolicyFloorCompliant(permissiveGlobal(), 'global')).toThrow(/Refusing launch/);
  });

  it('accepts the safe default policy', () => {
    expect(policyFloorViolations(PermissionPolicy.getDefaultPolicy())).toHaveLength(0);
    expect(() => assertPolicyFloorCompliant(PermissionPolicy.getDefaultPolicy(), 'global')).not.toThrow();
  });

  it('permissive effective policy cannot silently approve outside file (monitor falls back to default)', () => {
    // Even under a permissive config, the floor refuses launch — and a
    // permissive evaluate would auto-approve: prove the hole exists at the
    // policy layer so the launch/monitor guards are load-bearing.
    const p = PermissionPolicy.resolvePolicy({ globalPolicy: permissiveGlobal() });
    expect(
      p.evaluate(
        { type: 'file_operation', path: '/etc/passwd', description: 'edit outside' },
        { worktreePath: WT },
      ),
    ).toBe('auto-approve');
    // The floor is what blocks it before execution.
    expect(policyFloorViolations(permissiveGlobal()).join(' ')).toMatch(/outsideWorktree/);
  });

  it('shell without command text is ask-user (policy + relay agree)', () => {
    const policy = PermissionPolicy.resolvePolicy({});
    expect(
      policy.evaluate(
        { type: 'shell_command', description: 'run something' } as never,
        { worktreePath: WT },
      ),
    ).toBe('ask-user');
    const relay = shouldAutoApprove(
      { id: 'x', type: 'shell_command', description: 'run something' },
      WT,
    );
    expect(relay.autoApproved).toBe(false);
  });

  it('shell with outside command in description is ask-user even when path looks inside', () => {
    const policy = PermissionPolicy.resolvePolicy({});
    expect(
      policy.evaluate(
        { type: 'shell_command', path: 'echo hi', description: 'cat /etc/passwd' },
        { worktreePath: WT },
      ),
    ).toBe('ask-user');
    const relay = shouldAutoApprove(
      { id: 'x', type: 'shell_command', path: 'echo hi', description: 'cat /etc/passwd' },
      WT,
    );
    expect(relay.autoApproved).toBe(false);
  });

  it('legitimate in-worktree shell still auto-approves (policy + relay agree)', () => {
    const policy = PermissionPolicy.resolvePolicy({});
    expect(
      policy.evaluate(
        { type: 'shell_command', path: 'npm test', description: 'npm test' },
        { worktreePath: WT },
      ),
    ).toBe('auto-approve');
    const relay = shouldAutoApprove(
      { id: 'x', type: 'shell_command', path: 'npm test', description: 'npm test' },
      WT,
      'auto-approve',
    );
    expect(relay.autoApproved).toBe(true);
  });
});

describe('.opencode permissive guard (lane-policy)', () => {
  it('detects blanket/scoped allow, ignores lsp:allow', () => {
    expect(isPermissiveOpencodePermissionText('{"permission":{"*":"allow"}}')).toBe(true);
    expect(isPermissiveOpencodePermissionText('{"permission":{"edit":"allow"}}')).toBe(true);
    expect(isPermissiveOpencodePermissionText('{"permission":{"bash":"allow"}}')).toBe(true);
    expect(isPermissiveOpencodePermissionText('{"permission":{"lsp":"allow"}}')).toBe(false);
    expect(isPermissiveOpencodePermissionText('{"other":1}')).toBe(false);
  });

  it('blocks launch when main worktree carries a permissive config', () => {
    const root = mkdtempSync(join(tmpdir(), 'mc-polval-'));
    try {
      writeFileSync(join(root, 'opencode.json'), '{"permission":{"*":"allow"}}');
      expect(() => assertNoPermissiveOpencodeConfig(root)).toThrow(/permissive opencode permission/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('passes a clean worktree (no permission allow)', () => {
    const root = mkdtempSync(join(tmpdir(), 'mc-polval-'));
    try {
      mkdirSync(join(root, '.opencode'), { recursive: true });
      writeFileSync(join(root, '.opencode', 'opencode.json'), '{"permission":{"lsp":"allow"}}');
      expect(() => assertNoPermissiveOpencodeConfig(root)).not.toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
