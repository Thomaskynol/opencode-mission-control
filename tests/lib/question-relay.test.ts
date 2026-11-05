import { mock, describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  buildTaskSummary,
  isPathInsideWorktree,
  shouldAutoApprove,
  buildQuestionPrompt,
  QuestionRelay,
  getPendingQuestionsForJob,
  removePendingQuestion,
  clearPendingQuestionsForJob,
  type PermissionRequest,
} from '../../src/lib/question-relay';
import type { Job } from '../../src/lib/job-state';
import * as paths from '../../src/lib/paths';

describe('buildTaskSummary', () => {
  it('should return the full prompt if under 120 chars', () => {
    const prompt = 'Fix the login bug';
    expect(buildTaskSummary(prompt)).toBe(prompt);
  });

  it('should truncate and add ellipsis if over 120 chars', () => {
    const prompt = 'A'.repeat(150);
    const result = buildTaskSummary(prompt);
    expect(result.length).toBe(120);
    expect(result.endsWith('...')).toBe(true);
  });

  it('should handle exactly 120 chars without truncation', () => {
    const prompt = 'A'.repeat(120);
    expect(buildTaskSummary(prompt)).toBe(prompt);
  });
});

describe('isPathInsideWorktree', () => {
  it('should return true for paths inside worktree', () => {
    expect(isPathInsideWorktree('/home/user/project/src/file.ts', '/home/user/project')).toBe(true);
  });

  it('should return false for paths outside worktree', () => {
    expect(isPathInsideWorktree('/etc/passwd', '/home/user/project')).toBe(false);
  });

  it('should handle paths with trailing slashes', () => {
    expect(isPathInsideWorktree('/home/user/project/src/file.ts', '/home/user/project/')).toBe(true);
  });

  it('should handle Windows-style paths', () => {
    expect(isPathInsideWorktree('C:\\Users\\project\\src\\file.ts', 'C:\\Users\\project')).toBe(true);
  });

  it('should return false for sibling directories', () => {
    expect(isPathInsideWorktree('/home/user/other/file.ts', '/home/user/project')).toBe(false);
  });
});

describe('shouldAutoApprove', () => {
  const worktreePath = '/home/user/project';

  it('should auto-approve MCP tool execution', () => {
    const permission: PermissionRequest = {
      id: 'perm-1',
      type: 'mcp',
      description: 'Execute MCP tool',
    };

    const result = shouldAutoApprove(permission, worktreePath);

    expect(result.approved).toBe(true);
    expect(result.autoApproved).toBe(true);
  });

  it('should auto-approve file operations inside worktree', () => {
    const permission: PermissionRequest = {
      id: 'perm-1',
      type: 'file_operation',
      path: '/home/user/project/src/file.ts',
      description: 'Edit file',
    };

    const result = shouldAutoApprove(permission, worktreePath);

    expect(result.approved).toBe(true);
    expect(result.autoApproved).toBe(true);
  });

  it('should NOT auto-approve file operations outside worktree', () => {
    const permission: PermissionRequest = {
      id: 'perm-1',
      type: 'file_operation',
      path: '/etc/passwd',
      description: 'Edit system file',
    };

    const result = shouldAutoApprove(permission, worktreePath);

    expect(result.approved).toBe(false);
    expect(result.autoApproved).toBe(false);
  });

  it('should auto-approve shell commands inside worktree', () => {
    const permission: PermissionRequest = {
      id: 'perm-1',
      type: 'shell_command',
      path: '/home/user/project',
      description: 'Run npm install',
    };

    const result = shouldAutoApprove(permission, worktreePath);

    expect(result.approved).toBe(true);
    expect(result.autoApproved).toBe(true);
  });

  it('should NOT auto-approve shell commands without command text (fail-closed)', () => {
    const permission: PermissionRequest = {
      id: 'perm-1',
      type: 'shell_command',
      description: 'Run ls',
    };

    const result = shouldAutoApprove(permission, worktreePath);

    expect(result.approved).toBe(false);
    expect(result.autoApproved).toBe(false);
  });

  it('should NOT auto-approve shell commands outside worktree', () => {
    const permission: PermissionRequest = {
      id: 'perm-1',
      type: 'shell_command',
      path: '/etc',
      description: 'Run system command',
    };

    const result = shouldAutoApprove(permission, worktreePath);

    expect(result.approved).toBe(false);
    expect(result.autoApproved).toBe(false);
  });

  it('should NOT auto-approve network operations', () => {
    const permission: PermissionRequest = {
      id: 'perm-1',
      type: 'network',
      description: 'Make HTTP request',
    };

    const result = shouldAutoApprove(permission, worktreePath);

    expect(result.approved).toBe(false);
    expect(result.autoApproved).toBe(false);
  });

  it('should NOT auto-approve unknown permission types', () => {
    const permission: PermissionRequest = {
      id: 'perm-1',
      type: 'other',
      description: 'Unknown operation',
    };

    const result = shouldAutoApprove(permission, worktreePath);

    expect(result.approved).toBe(false);
    expect(result.autoApproved).toBe(false);
  });
});

