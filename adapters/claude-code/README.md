# Claude Code adapter — planned (charter §15.2)

Not implemented in 0.1.x. `sat init --platform claude-code` is refused with a clear message.

Planned mapping from the neutral roles in `core/roles/`:

| SAT | Claude Code |
|---|---|
| role file | `.claude/agents/<id>.md` (`name`, `description`, `tools`, `disallowedTools`, `model`, `skills`, `hooks`) |
| `model_class: strong / fast / session` | `opus` / `sonnet` / `inherit` |
| `guard` | `PreToolUse` hooks — scoped **per agent**, so write rules can be per role, not only per phase |
| verify-before-stop | `SubagentStop` hook (exit code 2 keeps the implementer working until `verify` passes) |
| flat hierarchy | `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH=1` |

VS Code (Copilot) also reads `.claude/agents` in the Claude format, so this adapter is expected to cover VS Code too. That has to be verified on VS Code itself before the README marks it as supported.

References: https://code.claude.com/docs/en/sub-agents · https://code.claude.com/docs/en/hooks · https://code.visualstudio.com/docs/agent-customization/custom-agents
