# Guards proof — updatePlanJob, PUSH_PATTERN, ask-user + first use

Scope: `guards-docs` on `feat/autonomous-orchestrator-v2`. No push, disposable
destinations only (`/tmp/opencode/*`, temp git repos). Full suite green.

## 1. updatePlanJob warn-and-apply → fail-closed

Before: invalid `status` warned and still wrote `plan.json`, so
`queued → merged` could skip the reviewer gate + merge train, and
`merged → canceled` could un-merge.

Fix: `updatePlanJob(planId, name, updates, opts?: { force?: boolean })`
(`src/lib/plan-state.ts`) throws on invalid transitions without applying.
Only the launch-failure recovery (`queued/waiting_deps → failed` in
`orchestrator.launchJob` catch) passes `{ force: true }` explicitly.

Regression (`tests/lib/plan-state.test.ts`):

- `queued → merged` throws `/Invalid job transition/`, state stays `queued`.
- `merged → canceled` throws, state stays `merged`.
- `queued → failed` with `{ force: true }` applies (recovery).

## 2. PUSH_PATTERN without `git -c`: aid, not barrier

`assertNoPush` (`src/lib/coordinator.ts`) has zero callers in `src/` —
it never enforced anything on operator or worker paths. Real barriers:

- Operator push/PR: `requireHumanAuth` (`src/lib/integration.ts`) in
  `mc_pr` (`src/tools/pr.ts`) and `orchestrator.createPR` — no flag = refusal.
- Worker shell: `requiresHumanAuth` + `PermissionPolicy`
  (`src/lib/permission-policy.ts`) → `ask-user` even inside the worktree
  unless `humanAuth: true` rides in the request. Monitor
  (`src/lib/monitor.ts`) enforces via the V2 permission reply endpoint.

Fix (effective barrier where it counts + aid hardened):

- `isGitPushArgs(argv)` (`coordinator.ts`): token scan for `git` +
  globals (`-C/-c <val>`, `--git-dir/--work-tree[=...]`, `--no-pager`, …)
  then `push`. Handles `git -C "my dir" push`, single-token `my dir`
  argv, `git -c k=v push`, `git --git-dir[=...] push`. Raw-space argv
  (`['git','-C','my dir','push']`) blocks; shell-free `gitCommand`
  (`cwd` opt, no shell) stays safe by construction.
- `isGitPushText(haystack)` + `requiresHumanAuth`
  (`permission-policy.ts`): shell-aware split keeps `"a b"` as one word,
  same globals list. `git -C "my dir" push`, `git -c a=b push`,
  `git --git-dir=/x push` → `ask-user` inside the worktree.
- `PM_FLAGS` now accepts quoted values (`npm --prefix "my dir" publish`).
- `assertNoPush` now checks `isGitPushArgs` OR the legacy regex
  (defense in depth). Documented as aid; the two `require*HumanAuth`
  paths are the barriers.

Tests (`tests/lib/coordinator.test.ts`, `tests/lib/permission-policy.test.ts`):

- `isGitPushArgs(['git','-C','my dir','push'])`, `['git','-c','a=b','push']`,
  `['git','--git-dir=/x','push']`, `['git','--no-pager','push']` → true;
  `commit -m "push origin"` → false.
- `isGitPushText('git -C "my dir" push')`, `'git -c a=b push'` → true;
  `requiresHumanAuth` for the same inside worktree → true / `ask-user`.

## 3. ask-user without warning → visible pending + safe timeout

Before: `permission.asked → ask-user` only set a 120s auto-approve timer.
No pending question, no sidecar entry — `mc_overview`, dashboard
`questions`, TUI `questions`/`follow` showed nothing. Worse,
`QuestionRelay.shouldAutoApprove` re-approved `git push` inside the
worktree, and the timeout approved publishing by silence.

Fix:

- `shouldAutoApprove` (`src/lib/question-relay.ts`) never auto-approves
  publishing (`isGitPushText` + `gh pr` + `publish` + `deploy`).
