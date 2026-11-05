import { describe, it, expect } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

/** TRIVIAL lane RED: `true`/no-op nunca é verificação funcional. */
describe('trivial no-op test command gate (RED)', () => {
  it('isTrivialTestCommand flags no-ops, never real commands', async () => {
    const { isTrivialTestCommand } = await import('../../src/lib/verification');
    // no-ops triviais
    expect(isTrivialTestCommand('true')).toBe(true);
    expect(isTrivialTestCommand(':')).toBe(true);
    expect(isTrivialTestCommand('exit 0')).toBe(true);
    expect(isTrivialTestCommand('/bin/true')).toBe(true);
    expect(isTrivialTestCommand('echo hi')).toBe(true);
    expect(isTrivialTestCommand('echo')).toBe(true);
    // comandos reais passam (nunca barrar substring)
    expect(isTrivialTestCommand('bun test')).toBe(false);
    expect(isTrivialTestCommand('node --test')).toBe(false);
    expect(isTrivialTestCommand('npm test')).toBe(false);
    expect(isTrivialTestCommand('npm run echo-test')).toBe(false);
    expect(isTrivialTestCommand('node check.mjs')).toBe(false);
    expect(isTrivialTestCommand('true && bun test')).toBe(false);
    expect(isTrivialTestCommand('echo hi && bun test')).toBe(false);
  });

  it('detectTestCommand returns null for trivial scripts.test=true', async () => {
    const { detectTestCommand } = await import('../../src/lib/merge-train');
    const dir = mkdtempSync(join(tmpdir(), 'mc-trivial-detect-'));
    try {
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'true' } }));
      expect(await detectTestCommand(dir)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('detectTestCommand keeps real commands', async () => {
    const { detectTestCommand } = await import('../../src/lib/merge-train');
    const dir = mkdtempSync(join(tmpdir(), 'mc-trivial-real-'));
    try {
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'bun test' } }));
      expect(await detectTestCommand(dir)).toBe('bun test');
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'node --test' } }));
      expect(await detectTestCommand(dir)).toBe('node --test');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('isTaskVerified recusa trivial mesmo com scope task', async () => {
    const { isTaskVerified } = await import('../../src/lib/verification');
    expect(isTaskVerified({ testStatus: 'passed', scope: 'task', testCommand: 'true', reviewedCommit: 'abc1234567890' } as never)).toBe(false);
    expect(isTaskVerified({ testStatus: 'passed', scope: 'task', testCommand: 'bun test', reviewedCommit: 'abc1234567890' } as never)).toBe(true);
  });

  it('docs-only sem testCommand segue task/passed/Verified', async () => {
    const { isTaskVerified } = await import('../../src/lib/verification');
    expect(isTaskVerified({ testStatus: 'passed', scope: 'task', reviewedCommit: 'abc1234567890' } as never)).toBe(true);
  });

  it('evidência integration/true existente segue Unverified', async () => {
    const { isTaskVerified } = await import('../../src/lib/verification');
    expect(isTaskVerified({ testStatus: 'passed', scope: 'integration', testCommand: 'true', reviewedCommit: 'abc1234567890' } as never)).toBe(false);
  });

  it('validateCeiling/resolveEffectiveTestCommand rejeitam trivial fail-closed', async () => {
    const { validateCeiling, resolveEffectiveTestCommand } = await import('../../src/lib/orchestrator');
    expect(() => validateCeiling({ testCommand: 'true' })).toThrow(/trivial|no-op/i);
    expect(() => validateCeiling({ testCommand: 'echo hi' })).toThrow(/trivial|no-op/i);
    expect(() => validateCeiling({ testCommand: ':' })).toThrow(/trivial|no-op/i);
    expect(() => resolveEffectiveTestCommand('true', undefined)).toThrow(/trivial|no-op/i);
    expect(() => resolveEffectiveTestCommand('/bin/true', undefined)).toThrow(/trivial|no-op/i);
    // reais passam
    expect(validateCeiling({ testCommand: 'bun test' }).testCommand).toBe('bun test');
    expect(validateCeiling({ testCommand: 'node --test' }).testCommand).toBe('node --test');
    expect(resolveEffectiveTestCommand('node --test', undefined)).toBe('node --test');
    expect(resolveEffectiveTestCommand('bun test', undefined)).toBe('bun test');
  });

  it('gate final fail-closed com repo só-`true` (segue caminho !verifyCommand)', async () => {
    const { detectTestCommand } = await import('../../src/lib/merge-train');
    const { isTrivialTestCommand } = await import('../../src/lib/verification');
    const dir = mkdtempSync(join(tmpdir(), 'mc-trivial-gate-'));
    try {
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'true' } }));
      const verifyConfigured = undefined;
      const verifyCommand = verifyConfigured ?? await detectTestCommand(dir);
      // detect retorna null para trivial → gate bloqueia (fail-closed, nunca success-skipped)
      expect(verifyCommand).toBeNull();
      const blocked = !verifyCommand || isTrivialTestCommand(verifyCommand);
      expect(blocked).toBe(true);
      // comando configurado trivial também bloqueia
      expect(isTrivialTestCommand('true')).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('render marca trivial como no-op e nunca Verified (integration segue p/ Gaps)', async () => {
    const { isTrivialTestCommand, isTaskVerified } = await import('../../src/lib/verification');
    const { buildFinalReportMarkdown } = await import('../../src/lib/reports');
    const cmd = 'true';
    expect(isTrivialTestCommand(cmd)).toBe(true);
    // Tests: trivial passed renderiza com marcador no-op
    const result = isTrivialTestCommand(cmd) ? 'passed (no-op, não é verificação funcional)' : 'passed';
    expect(result).toBe('passed (no-op, não é verificação funcional)');
    // Verified: trivial nunca verifica, mesmo com scope task
    expect(isTaskVerified({ testStatus: 'passed', scope: 'task', testCommand: cmd, reviewedCommit: 'abc123' } as never)).toBe(false);
    expect(isTaskVerified({ testStatus: 'passed', scope: 'integration', testCommand: cmd, reviewedCommit: 'abc123' } as never)).toBe(false);
    // Gaps/Unverified: entrada trivial renderiza sob Gaps, nunca Verified
    const md = buildFinalReportMarkdown({
      title: 'trivial-render',
      tasks: [{ name: 'j', status: 'merged' }],
      tests: [{ command: cmd, result, output: '' }],
      problems: [{ problem: `comando de teste trivial "${cmd}" em "j" (no-op, não é verificação funcional) — sem verificação funcional`, solution: 'configurar comando funcional e re-verificar' }],
      verified: [],
      unmet: [],
      unverified: [`j [merged] — comando de teste trivial "${cmd}" (no-op, não é verificação funcional), outcome not verified`],
    } as never);
    expect(md).toContain('no-op, não é verificação funcional');
    expect(md).toContain('## Gaps');
    expect(md).toMatch(/Nothing verified yet/);
  });
});

