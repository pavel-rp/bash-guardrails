# CLAUDE.md — bash-guardrails

A Claude Code marketplace plugin whose `PreToolUse` hook polices Bash commands
(deny destructive / block obfuscation-prone / auto-allow safe). See `README.md`
for the concept, layout, and install steps — this file covers only what you
can't infer from the code.

## Bootstrap paradox — read before testing

This plugin polices Bash, so **if it's installed while you work in this repo, it
blocks its own test workflow**: a pipe (`printf … | node`) trips the `|` block
rule and a heredoc trips the `<<` rule.

Use the self-hosted runner — it's a single `node` command (no pipe) that the
plugin auto-allows, so it works even with bash-guardrails installed:

```
node test/run.js
```

It spawns the hook and feeds each case via stdin's `input` option (not a shell
pipe). Add cases to the `CASES` table in `test/run.js`. Don't reach for
`printf … | node …` — the pipe trips the hook's own block rule.

## No hot-reload

After editing `hooks/guardrails.js` or `hooks/hooks.json`, **restart Claude Code**
(or reopen `/hooks`) before testing — hooks are loaded at session start and are
not hot-swapped. Re-running a test mid-session will exercise the OLD hook.

## Invariants — don't break these when editing `guardrails.js`

- **`DENY_RULES` scan the whole command string** (not just the first token).
  This is deliberate: it's what stops chaining from smuggling a destructive op
  past the gate, e.g. `pnpm build && rm -rf dist`. Keep deny patterns global.
- **`BLOCK_RULES` are first-match-wins**, most-specific first. Reordering changes
  which guidance message Claude gets.
- **`ALLOW` only fires for a single, non-chained command** (no `&&`/`;`; pipes
  are already blocked) whose leading token — after stripping `VAR=value` env
  prefixes — is in `ALLOW_COMMANDS`. Don't auto-allow chained commands; the deny
  scan can't vouch for an unknown second segment.
- **Some false positives are intentional.** `node -e "a > b"` is blocked because
  `>` reads as a redirection. The cost is a harmless rewrite, never a wrong
  execution. Don't loosen a regex to kill a false positive without weighing the
  hole it opens.
- **Empty `{}` output means "no opinion"** → Claude Code shows its normal prompt.
  That's the correct default for anything not explicitly denied/blocked/allowed.

## Name must agree in three places

The plugin name is referenced in `.claude-plugin/marketplace.json`,
`plugins/bash-guardrails/.claude-plugin/plugin.json`, and the
`/plugin install <name>@<marketplace>` command. Rename in all three together.

## Commit conventions

Concise, what-not-how, no AI/promotional signatures or trailers.
