# Marwan SAT — Marwan Software Agents Team

**A governed seven-agent software team with deterministic gates, installable in any project.**

> Version `0.2.0` — **experimental**. Not yet validated on a real project (charter §17). The charter and the Arabic README are the reference.

Marwan SAT is not "a smarter agent". It is **governance around agents**: who writes what, when, with what evidence, and who decides.

- **An agent's statement about its own work is not evidence.** Tool output, Git history and CI are.
- **One code writer.** The other agents analyse, review and attack; they do not write code.
- **The owner decides.** Two fixed gates and one conditional gate; only the owner merges, through GitHub.

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
| Claude Code | Planned for 0.2.0 | Tools and CI |
| VS Code (Copilot) | Planned; benefits from the Claude Code adapter, whose format it reads | Tools and CI |
| Cursor | Not yet | Tools and CI |
| Windsurf / Devin | Not yet | Tools and CI |

"Tools and CI" means `phase`, `verify` and `report` run with Node in any terminal and the CI workflow runs on GitHub whatever your editor. Without an adapter there are no agents playing the roles and no guard blocking writes before they happen. "Supported" means an adapter tested on that platform, not just install instructions.

## Install

SAT is installed into each project separately (a git repo with at least one commit).

**Option 1 — straight from GitHub, no clone:**

```bash
cd /path/to/your-project
npx github:marwan-ahmed/marwan-sat#v0.2.0 init --stack nextjs   # nextjs | laravel | flutter | react-native | custom
npx github:marwan-ahmed/marwan-sat#v0.2.0 doctor
git add .team .agents .github/workflows/sat-verify.yml .gitignore
git commit -m "chore: install Marwan SAT 0.2.0"
```

`#v0.2.0` pins the version. To update later: `npx github:marwan-ahmed/marwan-sat#<newer-tag> update`.

**Upgrading from 0.1.x to 0.2.0:** agent names now start with `marwan-sat-` (for example `marwan-sat-tech-manager`). Finish any active task first, then run `update`: it removes the old agent files. Then pick `marwan-sat-tech-manager` again in Antigravity.

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

Requirements: a clean working tree and no other active task (one task at a time). The tech manager comes back to you only at Gate 0 (≤ 3 blocking questions, if any), Gate 1 (design approval, before any code) and Gate 2 (report and PR; you merge). Check progress any time with `node .team/bin/phase.mjs status`.

After each merge, run `git checkout main` then `git pull` before the next task. A step-by-step beginner guide (Arabic) is in [docs/ANTIGRAVITY_GUIDE.md](docs/ANTIGRAVITY_GUIDE.md).

## Honest limits

- `guard` is the first line of defence; a shell command can still write files. `verify` and CI are the last line.
- Gates 0 and 1 are procedural in the default `agent` approval mode; set `gates.approval: owner` to enforce them.
- The security auditor is not a guarantee against attacks. Without an attack environment its verdict is `INCOMPLETE`; mobile apps are reviewed statically in this version.
- Antigravity tool names come from its documentation; open each generated agent once to confirm.

## License

**MIT License — Copyright (c) 2026 Marwan Ahmed (مروان أحمد).** See [LICENSE](LICENSE).
Anyone may use, copy, modify, merge, publish, distribute, sublicense and sell SAT, provided the copyright notice and the license text are kept in all copies or substantial portions. `sat init` copies the license to `.team/LICENSE` for that reason. Provided "as is", without warranty.

Security reports: [SECURITY.md](SECURITY.md).
