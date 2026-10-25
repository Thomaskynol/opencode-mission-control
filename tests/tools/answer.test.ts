import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import * as jobState from '../../src/lib/job-state';
import * as config from '../../src/lib/config';
import * as sdkClient from '../../src/lib/sdk-client';
import * as forms from '../../src/orchestrator-cli/forms';

const { mc_answer } = await import('../../src/tools/answer');

let mockGetJobByName: Mock;
let mockLoadConfig: Mock;
let mockV2Prompt: Mock;

const mockContext = {
  sessionID: 'test-session',
  messageID: 'test-message',
  agent: 'test-agent',
  directory: '/test/dir',
  worktree: '/test/worktree',
  abort: new AbortController().signal,
  metadata: vi.fn(),
  ask: vi.fn(),
} as any;

describe('mc_answer v2 sender (review fix)', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mockGetJobByName = vi.spyOn(jobState, 'getJobByName').mockResolvedValue({
      id: 'job-1',
      name: 'alpha',
      status: 'running',
      port: 14111,
      remoteSessionID: 'ses-remote',
    } as any) as unknown as Mock;

    mockLoadConfig = vi.spyOn(config, 'loadConfig').mockResolvedValue({
      serverPassword: undefined,
    } as any) as unknown as Mock;

    mockV2Prompt = vi.spyOn(sdkClient, 'v2Prompt').mockResolvedValue(undefined) as unknown as Mock;

    // Capture the sender and invoke it like forms.answerQuestion would.
    vi.spyOn(forms, 'answerQuestion').mockImplementation(
      async (_jobName: string, response: string, sender: forms.AnswerSender) => {
        await sender(14111, 'ses-remote', response);
        return 'ok';
      },
    );
  });

  it('routes the answer through the v2 /api client to the remote session', async () => {
    await mc_answer.execute({ name: 'alpha', response: 'go ahead' }, mockContext);

    expect(mockV2Prompt).toHaveBeenCalledTimes(1);
    const [client, sessionID, text] = mockV2Prompt.mock.calls[0];
    expect(client.baseUrl).toBe('http://127.0.0.1:14111/api');
    expect(sessionID).toBe('ses-remote');
    expect(text).toBe('go ahead');
  });

  it('refuses jobs without a remote session instead of misrouting', async () => {
    mockGetJobByName.mockResolvedValue({
      id: 'job-1',
      name: 'alpha',
      status: 'running',
      port: 14111,
      launchSessionID: 'ses-launch',
    } as any);

    await expect(
      mc_answer.execute({ name: 'alpha', response: 'go' }, mockContext),
    ).rejects.toThrow(/serve-mode|session info/i);
    expect(mockV2Prompt).not.toHaveBeenCalled();
  });
});
