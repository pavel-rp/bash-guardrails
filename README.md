# bash-guardrails

A Claude Code marketplace plugin that **tames the constant permission prompts**
without resorting to `--dangerously-skip-permissions`.

It installs a single `PreToolUse` hook that polices **both the Bash and
PowerShell tools** (on Windows the agent has both), making three decisions per
command:

| Decision | What | Examples |
|----------|------|----------|
| **DENY** | Hard-block destructive ops | `rm -rf` (incl. `/bin/rm -rf`), `find -delete`, `find -exec rm`, `dd`, `mkfs`, fork bombs, `git push --force` (incl. `+refspec`), `git reset --hard`, `git clean -f`, `git checkout <path>` / `git restore <path>` (discards changes), `git stash drop`/`clear`, `git switch -f`/`--discard-changes`, `git branch -D`/`--delete --force`, `git push --delete`/`:branch`/`--mirror`, push to `main`/`master`, PowerShell `Stop-Computer`/`Restart-Computer` |
| **BLOCK** | Reject obfuscation-prone compound commands **with an instructive reason**, so Claude rewrites them cleanly | pipes `\|`, redirects `>`, `cd`, heredocs `<<`, `cat`/`head`/`tail` in command position, backticks outside single quotes, appended `; echo "…$?"` exit-code probes |
| **ALLOW** | Auto-approve known-safe dev commands | `git`, `gh`, `pnpm`, `npm`, `node`, `ls`, `grep`, `mkdir`, `echo`, `rm` (non-recursive), `sleep`, `claude`, `mv`, … |

BLOCK and ALLOW decisions are **quote-aware**: the contents of quoted strings
are masked before the pattern rules run, so `git commit -m "feat: a | b"` or
`grep "tail" src/app.js` are not mistaken for a pipe or a file read. Bash
double quotes keep backticks and `$` expansions live (as bash itself does) —
a backtick inside a double-quoted message is still blocked because it really
would substitute; put literal backticks in **single quotes** instead. The DENY
scan stays quote-blind on purpose: there a false positive costs a prompt, an
oversight costs data.

A `;`/`&&` **chain of allow-listed commands** is blocked too, with guidance to
run the parts as separate calls (each then auto-approves silently). Chains that
genuinely need one shell — control flow (`for …; do …; done`) or shell state
(`source … && …`) — are exempt, because their leading word isn't allow-listed.

Everything else falls through to Claude Code's normal permission prompt — the
**ask** tier. The dangerous *forms* of otherwise-allowed tools are deliberately
demoted here rather than auto-approved: inline interpreters (`node -e`,
`python -c`, `perl -e`, `bun -e`, `deno eval`), package runners that execute an
arbitrary package (`npx`, `bunx`, `pnpm dlx`, `yarn dlx`, `npm exec`),
`find -exec`, `chmod`/`chown -R`, and `mv -f` (can silently overwrite an
existing destination). Git ref-surgery — `update-ref -d`, `reflog
expire`/`delete`, `gc --prune=now`/`--aggressive`, `filter-branch`/
`filter-repo`, `worktree remove --force` — is also demoted to ask rather than
denied: rarely typed by accident, but silent auto-approval is still wrong
given how much recovery value they can destroy. They're useful but can do
anything, so they prompt instead of running silently.

## Why it works

Claude Code has a **built-in command-safety classifier that runs *before* your
permission allowlist** and cannot be silenced by a `Bash(...)` allow rule. It
fires on things like:

- `"Contains brace with quote character (expansion obfuscation)"` — heredocs and
  `&& echo PASS || { ... }` blocks.
- `"Compound command contains cd with output redirection"` — `cd … && cmd > log`.

