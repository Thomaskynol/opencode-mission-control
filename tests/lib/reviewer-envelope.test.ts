import { describe, it, expect } from 'bun:test';
import { reviewFunctionallyViaOpenCode } from '../../src/lib/opencode-reviewer';

// Fixture REAL: `opencode run --standalone --model
// opencode-go/muse-spark-1.3-contributor --format json "<prompt pequeno>"`
// (opencode v2.2.5, EXIT=0, 3 linhas verbatim; só o prompt foi trocado pelo
// texto abaixo). O veredito viaja ESCAPADO em part.text de um evento
// {"type":"text"} dentro do envelope JSONL — não como [...] puro.
const REAL_ENVELOPE = [
  '{"type":"step_start","timestamp":1793518990500,"sessionID":"ses_TESTFIXTURE000000000000001","part":{"id":"prt_1960ff4a4001kogeEg4Wlz2Db5","sessionID":"ses_TESTFIXTURE000000000000001","messageID":"msg_1960feb470016aK3AxecjXV37i","type":"step-start","snapshot":"7ab6044407abffe1190024e94af353204ab57c81"}}',
  '{"type":"text","timestamp":1793518991607,"sessionID":"ses_TESTFIXTURE000000000000001","part":{"id":"prt_1960ff866001kaYKh5MB1JcmgX","sessionID":"ses_TESTFIXTURE000000000000001","messageID":"msg_1960feb470016aK3AxecjXV37i","type":"text","text":"[{\\"id\\": \\"r1\\", \\"demonstrated\\": true, \\"missing\\": [], \\"verdict\\": \\"pass\\", \\"reason\\": \\"probe\\"}]","time":{"start":1793518991462,"end":1793518991607}}}',
  '{"type":"step_finish","timestamp":1793518992001,"sessionID":"ses_TESTFIXTURE000000000000001","part":{"id":"prt_1960feb470016aK3AxecjXV37i_step-finish","sessionID":"ses_TESTFIXTURE000000000000001","messageID":"msg_1960feb470016aK3AxecjXV37i","type":"step-finish","reason":"stop","snapshot":"7ab6044407abffe1190024e94af353204ab57c81","cost":0,"tokens":{"input":26400,"output":40,"reasoning":179,"cache":{"read":0,"write":0}}}}',
].join('\n');

const REQ = [{ id: 'r1', description: 'probe requirement', anchors: ['probe'] }];

function stubSpawn(stdout: string, exitCode = 0) {
  const origSpawn = Bun.spawn;
  (Bun as unknown as { spawn: unknown }).spawn = (_argv: string[], _opts?: unknown) => ({
    stdout: new Response(stdout).body,
    stderr: new Response('').body,
    exited: Promise.resolve(exitCode),
    kill() {},
  });
  return () => {
    (Bun as unknown as { spawn: unknown }).spawn = origSpawn;
  };
}

describe('reviewer JSONL envelope (demo-TOUCHSET §3/§7.1)', () => {
  it('RED: desembrulha vereditos do envelope --format json real', async () => {
    const restore = stubSpawn(REAL_ENVELOPE);
    try {
      const results = await reviewFunctionallyViaOpenCode({ requirements: REQ, model: 'probe/model' });
      expect(results).toHaveLength(1);
      expect(results[0]!.verdict).toBe('pass');
      expect(results[0]!.demonstrated).toBe(true);
      expect(results[0]!.reason).toBe('probe');
    } finally {
      restore();
    }
  });

  it('remonta veredito dividido em dois eventos text', async () => {
    const lines = REAL_ENVELOPE.split('\n');
    const evt = JSON.parse(lines[1]!);
    const full: string = evt.part.text;
    const cut = Math.floor(full.length / 2);
    const a = { ...evt, part: { ...evt.part, text: full.slice(0, cut) } };
    const b = { ...evt, part: { ...evt.part, text: full.slice(cut) } };
    const restore = stubSpawn([lines[0], JSON.stringify(a), JSON.stringify(b), lines[2]].join('\n'));
    try {
      const results = await reviewFunctionallyViaOpenCode({ requirements: REQ, model: 'probe/model' });
      expect(results).toHaveLength(1);
      expect(results[0]!.verdict).toBe('pass');
    } finally {
      restore();
    }
  });

  it('fail-closed: envelope sem veredito continua fail', async () => {
    const restore = stubSpawn(
      '{"type":"step_start"}\n{"type":"step_finish","part":{"type":"step-finish","reason":"stop","cost":0}}',
    );
    try {
      const results = await reviewFunctionallyViaOpenCode({ requirements: REQ, model: 'probe/model' });
      expect(results).toHaveLength(1);
      expect(results[0]!.verdict).toBe('fail');
      expect(results[0]!.reason).toMatch(/no parseable/);
    } finally {
      restore();
    }
  });

  it('fail-closed: saída vazia continua fail sem throw', async () => {
    const restore = stubSpawn('');
    try {
      const results = await reviewFunctionallyViaOpenCode({ requirements: REQ, model: 'probe/model' });
      expect(results).toHaveLength(1);
      expect(results[0]!.verdict).toBe('fail');
    } finally {
      restore();
    }
  });
});
