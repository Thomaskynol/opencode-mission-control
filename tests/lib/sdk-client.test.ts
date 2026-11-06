import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as sdk from '@opencode-ai/sdk';

// Lane FR (reconciliação): este arquivo era do contrato extinto (SDK
// promptAsync/message). Reescrito para o contrato real L1, verificado live
// no serve 2.2.5 (lane FA):
// - POST /api/session/{id}/prompt {text} -> 200 {data:{id:msg_...}}
// - prompt_async e POST message NÃO existem (404 vazios); o SDK 1.1.53 só
//   conhece as rotas extintas — o transporte é fetch direto, nunca
//   client.session.promptAsync.
// - agent/model por mensagem não existem no 2.2.5: falham fechado (o pin é
//   propriedade da criação da sessão).
// Decisão registrada: forkJobSession com agent/model também falha fechado
// (via sendPrompt) em vez de seguir despinado em silêncio — o corpo do
// fork (POST /session/:id/fork) não tem contrato verificado para pin, e
// inventar um seria pior que recusar. Limitação explícita, não cobertura
// faltante.

// Scoped spy (no vi.mock): the shared registry keeps the real SDK module for
// every other file; only createOpencodeClient is stubbed here and restored
// after each test. Semantics identical (same mockClient).

const BASE = 'http://127.0.0.1:14100/api';
const AUTH = 'Basic ' + Buffer.from('opencode:secret').toString('base64');

const mockSessionList = vi.fn();
const mockSessionCreate = vi.fn();
const mockSessionPromptAsync = vi.fn();
const mockSessionFork = vi.fn();

// Fiel ao transporte real: resolvePromptTransport lê
// client._client.getConfig() (baseUrl + headers com auth/diretório).
const mockClient = {
  _client: {
    getConfig: () => ({
      baseUrl: BASE,
      headers: { Authorization: AUTH, 'x-opencode-directory': '/tmp/work' },
    }),
  },
  session: {
    list: mockSessionList,
    create: mockSessionCreate,
    promptAsync: mockSessionPromptAsync,
    fork: mockSessionFork,
  },
};

const { createJobClient, waitForServer, sendPrompt, createSessionAndPrompt, forkJobSession } = await import('../../src/lib/sdk-client');

const realFetch = globalThis.fetch;

interface SeenCall {
  url: string;
  init?: RequestInit;
}

let calls: SeenCall[] = [];

