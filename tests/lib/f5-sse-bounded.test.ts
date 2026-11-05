import { describe, it, expect, beforeEach, afterEach, spyOn, mock } from 'bun:test';

// F5 RED: processSSEStream against a dead serve must NOT loop forever on
// 100ms "attempt 1" reconnects. It must give up after bounded attempts with
// an actionable message, clean up only its own subscription, and leave the
// job/lease untouched (fail-closed).

function deadFetch(): typeof fetch {
  return (async () => {
    throw new Error('fetch failed: connection refused');
  }) as unknown as typeof fetch;
}

function liveJob() {
  return {
    id: 'job-sse-1',
    name: 'sse-job',
    port: 14999,
    remoteSessionID: 'ses_dead',
    status: 'running',
  };
}

describe('F5: SSE reconnect is bounded with an actionable error', () => {
  let prevFetch: typeof fetch | undefined;
  let warnings: string[];

  beforeEach(() => {
    prevFetch = globalThis.fetch;
    globalThis.fetch = deadFetch();
    warnings = [];
    spyOn(console, 'warn').mockImplementation(((...args: unknown[]) => {
      warnings.push(args.map(String).join(' '));
    }) as never);
  });

  afterEach(() => {
    if (prevFetch !== undefined) globalThis.fetch = prevFetch;
    try { mock.restore(); } catch {}
  });

  it('gives up after bounded attempts, cleans its subscription, keeps fail-closed state', async () => {
    const { JobMonitor } = await import('../../src/lib/monitor');
    const monitor = new JobMonitor();
    const job = liveJob() as never;
    const controller = new AbortController();
    (monitor as unknown as { isRunning: boolean }).isRunning = true;
    (monitor as unknown as { sseSubscriptions: Map<string, unknown> }).sseSubscriptions.set('job-sse-1', {
      abortController: controller,
      client: { baseUrl: 'http://127.0.0.1:14999/api', headers: {} },
      reconnectAttempts: 0,
    });

    await (monitor as unknown as {
      processSSEStream: (j: unknown, c: unknown, a: AbortController, o?: unknown) => Promise<void>;
    }).processSSEStream(
      job,
      { baseUrl: 'http://127.0.0.1:14999/api', headers: {} },
      controller,
      { maxAttempts: 3, baseMs: 1, maxMs: 2 },
    );

    expect(controller.signal.aborted).toBe(true); // give-up aborts only its own SSE subscription
    const subs = (monitor as unknown as { sseSubscriptions: Map<string, unknown> }).sseSubscriptions;
    expect(subs.has('job-sse-1')).toBe(false);
    const lost = warnings.filter((w) => w.includes('SSE connection lost'));
    expect(lost.length).toBeGreaterThan(0);
    expect(lost.length).toBeLessThanOrEqual(4);
    const last = warnings[warnings.length - 1]!;
    expect(last).toMatch(/give up|giving up|abandon/i);
    expect(last).toMatch(/sse-job/);
  });

  it('backoff grows across consecutive failures (no permanent "attempt 1" / 100ms loop)', async () => {
    const { JobMonitor } = await import('../../src/lib/monitor');
    const monitor = new JobMonitor();
    const job = liveJob() as never;
    const controller = new AbortController();
    (monitor as unknown as { isRunning: boolean }).isRunning = true;
    (monitor as unknown as { sseSubscriptions: Map<string, unknown> }).sseSubscriptions.set('job-sse-1', {
      abortController: controller,
      client: { baseUrl: 'http://127.0.0.1:14999/api', headers: {} },
      reconnectAttempts: 0,
    });

    await (monitor as unknown as {
      processSSEStream: (j: unknown, c: unknown, a: AbortController, o?: unknown) => Promise<void>;
    }).processSSEStream(
      job,
      { baseUrl: 'http://127.0.0.1:14999/api', headers: {} },
      controller,
      { maxAttempts: 3, baseMs: 10, maxMs: 1000 },
    );

    const attempts = warnings
      .filter((w) => w.includes('SSE connection lost'))
      .map((w) => Number((w.match(/attempt (\d+)/) ?? [])[1]));
    expect(attempts).toEqual([1, 2, 3]);
  });
});
