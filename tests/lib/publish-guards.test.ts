import { describe, it, expect } from 'bun:test';
import { PermissionPolicy } from '../../src/lib/permission-policy';
import { requireHumanAuth } from '../../src/lib/integration';

const WORKTREE = '/tmp/project';

describe('publish guards (requireHumanAuth)', () => {
  describe('permission-policy', () => {
    const policy = () => PermissionPolicy.resolvePolicy({});

    it('should not auto-approve git push inside the worktree', () => {
      const decision = policy().evaluate(
        { type: 'shell_command', path: WORKTREE, description: 'git push origin feature-x' },
        { worktreePath: WORKTREE },
      );
      expect(decision).toBe('ask-user');
    });

    it('should not auto-approve gh pr create inside the worktree', () => {
      const decision = policy().evaluate(
        { type: 'shell_command', path: WORKTREE, action: 'gh pr create --title feat' },
        { worktreePath: WORKTREE },
      );
      expect(decision).toBe('ask-user');
    });

    it('should not auto-approve deploys', () => {
      const decision = policy().evaluate(
        { type: 'shell_command', path: WORKTREE, description: 'deploy to production' },
        { worktreePath: WORKTREE },
      );
      expect(decision).toBe('ask-user');
    });

    it('should allow push/PR/deploy with explicit humanAuth in the request', () => {
      for (const description of ['git push origin feature-x', 'gh pr create --title feat', 'deploy to production']) {
        const decision = policy().evaluate(
          { type: 'shell_command', path: WORKTREE, description, humanAuth: true },
          { worktreePath: WORKTREE },
        );
        expect(decision).toBe('auto-approve');
      }
    });

    it('should not flag file edits whose names merely contain sensitive words', () => {
      const decision = policy().evaluate(
        { type: 'file_operation', path: '/tmp/project/deploy.sh', description: 'edit deploy script' },
        { worktreePath: WORKTREE },
      );
      expect(decision).toBe('auto-approve');
    });

    it('should keep auto-approving ordinary in-worktree shell commands', () => {
      const decision = policy().evaluate(
        { type: 'shell_command', path: WORKTREE, description: 'bun test' },
        { worktreePath: WORKTREE },
      );
      expect(decision).toBe('auto-approve');
    });
  });

  describe('integration guard', () => {
    it('should throw for push/PR/deploy without explicit human authorization', () => {
      expect(() => requireHumanAuth('git push')).toThrow(/explicit human authorization/);
      expect(() => requireHumanAuth('gh pr create', {})).toThrow(/explicit human authorization/);
      expect(() => requireHumanAuth('deploy', { humanAuth: false })).toThrow(/explicit human authorization/);
    });

    it('should pass with explicit human authorization', () => {
      expect(() => requireHumanAuth('git push', { humanAuth: true })).not.toThrow();
    });
  });
});
