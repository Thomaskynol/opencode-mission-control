# Static fixes — decisions and evidence

Scope: static-fixes lane (no lane isolation changes, no pushes). Each item
below states the decision, the code/tests that pin it, and what was
deliberately left alone.

## 1. Runner: `bun test` (vitest imports keep running)

Adopted runner is `bun test` (see `package.json` → `test`). Discovery
proof on this branch: full suite runs **59 files / 938 tests**
(`bun test` exit 1 only for the known `launch` flake, isolated — same
single failure with `tests/tools/launch.test.ts` alone vs. combined with
`tests/lib/model-tracker.test.ts`, order-dependent module state).

- 39 test files import from `vitest`, 20 from `bun:test` — **both execute**
  under `bun test` (runner-scoped `vitest` compat; plain
  `bun -e "import 'vitest'"` fails, so the mapping belongs to the runner,
  not the runtime).
- Mixed imports stay **only** with that proof. Canonical import for new
  tests is `bun:test`; file naming stays `*.test.ts`. Current totals
  after this lane: **60 files / 949 tests — 932 pass, 16 skip, 1 fail**
  (the single failure is the known `launch` flake below).
- Pinned by `tests/conventions.test.ts`: every file under `tests/` must
  keep `*.test.ts` naming and must not import another runner
  (`node:test`, `jest`, `@jest/globals`).

## 2. `mc_report_final` registered once, command-center only

Audited `src/index.ts`, `src/commands.ts`, tool map, manifest:

- Exactly one `tool()` definition (`src/tools/report.ts`) and exactly one
  registration (command-center `tool` map in `src/index.ts`).
- Job agents expose only `mc_report` + `mc_status` (they report; the final
  report assembles plan state, which only the command center holds).
- No plugin manifest file in the repo (tools come from the plugin return);
  no `mc-report-final` command wrapper exists or is needed (operator-facing
  commands are shortcuts; the final report is agent-assembled).
- Pinned by `tests/plugin-init.test.ts`: 21 command-center tools with
  `mc_report_final` exactly once and distinct from `mc_report`; job-agent
  map has no `mc_report_final`.

## 3. `verified` (evidence) vs `integrated` (merge) — no inflation

`classifyOutcome` (`src/lib/coordinator.ts`) already separates
`verified` (tests passed) from `integrated` (merged). The final report
now matches that matrix:

- `mc_report_final` claims **nothing** under `## Verified` without
  recorded test evidence (none is persisted per job at report time).
  Merged jobs are listed under `## Integration` (`Merged: <name>`).
  Summary line reads `Integrated / Unmet / Unverified`.
- Fail-closed rules kept: `completed`-without-merge lands under Gaps as
  "outcome not verified" (a worker claim is not evidence); unknown work
  never appears under Verified.
- `buildFinalReportMarkdown` keeps its generic `verified` input for
  future evidence wiring — the builder is unchanged, only the caller
  stopped inflating merges into it.
- Pinned by `tests/tools/report-final.test.ts` (merged under
  Integration, not Verified; completed-without-merge still unverified)
  and unchanged `tests/lib/wire-report.test.ts` builder cases.

## 4. No "pass" without observed execution

`reviewJob` (`src/lib/reviewer.ts`) fails closed on every missing piece
of observable execution: empty command (not repeatable), empty output
(not observable), blank/mismatched `testedCommit` (unknown or stale code
under test), non-zero exit, missing requirement anchors in the output
(a filename in the diff is not coverage). `claimedPass: true` without
passing evidence adds an explicit "optimistic report" reason and still
fails. Pinned by `tests/lib/reviewer.test.ts` ("never passes on a
'pass' claim without observed execution", missing command/output,
stale commit, anchor coverage).

## 5. Parallel cap 4–8: defaults, not mandates

`clampMaxParallel(raw?, bounds?)` (`src/lib/coordinator.ts`):

- Default window 4–8 with fallback 4 (`MIN_PARALLEL`/`MAX_PARALLEL`
  exported); `undefined`/non-finite → fallback; fractions floored.
