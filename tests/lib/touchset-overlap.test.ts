// Lane CD — achado C (RED): overlap de touchSet por valor real caminho/padrão,
// nunca por string exata nem sufixo. Referência canônica: matchesTouchPattern
// (merge-train). Estes testes FALHAM no HEAD (sonda /tmp/opencode/sonda-cd.ts).
import { describe, it, expect } from 'bun:test';
import {
  assertPlanCoherence,
  touchSetCovers,
  runAutoIntake,
  type AutoPlanDraft,
} from '../../src/lib/auto-plan';
import { matchesTouchPattern, touchPatternsOverlap } from '../../src/lib/merge-train';

function planOf(entries: Array<{ name: string; touchSet: string[]; dependsOn?: string[] }>): AutoPlanDraft {
  return {
    requirements: [{ id: 'r1', text: 'overlap guard', acceptance: ['done'] }],
    tasks: entries.map((e) => ({
      name: e.name,
      prompt: `Do ${e.name}`,
      touchSet: e.touchSet,
      ...(e.dependsOn ? { dependsOn: e.dependsOn } : {}),
      acceptance: [`${e.name} works`],
    })),
    decisions: [],
    questions: [],
    nextSteps: [],
  };
}

describe('C — overlap canônico caminho/padrão (RED no HEAD)', () => {
  it('C1: glob × arquivo concreto sem dependsOn é bloqueado (src/** × src/total.js)', () => {
    expect(matchesTouchPattern('src/**', 'src/total.js')).toBe(true); // referência merge-train
    expect(() =>
      assertPlanCoherence(planOf([
        { name: 'task-a', touchSet: ['src/**'] },
        { name: 'task-b', touchSet: ['src/total.js'] },
      ])),
    ).toThrow(/overlap|no dependsOn ordering/i);
  });

  it('dir × file sem dependsOn é bloqueado (src/ × src/total.js)', () => {
    expect(() =>
      assertPlanCoherence(planOf([
        { name: 'task-a', touchSet: ['src/'] },
        { name: 'task-b', touchSet: ['src/total.js'] },
      ])),
    ).toThrow(/overlap|no dependsOn ordering/i);
  });

  it('glob × glob sobreposto é bloqueado (src/** × src/**/*.js)', () => {
    expect(touchPatternsOverlap('src/**', 'src/**/*.js')).toBe(true);
    expect(() =>
      assertPlanCoherence(planOf([
        { name: 'task-a', touchSet: ['src/**'] },
        { name: 'task-b', touchSet: ['src/**/*.js'] },
      ])),
    ).toThrow(/overlap|no dependsOn ordering/i);
  });

  it('C2: mesmo basename em diretórios distintos NÃO cobre (sufixo não é igualdade)', () => {
    expect(matchesTouchPattern('src/total.js', 'other/src/total.js')).toBe(false); // referência
    expect(touchSetCovers(['src/total.js'], 'other/src/total.js')).toBe(false);
    expect(touchPatternsOverlap('src/total.js', 'other/src/total.js')).toBe(false);
    expect(() =>
      assertPlanCoherence(planOf([
        { name: 'task-a', touchSet: ['src/total.js'] },
        { name: 'task-b', touchSet: ['other/src/total.js'] },
      ])),
    ).not.toThrow();
  });

  it('globs disjuntos no mesmo pai não colidem (src/*.js × src/*.ts)', () => {
    expect(touchPatternsOverlap('src/*.js', 'src/*.ts')).toBe(false);
    expect(() =>
      assertPlanCoherence(planOf([
        { name: 'task-a', touchSet: ['src/*.js'] },
        { name: 'task-b', touchSet: ['src/*.ts'] },
      ])),
    ).not.toThrow();
  });

  it('overlap real com handoff transitivo é aceito (a→b→c serializa a×c)', () => {
    expect(() =>
      assertPlanCoherence(planOf([
        { name: 'task-a', touchSet: ['src/total.js'] },
        { name: 'task-b', touchSet: ['src/total.js'], dependsOn: ['task-a'] },
        { name: 'task-c', touchSet: ['src/**'], dependsOn: ['task-b'] },
      ])),
    ).not.toThrow();
  });

  it('overlap real com cadeia quebrada continua bloqueado', () => {
    expect(() =>
      assertPlanCoherence(planOf([
        { name: 'task-a', touchSet: ['src/total.js'] },
        { name: 'task-b', touchSet: ['src/total.js'], dependsOn: ['task-a'] },
        { name: 'task-c', touchSet: ['src/**'] },
      ])),
    ).toThrow(/task-c/);
  });

  it('planejamento real (runAutoIntake) rejeita plano com overlap glob×arquivo', async () => {
    const overlapping = planOf([
      { name: 'task-a', touchSet: ['src/**'] },
      { name: 'task-b', touchSet: ['src/total.js'] },
    ]);
    await expect(
      runAutoIntake({ request: 'do overlap work' }, async () => JSON.stringify(overlapping)),
    ).rejects.toThrow(/overlap|no dependsOn ordering/i);
  });
});

describe('C — acordo planning/dispatch/integration em padrões "./"-prefixados', () => {
  it('./src/** cobre src/total.js em todos os níveis (matcher, covers, overlap)', () => {
    // planning (touchSetCovers) e overlap já normalizam "./"; o matcher
    // canônico precisa concordar ou validateTouchSet/reviewer divergem.
    expect(touchSetCovers(['./src/**'], 'src/total.js')).toBe(true);
    expect(touchPatternsOverlap('./src/**', 'src/total.js')).toBe(true);
    expect(matchesTouchPattern('./src/**', 'src/total.js')).toBe(true);
  });

  it('./src/total.js casa src/total.js no matcher canônico', () => {
    expect(matchesTouchPattern('./src/total.js', 'src/total.js')).toBe(true);
  });
});
