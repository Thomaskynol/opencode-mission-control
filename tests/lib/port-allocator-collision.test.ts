import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { join } from 'path';
import { tmpdir } from 'os';
import type { Job } from '../../src/lib/job-state';
import type { MCConfig } from '../../src/lib/config';

vi.mock('../../src/lib/paths', () => ({
  getDataDir: vi.fn(),
}));

const paths = await import('../../src/lib/paths');
const { allocatePort } = await import('../../src/lib/port-allocator');

let testDataDir: string;
let foreignServers: Array<{ stop: (closeActive?: boolean) => void }> = [];

function makeConfig(overrides?: Partial<MCConfig>): MCConfig {
  return {
    defaultPlacement: 'session',
    pollInterval: 10000,
    idleThreshold: 300000,
    worktreeBasePath: '/tmp/mc-worktrees',
    useServeMode: true,
    portRangeStart: 14800,
    portRangeEnd: 14810,
    omo: { enabled: false, defaultMode: 'vanilla' },
    ...overrides,
  } as MCConfig;
}

/** Bind a real socket OUTSIDE the allocator lock/XDG — simulates a foreign process. */
function occupyPort(port: number) {
  const server = Bun.serve({
    port,
    hostname: '127.0.0.1',
    fetch: () => new Response('foreign'),
  });
  foreignServers.push(server);
  return server;
}

/** Find a bindable port in the probe area to use as deterministic fixture base. */
function findOccupiableBase(): number {
  for (let port = 14800; port < 14860; port++) {
    try {
      const s = Bun.serve({
        port,
        hostname: '127.0.0.1',
        fetch: () => new Response('probe'),
      });
      s.stop(true);
      return port;
    } catch {
      continue;
    }
  }
  throw new Error('no bindable port found for collision fixture (14800-14859 all busy?)');
}

describe('port-allocator foreign-process collision', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    const fs = await import('fs');
    testDataDir = fs.mkdtempSync(join(tmpdir(), 'mc-port-collision-'));
    (paths.getDataDir as ReturnType<typeof vi.fn>).mockResolvedValue(testDataDir);
    foreignServers = [];
  });

  afterEach(async () => {
    for (const s of foreignServers) {
      try {
        s.stop(true);
      } catch {
        // best-effort
      }
    }
    foreignServers = [];
    vi.restoreAllMocks();
    const fs = await import('fs');
    if (fs.existsSync(testDataDir)) {
      fs.rmSync(testDataDir, { recursive: true, force: true });
    }
  });

  it('RED: must skip a port held by a foreign process outside lock/XDG', async () => {
    const base = findOccupiableBase();
    occupyPort(base);
    const config = makeConfig({ portRangeStart: base, portRangeEnd: base + 2 });
    const port = await allocatePort(config, []);
    expect(port).not.toBe(base);
    expect(port).toBe(base + 1);
  });

  it('must throw explicit error (never an occupied port) when range is fully held by foreign processes', async () => {
    const base = findOccupiableBase();
    occupyPort(base);
    occupyPort(base + 1);
    const config = makeConfig({ portRangeStart: base, portRangeEnd: base + 1 });
    await expect(allocatePort(config, [])).rejects.toThrow(/No available ports in range/);
  });
});
