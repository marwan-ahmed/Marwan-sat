# Marwan SAT — Marwan Software Agents Team

**A governed seven-agent software team with deterministic gates, installable in any project.**

> Version `0.5.0` — **experimental**. Not yet validated on a real project (charter §17). The charter and the Arabic README are the reference.

Marwan SAT is not "a smarter agent". It is **governance around agents**: who writes what, when, with what evidence, and who decides.

- **An agent's statement about its own work is not evidence.** Tool output, Git history and CI are.
- **One code writer.** The other agents analyse, review and attack; they do not write code.
- **The owner decides, and preparation is kept apart from execution.**
  - Nothing in the project changes until the owner sends two separate, exact replies: «اعتمد الخطة» (approve the plan), then «ابدأ التنفيذ» (start).
  - The tool checks the wording.
  - Only the owner merges, through GitHub.
  - Every message to the owner starts with a stage line (preparation or execution) and keeps technical detail in a final section.
  - `owner.audience: simple|developer` sets the vocabulary.

## The team

| # | Role | Does | Never |
|---|---|---|---|
| 1 | `marwan-sat-tech-manager` | Receives requests, runs the phase machine, delegates, escalates, delivers the report | Code, technical decisions, overriding a veto |
| 2 | `marwan-sat-request-interpreter` | Turns the request into a single-interpretation executive prompt (rules, worked examples, ≤ 3 blocking questions) | Design |
| 3 | `marwan-sat-architect` | Testable SPEC (AC-n), ARCH, PLAN with narrow `allowed_write` per task | Code or tests |
| 4 | `marwan-sat-security-auditor` | Threat model with abuse cases; later attacks the running app on localhost with synthetic data | Editing code, non-local targets |
| 5 | `marwan-sat-test-author` | Writes tests **before** the code, from acceptance criteria and abuse cases | Source code |
| 6 | `marwan-sat-implementer` | The only code writer, inside its task's `allowed_write` | Touching frozen tests or specs |
| 7 | `marwan-sat-adversarial-reviewer` | Logic, money and test-tampering review with a clean context | Reading the implementer's notes |

Deterministic tools (Node.js only, zero dependencies): `phase` (state machine, task branch, test freeze commit), `verify` (build/tests/scanners + integrity checks, raw evidence), `report` (evidence-built, hash-locked report), `guard` (Antigravity `PreToolUse` hook enforcing per-phase write rules).

## Platform support

| Platform | Status in 0.1.x | What works there |
|---|---|---|
| **Google Antigravity app** | **Supported** | The seven agents, the guard, the tools and CI |
| Antigravity CLI | Reads the same files per its docs; untested | Expected: all of the above |
| Antigravity IDE | Partial | Tools and CI. Its docs don't cover custom agents, so talk to the team from the app |
| Claude Code | Planned for a later release | Tools and CI |
| VS Code (Copilot) | Planned; benefits from the Claude Code adapter, whose format it reads | Tools and CI |
| Cursor | Not yet | Tools and CI |
| Windsurf / Devin | Not yet | Tools and CI |

"Tools and CI" means `phase`, `verify` and `report` run with Node in any terminal and the CI workflow runs on GitHub whatever your editor. Without an adapter there are no agents playing the roles and no guard blocking writes before they happen. "Supported" means an adapter tested on that platform, not just install instructions.

## Install

SAT is installed into each project separately (a git repo with at least one commit).

**Option 1 — straight from GitHub, no clone:**

```bash
cd /path/to/your-project
npx github:marwan-ahmed/marwan-sat#v0.5.0 init --stack nextjs   # nextjs | laravel | flutter | react-native | custom
npx github:marwan-ahmed/marwan-sat#v0.5.0 doctor
git add .team .agents .github/workflows/sat-verify.yml .gitignore
git commit -m "chore: install Marwan SAT 0.5.0"
```

`#v0.5.0` pins the version. To update later: `npx github:marwan-ahmed/marwan-sat#<newer-tag> update`.

**Upgrading from 0.1.x to 0.2.0:** agent names now start with `marwan-sat-` (for example `marwan-sat-tech-manager`). Finish any active task first, then run `update`: it removes the old agent files. Then pick `marwan-sat-tech-manager` again in Antigravity.

**Upgrading to 0.5.0:**
- **What it adds:**
  - The tools run git for the owner: commit, push, and open the pull request.
  - Pressing Merge on GitHub is the approval at Gate 2. «اعتمد النتيجة» is now only for accepting risks the report names.
  - One-approval team updates: ask «حدّث الفريق», then reply «نفّذ التحديث».
- **The first upgrade to this version is manual,** because the team-update instructions arrive with it. On the project's main branch, with no task in progress:
  ```bash
  npx github:marwan-ahmed/marwan-sat#v0.5.0 update --approve "نفّذ التحديث"
  ```
  It creates an update branch, pushes it and opens the pull request. Press Merge.
- **What it changes:**
  - A task waiting at Gate 2: press Merge on its pull request, and it closes when the next task starts. If it has no pull request, run `node .team/bin/phase.mjs ship` to open one.
  - No `project.yaml` change is needed.
- **After merging:** start a new conversation with the tech manager.

**Upgrading to 0.4.1:** `sat doctor` now actually verifies the main branch's protection, so a project that was READY may now be NOT READY. Either turn the protection on (a private repo needs GitHub Pro), or add `branch_protection: accepted_risk` under `git:` in `.team/project.yaml` and record why in `.team/DECISIONS.md`. This verdict does not block starting tasks.

**Upgrading to 0.4.0:**
- **What it adds:**
  - The audit path (charter §5.5).
  - A start-permission gate, separate from the plan approval.
  - Exact reply phrases for approvals (§6).