function stubFetch(handler: (url: string, init?: RequestInit) => Response): void {
  calls = [];
  globalThis.fetch = (async (url: unknown, init?: unknown) => {
    calls.push({ url: String(url), init: init as RequestInit });
    return handler(String(url), init as RequestInit);
  }) as typeof fetch;
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function headerOf(call: SeenCall, name: string): string | undefined {
  const headers = (call.init?.headers ?? {}) as Record<string, string>;
  if (typeof Headers !== 'undefined' && headers instanceof Headers) {
    return headers.get(name) ?? undefined;
  }
  const found = Object.keys(headers).find((k) => k.toLowerCase() === name.toLowerCase());
  return found ? headers[found] : undefined;
}

describe('sdk-client', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(sdk, 'createOpencodeClient').mockImplementation((() => mockClient) as any);
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
  });

  describe('createJobClient', () => {
    it('should create client with correct baseUrl', () => {
      createJobClient(14100);

      expect(sdk.createOpencodeClient).toHaveBeenCalledWith(
        expect.objectContaining({
          baseUrl: 'http://127.0.0.1:14100/api',
        }),
      );
    });

    it('should add auth header when password provided', () => {
      createJobClient(14100, 'secret');

      const expectedAuth = 'Basic ' + Buffer.from('opencode:secret').toString('base64');
      expect(sdk.createOpencodeClient).toHaveBeenCalledWith(
        expect.objectContaining({
          headers: { Authorization: expectedAuth },
        }),
      );
    });

    it('should not include auth header when no password', () => {
      createJobClient(14100);

      expect(sdk.createOpencodeClient).toHaveBeenCalledWith(
        expect.objectContaining({
          headers: {},
        }),
      );
    });
  });

  describe('waitForServer', () => {
    it('should return client when server responds immediately', async () => {
      mockSessionList.mockResolvedValue({ data: [] });

      const client = await waitForServer(14100);
      expect(client).toBeDefined();
      expect(client.session).toBeDefined();
    });

    it('should retry until server responds', async () => {
      mockSessionList
        .mockRejectedValueOnce(new Error('ECONNREFUSED'))
        .mockRejectedValueOnce(new Error('ECONNREFUSED'))
        .mockResolvedValueOnce({ data: [] });

      const client = await waitForServer(14100);
      expect(client).toBeDefined();
      expect(mockSessionList).toHaveBeenCalledTimes(3);
    });

    it('should throw on timeout', async () => {
      mockSessionList.mockRejectedValue(new Error('ECONNREFUSED'));

      await expect(
        waitForServer(14100, { timeoutMs: 500 }),
      ).rejects.toThrow('did not become ready within 500ms');
    });

    it('should pass password to client', async () => {
      mockSessionList.mockResolvedValue({ data: [] });

      await waitForServer(14100, { password: 'secret' });

      const expectedAuth = 'Basic ' + Buffer.from('opencode:secret').toString('base64');
      expect(sdk.createOpencodeClient).toHaveBeenCalledWith(
        expect.objectContaining({
          headers: { Authorization: expectedAuth },
        }),
      );
    });
  });

  describe('sendPrompt', () => {
    it('should POST {text} to /session/{id}/prompt and return the message id', async () => {
      stubFetch(() => jsonResponse({ data: { id: 'msg_1' } }));

      const id = await sendPrompt(mockClient as any, 'session-1', 'Hello');

      expect(id).toBe('msg_1');
      expect(calls).toHaveLength(1);
      expect(calls[0].url).toBe(`${BASE}/session/session-1/prompt`);
      expect(calls[0].init?.method).toBe('POST');
      expect(JSON.parse(String(calls[0].init?.body))).toEqual({ text: 'Hello' });
      // auth + diretório preservados no transporte fetch
      expect(headerOf(calls[0], 'Authorization')).toBe(AUTH);
      expect(headerOf(calls[0], 'x-opencode-directory')).toBe('/tmp/work');
      // rotas extintas nunca chamadas
      expect(mockSessionPromptAsync).not.toHaveBeenCalled();
      expect(calls[0].url).not.toContain('prompt_async');
    });

    it('should fail closed when agent is provided (pin é da criação)', async () => {
      stubFetch(() => jsonResponse({ data: { id: 'msg_x' } }));

      await expect(
        sendPrompt(mockClient as any, 'session-1', 'Hello', 'build'),
      ).rejects.toThrow(/creation/i);
      expect(calls).toHaveLength(0);
      expect(mockSessionPromptAsync).not.toHaveBeenCalled();
    });

    it('should fail closed when model is provided (pin é da criação)', async () => {
      stubFetch(() => jsonResponse({ data: { id: 'msg_x' } }));

      const model = { providerID: 'anthropic', modelID: 'claude-sonnet-4-20250514' };
      await expect(
        sendPrompt(mockClient as any, 'session-1', 'Hello', undefined, model),
      ).rejects.toThrow(/creation/i);
      expect(calls).toHaveLength(0);
      expect(mockSessionPromptAsync).not.toHaveBeenCalled();
    });

    it('should surface 401 explicitly without leaking the password', async () => {
      stubFetch(() => jsonResponse({ _tag: 'UnauthorizedError' }, 401));

      const err = await sendPrompt(mockClient as any, 'session-1', 'Hello').catch((e) => e);
      expect(String(err?.message ?? err)).toMatch(/401/);
      expect(String(err?.message ?? err)).not.toContain('secret');
    });

    it('should surface 404 (unknown session) explicitly', async () => {
      stubFetch(() => jsonResponse({ _tag: 'SessionNotFoundError' }, 404));

      await expect(sendPrompt(mockClient as any, 'ses_nope', 'Hello')).rejects.toThrow(/404/);
    });

    it('should wrap network errors with context', async () => {
      stubFetch(() => { throw new Error('network error'); });

      await expect(
        sendPrompt(mockClient as any, 'session-1', 'Hello'),
      ).rejects.toThrow('Failed to send prompt to session session-1');
    });
  });

  describe('createSessionAndPrompt', () => {
    it('should create session and send prompt', async () => {
      mockSessionCreate.mockResolvedValue({
        data: { id: 'new-session-id', title: 'test' },
      });
      stubFetch(() => jsonResponse({ data: { id: 'msg_new' } }));

      const sessionId = await createSessionAndPrompt(mockClient as any, 'Hello');

      expect(sessionId).toBe('new-session-id');
      expect(mockSessionCreate).toHaveBeenCalled();
      expect(calls).toHaveLength(1);
      expect(calls[0].url).toBe(`${BASE}/session/new-session-id/prompt`);
      expect(JSON.parse(String(calls[0].init?.body))).toEqual({ text: 'Hello' });
      expect(mockSessionPromptAsync).not.toHaveBeenCalled();
    });

    it('should pin agent/model at creation (not per-prompt)', async () => {
      mockSessionCreate.mockResolvedValue({ data: { id: 'ses_pin' } });
      stubFetch(() => jsonResponse({ data: { id: 'msg_pin' } }));

      const model = { providerID: 'anthropic', modelID: 'claude-sonnet-4-20250514' };
      const sessionId = await createSessionAndPrompt(mockClient as any, 'Hello', 'build', model);

      expect(sessionId).toBe('ses_pin');
      expect(mockSessionCreate).toHaveBeenCalledWith({
        body: {
          agent: 'build',
          model: { providerID: 'anthropic', id: 'claude-sonnet-4-20250514' },
        },
      });
      expect(JSON.parse(String(calls[0].init?.body))).toEqual({ text: 'Hello' });
    });

    it('should throw when session creation fails', async () => {
      mockSessionCreate.mockResolvedValue({
        data: undefined,
        error: { message: 'server error' },
      });

      await expect(
        createSessionAndPrompt(mockClient as any, 'Hello'),
      ).rejects.toThrow('Failed to create session');
    });

    it('should call create with empty body', async () => {
      mockSessionCreate.mockResolvedValue({
        data: { id: 'new-session-id', title: 'test' },
      });
      stubFetch(() => jsonResponse({ data: { id: 'msg_new' } }));

      await createSessionAndPrompt(mockClient as any, 'Hello');

      expect(mockSessionCreate).toHaveBeenCalledWith({ body: {} });
    });

    it('should unwrap nested data envelope', async () => {
      mockSessionCreate.mockResolvedValue({
        data: { data: { id: 'nested-session-id' } },
      });
      stubFetch(() => jsonResponse({ data: { id: 'msg_nested' } }));

      const sessionId = await createSessionAndPrompt(mockClient as any, 'Hello');

      expect(sessionId).toBe('nested-session-id');
    });

    it('should throw when session id is missing (fail-closed)', async () => {
      mockSessionCreate.mockResolvedValue({ data: {} });

      await expect(
        createSessionAndPrompt(mockClient as any, 'Hello'),
      ).rejects.toThrow('Failed to create session');
    });

    it('should throw when session id is empty (fail-closed)', async () => {
      mockSessionCreate.mockResolvedValue({ data: { id: '' } });

      await expect(
        createSessionAndPrompt(mockClient as any, 'Hello'),
      ).rejects.toThrow('Failed to create session');
    });
  });

  describe('forkJobSession', () => {
    it('should call session.fork with source session ID', async () => {
      mockSessionFork.mockResolvedValue({
        data: { id: 'forked-session-id' },
      });
      stubFetch(() => jsonResponse({ data: { id: 'msg_fork' } }));

      const newId = await forkJobSession(mockClient as any, 'source-session', {
        sourceJobName: 'api-job',
        newJobName: 'api-job-v2',
        additionalPrompt: 'Continue the API work',
      });

      expect(newId).toBe('forked-session-id');
      expect(mockSessionFork).toHaveBeenCalledWith({
        path: { id: 'source-session' },
        body: {},
      });
      expect(calls).toHaveLength(1);
      expect(calls[0].url).toBe(`${BASE}/session/forked-session-id/prompt`);
      expect(mockSessionPromptAsync).not.toHaveBeenCalled();
    });

    it('should send context prompt to forked session when additionalPrompt provided', async () => {
      mockSessionFork.mockResolvedValue({
        data: { id: 'forked-session-id' },
      });
      stubFetch(() => jsonResponse({ data: { id: 'msg_fork' } }));

      await forkJobSession(mockClient as any, 'source-session', {
        sourceJobName: 'db-schema',
        newJobName: 'db-schema-v2',
        additionalPrompt: 'Add indexes',
      });

      expect(calls).toHaveLength(1);
      expect(calls[0].url).toBe(`${BASE}/session/forked-session-id/prompt`);
      expect(JSON.parse(String(calls[0].init?.body)).text).toMatch(
        /Forked from job "db-schema" as "db-schema-v2"/,
      );
      expect(mockSessionPromptAsync).not.toHaveBeenCalled();
    });

    it('should include additional prompt in context message', async () => {
      mockSessionFork.mockResolvedValue({
        data: { id: 'forked-session-id' },
      });
      stubFetch(() => jsonResponse({ data: { id: 'msg_fork' } }));

      await forkJobSession(mockClient as any, 'source-session', {
        sourceJobName: 'src',
        newJobName: 'dst',
        additionalPrompt: 'Focus on error handling',
      });

      expect(calls).toHaveLength(1);
      expect(JSON.parse(String(calls[0].init?.body)).text).toMatch(/Focus on error handling/);
    });

    it('should not send prompt when additionalPrompt is not provided', async () => {
      mockSessionFork.mockResolvedValue({
        data: { id: 'forked-session-id' },
      });
      stubFetch(() => jsonResponse({ data: { id: 'msg_x' } }));

      const newId = await forkJobSession(mockClient as any, 'source-session', {
        sourceJobName: 'src',
        newJobName: 'dst',
      });

      expect(newId).toBe('forked-session-id');
      expect(calls).toHaveLength(0);
      expect(mockSessionPromptAsync).not.toHaveBeenCalled();
    });

    it('should fail closed when agent/model passed (pin é da criação, não do fork)', async () => {
      mockSessionFork.mockResolvedValue({
        data: { id: 'forked-session-id' },
      });
      stubFetch(() => jsonResponse({ data: { id: 'msg_x' } }));

      const model = { providerID: 'anthropic', modelID: 'claude-sonnet-4-20250514' };
      await expect(
        forkJobSession(mockClient as any, 'source-session', {
          sourceJobName: 'src',
          newJobName: 'dst',
          additionalPrompt: 'Continue',
          agent: 'build',
          model,
        }),
      ).rejects.toThrow(/creation/i);
    });

    it('should throw when fork call fails', async () => {
      mockSessionFork.mockResolvedValue({
        data: undefined,
        error: { message: 'fork not supported' },
      });

      await expect(
        forkJobSession(mockClient as any, 'source-session', {
          sourceJobName: 'src',
          newJobName: 'dst',
        }),
      ).rejects.toThrow('Failed to fork session');
    });
  });
});
