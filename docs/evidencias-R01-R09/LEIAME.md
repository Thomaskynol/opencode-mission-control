# Evidências das correções R01–R09 (2026-10-30)
- build.log: `bun run build` exit 0 (index.js 1.46 MB)
- full-test.log: `bun test` 1127 pass / 1 fail / 1128 (79 arquivos). Único fail: wire createPR, passa isolado 11/0 (isolamento pré-existente, falha igual com src pristino).
- Demo pública com injeção controlada: /tmp/opencode/demo-R/ (99 arquivos; fixture total.js errado + check verde irrelevante). Produto REJEITOU, pediu correção, reverificou; pausou em decisão humana legítima (touchSet) sem declarar Verified falso.
- Regressões TDD RED→GREEN: /tmp/opencode/r-verify/ (scripts ad-hoc) + tests/lib/gate-resume-approve.test.ts, gap1-integration-context.test.ts, acceptance-less-regression.test.ts.
- Revisão independente (cavecrew-reviewer): veredito aceitar, 0 achados após correções.
