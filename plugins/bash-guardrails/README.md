# bash-guardrails (plugin)

`PreToolUse` Bash guardrails for Claude Code. See the
[repo README](../../README.md) for the full explanation and install steps.

- `hooks/hooks.json` — wires the `PreToolUse` hook (matcher: `Bash`) to
  `node "${CLAUDE_PLUGIN_ROOT}/hooks/guardrails.js"`.
- `hooks/guardrails.js` — the decision logic: `DENY_RULES`, `BLOCK_RULES`,
  `ALLOW_COMMANDS`. Plain, commented JavaScript — edit it directly.

The hook reads the PreToolUse event JSON on stdin and writes a decision on
stdout using the documented schema:

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "allow | deny | ask",
    "permissionDecisionReason": "..."
  }
}
```

An empty `{}` means "no opinion" → Claude Code shows its normal prompt.
