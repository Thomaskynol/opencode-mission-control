# User Guide — Autonomous Orchestrator (v2)

Reproducible operator manual for the autonomous orchestration layer
(coordinator + serve-mode instances + human controls + final report).
For the classic job tools, see `README.md` (Tools Reference).

## 1. What this is (vs just launching jobs)

`mc_launch` alone fires an isolated agent in a worktree and leaves
scheduling, ordering, merging and reporting to you.

The autonomous orchestrator adds a closed loop around those jobs:

- **Coordinator** (`src/lib/coordinator.ts`): `observe → decide → dispatch → gate → enqueue`.
  It picks which queued jobs may run next (dependencies satisfied,
  within the parallel cap), dispatches each through the pinned
  model/agent/directory profile, holds integration behind the
  reviewer gate, and only then enqueues into the merge train.
- **Reviewer gate** (fail-closed): a job merges only with a `pass`
  verdict — non-empty diff, touchSet respected, test evidence with
  `exitCode === 0` on the exact tested commit, every essential
  requirement anchored in tests. Missing proof = `fail`, never `pass`.
- **Merge train**: serializes integration per branch, runs the
  configured `testCommand` (+ optional `regressionCommand`) after
  each merge, rolls back on failure/conflict.
- **Human controls**: pause / resume / complement / cancel / answer
  without losing code (stopping a process never discards code;
  only `mc_cleanup` discards).
- **Final report** (`mc_report_final`): one readable document —
  request → Integrated vs Gaps → next steps — with long logs as
  truncated annexes. Unknown work is listed under Gaps, never
  under Verified; a merge alone does not prove functioning.

## 2. Prerequisites

| Requirement | Notes |
|---|---|
| `tmux` | Hard requirement (session isolation, monitoring). |
| `git` | Worktrees and branches. |
| `gh` | Only for `mc_pr` / automatic plan PRs. Must be authenticated. |
| `bun` | Build, tests, and the human CLI (`bun src/orchestrator-cli/index.ts …`). |
| `opencode` **2.1.4** (validated) | Check with `opencode --version`. The serve-mode API surface used here (`/api`-prefixed session endpoints) was verified against the 2.1.4 binary's `/openapi.json`. Other versions may move or rename endpoints and are **not** validated. |

Install the plugin via `opencode.json`:

```json
{ "plugins": ["opencode-mission-control"] }
```

No `npm install` needed for normal use; local development uses
`bun install` inside this repo.

## 3. Starting the interface and the coordinator

There are two surfaces:

**A. Inside OpenCode (coordinator + all `mc_*` tools).**
The plugin starts the monitor automatically in the command-center
session and resumes a `running`/`paused` plan on boot. Drive it with:

- `mc_overview` — dashboard (start here).
- `mc_plan(…)` — create a multi-job plan (autopilot / copilot / supervisor).
- `mc_plan_status`, `mc_plan_approve`, `mc_plan_cancel` — supervise it.
- `mc_report_final` — write the final report when the plan is done.

**B. Separate human TUI (conversational, same machine).**
A standalone process that talks to the coordinator only via local
state files and session endpoints scoped to one execution. It never
pilots a worker directly.

```bash
bun src/orchestrator-cli/index.ts help
bun src/orchestrator-cli/index.ts follow
bun src/orchestrator-cli/index.ts send <large request>
bun src/orchestrator-cli/index.ts task <name>
bun src/orchestrator-cli/index.ts pause <name> [--detach]
bun src/orchestrator-cli/index.ts resume <name> [follow-up text] [--wait]
bun src/orchestrator-cli/index.ts add <name> <follow-up text>
bun src/orchestrator-cli/index.ts answer <name> <response>
bun src/orchestrator-cli/index.ts questions
bun src/orchestrator-cli/index.ts order
bun src/orchestrator-cli/index.ts session <name>   # read-only pointer
bun src/orchestrator-cli/index.ts log <name>       # last milestone line only
bun src/orchestrator-cli/index.ts cancel <name>
```

## 4. Choosing repo, branch, model, and ceiling

- **Repo**: the repository is whatever `git` repo your OpenCode
  session runs in. State is namespaced per project under
  `~/.local/share/opencode-mission-control/<project>/`
  (`state/` for job/plan/runtime state, `reports/` for reports).
