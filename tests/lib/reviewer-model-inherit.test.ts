import { describe, it, expect, afterEach } from 'bun:test';
import {
  reviewFunctionallyViaOpenCode,
  resolveReviewModel,
  getDivergentReviewModelAudit,
} from '../../src/lib/opencode-reviewer';

const REQ = [{ id: 'REQ-inherit', description: 'inherit effective model', anchors: ['inherit'] }];
const EFFECTIVE = 'opencode-go/muse-spark-1.3-contributor';

let savedEnv: string | undefined;
function clearReviewEnv() {
  savedEnv = process.env.MC_REVIEW_MODEL;
  delete process.env.MC_REVIEW_MODEL;
}
afterEach(() => {
  if (savedEnv !== undefined) process.env.MC_REVIEW_MODEL = savedEnv;
  else delete process.env.MC_REVIEW_MODEL;
});

describe('reviewer model inheritance (effective → review)', () => {
  it('buraco atual: sem MC_REVIEW_MODEL e sem args.model, herda o modelo efetivo em vez de falhar unpinned', () => {
    clearReviewEnv();
    const resolved = resolveReviewModel({}, EFFECTIVE);
    // RED on old code: resolveReviewModel does not exist / returns undefined.
    // GREEN: inherits the effective model passed by the integrator.
    expect(resolved).toBe(EFFECTIVE);
  });

  it('precedência: args.model > MC_REVIEW_MODEL > effectiveModel (divergência exige autorização)', () => {
    clearReviewEnv();
    expect(resolveReviewModel({}, EFFECTIVE)).toBe(EFFECTIVE);
    // Igual ao efetivo: aceito sem autorização extra.
    process.env.MC_REVIEW_MODEL = EFFECTIVE;
    expect(resolveReviewModel({}, EFFECTIVE)).toBe(EFFECTIVE);
    // Divergente sem autorização explícita: rejeitado, nunca silencioso.
    process.env.MC_REVIEW_MODEL = 'env-model/env-id';
    expect(() => resolveReviewModel({}, EFFECTIVE)).toThrow(/diverg/i);
    // R7: par de envs iguais NÃO autoriza (env sozinha nunca autoriza).
    process.env.MC_REVIEW_MODEL_ALLOW_DIVERGENT = 'env-model/env-id';
    expect(() => resolveReviewModel({}, EFFECTIVE)).toThrow(/diverg/i);
    delete process.env.MC_REVIEW_MODEL_ALLOW_DIVERGENT;
    // Decisão explícita da missão autoriza + audita.
    const before = getDivergentReviewModelAudit().length;
    expect(resolveReviewModel({ allowDivergentModel: 'env-model/env-id' }, EFFECTIVE)).toBe('env-model/env-id');
    const audit = getDivergentReviewModelAudit();
    expect(audit.length).toBe(before + 1);
    expect(audit[audit.length - 1]).toMatchObject({ override: 'env-model/env-id', effective: EFFECTIVE });
    expect(() => resolveReviewModel({ model: 'args-model/args-id' }, EFFECTIVE)).toThrow(/diverg/i);
    // R7: env com o valor do args também não autoriza.
    process.env.MC_REVIEW_MODEL_ALLOW_DIVERGENT = 'args-model/args-id';
    expect(() => resolveReviewModel({ model: 'args-model/args-id' }, EFFECTIVE)).toThrow(/diverg/i);
    delete process.env.MC_REVIEW_MODEL_ALLOW_DIVERGENT;
    const before2 = getDivergentReviewModelAudit().length;
    expect(
      resolveReviewModel({ model: 'args-model/args-id', allowDivergentModel: 'args-model/args-id' }, EFFECTIVE),
    ).toBe('args-model/args-id');
    expect(getDivergentReviewModelAudit().length).toBe(before2 + 1);
    delete process.env.MC_REVIEW_MODEL;
  });

  it('aceita ModelRef com variant e formata com #variant', () => {
    clearReviewEnv();
    const ref = { providerID: 'opencode-go', id: 'muse-spark-1.3-contributor', variant: 'v123' };
    expect(resolveReviewModel({}, ref)).toBe('opencode-go/muse-spark-1.3-contributor#v123');
    expect(resolveReviewModel({ model: ref })).toBe('opencode-go/muse-spark-1.3-contributor#v123');
  });

  it('argv inclui --model com o ref efetivo (+variant quando houver)', async () => {
    clearReviewEnv();
    const seen: string[][] = [];
    const origSpawn = Bun.spawn;
    const passJson = JSON.stringify([
      { id: 'REQ-inherit', demonstrated: true, missing: [], verdict: 'pass', reason: 'ok' },
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
      const ref = { providerID: 'opencode-go', id: 'muse-spark-1.3-contributor', variant: 'v123' };
      const results = await reviewFunctionallyViaOpenCode(
        { requirements: REQ },
        ref as any,
      );
      expect(results[0]!.verdict).toBe('pass');
      expect(seen).toHaveLength(1);
      const argv = seen[0]!;
      const idx = argv.indexOf('--model');
      expect(idx).toBeGreaterThan(-1);
      expect(argv[idx + 1]).toBe('opencode-go/muse-spark-1.3-contributor#v123');
    } finally {
      (Bun as any).spawn = origSpawn;
    }
  });

  it('argv inclui --model com string efetiva sem variant', async () => {
    clearReviewEnv();
    const seen: string[][] = [];
    const origSpawn = Bun.spawn;
    const passJson = JSON.stringify([
      { id: 'REQ-inherit', demonstrated: true, missing: [], verdict: 'pass', reason: 'ok' },
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
      const results = await reviewFunctionallyViaOpenCode({ requirements: REQ }, EFFECTIVE);
      expect(results[0]!.verdict).toBe('pass');
      const argv = seen[0]!;
      const idx = argv.indexOf('--model');
      expect(argv[idx + 1]).toBe(EFFECTIVE);
    } finally {
      (Bun as any).spawn = origSpawn;
    }
  });

  it('sem modelo em nenhum lugar → fail-closed unpinned sem invocar binário', async () => {
    clearReviewEnv();
    let calls = 0;
    const origSpawn = Bun.spawn;
    (Bun as any).spawn = (...a: unknown[]) => {
      calls++;
      return (origSpawn as any)(...(a as []));
    };
    try {
      const results = await reviewFunctionallyViaOpenCode({ requirements: REQ });
      expect(results).toHaveLength(1);
      expect(results[0]!.verdict).toBe('fail');
      expect(results[0]!.reason).toMatch(/review model unpinned/);
      expect(calls).toBe(0);
    } finally {
      (Bun as any).spawn = origSpawn;
    }
  });
});
