# bash-guardrails

A Claude Code marketplace plugin that **tames the constant permission prompts**
without resorting to `--dangerously-skip-permissions`.

It installs a single `PreToolUse` hook that polices **both the Bash and
PowerShell tools** (on Windows the agent has both), making three decisions per
command:

| Decision | What | Examples |
|----------|------|----------|
| **DENY** | Hard-block destructive ops | `rm -rf` (incl. `/bin/rm -rf`), `find -delete`, `find -exec rm`, `git push --force`, `git reset --hard`, `git clean -f`, `git push --delete`/`:branch`/`--mirror`, push to `main`/`master` |
| **BLOCK** | Reject obfuscation-prone compound commands **with an instructive reason**, so Claude rewrites them cleanly | pipes `\|`, redirects `>`, `cd`, heredocs `<<`, `jq`, `cat`/`head`/`tail`, backticks |
| **ALLOW** | Auto-approve known-safe dev commands | `git`, `gh`, `pnpm`, `npm`, `npx`, `node`, `ls`, `grep`, `mkdir`, `echo`, … |

A `;`/`&&` **chain of allow-listed commands** is blocked too, with guidance to
run the parts as separate calls (each then auto-approves silently). Chains that
genuinely need one shell — control flow (`for …; do …; done`) or shell state
(`source … && …`) — are exempt, because their leading word isn't allow-listed.

Everything else falls through to Claude Code's normal permission prompt — the
**ask** tier. The dangerous *forms* of otherwise-allowed tools are deliberately
demoted here rather than auto-approved: inline interpreters (`node -e`,
`python -c`, `perl -e`, `bun -e`, `deno eval`), `find -exec`, and `chmod`/`chown
-R`. They're useful but can do anything, so they prompt instead of running
silently.

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
formats, and the shared destructive git ops; steers `Out-File`/`Set-Content`/`>`
to the Write tool; and auto-approves read-only cmdlets (`Get-ChildItem`,
`Select-String`, …) and dev tools. Unlike Bash, the object pipeline `|` is **not**
blocked — it's idiomatic in PowerShell — but the deny scan still reads the whole
pipeline, so a recursive delete hidden after a `|` is still caught.

## Install

```sh
# 1. Add this repo as a plugin marketplace (local path or git URL)
/plugin marketplace add B:/Projects/bash-guardrails
#   or:  /plugin marketplace add pavel-rp/bash-guardrails   (after the GitHub push)

# 2. Install the plugin (user-level — applies to every project)
/plugin install bash-guardrails@bash-guardrails
```

Restart Claude Code (or open `/hooks` once) so the hook loads — hooks are not
hot-reloaded mid-session.

On another machine, run the same two commands after cloning/adding the repo.

## Customize

All rules live in [`plugins/bash-guardrails/hooks/guardrails.js`](plugins/bash-guardrails/hooks/guardrails.js)
as readable arrays:

- `DENY_RULES` — destructive patterns (add your own).
- `BLOCK_RULES` — obfuscation-prone patterns + the guidance Claude receives.
- `ALLOW_COMMANDS` — the auto-approved leading commands.

Edit, save, restart. To loosen a rule (e.g. allow pipes), delete it from
`BLOCK_RULES`.

## Trade-offs

- **More round-trips.** Claude runs 4 clean calls instead of 1 blob. Each is
  silent, which is the point.
- **Inline interpreters prompt, but plain scripts auto-run.** `node -e "…"` /
  `python -c "…"` can do anything the deny scan can't see inside (it catches
  literal `rm -rf`, not `fs.rmSync`), so those forms fall to the **ask** tier.
  `node build.js` and `python script.py` still auto-approve. Add forms to
  `NEVER_AUTO_ALLOW` to demote more; remove `node`/`npx` from `ALLOW_COMMANDS`
  to make them always prompt.
- **Regex, not a shell parser — and not a security boundary.** This is a
  friction-reducer and mistake-catcher, not adversary-proof. A determined bypass
  (path aliasing, base64, `bash -c`, writing a script to disk) can defeat any
  in-process command filter; the real boundary is git's recoverability plus, if
  you need it, an OS sandbox. A few false positives are intentional (e.g.
  `node -e "a > b"` is blocked because `>` looks like redirection); the cost is a
  rewrite, not a wrong execution.

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
        │   └── guardrails.js      # the rules (readable, edit me)
        └── README.md
```
