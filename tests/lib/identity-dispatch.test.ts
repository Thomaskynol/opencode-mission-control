import { describe, it, expect } from 'bun:test';
import {
  isAllowedTestArtifact,
  parsePorcelainDirtyPaths,
  filterRelevantDirtyPaths,
  hasRelevantContentChange,
  parsePorcelainEntries,
  filterRelevantDirtyEntries,
} from '../../src/lib/orchestrator';

describe('identity artifacts (sondas 8/9/10, revisão 9f47d5f §6)', () => {
  it('dist/build versionados são relevantes (não ignore global)', () => {
    expect(isAllowedTestArtifact('dist/total.mjs')).toBe(false);
    expect(isAllowedTestArtifact('build/out.js')).toBe(false);
    expect(isAllowedTestArtifact('coverage/lcov.info')).toBe(true);
    expect(isAllowedTestArtifact('tmp/x.log')).toBe(true);
  });

  it('parse preserva status para distinguir untracked de staged', () => {
    const entries = parsePorcelainEntries('?? dist/gen.js\nM  dist/total.mjs\n M src/a.ts');
    expect(entries).toContainEqual({ status: '??', path: 'dist/gen.js' });
    expect(entries).toContainEqual({ status: 'M', path: 'dist/total.mjs' });
    expect(entries).toContainEqual({ status: 'M', path: 'src/a.ts' });
  });

  it('untracked dist (saída gerada, não versionada) continua permitido; staged dist bloqueia', () => {
    const entries = parsePorcelainEntries('?? dist/gen.js\nM  dist/total.mjs\n?? coverage/lcov.info\n M src/a.ts');
    const relevant = filterRelevantDirtyEntries(entries);
    expect(relevant).not.toContain('dist/gen.js');
    expect(relevant).not.toContain('coverage/lcov.info');
    expect(relevant).toContain('dist/total.mjs');
    expect(relevant).toContain('src/a.ts');
  });

  it('filter legado mantém compat: dist versionado é relevante', () => {
    const paths = parsePorcelainDirtyPaths('M  dist/total.mjs\n M src/a.ts');
    const relevant = filterRelevantDirtyPaths(paths);
    expect(relevant).toContain('dist/total.mjs');
    expect(relevant).toContain('src/a.ts');
  });

  it('mutação persistente em dist versionado é detectada via conteúdo', () => {
    const before = { 'dist/total.mjs': 'export function total(){return 0;}\n' };
    const after = { 'dist/total.mjs': 'export function total(){return 3;}\n' };
    expect(hasRelevantContentChange(before, after)).toBe(true);
  });

  it('saída gerada não versionada fora do escopo não bloqueia conteúdo', () => {
    const before = { 'src/a.ts': 'a' };
    const after = { 'src/a.ts': 'a', 'coverage/lcov.info': 'cov' };
    // coverage é artefato permitido: mudança só nele não é mutação relevante
    expect(hasRelevantContentChange(before, after)).toBe(false);
  });
});