describe('buildQuestionPrompt', () => {
  it('should include job name and task summary', () => {
    const context = {
      jobName: 'fix-auth',
      taskSummary: 'Fix the authentication bug',
    };

    const prompt = buildQuestionPrompt(context);

    expect(prompt).toContain('fix-auth');
    expect(prompt).toContain('Fix the authentication bug');
  });

  it('should include current file when provided', () => {
    const context = {
      jobName: 'fix-auth',
      taskSummary: 'Fix the authentication bug',
      currentFile: 'src/auth.ts',
    };

    const prompt = buildQuestionPrompt(context);

    expect(prompt).toContain('src/auth.ts');
  });

  it('should include permission request details', () => {
    const context = {
      jobName: 'fix-auth',
      taskSummary: 'Fix the authentication bug',
      permissionRequest: {
        id: 'perm-1',
        type: 'file_operation' as const,
        path: '/etc/config',
        description: 'Edit system config',
      },
    };

    const prompt = buildQuestionPrompt(context);

    expect(prompt).toContain('file_operation');
    expect(prompt).toContain('/etc/config');
    expect(prompt).toContain('Edit system config');
  });

  it('should include timeout-deny notice (silence never approves)', () => {
    const context = {
      jobName: 'fix-auth',
      taskSummary: 'Fix the authentication bug',
    };

    const prompt = buildQuestionPrompt(context);

    expect(prompt).toContain('yes');
    expect(prompt).toContain('no');
    expect(prompt).toContain('DENIED on timeout');
  });
});

