import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'path';
import { tmpdir } from 'os';
import type { Job } from '../../src/lib/job-state';
import type { MCConfig } from '../../src/lib/config';

vi.mock('../../src/lib/paths', () => ({
  getDataDir: vi.fn(),
}));

const paths = await import('../../src/lib/paths');
const { allocatePort, releasePort } = await import('../../src/lib/port-allocator');

let testDataDir: string;

function makeConfig(overrides?: Partial<MCConfig>): MCConfig {
  return {
    defaultPlacement: 'session',
    pollInterval: 10000,
    idleThreshold: 300000,
    worktreeBasePath: '/tmp/mc-worktrees',
    useServeMode: true,
    portRangeStart: 14100,
    portRangeEnd: 14110,
    omo: { enabled: false, defaultMode: 'vanilla' },
    ...overrides,
  } as MCConfig;
}

function makeJob(overrides?: Partial<Job>): Job {
  return {
    id: 'job-1',
    name: 'test-job',
    worktreePath: '/tmp/worktree',
    branch: 'mc/test',
    tmuxTarget: 'mc-test',
    placement: 'session',
    status: 'running',
    prompt: 'test',
    mode: 'vanilla',
    createdAt: new Date().toISOString(),
    ...overrides,
  } as Job;
}

/**
 * Find `count` consecutive OS-free ports for the fixture range.
 * Isolates these tests from foreign listeners on the host (e.g. other
 * live serve processes on 1410x) — the allocator's bind-probe correctly
 * skips those, so hardcoded expectations on 1410x are only valid when
 * the OS range is actually free.
 */
function findFreeBase(count: number): number {
  for (let base = 25000; base < 30000; base++) {
    let ok = true;
    for (let p = base; p < base + count; p++) {
      try {
        Bun.serve({
          port: p,
          hostname: '127.0.0.1',
          fetch: () => new Response('probe'),
        }).stop(true);
      } catch {
        ok = false;
        break;
      }
    }
    if (ok) return base;
  }
  throw new Error('no free port block found for test fixture');
}

describe('port-allocator', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    const fs = await import('fs');
    testDataDir = fs.mkdtempSync(join(tmpdir(), 'mc-port-test-'));
    (paths.getDataDir as ReturnType<typeof vi.fn>).mockResolvedValue(testDataDir);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    const fs = await import('fs');
    if (fs.existsSync(testDataDir)) {
      fs.rmSync(testDataDir, { recursive: true, force: true });
    }
  });

  describe('allocatePort', () => {
    it('should allocate first port in range when no active jobs', async () => {
      const port = await allocatePort(makeConfig(), []);
      expect(port).toBe(14100);
    });

    it('should skip ports used by active jobs', async () => {
      const base = findFreeBase(3);
      const jobs = [
        makeJob({ port: base }),
        makeJob({ port: base + 1 }),
      ];
      const config = makeConfig({ portRangeStart: base, portRangeEnd: base + 10 });
      const port = await allocatePort(config, jobs);
      expect(port).toBe(base + 2);
    });

    it('should skip ports in lock file from previous allocations', async () => {
      await allocatePort(makeConfig(), []);
      const secondPort = await allocatePort(makeConfig(), []);
      expect(secondPort).toBe(14101);
    });

    it('should use custom port range from config', async () => {
      const config = makeConfig({ portRangeStart: 15000, portRangeEnd: 15010 });
      const port = await allocatePort(config, []);
      expect(port).toBe(15000);
    });

    it('should throw when all ports in range are exhausted', async () => {
      const config = makeConfig({ portRangeStart: 14100, portRangeEnd: 14101 });
      await allocatePort(config, []);
      await allocatePort(config, []);

      await expect(allocatePort(config, [])).rejects.toThrow(
        'No available ports in range 14100-14101',
      );
    });

    it('should consider both job ports and lock file ports', async () => {
      const base = findFreeBase(4);
      const config = makeConfig({ portRangeStart: base, portRangeEnd: base + 3 });
      await allocatePort(config, []);
      const jobs = [makeJob({ port: base + 1 })];
      const port = await allocatePort(config, jobs);
      expect(port).toBe(base + 2);
    });

    it('should handle corrupted lock file gracefully', async () => {
      const fs = await import('fs');
      fs.writeFileSync(join(testDataDir, 'port.lock'), 'invalid json{{{');
      const port = await allocatePort(makeConfig(), []);
      expect(port).toBe(14100);
    });

    it('should handle jobs without ports', async () => {
      const jobs = [makeJob({ port: undefined })];
      const port = await allocatePort(makeConfig(), jobs);
      expect(port).toBe(14100);
    });
  });

  describe('releasePort', () => {
    it('should remove port from lock file', async () => {
      const config = makeConfig();
      await allocatePort(config, []);
      await releasePort(14100);
      const port = await allocatePort(config, []);
      expect(port).toBe(14100);
    });

    it('should be idempotent for unknown ports', async () => {
      await expect(releasePort(99999)).resolves.toBeUndefined();
    });

    it('should only remove the specified port', async () => {
      const config = makeConfig();
      await allocatePort(config, []);
      await allocatePort(config, []);

      await releasePort(14100);

      const port = await allocatePort(config, []);
      expect(port).toBe(14100);
    });

    it('should handle missing lock file gracefully', async () => {
      await expect(releasePort(14100)).resolves.toBeUndefined();
    });
  });
});
