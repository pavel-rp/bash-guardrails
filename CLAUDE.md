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

- **Every entry in `DENY_RULES`/`GIT_DENY_RULES`/`BLOCK_RULES`/`NEVER_AUTO_ALLOW`/
  `GIT_NEVER_AUTO_ALLOW` and the PS mirrors (`PS_DENY_RULES`/`PS_GUIDANCE_RULES`/
  `PS_NEVER_AUTO`) needs a kebab-case `id` and a `tier`** (`deny`/`block`/
  `never-auto-allow`, matching the array's own tier). This is the prerequisite
  for config-file rule references (Phase 3) and for `test/run.js`'s "rule ids
  are unique" wire check — a new rule without an id fails that check. Pick an
  id that describes the pattern, not the flag spelling (`git-switch-force`,
  not `git-switch-dash-f`), since a rule may later grow to match more
  spellings of the same operation.
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
- **BLOCK/ALLOW run on a quote-MASKED string; DENY runs on the RAW string.**
  `maskQuotes` blanks quoted contents (keeping bash's still-active `` ` `` and
  `$…` inside double quotes) so commit messages and grep patterns can't trip
  the guidance rules or the chain detector. Don't "simplify" by testing
  everything on one string: masking DENY would let quoted-context tricks past
  the destructive scan, and raw-testing BLOCK re-opens the
  `git commit -m "a | b"` false-positive class. A rule can opt back into the
  raw string with `raw: true` (the `=>({` rule needs it — its pattern lives
  inside `node -e "…"` quotes). On unbalanced quotes `maskQuotes` returns the
  string unmasked — conservative, same as pre-masking behavior.
- **Remaining false positives are intentional.** The DENY scan is quote-blind
  (a commit message quoting `rm -rf` is denied), and a backtick in a
  DOUBLE-quoted message is blocked because bash really substitutes there — the
  guidance says to use single quotes. The cost is a harmless rewrite, never a
  wrong execution. Don't loosen a regex to kill a false positive without
  weighing the hole it opens.
- **Package runners (`npx`, `bunx`, `pnpm/yarn dlx`, `npm exec`) are ask-tier
  by leading-token check, not regex.** A whole-string regex would demote every
  commit message mentioning "npx". Keep the check on `leadingCommand` /
  anchored subcommand.
- **Empty `{}` output means "no opinion"** → Claude Code shows its normal prompt.
  That's the correct default for anything not explicitly denied/blocked/allowed.

## Config engine (`config.js`) invariants

- **Every field in `bash-guardrails.json` is shell-scoped.** Top-level
  `disabledRules`/`ruleOverrides`/`extraAllowCommands`/`extraDenyRules`/
  `extraBlockRules` apply to `decideBash` only; `powershell.*` applies to
  `decidePowershell` only — including for shared git rules. Don't make these
  cross-apply "for convenience"; a mistake in one section must not silently
  change the other shell's behavior. See README "Configure without forking".
- **`effectiveTier()`'s no-override branch must map `tier` to an OUTCOME, not
  echo it back.** `tier: 'block'` rules natively emit a `'deny'` decision
  (with an instructive reason) — if you return `'block'` as the "effective
  tier" for a no-override block rule, `applyBlockRule`'s `eff === 'deny'`
  check never matches and the rule silently stops firing. (This exact bug
  shipped and was caught by `node test/run.js` immediately — every BLOCK_RULES
  case failed — before it left the working tree.)
- **`ruleOverrides: "off"` and `disabledRules` are the SAME clamp path for a
  `deny`-tier id** — both resolve to `"ask"`, never a true disable. A config
  can loosen a hard deny to a prompt; it can never make one vanish silently.
  `block`/`never-auto-allow` tiers have no such clamp — "off" there is a
  deliberate, sanctioned loosening of friction, not a safety boundary.
- **Unknown/invalid override values (e.g. a typo `"denye"` instead of `"deny"`)
  are treated as "no override" — they fall through to the native default.**
  This is enforced by `VALID_OVERRIDES` in `effectiveTier()`. Without this
  guard a typo in a deny-tier id would silently disable that rule, bypassing
  the clamp invariant above.
- **An `"ask"` override must return `passthrough()` directly on match, not
  just skip the rule.** Skipping alone lets execution fall through to the
  ALLOW check, where an allow-listed leading token (e.g. `git`) could
  silently auto-approve the very command being demoted. See
  `applyDenyRule`/`applyBlockRule`'s comments in `guardrails.js`.
- **Config is loaded fresh from disk on every hook invocation** (no caching)
  — cheap, and means an edited config file takes effect on the very next
  command with no restart. Any load/parse/merge failure degrades to
  `emptyConfig()` (built-in defaults only), never a silent allow — see
  `loadConfig`'s outer try/catch and the failure matrix in
  `docs/research/04_config.md` §2.4.
- **Config paths are injectable for tests** (`loadConfig({userConfigPath,
  projectConfigPath})`) — unit tests pass explicit fixture paths and never
  touch the real `~/.claude/bash-guardrails.json`; the end-to-end spawn tests
  in `test/run.js` override `HOME`/`USERPROFILE`/`CLAUDE_PROJECT_DIR` in the
  child process env instead. Never remove this seam — without it, a config
  file that happens to exist on the machine running the tests silently
  changes what "no config" test cases actually verify.

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

## Chained allow-listed commands are blocked, on purpose

`isSplittableChain` blocks a `;`/`&&` chain only when **every** segment leads
with an allow-listed command (so it's a pure sequence of known-safe commands the
model should issue as separate auto-approving calls). It deliberately does NOT
fire on control-flow (`for`/`if` — `;` is syntax there) or shell-state chains
(`source`/`export` — must share one shell), because those leading tokens aren't
allow-listed and so the chain doesn't qualify. Don't "fix" that by adding `for`/
`source` to `ALLOW_COMMANDS` — it would make those chains start getting blocked.

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

## Never allow-list a nested shell

`bash`/`sh`/`cmd`/`cmd.exe`/`powershell`/`pwsh`/`wsl` must never be added to
`ALLOW_COMMANDS` or `PS_ALLOW`. Each shell's rules only understand that
shell's own syntax — Bash's `DENY_RULES` don't recognize `Remove-Item
-Recurse`, PowerShell's `PS_DENY_RULES` don't recognize `rm -rf`. Invoking
one shell's interpreter from inside the other tool hands it an opaque string
neither rule set can parse, silently routing around every check. This isn't
a present gap (none of those tokens are allow-listed today) — it's a standing
invariant to protect against a future mistake.

## Name must agree in three places

The plugin name is referenced in `.claude-plugin/marketplace.json`,
`plugins/bash-guardrails/.claude-plugin/plugin.json`, and the
`/plugin install <name>@<marketplace>` command. Rename in all three together.

## Commit conventions

Concise, what-not-how, no AI/promotional signatures or trailers.
