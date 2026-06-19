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

## hooks.json must wrap events under a top-level `hooks` key

`hooks/hooks.json` is **auto-discovered** by Claude Code and must be shaped
`{ "hooks": { "PreToolUse": [ … ] } }`. Putting `PreToolUse` at the root fails
to load with `expected record, received undefined at path ["hooks"]` and the
plugin silently does nothing. `${CLAUDE_PLUGIN_ROOT}` is the correct path var.

Do **NOT** add `"hooks": "./hooks/hooks.json"` to `plugin.json` — the standard
path is already auto-loaded, so pointing the manifest at it too loads the file
twice and errors with `Duplicate hooks file detected`. `manifest.hooks` is only
for *additional* hook files outside the standard path. We removed that field.
`test/run.js` spawns `guardrails.js` directly, so it can't catch a wiring break —
the `wire` checks at the end of that file validate the `hooks.json` shape
instead. Keep them.

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
- **`NEVER_AUTO_ALLOW` is the ask tier, and it's deliberate.** Inline
  interpreters (`node -e`, `python -c`, `perl/ruby -e`, `bun -e`, `deno eval`),
  `find -exec`, and `chmod/chown -R` have allow-listed leading tokens but are
  demoted to a prompt because the deny scan **cannot see inside an interpreter** —
  `node -e` runs JS, so no `rm -rf` regex applies. Don't move these back into
  silent auto-allow to kill a prompt; that reopens the `fs.rmSync` hole.
- **rm/find deny rules are path-aware on purpose.** `rm` matches an optional
  `\S*/` prefix so `/bin/rm -rf` can't dodge the separator anchor; `find -delete`
  and `find -exec rm` are hard-denied (they wipe a tree like `rm -rf`). Keep the
  path prefix when editing.
- **`git push` denials cover remote-destructive forms too**, not just force/main:
  `--delete`/`-d`, `origin :branch` (the `\s:` requires a *space* before the
  colon, so legit `local:remote` refspecs still allow), and `--mirror`.
- **Some false positives are intentional.** `node -e "a > b"` is blocked because
  `>` reads as a redirection. The cost is a harmless rewrite, never a wrong
  execution. Don't loosen a regex to kill a false positive without weighing the
  hole it opens.
- **Empty `{}` output means "no opinion"** → Claude Code shows its normal prompt.
  That's the correct default for anything not explicitly denied/blocked/allowed.

## Bump the version or your fix never ships

Claude Code caches installed plugins **by version** at
`~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/`. `/plugin marketplace
update` compares versions: if the pushed `version` equals the installed one it
reports "already at the latest version" and **does not refetch** — so a fix
pushed under the same version is invisible to every machine that already
installed it (the stale cached `hooks.json`/`guardrails.js` keeps running). Any
change to plugin files MUST bump `version` in **both** `plugin.json` and
`marketplace.json` (keep them equal). For an already-broken local cache, patch
the file under the cache path directly for instant relief, then bump+push for
the durable fix.

## Two shells: Bash and PowerShell

On Windows the agent has a **PowerShell** tool separate from Bash. The hook
matcher is `"Bash|PowerShell"` and `decide()` dispatches on `tool_name`:
`Bash` → `decideBash`, `powershell`/`pwsh` → `decidePowershell`, anything else →
passthrough. If you add a shell tool, add it to BOTH the matcher and the
dispatcher or it runs unguarded (a `wire` test asserts the matcher covers both).

PowerShell rules mirror the Bash tiers but differ deliberately:
- **The object pipeline `|` is NOT blocked** — it's idiomatic typed-object flow,
  not a Bash text pipe. Only file redirects (`>`, `Out-File`, `Set-Content`) are
  steered to the Write tool. The deny scan still runs over the whole string, so
  `gci -Recurse | Remove-Item -Force` is caught despite being one pipeline.
- `GIT_DENY_RULES` is shared by both shells (git is shell-agnostic).
- `PS_NEVER_AUTO` blocks auto-approve for any mutating verb / scriptblock / iex /
  download even when the leading cmdlet is safe — so `gci | Remove-Item` prompts.

## Name must agree in three places

The plugin name is referenced in `.claude-plugin/marketplace.json`,
`plugins/bash-guardrails/.claude-plugin/plugin.json`, and the
`/plugin install <name>@<marketplace>` command. Rename in all three together.

## Commit conventions

Concise, what-not-how, no AI/promotional signatures or trailers.