describe('QuestionRelay', () => {
  let relay: QuestionRelay;
  let outerStateDir = '';

  beforeEach(async () => {
    relay = new QuestionRelay();
    const fs = await import('fs');
    outerStateDir = await fs.promises.mkdtemp(join(tmpdir(), 'mc-relay-outer-'));
    spyOn(paths, 'getDataDir').mockResolvedValue(join(outerStateDir, 'state'));
    fs.mkdirSync(join(outerStateDir, 'state'), { recursive: true });
  });

  afterEach(async () => {
    relay.dispose();
    for (const id of ['job-1', 'job-vis', 'job-pub-timeout', 'job-plain-timeout']) {
      clearPendingQuestionsForJob(id);
    }
    (paths.getDataDir as unknown as { mockRestore?: () => void }).mockRestore?.();
    const fs = await import('fs');
    if (outerStateDir && fs.existsSync(outerStateDir)) {
      fs.rmSync(outerStateDir, { recursive: true, force: true });
    }
  });

  const mockJob: Job = {
    id: 'job-1',
    name: 'Test Job',
    worktreePath: '/home/user/project',
    branch: 'main',
    tmuxTarget: 'mc-test',
    placement: 'session',
    status: 'running',
    prompt: 'Fix the authentication bug',
    mode: 'vanilla',
    createdAt: new Date().toISOString(),
    port: 8080,
    launchSessionID: 'session-123',
  };

  describe('handlePermissionRequest', () => {
    it('should auto-approve MCP permissions without relaying', async () => {
      const permission: PermissionRequest = {
        id: 'perm-1',
        type: 'mcp',
        description: 'Execute MCP tool',
      };

      const result = await relay.handlePermissionRequest(mockJob, permission);

      expect(result.autoApproved).toBe(true);
    });

    it('should auto-approve file operations inside worktree', async () => {
      const permission: PermissionRequest = {
        id: 'perm-1',
        type: 'file_operation',
        path: '/home/user/project/src/file.ts',
        description: 'Edit file',
      };

      const result = await relay.handlePermissionRequest(mockJob, permission);

      expect(result.autoApproved).toBe(true);
    });

    it('should not auto-approve operations outside worktree', async () => {
      const permission: PermissionRequest = {
        id: 'perm-1',
        type: 'file_operation',
        path: '/etc/passwd',
        description: 'Edit system file',
      };

      const result = await relay.handlePermissionRequest(mockJob, permission);

      expect(result.autoApproved).toBe(false);
      expect(result.approved).toBe(false);
    });

    it('should handle jobs without port gracefully', async () => {
      const jobWithoutPort = { ...mockJob, port: undefined };
      const permission: PermissionRequest = {
        id: 'perm-1',
        type: 'mcp',
        description: 'Execute MCP tool',
      };

      const result = await relay.handlePermissionRequest(jobWithoutPort, permission);

      expect(result.autoApproved).toBe(true);
    });

    it('should handle jobs without launchSessionID gracefully', async () => {
      const jobWithoutSession = { ...mockJob, launchSessionID: undefined };
      const permission: PermissionRequest = {
        id: 'perm-1',
        type: 'file_operation',
        path: '/etc/passwd',
        description: 'Edit system file',
      };

      const result = await relay.handlePermissionRequest(jobWithoutSession, permission);

      expect(result.autoApproved).toBe(false);
    });
  });

  describe('configuration', () => {
    it('should accept custom timeout configuration', () => {
      const customRelay = new QuestionRelay({
        autoResponseTimeoutMs: 60000,
        defaultResponse: 'custom response',
      });

      expect(customRelay).toBeDefined();
    });
  });

  describe('cleanup', () => {
    it('should clean up without errors', () => {
      relay.cleanup('job-1');
    });

    it('should dispose without errors', () => {
      relay.dispose();
    });
  });

  describe('publishing guard + operator visibility', () => {
    let realFetch: typeof fetch;

    beforeEach(async () => {
      realFetch = globalThis.fetch;
    });

    afterEach(async () => {
      globalThis.fetch = realFetch;
    });

    it('never auto-approves git push with -C space/quote paths inside the worktree', () => {
      for (const description of [
        'git push origin x',
        'git -C "my dir" push origin main',
        "git -C 'my dir' push",
        'git -c core.sshCommand=ssh push',
        'git --git-dir=/tmp/x push',
      ]) {
        const result = shouldAutoApprove(
          { id: 'p', type: 'shell_command', path: '/home/user/project', description },
          '/home/user/project',
        );
        expect(result.autoApproved).toBe(false);
      }
    });

    it('makes ask-user escalation visible as a pending question (memory + sidecar)', async () => {
      const job: Job = {
        ...mockJob,
        id: 'job-vis',
        name: 'vis-job',
        port: 18080,
        remoteSessionID: 'ses_vis',
      };
      const permission: PermissionRequest = {
        id: 'per-vis-1',
        type: 'shell_command',
        path: '/etc',
        description: 'Run system command outside worktree',
      };
      const result = await relay.handlePermissionRequest(job, permission);
      expect(result.autoApproved).toBe(false);

      const pending = getPendingQuestionsForJob('job-vis');
      expect(pending.map((q) => q.partId)).toContain('perm:per-vis-1');
      expect(pending[0].question).toMatch(/Permission needed/);

      const { loadRuntimeSnapshot } = await import('../../src/lib/durable-state');
      const sidecar = await loadRuntimeSnapshot();
      expect((sidecar?.pendingQuestions ?? []).map((q) => q.partId)).toContain('perm:per-vis-1');

      relay.cleanup('job-vis');
      removePendingQuestion('job-vis', 'perm:per-vis-1');
    });

    it('auto-denies ALL escalations on timeout (R1 fail-closed: silence never approves)', async () => {
      const seen: Array<{ url: string; body: unknown }> = [];
      globalThis.fetch = (async (url: unknown, init?: unknown) => {
        seen.push({ url: String(url), body: (init as { body?: unknown })?.body });
        return new Response('{}', { status: 200 });
      }) as typeof fetch;

      const fastRelay = new QuestionRelay({ autoResponseTimeoutMs: 20 });

      const pubJob: Job = {
        ...mockJob,
        id: 'job-pub-timeout',
        name: 'pub-job',
        port: 18081,
        remoteSessionID: 'ses_pub',
      };
      await fastRelay.handlePermissionRequest(pubJob, {
        id: 'per-pub-1',
        type: 'shell_command',
        path: '/home/user/project',
        description: 'git -C "my dir" push origin main',
      });
      await new Promise((r) => setTimeout(r, 60));
      const pubCall = seen.find((s) => s.url.includes('per-pub-1'));
      expect(pubCall).toBeDefined();
      expect(JSON.stringify(pubCall!.body)).toMatch(/reject/);
      fastRelay.dispose();

      seen.length = 0;
      const plainRelay = new QuestionRelay({ autoResponseTimeoutMs: 20 });
      const plainJob: Job = {
        ...mockJob,
        id: 'job-plain-timeout',
        name: 'plain-job',
        port: 18082,
        remoteSessionID: 'ses_plain',
      };
      await plainRelay.handlePermissionRequest(plainJob, {
        id: 'per-plain-1',
        type: 'shell_command',
        path: '/etc',
        description: 'Run system command outside worktree',
      });
      await new Promise((r) => setTimeout(r, 60));
      const plainCall = seen.find((s) => s.url.includes('per-plain-1'));
      expect(plainCall).toBeDefined();
      expect(JSON.stringify(plainCall!.body)).toMatch(/reject/);
      expect(JSON.stringify(plainCall!.body)).not.toMatch(/once/);
      plainRelay.dispose();
    });
  });
});

