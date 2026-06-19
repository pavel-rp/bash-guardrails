# bash-guardrails

A Claude Code marketplace plugin that **tames the constant permission prompts**
without resorting to `--dangerously-skip-permissions`.

It installs a single `PreToolUse` hook that makes three decisions per Bash
command:

| Decision | What | Examples |
|----------|------|----------|
| **DENY** | Hard-block destructive ops | `rm -rf`, `git push --force`, `git reset --hard`, `git clean -f`, push to `main`/`master` |
| **BLOCK** | Reject obfuscation-prone compound commands **with an instructive reason**, so Claude rewrites them cleanly | pipes `\|`, redirects `>`, `cd`, heredocs `<<`, `jq`, `cat`/`head`/`tail`, backticks |
| **ALLOW** | Auto-approve known-safe dev commands | `git`, `gh`, `pnpm`, `npm`, `npx`, `node`, `ls`, `grep`, `mkdir`, `echo`, … |

Everything else falls through to Claude Code's normal permission prompt.

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

## Install

```sh
# 1. Add this repo as a plugin marketplace (local path or git URL)
/plugin marketplace add B:/Projects/bash-guardrails
#   or:  /plugin marketplace add <you>/bash-guardrails   (once pushed to GitHub)

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
- **`node`/`npx` are auto-allowed.** A `node -e "…"` can do anything; the deny
  scan catches literal `rm -rf` but not, say, `fs.rmSync`. Remove `node`/`npx`
  from `ALLOW_COMMANDS` if you want them to prompt.
- **Regex, not a shell parser.** A few false positives are intentional (e.g.
  `node -e "a > b"` is blocked because `>` looks like redirection). The cost is a
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
