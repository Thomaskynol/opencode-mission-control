import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import {
  createV2Client,
  v2CreateSession,
  v2GetSession,
  v2Interrupt,
} from '../../src/lib/sdk-client';

const realFetch = globalThis.fetch;

function stubFetch(handler: (url: string, init?: RequestInit) => Response): void {
  globalThis.fetch = (async (url: unknown, init?: unknown) =>
    handler(String(url), init as RequestInit)) as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('v2 client', () => {
  beforeEach(() => {
    stubFetch(
      () =>
        new Response(JSON.stringify({ data: { ok: true } }), { status: 200 }),
    );
  });

  it('points at the /api prefix and sets basic auth when a password is given', async () => {
    let seenUrl = '';
    let seenAuth = '';
    stubFetch((url, init) => {
      seenUrl = url;
      seenAuth = String((init?.headers as Record<string, string>)?.['Authorization'] ?? '');
      return new Response(JSON.stringify({ data: { ok: true } }), { status: 200 });
    });

    await v2GetSession(createV2Client(17891, 's3cret'), 'ses_1');

    expect(seenUrl).toBe('http://127.0.0.1:17891/api/session/ses_1');
    expect(seenAuth).toBe('Basic ' + Buffer.from('opencode:s3cret').toString('base64'));
  });

  it('sends no auth header without a password', async () => {
    let seenAuth: unknown = 'present';
    stubFetch((_url, init) => {
      seenAuth = (init?.headers as Record<string, string>)?.['Authorization'];
      return new Response(JSON.stringify({ data: { ok: true } }), { status: 200 });
    });

    await v2GetSession(createV2Client(17891), 'ses_1');
    expect(seenAuth).toBeUndefined();
  });

  it('creates a session with the pinned profile body', async () => {
    let seenBody: Record<string, unknown> = {};
    stubFetch((_url, init) => {
      seenBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({ data: { id: 'ses_9' } }), { status: 200 });
    });

    const info = await v2CreateSession(createV2Client(17891), {
      agent: 'build',
      model: { providerID: 'anthropic', id: 'claude-sonnet-4-20250514' },
      location: { directory: '/tmp/m2-work' },
      permissions: [{ action: 'edit', resource: '/tmp/**', effect: 'allow' }],
    });

    expect(info.id).toBe('ses_9');
    expect(seenBody).toEqual({
      agent: 'build',
      model: { providerID: 'anthropic', id: 'claude-sonnet-4-20250514' },
      location: { directory: '/tmp/m2-work' },
      permissions: [{ action: 'edit', resource: '/tmp/**', effect: 'allow' }],
    });
  });

  it('throws without leaking credentials on HTTP errors', async () => {
    stubFetch(() => new Response('{"error":"nope"}', { status: 401 }));
    const err = await v2GetSession(createV2Client(17891, 's3cret'), 'ses_1').catch(
      (e: unknown) => e as Error,
    );
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/401/);
    expect(err.message).not.toMatch(/s3cret/);
  });

  it('throws when the data envelope is missing', async () => {
    stubFetch(() => new Response('{"unexpected":true}', { status: 200 }));
    await expect(v2GetSession(createV2Client(17891), 'ses_1')).rejects.toThrow(
      /data envelope/,
    );
  });

  it('passes through non-enveloped responses (interrupt) and empty 204s', async () => {
    stubFetch(() => new Response('{"interrupted":false}', { status: 200 }));
    await expect(v2Interrupt(createV2Client(17891), 'ses_1')).resolves.toEqual({
      interrupted: false,
    });

    stubFetch(() => new Response('', { status: 204 }));
    await expect(v2Interrupt(createV2Client(17891), 'ses_1')).resolves.toBeUndefined();
  });
});