describe('policy decision gating (P1)', () => {
  const worktreePath = '/home/user/project';

  it('ask-user is never auto-approved for shell inside worktree', () => {
    const result = shouldAutoApprove(
      { id: 'p1', type: 'shell_command', path: '/home/user/project/run.sh', description: 'Run build' },
      worktreePath,
      'ask-user',
    );
    expect(result.autoApproved).toBe(false);
    expect(result.approved).toBe(false);
  });

  it('ask-user is never auto-approved for file operations inside worktree', () => {
    const result = shouldAutoApprove(
      { id: 'p1', type: 'file_operation', path: '/home/user/project/src/a.ts', description: 'Edit file' },
      worktreePath,
      'ask-user',
    );
    expect(result.autoApproved).toBe(false);
    expect(result.approved).toBe(false);
  });

  it('ask-user is never auto-approved for MCP tools', () => {
    const result = shouldAutoApprove(
      { id: 'p1', type: 'mcp', description: 'Execute MCP tool' },
      worktreePath,
      'ask-user',
    );
    expect(result.autoApproved).toBe(false);
    expect(result.approved).toBe(false);
  });

  it('deny is never auto-approved, even for MCP', () => {
    const result = shouldAutoApprove(
      { id: 'p1', type: 'mcp', description: 'Execute MCP tool' },
      worktreePath,
      'deny',
    );
    expect(result.approved).toBe(false);
    expect(result.autoApproved).toBe(false);
  });

  it('auto-approve policy still auto-approves shell inside worktree (positive)', () => {
    const result = shouldAutoApprove(
      { id: 'p1', type: 'shell_command', path: '/home/user/project/run.sh', description: 'Run build' },
      worktreePath,
      'auto-approve',
    );
    expect(result.autoApproved).toBe(true);
  });

  it('auto-approve decision cannot re-approve publishing push (guard stays a ceiling)', () => {
    const result = shouldAutoApprove(
      { id: 'p1', type: 'shell_command', path: '/home/user/project', description: 'git push origin main' },
      worktreePath,
      'auto-approve',
    );
    expect(result.autoApproved).toBe(false);
  });

  it('legacy callers without a decision keep path-based behavior', () => {
    const result = shouldAutoApprove(
      { id: 'p1', type: 'shell_command', path: '/home/user/project/run.sh', description: 'Run build' },
      worktreePath,
    );
    expect(result.autoApproved).toBe(true);
  });

  it('rejects sibling-prefix paths even with auto-approve decision (no re-approval outside)', () => {
    const result = shouldAutoApprove(
      { id: 'p1', type: 'shell_command', path: '/home/user/project2/run.sh', description: 'Run build' },
      worktreePath,
      'auto-approve',
    );
    expect(result.autoApproved).toBe(false);
  });
});