- Neither bound is hard-coded at call sites: pass
  `{ min, max, defaultValue? }` for a different window (e.g. `{ min: 1,
  max: 16 }` for debugging/big machines). Callers keep default bounds,
  so effective behavior is unchanged.
- Note: repo default `maxParallel: 3` (`src/lib/config.ts`) clamps to
  the 4 floor inside `decideNextJobs`; set an explicit config value or
  custom bounds to run another window.
- Pinned by `tests/lib/coordinator.test.ts` (`clampMaxParallel`
  default + custom-window cases).

## 6. Throwing transitions, legacy senders, quoted paths

- `updateJob` throws on invalid transitions (fail-closed); `updatePlanJob`
  still warns-and-applies **by design**: recovery paths legitimately force
  terminal states from any state (e.g. `launchJob` catch marks
  queued/waiting_deps jobs `failed`). Unifying to throw would break the
  launch-failure path — asymmetry documented here instead of "fixed".
- Audited real `updateJob` callers (`orchestrator` cancel/resume use
  `running`-only jobs — valid; `merge-train` uses no `updateJob`;
  `integration`/`answer`/`overview` don't write job status):
  - `mc_kill` on `merged`/`canceled` jobs had no valid transition to
    `stopped` → now returns "already <status>" without touching tmux
    (pinned by `tests/tools/kill.test.ts`).
  - `JobMonitor.handleSSEEvent` terminal events (`session.status` idle,
    `session.idle`, `session.error`) re-read the job first; events for
    non-`running` jobs (killed/cleaned-up while SSE was open) are dropped
    after cleanup instead of throwing inside the `for await` loop (which
    turned into a reconnect storm). Fail-open only when the fresh read
    itself errors — then `updateJob` still validates
    (pinned by `tests/lib/monitor.test.ts`).
- `projectID` create-vs-assert (`src/lib/instance-manager.ts`):
  `session.create` has no `projectID` field (server derives it), so a
  profile pin cannot mount verbatim — `launch()` pauses with a drift
  question instead of continuing degraded. Safe direction; no code
  change, document-not-relax.
- `remoteSessionID`: merge-train fix-before-rollback and plan fork target
  the remote worker session with loud skip-and-rollback when unreachable
  (no prompt ever goes to the operator's `launchSessionID`); `mc_answer`
  travels over the v2 client. Legacy non-`/api` senders remain in
  `question-relay.ts`, `job-comms.ts`, `monitor.ts` (SSE subscribe),
  `orchestrator-cli/index.ts` (answer path) — follow-up, out of scope.
- `git` paths with spaces/quotes + publish flags (`assertNoPush`):
  pattern now accepts quoted `-C` values (`git -C "my dir" push`,
  single- or double-quoted) and package-manager flags on either side of
  `publish` (`npm --prefix <dir> publish`, `pnpm --filter <sel>
  publish`, trailing `--tag/--dry-run` as before). Still no false
  positives (`npm run publish`, `git commit -m "push origin"` pass
  through). `git -c`/`--git-dir=` scoped flags remain unparsed (rare;
  revisit if a caller uses them). Raw-space argv paths (`['git', '-C',
  'my dir', 'push']`) execute shell-free via `gitCommand` argv arrays —
  safe by construction, not a guard hole.
  Pinned by `tests/lib/coordinator.test.ts` (`assertNoPush` quoted-path
  and publish-flag cases).

## 7. Verification

- `bun run build`: exit 0.
- `bun test`: green except the known `launch` flake (isolated, see §1).

## 8. Serve-mode V2 migration (live-gaps lane)

Root cause of the three live gaps: the legacy unprefixed SDK
(`OpencodeClient`: `/session`, `/global/event`) is not served by
2.1.4 — `session.create` answered `{}` ("Failed to create session:
{}"), and the legacy `/permission/:id/reply` answers 405. The 2.1.4
surface is `/api`-prefixed and was verified live against disposable
serve instances (real `muse-spark-1.3-contributor` workers): session
create/get/prompt/generate/interrupt(+`?resume=true`)/background/
`experimental/wait`/log/message/fork/move/compact, `form.created` →
list → reply 204 → agent resumes to `succeeded`, session-scoped
permission reply (`once`/`always`/`reject`), native event stream
(`session.execution.*`, `form.*`, `permission.*`).

- `src/lib/sdk-client.ts` (additive only): `v2WaitForServer` (polls
  `GET /api/info` — server-scoped, unlike `/api/session` which lists
  every project's sessions), `v2ListForms`/`v2GetForm`/`v2CreateForm`/
  `v2ReplyForm`, `v2ListPermissions`/`v2ReplyPermission`
  (session-scoped), `quoteShellPath` (single-quote escaping for
  `bash '...'` launcher lines). Legacy exports kept untouched.
- Senders migrated to V2, always targeting `remoteSessionID` (never
  the operator's `launchSessionID`): `mc_launch` serve path
  (create with pinned model triple + `location.directory`, then
  prompt), `JobComms.deliverMessages`, orchestrator `addJob` fork
  (`v2ForkSession` + follow-up prompt), `QuestionRelay`
  (auto-approve → single-use `once`; escalation keeps the worker
  unblocked via the auto-response timeout instead of POSTing to the
  operator session on the worker port — that POST always missed and
  operator delivery stays with the notifications hook), monitor SSE
  (native `/api/event` stream filtered per session +
  `v2ListForms` backfill; terminal `session.execution.succeeded/failed`
  reuse the stale-event guard; `form.created` registers + persists the
  question, `form.replied/cancelled` drops it).
- `answerQuestion` (`forms.ts`): tries the form reply first (label/
  value/position → field key), falls back to the text-prompt sender
  only when the form is gone. Legacy `partId`s never touch the
  network, so existing unit tests stay hermetic.
- `JobSpecSchema` now parses `remoteSessionID` (it was already in
  the interface but zod stripped it on every load — fork and
  fix-before-rollback lost the worker session after a coordinator
  restart).
- Sidecar question helpers moved to `durable-state.ts` (`forms.ts`
  re-exports; `monitor.ts` imports lib-to-lib). Partial `job-state`
  mocks (`monitor.test.ts`, `z-workflows.test.ts`) completed with
  the missing migration exports — the real module surface, not new
  behavior.
- Pinned by: `sdk-client-v2.test.ts` (info-poll auth, form reply
  body, permission reply route/decisions, quoting),
  `human-controls.test.ts` (form-first answer, no prompt fallback),
  `monitor-v2.test.ts` (event scoping, terminal events, form
  lifecycle incl. durable sidecar, permission-asked without worker
  session), `plan-state.test.ts` (remoteSessionID round-trip),
  `prompt-file.test.ts` (spaces/quotes), updated `launch`/`job-comms`/
  `orchestrator` serve-path tests.
- Deliberately unchanged: `coordinator-client.ts` (read-only over
  memory + sidecar — correct once the monitor persists),
  `instance-manager.ts` / `job-pause.ts` / `job-resume.ts` (already
  V2; the gap was the broken launch beneath them, now fixed).
  Lane note: this lane touched `sdk-client.ts` and `durable-state.ts`
  outside the m6-human writer scope, under explicit live-gaps
  authorization — recorded here instead of rewriting lane scopes.
- Ask-user permission escalation has no operator push: it stays
  visible in the serve TUI / policy log with the timeout keeping
  the worker unblocked. Pending forms are the operator-visible
  question queue (`questions` command).

## 9. Verification (live-gaps)

- `bun run build`: exit 0.
- `bun test`: **953 pass, 16 skip, 0 fail** across 62 files
  (the previously known `launch` flake did not reproduce in the
  final run; `z-workflows` 24/24 in its isolated subprocess).
- Live: `bun /tmp/opencode/live-gaps/run.ts` → `ALL LIVE GAPS OK`
  (exit 0), serve `opencode v2.1.4` on disposable port 14492 + dir
  `/tmp/opencode/live-gaps-app`, workers
  `opencode-go/muse-spark-1.3-contributor`. Evidences under
  `/tmp/opencode/live-gaps/evidence/` (see `docs/live-proof.md`
  adendo). Teardown: serve processes killed, disposable
  `live-gaps/state|reports` removed, repo/global state untouched.
