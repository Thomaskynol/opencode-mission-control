import { describe, it, expect, beforeEach, afterEach, spyOn, mock } from 'bun:test';
import { join } from 'path';
import { tmpdir } from 'os';
import * as paths from '../../src/lib/paths';

/**
 * OBJETIVO 1 (M9): `reviewAttempts` volátil por processo — cada
 * `approve --retry` gera conductor one-shot novo, `prev.attempts` sempre 0,
 * rótulo sempre "attempt 1/2", budget 2 inalcançável (7× attempt 1/2, nenhum
 * 2/2). Causa geral: attempts+lastSignature devem persistir no estado do
 * plano (via plan-state), de modo que retry preserve e o budget esgote
 * corretamente; escalada on_error+pausa permanece.
 *
 * RED-first: duas rodadas de review com mesmo signature através de restart
 * simulado (estado relido do disco, sem Map em memória) devem progredir
 * 1/2 → 2/2 → escalada (budget esgotado).
 */
describe('review attempts persistentes (M9 budget 2)', () => {
  let testStateDir = '';

  beforeEach(async () => {
    const fs = await import('fs');
    const base = await fs.promises.mkdtemp(join(tmpdir(), 'mc-review-attempts-'));
    testStateDir = join(base, 'state');
    fs.mkdirSync(testStateDir, { recursive: true });
    spyOn(paths, 'getDataDir').mockResolvedValue(testStateDir);
  });

  afterEach(() => {
    mock.restore();
  });

  it('persiste attempts+lastSignature no disco (restart simulado enxerga)', async () => {
    const { saveReviewAttempt, loadReviewAttempt } = await import('../../src/lib/plan-state');
    const found = await loadReviewAttempt('plan-m9', 'job-a', undefined);
    expect(found).toBeNull();

    await saveReviewAttempt('plan-m9', 'job-a', { attempts: 1, lastSignature: 'SIG-FALHA' }, undefined);

    // Prova de disco: bytes no state dir, sem depender de memória do processo.
    const fs = await import('fs');
    const raw = JSON.parse(fs.readFileSync(join(testStateDir, 'review-attempts.json'), 'utf8'));
    expect(raw['plan-m9']?.['job-a']).toMatchObject({ attempts: 1, lastSignature: 'SIG-FALHA' });

    // Restart simulado: releitura fria do disco.
    const reloaded = await loadReviewAttempt('plan-m9', 'job-a', undefined);
    expect(reloaded).toMatchObject({ attempts: 1, lastSignature: 'SIG-FALHA' });
  });

  it('mesmo signature em duas rodadas progride 1/2 → 2/2 → escalada', async () => {
    const { saveReviewAttempt, loadReviewAttempt } = await import('../../src/lib/plan-state');
    const { decideReviewAutoFix } = await import('../../src/lib/orchestrator');
    const SIG = 'coverage fail: requirement R1 not exercised';
    const opts = { reserved: false, canRelaunch: true, maxAutoFix: 2 };

    // Rodada 1 (processo A): sem histórico → despacha attempt 1/2.
    const prev1 = (await loadReviewAttempt('plan-m9', 'job-b', undefined)) ?? { attempts: 0, lastSignature: '' };
    const d1 = decideReviewAutoFix(prev1, SIG, opts);
    expect(d1.dispatch).toBe(true);
    expect(d1.nextAttempts).toBe(1);
    await saveReviewAttempt('plan-m9', 'job-b', { attempts: d1.nextAttempts, lastSignature: SIG }, undefined);

    // Restart simulado (processo B, one-shot novo): mesmo signature ainda
    // despacha — attempt 2/2 — em vez de reetiquetar 1/2 ou escalar cedo.
    const prev2 = (await loadReviewAttempt('plan-m9', 'job-b', undefined)) ?? { attempts: 0, lastSignature: '' };
    expect(prev2.attempts).toBe(1);
    const d2 = decideReviewAutoFix(prev2, SIG, opts);
    expect(d2.dispatch).toBe(true);
    expect(d2.nextAttempts).toBe(2);
    await saveReviewAttempt('plan-m9', 'job-b', { attempts: d2.nextAttempts, lastSignature: SIG }, undefined);

    // Restart simulado (processo C): budget esgotado → sem dispatch, escala.
    const prev3 = (await loadReviewAttempt('plan-m9', 'job-b', undefined)) ?? { attempts: 0, lastSignature: '' };
    expect(prev3.attempts).toBe(2);
    const d3 = decideReviewAutoFix(prev3, SIG, opts);
    expect(d3.dispatch).toBe(false);
    expect(d3.escalateReason).toBe('budget-exhausted');
  });

  it('pass limpa o contador persistido', async () => {
    const { saveReviewAttempt, loadReviewAttempt, clearReviewAttempt } = await import('../../src/lib/plan-state');
    await saveReviewAttempt('plan-m9', 'job-c', { attempts: 2, lastSignature: 'SIG' }, undefined);
    await clearReviewAttempt('plan-m9', 'job-c', undefined);
    expect(await loadReviewAttempt('plan-m9', 'job-c', undefined)).toBeNull();
  });

  it('estado ausente ou corrompido degrada para nulo sem throw', async () => {
    const { loadReviewAttempt } = await import('../../src/lib/plan-state');
    expect(await loadReviewAttempt('plan-m9', 'job-inexistente', undefined)).toBeNull();
    const fs = await import('fs');
    fs.writeFileSync(join(testStateDir, 'review-attempts.json'), '{corrompido!!!');
    expect(await loadReviewAttempt('plan-m9', 'job-qualquer', undefined)).toBeNull();
  });
});