describe('TCMD compound proof gate (GREEN)', () => {
  async function makeDir(): Promise<string> {
    const { mkdtempSync } = await import('fs');
    const { tmpdir } = await import('os');
    const { join } = await import('path');
    return mkdtempSync(join(tmpdir(), 'mc-tcmd-proof-'));
  }

  it('split respeita single quotes (&& dentro de quotes não separa)', async () => {
    const { splitTestCommandSegments } = await import('../../src/lib/verification');
    expect(splitTestCommandSegments(`echo 'a && b' && bun test`)).toEqual([`echo 'a && b'`, 'bun test']);
    expect(splitTestCommandSegments(`true && node --test`)).toEqual(['true', 'node --test']);
    expect(splitTestCommandSegments(`node --test || true`)).toEqual(['node --test', 'true']);
    expect(splitTestCommandSegments(`bun test; echo done`)).toEqual(['bun test', 'echo done']);
  });

  it('true sozinho nunca é prova (fail-closed mesmo com exit 0)', async () => {
    const { runTestCommand } = await import('../../src/lib/merge-train');
    const dir = await makeDir();
    try {
      const r = await runTestCommand(dir, 'true', 10000);
      expect(r.success).toBe(false);
      expect(r.output).toMatch(/trivial|no-op|nunca.*prova/i);
    } finally {
      const { rmSync } = await import('fs');
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('echo hi nunca é prova', async () => {
    const { runTestCommand } = await import('../../src/lib/merge-train');
    const dir = await makeDir();
    try {
      const r = await runTestCommand(dir, 'echo hi', 10000);
      expect(r.success).toBe(false);
      expect(r.output).toMatch(/trivial|no-op|nunca.*prova/i);
    } finally {
      const { rmSync } = await import('fs');
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('true && true (só trivial) nunca é prova', async () => {
    const { runTestCommand, detectTestCommand } = await import('../../src/lib/merge-train');
    const dir = await makeDir();
    try {
      const { writeFileSync } = await import('fs');
      const { join } = await import('path');
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'true && true' } }));
      expect(await detectTestCommand(dir)).toBeNull();
      const r = await runTestCommand(dir, 'true && true', 10000);
      expect(r.success).toBe(false);
    } finally {
      const { rmSync } = await import('fs');
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('true && node --test (pass real) é prova via segmento real', async () => {
    const { runTestCommand } = await import('../../src/lib/merge-train');
    const dir = await makeDir();
    try {
      const { writeFileSync } = await import('fs');
      const { join } = await import('path');
      // Fixture sem import de runner (convenção: só bun:test/vitest nos .test.ts):
      // node --test conta o arquivo como teste (pass 1) via exit code.
      writeFileSync(join(dir, 'ok.cjs'), 'process.exit(0);\n');
      const r = await runTestCommand(dir, 'true && node --test ok.cjs', 30000);
      expect(r.success).toBe(true);
      expect(r.output).toMatch(/prova via/i);
      expect(r.output).toContain('node --test ok.cjs');
    } finally {
      const { rmSync } = await import('fs');
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('node --test (fail) || true mascara falha → deve FAIL', async () => {
    const { runTestCommand } = await import('../../src/lib/merge-train');
    const dir = await makeDir();
    try {
      const { writeFileSync } = await import('fs');
      const { join } = await import('path');
      writeFileSync(join(dir, 'bad.cjs'), 'process.exit(1);\n');
      const r = await runTestCommand(dir, 'node --test bad.cjs || true', 30000);
      // shell puro daria exit 0; gate não pode aceitar máscara
      expect(r.success).toBe(false);
      expect(r.output).toMatch(/máscara|mask|falha real|real.*falh/i);
    } finally {
      const { rmSync } = await import('fs');
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('comando real sem contagem declara evidência parcial (sem inventar cobertura)', async () => {
    const { runTestCommand } = await import('../../src/lib/merge-train');
    const dir = await makeDir();
    try {
      const r = await runTestCommand(dir, 'test -f package.json && test -d .', 10000);
      // sem runner conhecido: exit 0 mas sem quantificação → parcial, ainda prova via execução real
      // aqui o dir não tem package.json → falha real → FAIL (não inventa pass)
      expect(r.success).toBe(false);
      const { writeFileSync } = await import('fs');
      const { join } = await import('path');
      writeFileSync(join(dir, 'package.json'), '{}');
      const r2 = await runTestCommand(dir, 'test -f package.json', 10000);
      expect(r2.success).toBe(true);
      expect(r2.output).toMatch(/parcial|não quantificad/i);
    } finally {
      const { rmSync } = await import('fs');
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