- Escalations create `perm:<id>` pending (memory + `runtime-state.json`
  sidecar) → visible in `mc_overview` Questions/Suggested Actions,
  `getDashboard().questions`, TUI `questions`/`follow`/`task`.
  `permission.replied/rejected` clears timeout + memory + sidecar
  (`src/lib/monitor.ts`).
- Timeout: publishing → auto-deny (`reject` + policy message);
  ordinary → auto-approve (`once` + default response). Worker never
  blocks, push never authorized by silence.
- `answerViaPermission` (`src/orchestrator-cli/forms.ts`): `answer <job>
  <approve|deny|1|2|text>` replies via `POST .../permission/:id/reply`,
  drops memory + sidecar. Offline (`port 0`) records the decision
  without throwing. `renderQuestionForm` shows `🔐` + `answer <job>
  <approve|deny>` terms for `perm:` entries.

Tests (`tests/lib/question-relay.test.ts`):

- Publishing inside worktree → `autoApproved false`.
- Escalation creates `perm:<id>` in memory + sidecar.
- Short-timeout relay: publishing → `reject`, ordinary → `once`
  (mocked `fetch`, 20ms timeout).

## 4. First use, reproducible (exits observed 2026-10-25)

TUI = one-shot commands (no REPL):
`bun src/orchestrator-cli/index.ts <command>` from the repo root.
Repo = the `git` repo the session runs in; branch per job
(`mc_launch(branch, baseBranch)`, default `mc/<name>`), per plan
(`mc_plan(baseBranch)`, integration `mc/integration-<planId>`).

```bash
bun run build  # exit 0 — Bundled 221 modules, index.js 1.33 MB
bun src/orchestrator-cli/index.ts help     # exit 0 — command list
bun src/orchestrator-cli/index.ts follow   # exit 0 — 0 running, Questions: none
bun src/orchestrator-cli/index.ts questions # exit 0 — No pending questions…
bun src/orchestrator-cli/index.ts order    # exit 0 — No active plan.
bun src/orchestrator-cli/index.ts send "Add CSV export to the billing view — repo: . base branch: main"
# exit 0 — wrapped prompt, ready to dispatch via mc_launch
```

Disposable demo (`/tmp/opencode/first-use-demo-*`, temp git repo,
`cd $DEMO && …` so state namespaces to that project):

```bash
cd $DEMO && bun …/index.ts follow    # exit 0 — 1 running after seed
cd $DEMO && bun …/index.ts questions # exit 0 — 🔐 Permission needed [shell_command]: git -C "my dir" push…
cd $DEMO && bun …/index.ts task demo-csv # exit 0 — Pending questions: 1
cd $DEMO && bun …/index.ts answer demo-csv deny # exit 0 — recorded (worker offline)
cd $DEMO && bun …/index.ts questions # exit 0 — No pending questions…
cd $DEMO && bun …/index.ts pause demo-csv  # exit 1 — not a serve-mode job: … stop tmux jobs with mc_kill
cd $DEMO && bun …/index.ts resume demo-csv # exit 1 — same guidance
cd $DEMO && bun …/index.ts log demo-csv    # exit 0 — No milestone reports yet
cd $DEMO && bun …/index.ts session demo-csv # exit 0 — tmux attach pointer (read-only)
```

Serve-mode `pause → resume` (same session) and `form.created → reply`
were validated live against serve 2.1.4 disposable (see
`docs/live-proof.md` adendo G1/G2); the tmux guidance above is the
expected path for non-serve jobs (code preserved, discard only via
`mc_cleanup`). Teardown: `rm -rf $DEMO
~/.local/share/opencode-mission-control/<demo-project>/`.

## 5. Verification

- `bun run build` — exit 0.
- `bun test` — exit 0, **963 pass, 16 skip, 0 fail** (62 files;
  +10 vs 953: 3 plan-state + 2 coordinator + 2 permission-policy + 3 relay).
- No push, no global config change, no live workers in this lane.