describe('QuestionRelay policy handling (P1)', () => {
  let relay: QuestionRelay;
  let outerStateDir = '';
  let realFetch: typeof fetch;
  const seen: Array<{ url: string; body: string }> = [];

  const policyJob: Job = {
    id: 'job-p1',
    name: 'P1 Job',
    worktreePath: '/home/user/project',
    branch: 'main',
    tmuxTarget: 'mc-p1',
    placement: 'session',
    status: 'running',
    prompt: 'Do work',
    mode: 'vanilla',
    createdAt: new Date().toISOString(),
    port: 18091,
    remoteSessionID: 'ses_p1',
  };

  beforeEach(async () => {
    relay = new QuestionRelay({ autoResponseTimeoutMs: 60_000 });
    const fs = await import('fs');
    outerStateDir = await fs.promises.mkdtemp(join(tmpdir(), 'mc-relay-p1-'));
    spyOn(paths, 'getDataDir').mockResolvedValue(join(outerStateDir, 'state'));
    fs.mkdirSync(join(outerStateDir, 'state'), { recursive: true });
    realFetch = globalThis.fetch;
    seen.length = 0;
    globalThis.fetch = (async (url: unknown, init?: unknown) => {
      seen.push({ url: String(url), body: JSON.stringify((init as { body?: string })?.body ?? {}) });
      return new Response('{}', { status: 200 });
    }) as typeof fetch;
  });

  afterEach(async () => {
    relay.dispose();
    clearPendingQuestionsForJob('job-p1');
    globalThis.fetch = realFetch;
    (paths.getDataDir as unknown as { mockRestore?: () => void }).mockRestore?.();
    const fs = await import('fs');
    if (outerStateDir && fs.existsSync(outerStateDir)) {
      fs.rmSync(outerStateDir, { recursive: true, force: true });
    }
  });

  it('ask-user shell inside worktree is relayed, not auto-approved', async () => {
    const result = await relay.handlePermissionRequest(
      policyJob,
      { id: 'p-ask-shell', type: 'shell_command', path: '/home/user/project/run.sh', description: 'Run build' },
      undefined,
      'ask-user',
    );
    expect(result.autoApproved).toBe(false);
    expect(result.approved).toBe(false);
    // Escalated, not decided: no reply on the wire…
    expect(seen.find((s) => s.url.includes('p-ask-shell'))).toBeUndefined();
    // …but visible as pending.
    expect(getPendingQuestionsForJob('job-p1').map((q) => q.partId)).toContain('perm:p-ask-shell');
  });

  it('ask-user MCP is relayed, not auto-approved', async () => {
    const result = await relay.handlePermissionRequest(
      policyJob,
      { id: 'p-ask-mcp', type: 'mcp', description: 'Execute MCP tool' },
      undefined,
      'ask-user',
    );
    expect(result.autoApproved).toBe(false);
    expect(seen.find((s) => s.url.includes('p-ask-mcp'))).toBeUndefined();
    expect(getPendingQuestionsForJob('job-p1').map((q) => q.partId)).toContain('perm:p-ask-mcp');
  });

  it('deny blocks without relaying to the user (no pending, reject on the wire)', async () => {
    const result = await relay.handlePermissionRequest(
      policyJob,
      { id: 'p-deny-shell', type: 'shell_command', path: '/home/user/project/run.sh', description: 'Run build' },
      undefined,
      'deny',
    );
    expect(result.approved).toBe(false);
    expect(result.autoApproved).toBe(false);
    expect(getPendingQuestionsForJob('job-p1').map((q) => q.partId)).not.toContain('perm:p-deny-shell');
    const call = seen.find((s) => s.url.includes('p-deny-shell'));
    expect(call).toBeDefined();
    expect(call!.body).toMatch(/reject/);
  });

  it('user response "yes" approves once and cancels the pending timeout (no double reply)', async () => {
    const fast = new QuestionRelay({ autoResponseTimeoutMs: 30 });
    try {
      await fast.handlePermissionRequest(
        policyJob,
        { id: 'p-cancel', type: 'shell_command', path: '/home/user/project/run.sh', description: 'Run build' },
        undefined,
        'ask-user',
      );
      await fast.handleUserResponse(policyJob, 'p-cancel', 'yes');
      await new Promise((r) => setTimeout(r, 90));
      const calls = seen.filter((s) => s.url.includes('p-cancel'));
      expect(calls).toHaveLength(1);
      expect(calls[0].body).toMatch(/once/);
    } finally {
      fast.dispose();
    }
  });

  it('cleanup cancels pending escalation (restart-safe: no reply after cleanup)', async () => {
    const fast = new QuestionRelay({ autoResponseTimeoutMs: 30 });
    try {
      await fast.handlePermissionRequest(
        policyJob,
        { id: 'p-cleanup', type: 'shell_command', path: '/home/user/project/run.sh', description: 'Run build' },
        undefined,
        'ask-user',
      );
      fast.cleanup(policyJob.id);
      await new Promise((r) => setTimeout(r, 90));
      expect(seen.filter((s) => s.url.includes('p-cleanup'))).toHaveLength(0);
    } finally {
      fast.dispose();
      removePendingQuestion(policyJob.id, 'perm:p-cleanup');
    }
  });
});
