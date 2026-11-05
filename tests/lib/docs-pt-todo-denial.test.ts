import { describe, it, expect } from 'bun:test';
/**
 * OBJETIVOS 1c — desambiguação PT sem enfraquecer EN.
 *
 * Causa: GLOBAL_PLACEHOLDER_RE `\btodo\b` casava PT "todo artefato";
 * DENIAL `\bsem\b`/`\bno\b` casava PT "sem espaços"/"no lugar de".
 * Fix: `todo` minúsculo só com marcador explícito (`TODO:`, `[TODO]`,
 * linha só-`todo`) ou em maiúsculas (`TODO`); `sem` só com substantivo
 * meta (cobertura, documentação, ...); `no` só em moldura EN
 * ("There is no X", "has no X", `No X` inicial) regendo o critério.
 */
import { assessDocsCoverage } from '../../src/lib/docs-review';

const INSTALL_REQ = {
  id: 'readme-req-1',
  description: 'README documents installation (`bun install`) and how to run checks (`bun test`)',
};

const GOOD_README = `# MyApp

Installation: run \`bun install\` to fetch dependencies.

Checks: run \`bun test\` to execute the suite.
`;

const GLOSS_REQ = {
  id: 'g',
  description: 'Glossary documents artifact names with code `artifact-id` and spacing rules',
};

describe('PT disambiguation: todo/sem/no no longer false-positive', () => {
  it('brief PT "todo artefato" passa (quantificador, não placeholder)', () => {
    const doc = `${GOOD_README}\nEste README cobre todo artefato instalado (installation): abra o terminal, execute \`bun install\` e depois verifique com \`bun test\` seguindo os checks abaixo.\n`;
    const r = assessDocsCoverage(INSTALL_REQ, { 'README.md': doc });
    expect(r.covered).toBe(true);
    expect(r.status).toBe('covered');
  });

  it('glossário PT "sem espaços" / "no lugar de" passa (descrição, não denial)', () => {
    const doc = `# Glossary

This glossary documents artifact names with code \`artifact-id\` and spacing rules for todo artefato catalogado aqui.

Spacing rules: names em letras minusculas sem espacos.

Hyphen no lugar de espacos para spacing correto.

Para aplicar, abra o editor, digite o names e salve o arquivo com \`artifact-id\` seguindo o padrao de spacing rules.
`;
    const r = assessDocsCoverage(GLOSS_REQ, { 'docs/glossary.md': doc });
    expect(r.covered).toBe(true);
    expect(r.status).toBe('covered');
  });

  it('PT "Todo" capitalizado no início de frase não é placeholder', () => {
    const doc = `${GOOD_README}\nTodo artefato listado neste README (installation) passa pelos checks: abra o terminal, execute \`bun install\` e verifique com \`bun test\`.\n`;
    const r = assessDocsCoverage(INSTALL_REQ, { 'README.md': doc });
    expect(r.covered).toBe(true);
  });
});

describe('EN negatives still rejected (no weakening)', () => {
  it('`TODO:` maiúsculo continua placeholder', () => {
    const r = assessDocsCoverage(INSTALL_REQ, {
      'README.md': `${GOOD_README}\nTODO: preencher o restante do guia.\n`,
    });
    expect(r.covered).toBe(false);
    expect(r.reason).toMatch(/placeholder|disclaim/i);
  });

  it('`[TODO]` continua placeholder', () => {
    const r = assessDocsCoverage(INSTALL_REQ, {
      'README.md': `${GOOD_README}\n[TODO] finish the guide.\n`,
    });
    expect(r.covered).toBe(false);
    expect(r.reason).toMatch(/placeholder|disclaim/i);
  });

  it('`todo:` minúsculo com marcador continua placeholder', () => {
    const r = assessDocsCoverage(INSTALL_REQ, {
      'README.md': `${GOOD_README}\ntodo: finish installation steps.\n`,
    });
    expect(r.covered).toBe(false);
    expect(r.reason).toMatch(/placeholder|disclaim/i);
  });

  it('linha só-`todo` continua placeholder', () => {
    const r = assessDocsCoverage(INSTALL_REQ, { 'README.md': `${GOOD_README}\ntodo\n` });
    expect(r.covered).toBe(false);
    expect(r.reason).toMatch(/placeholder|disclaim/i);
  });

  it('disclaimer real EN continua rejeitado', () => {
    const r = assessDocsCoverage(INSTALL_REQ, {
      'README.md': `${GOOD_README}\nNo instructions provided here.\n`,
    });
    expect(r.covered).toBe(false);
    expect(r.reason).toMatch(/disclaim|placeholder/i);
  });

  it('denial real EN "There is no <critério>" continua not-covered', () => {
    const r = assessDocsCoverage(
      { id: 'r', description: 'README documents the rollback procedure for failed deploys' },
      {
        'README.md':
          '# Guide\n\nThere is no rollback procedure documented here. See the runbook.\n\nRun `bun install` and follow the extra steps carefully with the tool.\n',
      },
    );
    expect(r.covered).toBe(false);
    expect(r.status).toBe('not-covered');
    expect(r.reason).toMatch(/deny|contradict/i);
  });

  it('denial real PT "sem cobertura de <critério>" continua not-covered', () => {
    const r = assessDocsCoverage(
      { id: 'r', description: 'README documents the rollback procedure for failed deploys' },
      {
        'README.md': '# Guia\n\nEste guia esta sem cobertura de rollback.\n\nMais detalhes sobre rollback procedure for failed deploys.\n',
      },
    );
    expect(r.covered).toBe(false);
    expect(r.status).toBe('not-covered');
    expect(r.reason).toMatch(/deny|contradict/i);
  });

  it('negação verbal PT "não explica <critério>" continua rejeitada', () => {
    const r = assessDocsCoverage(
      { id: 'p1', description: 'Explique o procedimento de backup' },
      { 'docs/guia.md': '# Procedimento de backup\nEste manual não explica o procedimento de backup. Consulte a equipe para definir os próximos passos e abra o chamado com detalhes.' },
    );
    expect(r.covered).toBe(false);
    expect(r.status).not.toBe('covered');
  });
});