Allowlisting can't fix that, and compound commands don't match simple prefixes
anyway (`gh api … | …` doesn't match `Bash(gh:*)`). So this plugin doesn't try
to *approve* the gnarly commands — it makes Claude **stop writing them**. The
`BLOCK` reasons push Claude to run clean, single-purpose commands and to use the
`Read`/`Write`/`Glob` tools. Those clean commands then match the `ALLOW` set and
run silently.

## PowerShell

On Windows the agent reaches for a separate **PowerShell** tool, so the hook
covers it too (matcher `Bash|PowerShell`). The PowerShell tier denies
`Remove-Item -Recurse`, `gci -Recurse | Remove-Item`, `Clear-Content`, disk
formats, `Stop-Computer`/`Restart-Computer`, and the shared destructive git
ops; steers `Out-File`/`Set-Content`/`New-Item -Value`/`>` to the Write tool;
and auto-approves read-only cmdlets (`Get-ChildItem`, `Select-String`, …),
dev tools, and the narrow `netsh wlan show *` diagnostic query (bare `netsh`
also does firewall/interface writes, so it isn't allow-listed generally).
Unlike Bash, the object pipeline `|` is **not** blocked — it's idiomatic in
PowerShell — but the deny scan still reads the whole pipeline (so a recursive
delete hidden after a `|` is caught), and piping into an external interpreter
(`… | node x.js`) is demoted to a prompt: the pipeline exemption is for typed
cmdlet flow, not for feeding scripts.

Neither shell's `ALLOW_COMMANDS`/`PS_ALLOW` will ever include the other shell
(or `cmd`/`wsl`) — a nested shell hands its argument to rules that can't parse
that shell's syntax, silently routing around every check. See CLAUDE.md.

## Install

Run these two slash commands inside Claude Code:

```sh
# 1. Add the GitHub repo as a plugin marketplace
/plugin marketplace add pavel-rp/bash-guardrails

# 2. Install the plugin (user-level — applies to every project)
/plugin install bash-guardrails@bash-guardrails
```

`/plugin marketplace add` fetches straight from GitHub — no clone needed. The
same two commands work on any machine.

Restart Claude Code (or open `/hooks` once) so the hook loads — hooks are not
hot-reloaded mid-session.

### Updating

```sh
/plugin marketplace update bash-guardrails
```

Plugins are cached **by version**, so an update only refetches when the repo's
`version` is higher than the installed one. If a machine reports "already at the
latest version" but you expect changes, the version wasn't bumped.

## Configure without forking

Drop a `bash-guardrails.json` in `~/.claude/` (user-wide) and/or
`<project>/.claude/` (project-specific, wins on conflict) — no fork, no
restart-required code edit, effective on the next hook invocation:

```jsonc
{
  "version": 1,
  "disabledRules": ["cat-head-tail-guard"],
  "ruleOverrides": { "chmod-chown-recursive": "deny" },
  "extraAllowCommands": ["docker", "kubectl"],
  "extraDenyRules": [
    { "id": "org-terraform-destroy", "pattern": "\\bterraform\\s+destroy\\b", "reason": "blocked by team policy." }
  ],
  "extraBlockRules": [],
  "powershell": { "disabledRules": [], "ruleOverrides": {}, "extraAllowCommands": [], "extraDenyRules": [], "extraBlockRules": [] }
}
```

Every field is **shell-scoped**: the top level applies to the Bash tool only,
`powershell.*` to the PowerShell tool only — a shared rule (e.g. a git deny
rule that fires in both shells) needs its own entry in both sections to
loosen it everywhere. This is deliberate: a mistake in one section can't
silently change the other shell's behavior.

Rule ids come from `guardrails.js`'s `id` fields (every entry in
`DENY_RULES`/`BLOCK_RULES`/`NEVER_AUTO_ALLOW` and the PS mirrors has one).
`ruleOverrides`/`disabledRules` (equivalent — `disabledRules` is shorthand for
`ruleOverrides: {id: "off"}`) accept a new tier per id:

| Native tier | `"deny"` | `"ask"` | `"off"` |
|---|---|---|---|
| `deny` (hard-block) | no-op | demote to a prompt | **clamped to `"ask"`** — a deny-tier rule can never be fully disabled by config, only loosened to a prompt |
| `block` (obfuscation guidance) | no-op (still emits `deny`) | demote to a prompt | fully disabled |
| `never-auto-allow` (demoted from auto-allow) | **promote** to a hard block | no-op | stop demoting — the pattern can auto-approve again if otherwise eligible |

`extraDenyRules`/`extraBlockRules` take `{id, pattern, reason, flags?}`
(`flags` defaults to `"i"`); a bad regex or an id colliding with a built-in
drops just that one entry, not the whole file. Any load failure — missing
file, unreadable, malformed JSON, unknown `version` — silently falls back to
the built-in defaults; **nothing in the failure path produces a silent
allow**. See `docs/research/04_config.md` for the full design rationale.

## Tune from your own usage (`/bash-guardrails:tune-rules`)

The plugin ships a skill that turns your real usage into tuning proposals.
Invoke `/bash-guardrails:tune-rules` (or ask Claude to "check if any new
guardrail rules should be added"): a bundled analyzer mines your local Claude
Code transcripts read-only (last 30 days by default), replays every unique
shell command through the current hook, and reports

- **ALLOW candidates** — commands that keep hitting the ask tier, ranked by
  frequency × project spread (nested shells and inline-eval forms are
  excluded by design, however often they prompt);
- **false-positive review** — what each BLOCK rule actually caught, so quoted
  strings/filenames misread as shell syntax surface as fixable bugs;
- **deny evidence** — commands you manually rejected;
- **steering effectiveness** — per BLOCK rule, how often Claude successfully
  rewrote after the guidance, flagging rules whose wording isn't landing.

Nothing is changed automatically: each proposal names its channel (the config
file above, or a plugin PR) and is applied only with your per-item approval.

## Customize (fork)

For a wholly new rule shape the config file's schema can't express, fork
[`pavel-rp/bash-guardrails`](https://github.com/pavel-rp/bash-guardrails) and
edit [`plugins/bash-guardrails/hooks/guardrails.js`](plugins/bash-guardrails/hooks/guardrails.js)
directly — the rules are readable arrays:

- `DENY_RULES` / `GIT_DENY_RULES` — destructive patterns (add your own).
- `BLOCK_RULES` — obfuscation-prone patterns + the guidance Claude receives.
- `ALLOW_COMMANDS` — the auto-approved leading commands.
- `NEVER_AUTO_ALLOW` — allow-listed tools whose dangerous forms are demoted to a
  prompt (inline interpreters, package runners like `npx`/`pnpm dlx`,
  `find -exec`, `chmod -R`).
- `PS_*` — the PowerShell equivalents of each tier.

Bump `version` in both `plugin.json` and `marketplace.json`, and add your fork
as the marketplace instead. Restart Claude Code after any change — hooks
aren't hot-reloaded.

## Trade-offs

- **More round-trips.** Claude runs 4 clean calls instead of 1 blob. Each is
  silent, which is the point.
- **Inline interpreters prompt, but plain scripts auto-run.** `node -e "…"` /
  `python -c "…"` can do anything the deny scan can't see inside (it catches
  literal `rm -rf`, not `fs.rmSync`), so those forms fall to the **ask** tier.
  `node build.js` and `python script.py` still auto-approve. Add forms to
  `NEVER_AUTO_ALLOW` to demote more; remove `node`/`npx` from `ALLOW_COMMANDS`
  to make them always prompt.
- **Regex over a quote-masked string, not a shell parser — and not a security
  boundary.** This is a friction-reducer and mistake-catcher, not
  adversary-proof. A determined bypass (path aliasing, base64, `bash -c`,
  writing a script to disk) can defeat any in-process command filter; the real
  boundary is git's recoverability plus, if you need it, an OS sandbox. The
  remaining false positives are deliberately conservative: the DENY scan is
  quote-blind (a commit message quoting `rm -rf` is still denied), and
  unbalanced quotes disable masking entirely — in both cases the cost is a
  rewrite or a prompt, never a wrong execution.

## Layout

```
bash-guardrails/
├── .claude-plugin/
│   └── marketplace.json          # marketplace listing
└── plugins/
    └── bash-guardrails/
        ├── .claude-plugin/
        │   └── plugin.json        # plugin manifest
        ├── hooks/
        │   ├── hooks.json         # wires the PreToolUse hook
        │   ├── guardrails.js      # the rules (readable, edit me)
        │   └── config.js          # loads/merges the optional config file
        ├── skills/
        │   └── tune-rules/
        │       ├── SKILL.md       # /bash-guardrails:tune-rules
        │       └── scripts/
        │           └── analyze.js # transcript miner + hook replay (read-only)
        └── README.md
```