- **What it changes:**
  - A task in progress is not broken. A task at Gate 1 moves to the start gate once the plan is approved.
  - A light task touching a `payout`, `withdraw` or `refund` file now needs the full path.
  - The default audience is `simple`. Developers can set `owner.audience: developer`, then run `sat regenerate`.
- **After updating:** start a new conversation with the tech manager.

**Upgrading to 0.3.0:** scanners now judge only the task's change, so a task no longer fails on vulnerabilities, secrets or findings that were in the project before it; that debt is reported instead. You can update with a task in progress: update on the main branch, then merge it into the task branch. See the CHANGELOG and charter §9.6.

**Option 2 — clone once, then use `sat` everywhere:**

```bash
git clone https://github.com/marwan-ahmed/marwan-sat.git
cd marwan-sat
npm link
cd /path/to/your-project
sat init --stack nextjs
sat doctor
```

Update with `git pull` in `marwan-sat`, then `sat update` in the project.
On Windows PowerShell, if you see `running scripts is disabled on this system`, use `sat.cmd` / `npx.cmd`, or run `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` ([Microsoft docs](https://learn.microsoft.com/powershell/module/microsoft.powershell.core/about/about_execution_policies)).

## Getting started

There is no terminal command to start a task: the tech manager opens it, records your request verbatim and creates the `sat/TASK-<n>` branch.

1. Open the project folder in the Google Antigravity **app** (not the IDE), without a worktree.
2. Open the **model button** under the message box (it shows the model name, e.g. `Gemini … ⌄`) and pick `marwan-sat-tech-manager` from its agent picker; it then shows as a chip next to the model name. In Antigravity versions before 2.29 the picker was a separate **Main Agent** dropdown above the message box.
3. Send the start command:

```text
New task: <describe what you need, as you would to a human tech lead>
```

Requirements: a clean working tree and no other active task (one task at a time). Before the first task, `sat doctor` must say READY: it verifies through `gh` that the base branch requires a pull request and that admins cannot bypass it (a private repository needs GitHub Pro for this). If you cannot have that, record the accepted risk with `git.branch_protection: accepted_risk` in `.team/project.yaml`. The tech manager comes back to you only at these points:
- **Gate 0:** up to 3 blocking questions, if any.
- **Gate 1:** plan approval. Reply «اعتمد الخطة».
- **The start permission:** a separate message. Reply «ابدأ التنفيذ». Until then nothing in the project changes.
- **Gate 2:** report and PR. **Pressing Merge on GitHub is your approval**; you type nothing. Only when the report lists risks that need your written acceptance do you reply «اعتمد النتيجة» before merging. Check progress any time with `node .team/bin/phase.mjs status`.

**Auditing an existing project.** Ask the tech manager for an audit (`Audit: <scope>`). It never answers with a free-form list. It opens an **audit task** (`phase new "<title>" --kind audit`), which changes nothing outside its folder:
- **INVENTORY:** evidence-backed environment facts, and every entry point with its server-side check.
- **FINDINGS:** three parallel lenses: security, logic and money, and gaps. Every finding has a proof status and a `file#symbol` location.
- **CHALLENGE:** every finding is reviewed by a role that did not write it. It checks reachability, whether the fix is right in this environment, the severity, and any external claims.
- **BACKLOG:** `backlog.mjs` builds small, ordered items from a fixed priority table. Each item has a ready request, with fixes kept apart as non-binding hints.

You approve the backlog at Gate A by merging its PR. Approving the list starts nothing. Each item is then prepared on request with `phase new --from TASK-<n>:B-<m>`, and passes its own plan and start gates. See charter §5.5 and §7.8.

**No git commands for you.** SAT returns to the main branch and updates it, commits the task records, pushes the branch and opens the PR itself; your only action outside the chat is pressing **Merge**. While a task waits for your Merge, no new task starts. To update the team, tell the tech manager «حدّث الفريق»: it shows what is new, and after your exact reply «نفّذ التحديث» it updates on a branch of its own and sends you a Merge link. A step-by-step beginner guide (Arabic) is in [docs/ANTIGRAVITY_GUIDE.md](docs/ANTIGRAVITY_GUIDE.md).

## Honest limits

- `guard` is the first line of defence; a shell command can still write files. `verify` and CI are the last line.
- In the default `agent` mode, the tech manager records your reply. The tool checks the wording but cannot prove who wrote it. Set `gates.approval: owner` to run approvals yourself.
- Plain language is an instruction to the agents. The tool enforces the structure: the stage line, the exact phrases, the technical section, and a plain sentence per finding.
- An audit is only as good as what it examined: its backlog lists what was not examined, and suspected findings stay suspected until a task confirms them.
- The security auditor is not a guarantee against attacks. Without an attack environment its verdict is `INCOMPLETE`; mobile apps are reviewed statically in this version.
- Antigravity tool names come from its documentation; open each generated agent once to confirm. `sat doctor` stops warning once a real run is recorded as `confirmed` in `adapters/antigravity/tools.json`.
- Agents act with your GitHub identity: GitHub cannot tell your commands from theirs. That is why protection must bind admins too, and why `guard` refuses `gh pr merge` and any push to the base branch. A separate identity for the agents (an account without merge rights) is outside this version.

## License

**MIT License — Copyright (c) 2026 Marwan Ahmed (مروان أحمد).** See [LICENSE](LICENSE).
Anyone may use, copy, modify, merge, publish, distribute, sublicense and sell SAT, provided the copyright notice and the license text are kept in all copies or substantial portions. `sat init` copies the license to `.team/LICENSE` for that reason. Provided "as is", without warranty.

Security reports: [SECURITY.md](SECURITY.md).