- **Branch**: per job via `mc_launch(branch, baseBranch)` (default
  branch `mc/<name>`, default base = repo default branch); per plan
  via `mc_plan(baseBranch)` (integration branch `mc/integration-<planId>`,
  PR targets `baseBranch`).
- **Model**: the coordinator pins an exact triple
  `providerID / id / variant` (+ agent + worktree directory) at
  session creation and re-verifies it against the live session.
  There is **no silent fallback**: if the model cannot be served (or
  the session drifts from the profile), the instance pauses with a
  question to you. You pick the replacement explicitly; the manager
  never swaps models on its own (`swappedModel` is always `undefined`).
- **Ceiling (maxParallel)**: set `maxParallel` in `config.json`
  (default `3`). The coordinator clamps it into the **4–8** contract
  window (`clampMaxParallel`); the plan reconciler preserves your
  configured budget exactly. `decideNextJobs` only picks
  `queued`/`waiting_deps` jobs whose dependencies are `merged`,
  ordered by `mergeOrder` then `priority`.

## 5. Following, complementing, pausing, resuming, canceling

| Goal | Command |
|---|---|
| Dashboard | `mc_overview` (or TUI `follow`) |
| One task | TUI `task <name>` · `mc_status(name)` · `mc_capture(name)` |
| Complement a job (same session) | TUI `add <name> <text>` · `mc_job_resume(name, message)` |
| Pause (loop stops, code stays) | `mc_job_pause(name, detach?)` · TUI `pause <name> [--detach]` |
| Resume (same session) | `mc_job_resume(name, message?, wait?)` · TUI `resume <name> [text] [--wait]` |
| Cancel (process stops, code preserved) | `mc_kill(name)` · TUI `cancel <name>` |
| Answer a worker question | `mc_answer(name, response)` · TUI `answer <name> <text>` / `questions` |
| Preview dispatch order | TUI `order` |

Rules that matter:

- Serve-mode pause uses `session.interrupt` (+ `session.background`
  with `detach`); job status stays `running` plus a `paused` milestone.
  **Tmux jobs have no session loop** — stop those with `mc_kill`
  (work is still preserved).
- Cancel = stop the process, preserve the work. Discarding code is
  only ever via explicit `mc_cleanup` (`deleteBranch: true` to also
  drop the branch).
- Correction of the same work continues the **same** session; a
  distinct task starts a **new** session.

## 6. State, sessions, reports

- **State** (per project):
  `~/.local/share/opencode-mission-control/<project>/state/`
  (`job-state`, `plan-state`, `runtime-state.json` sidecar for pending
  questions — survives kills, reconciled on boot;
  `config.json`; `port.lock` for serve ports).
- **Sessions**: `mc_attach(name)` returns the attach command
  (read-only observation; the TUI `session` command says the same).
  Serve-mode jobs expose `port`/`remoteSessionID`; tmux jobs expose
  the tmux target.
- **Reports**:
  - During work, agents call `mc_report(status, message, progress?)`
    (`working` / `progress` / `blocked` / `needs_review` / `completed`).
    Progress `%` appears only when the worker reported it — it is
    never invented (`Progress: unknown (never invented)`).
  - Alerts (`blocked`/`needs_review`) surface in `mc_overview` and the
    TUI `follow` view; `mc_answer`/`questions` show what needs a reply.
  - At the end: `mc_report_final(notes?, includeAttachments?)`
    assembles the plan + job-state + milestone reports and writes
    `~/.local/share/opencode-mission-control/<project>/reports/final-<planId>.md`.
    It prints `Integrated / Unmet / Unverified` counts (merges are
    integration, not verification). Per-job full
    messages go to `## Annexes`, truncated at 12000 chars with a
    `[truncated N chars, see source]` marker.

## 7. Integration and credentials policy

- **No push by default.** `git push`, `gh pr create|merge`,
  `npm publish`, and `deploy` require explicit `humanAuth: true`.
  `mc_pr` refuses without the flag; the autopilot PR step pauses at
  the `pre_pr` checkpoint instead of pushing — approve with
  `mc_plan_approve(checkpoint: "pre_pr")`.
