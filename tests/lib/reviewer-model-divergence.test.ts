// Lane CD — achado D (RED): MC_REVIEW_MODEL divergente não pode trocar
// silenciosamente o modelo do revisor. Contrato: herda o triplo efetivo;
// override divergente sem autorização explícita é rejeitado (throw), e o
// caminho público converte em fail-closed sem invocar o binário.
import { describe, it, expect, afterEach } from 'bun:test';
import {
  reviewFunctionallyViaOpenCode,
  resolveReviewModel,
} from '../../src/lib/opencode-reviewer';

const REQ = [{ id: 'REQ-d', description: 'divergence guard', anchors: ['d'] }];
const MISSION = 'opencode-go/muse-spark-1.3-contributor#xhigh';
const DIVERGENT = 'other-provider/other-model#other-variant';

const savedEnv: Record<string, string | undefined> = {};
function saveEnv() {
  savedEnv.MC_REVIEW_MODEL = process.env.MC_REVIEW_MODEL;
  savedEnv.MC_REVIEW_MODEL_ALLOW_DIVERGENT = process.env.MC_REVIEW_MODEL_ALLOW_DIVERGENT;
}
function clearEnv() {
  delete process.env.MC_REVIEW_MODEL;
  delete process.env.MC_REVIEW_MODEL_ALLOW_DIVERGENT;
}
afterEach(() => {
  if (savedEnv.MC_REVIEW_MODEL !== undefined) process.env.MC_REVIEW_MODEL = savedEnv.MC_REVIEW_MODEL;
  else delete process.env.MC_REVIEW_MODEL;
  if (savedEnv.MC_REVIEW_MODEL_ALLOW_DIVERGENT !== undefined) {
    process.env.MC_REVIEW_MODEL_ALLOW_DIVERGENT = savedEnv.MC_REVIEW_MODEL_ALLOW_DIVERGENT;
  } else delete process.env.MC_REVIEW_MODEL_ALLOW_DIVERGENT;
});
saveEnv();

describe('D — override divergente do modelo do revisor (RED no HEAD)', () => {
  it('ausente: herda o triplo efetivo da missão (com variante)', () => {
    clearEnv();
    expect(resolveReviewModel({}, MISSION)).toBe(MISSION);
  });

  it('igual: env idêntico ao efetivo é aceito sem autorização extra', () => {
    clearEnv();
    process.env.MC_REVIEW_MODEL = MISSION;
    expect(resolveReviewModel({}, MISSION)).toBe(MISSION);
  });

  it('divergente: env divergente sem autorização é rejeitado', () => {
    clearEnv();
    process.env.MC_REVIEW_MODEL = DIVERGENT;
    expect(() => resolveReviewModel({}, MISSION)).toThrow(/diverg/i);
  });

  it('divergente autorizado: MC_REVIEW_MODEL_ALLOW_DIVERGENT com o valor exato libera', () => {
    clearEnv();
    process.env.MC_REVIEW_MODEL = DIVERGENT;
    process.env.MC_REVIEW_MODEL_ALLOW_DIVERGENT = DIVERGENT;
    expect(resolveReviewModel({}, MISSION)).toBe(DIVERGENT);
  });

  it('autorização de outro valor não libera a divergência', () => {
    clearEnv();
    process.env.MC_REVIEW_MODEL = DIVERGENT;
    process.env.MC_REVIEW_MODEL_ALLOW_DIVERGENT = 'unrelated-model/x';
    expect(() => resolveReviewModel({}, MISSION)).toThrow(/diverg/i);
  });

  it('args.model divergente do efetivo também exige autorização', () => {
    clearEnv();
    expect(() => resolveReviewModel({ model: DIVERGENT }, MISSION)).toThrow(/diverg/i);
    process.env.MC_REVIEW_MODEL_ALLOW_DIVERGENT = DIVERGENT;
    expect(resolveReviewModel({ model: DIVERGENT }, MISSION)).toBe(DIVERGENT);
  });

  it('caminho público: divergência vira fail-closed SEM invocar o binário', async () => {
    clearEnv();
    process.env.MC_REVIEW_MODEL = DIVERGENT;
    let calls = 0;
    const origSpawn = Bun.spawn;
    (Bun as any).spawn = (...a: unknown[]) => {
      calls++;
      return (origSpawn as any)(...(a as []));
    };
    try {
      const results = await reviewFunctionallyViaOpenCode({ requirements: REQ }, MISSION);
      expect(results).toHaveLength(1);
      expect(results[0]!.verdict).toBe('fail');
      expect(results[0]!.reason).toMatch(/diverg/i);
      expect(calls).toBe(0);
    } finally {
      (Bun as any).spawn = origSpawn;
    }
  });

  it('caminho público: modelo efetivo com variante chega ao argv (--model triplo)', async () => {
    clearEnv();
    const seen: string[][] = [];
    const origSpawn = Bun.spawn;
    const passJson = JSON.stringify([
      { id: 'REQ-d', demonstrated: true, missing: [], verdict: 'pass', reason: 'ok' },
    ]);
    (Bun as any).spawn = (argv: string[], _opts?: unknown) => {
      seen.push(argv);
      return {
        stdout: new Response(passJson).body,
        stderr: new Response('').body,
        exited: Promise.resolve(0),
        kill() {},
      };
    };
    try {
      const results = await reviewFunctionallyViaOpenCode({ requirements: REQ }, MISSION);
      expect(results[0]!.verdict).toBe('pass');
      expect(seen).toHaveLength(1);
      const idx = seen[0]!.indexOf('--model');
      expect(idx).toBeGreaterThan(-1);
      expect(seen[0]![idx + 1]).toBe(MISSION);
    } finally {
      (Bun as any).spawn = origSpawn;
    }
  });

  it('ao vivo (gated): binário opencode responde --version (observação registrada, sem chamada de modelo)', async () => {
    if (process.env.TEST_LIVE !== '1') return; // sem modelo real: limite registrado, não falha
    const proc = Bun.spawn(['opencode', '--version'], { stdout: 'pipe', stderr: 'pipe' });
    const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    expect(code).toBe(0);
    expect(out.trim().length).toBeGreaterThan(0);
  });
});