- **Permission defaults** (inside vs outside the job worktree):
  file edits auto-approve inside / deny outside; shell commands
  auto-approve inside / ask outside; package installs ask;
  network access denies; MCP tools auto-approve. Unknown types ask.
- **No global profile changes.** The manager only pins the profile
  on `session.create` and re-checks it on `session.get`. It never
  rewrites your OpenCode config, plugins, skills, or agents.
- **Secrets** are redacted from prompts and logs; serve ports are
  per-execution (`14100–14199` by default, `portRangeStart/End` in
  config, guarded by `port.lock`); each job gets its own isolated
  worktree. If the server is password-protected, set
  `serverPassword` in `config.json` (sent as Basic auth to
  `127.0.0.1` only).

## 8. Limitations (read before relying on it)

- Validated against **opencode 2.1.4 only**. Other server versions
  may break the serve-mode endpoints.
- **`question.*` has no HTTP endpoint in 2.1.4.** Worker questions
  arrive as forms and your answer travels as session text
  (`mc_answer`); only `permission.*` uses the permission-reply
  endpoint. If you ignore an essential question for 120s, the relay
  auto-responds `use your best judgment` so independent jobs keep
  moving (`QUESTION_AUTO_RESPONSE_MS` / `QUESTION_DEFAULT_RESPONSE`).
- Parallel ceiling is clamped to **4–8**; tmux jobs cannot be
  paused via session interrupt (use `mc_kill`, code is preserved).
- Empty diffs are valid diagnostics: a merge producing
  "nothing to commit" succeeds with `testReport.status = 'skipped'`.
- A worker that goes quiet without `mc_report(status: "completed")`
  reads as "still running" — the `completed` call is mandatory.
- No remote push, no global config writes, no auto discard:
  anything not covered above is out of scope for the loop.

## 9. Removing the dev integration

To detach this plugin from an OpenCode setup (dev install):

1. Remove the entry from your `opencode.json`:
   ```json
   { "plugins": [] }
   ```
   (delete the `"opencode-mission-control"` line; for a local path
   install, delete the local path entry instead).
2. Restart OpenCode so the plugin unloads (monitor stops with it).
3. Finish or cancel running work first: `mc_kill` per job
   (preserves code), then `mc_cleanup(all: true, deleteBranch: true)`
   or the repo's Nuclear Cleanup script in `MANUAL_TEST_PLAN.md`
   (kills `mc-*` tmux sessions, removes test worktrees/branches).
4. Optional: delete persisted state
   `~/.local/share/opencode-mission-control/<project>/`
   (`state/` + `reports/`) and any leftover `mc/*` branches /
   worktrees (`git worktree list`, `git branch --list 'mc/*'`).

The plugin never touches your global OpenCode config on its own;
step 1 is the only config change, and it is manual.

## 10. Examples

**Autonomous feature with dependencies (autopilot):**

```
mc_plan(name: "feat: search upgrade", mode: "autopilot", jobs: [
  { name: "schema", prompt: "Add search index tables" },
  { name: "api",    prompt: "Implement search endpoints", dependsOn: ["schema"] },
  { name: "ui",     prompt: "Build search UI",            dependsOn: ["api"] }
])
mc_plan_status()            # watch merge train
mc_report_final()           # → reports/final-<planId>.md + Integrated/Unmet/Unverified
```

**Supervised run with a mid-course correction:**

```
bun src/orchestrator-cli/index.ts send "Add CSV export to the billing view"
# … plan running …
bun src/orchestrator-cli/index.ts follow
bun src/orchestrator-cli/index.ts add export-csv "Also handle empty result sets"
bun src/orchestrator-cli/index.ts pause export-csv
bun src/orchestrator-cli/index.ts resume export-csv "Continue with the empty-set fix" --wait
mc_report_final(notes: "CSV export manually verified: bun test green, see Tests section")
```

**Answer a blocked job without stopping the rest:**

```
mc_overview()               # shows Questions: export-csv
mc_answer(name: "export-csv", response: "Use option B: server-side pagination")
# other jobs keep running; unanswered essentials auto-resolve after 120s
```
