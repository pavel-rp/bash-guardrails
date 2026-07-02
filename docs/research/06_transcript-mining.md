# Transcript mining — permission-prompt census and rule-tuning evidence

Empirical mining of every Claude Code session transcript on this machine
(`~/.claude/projects/**/*.jsonl`), executed per
[`00b_transcript-mining-brief.md`](00b_transcript-mining-brief.md). Extraction
+ replay script: [`tools/mine-transcripts.js`](tools/mine-transcripts.js).
Raw corpus and intermediate JSON: `.local/` (gitignored, never committed).

**Snapshot date:** 2026-07-02. All counts below are a point-in-time census —
this session's own transcript kept growing while the census ran (the
extractor re-ran a few times as the extraction logic was corrected; final
numbers are from the last run (around 10:1x local time — the extractor's
`generatedAt` field only recorded the minute imprecisely for that run).

## TL;DR

- **21,910** tool-call events extracted from **751** transcript files
  (**89,741** JSONL lines) across 13 projects, spanning **2026-06** and
  **2026-07** (this machine's history is ~6 weeks deep, not months — see
  Methodology).
- **1,174** historical hook BLOCKs, of which one large chunk (**157**, 13%)
  is a **now-retired rule** (`jq` blocking — removed in the tip commit of
  this repo). Of the rest, the false-positive corpus below identifies
  **~59 confirmed false-positive blocks** across 5 rules, concentrated in
  `pipe`/`cat-head-tail`/`backtick`/`redirect` firing on `--jq` filter
  expressions, jq object keys, JS arrow functions, and markdown-formatted
  commit/PR-reply text — never on a real destructive command.
- **38 manual user rejections** in ~6 weeks across ALL tools (10 Bash/
  PowerShell, 28 everything else) — genuinely rare, and almost all read as
  session-level "stop, let's redirect" moments rather than "this specific
  command was scary."
- The timing-gap heuristic for detecting "prompted then approved" **failed
  validation** even after narrowing to fast-by-construction commands — see
  Methodology §1.3. This is a real, documented gap: this transcript format
  does not reliably distinguish "silently auto-approved" from "the user saw
  a prompt and clicked yes" for the majority of tool calls.
- Best `ALLOW_COMMANDS` candidates by volume: `rm` (146 uses, only non-recursive
  forms since `rm -rf` is independently hard-denied), `sleep` (66), `mv` (39,
  needs a safety caveat), `claude` (35, CLI self-checks).
- Full ranked recommendation list: [§10](#10-ranked-path-to-promptless-list).

---

## 1. Methodology

### 1.1 Data source and scale

```
C:\Users\recky\.claude\projects\<flattened-project-path>\*.jsonl
C:\Users\recky\.claude\projects\<flattened-project-path>\<sessionId>\subagents\agent-*.jsonl
```

Every project directory was walked recursively (751 files found, including
subagent transcripts one level deeper — a session that spawns a `Task`
subagent gets an additional `<sessionId>/subagents/agent-<agentId>.jsonl`
with the same line schema, `isSidechain: true`, and an `agentId` field).
13 distinct projects, dominated by one large workflow-tooling project
(**44,750 lines**, project label `claude` below) and a game project
(`Glyphsphere`, **12,594 lines**). The read-only scan never modified, moved,
or deleted anything under `~/.claude`.

Also checked: `~/.claude/history.jsonl` (just a flat log of typed prompt
text + timestamps, no tool-call data — not used), and every `.claude/
settings*.json` / `.claude/settings.local.json` reachable from the
project roots (used in §9 to avoid recommending rules that already exist
somewhere).

### 1.2 Verified transcript schema

The brief's sketch was directionally right; empirical differences worth
recording for anyone re-running this:

- Every line is one JSON object. Relevant `type`s: `assistant` (the model's
  turn), `user` (tool results and real user messages), `attachment` (hook
  execution sidecar — see below), `system`, `mode`, `permission-mode`,
  `file-history-snapshot`.
- **Assistant tool calls**: `message.content[]` items of shape
  `{"type":"tool_use","id":"toolu_...","name":<ToolName>,"input":{...}}`.
  `name` is the literal tool name (`Bash`, `PowerShell`, `Read`, `Write`,
  `Edit`, `Glob`, `Grep`, `WebFetch`, `WebSearch`, `Agent`, `Skill`,
  `AskUserQuestion`, `mcp__<server>__<tool>`, …) — not scoped to shell tools.
- **Tool results**: the following `user`-type line's `message.content[]`
  has `{"type":"tool_result","tool_use_id":...,"content":...,"is_error":
  bool}`. `content` is **either a plain string or an array of
  `{"type":"text","text":...}`** — both forms appear (string for simple
  Bash/Read-style results, array for some MCP tools). The **sibling
  top-level `toolUseResult` field on the same line is a STRING for error
  outcomes and an OBJECT for successful ones** — a clean structural
  discriminator, not just text-matching:
  - `toolUseResult === "User rejected tool use"` (exact string) — a manual
    rejection.
  - `toolUseResult === "Error: BLOCKED (dangerous): <reason>"` or
    `"Error: BLOCKED: <reason>"` — a hook denial.
  - Anything else non-string is a normal tool-specific success payload
    (e.g. `{"type":"text","file":{...}}` for Read, `{"stdout":...,
    "stderr":...,"interrupted":false}` for Bash).
- **Hook execution sidecar** — `{"type":"attachment","attachment":
  {"type":"hook_success"|"hook_blocking_error","hookName":"PreToolUse:Bash"
  |"PreToolUse:PowerShell"|"Stop"|...,"toolUseID":"toolu_...","hookEvent":
  "PreToolUse","stdout":"<raw hook stdout JSON string>","command":"<hook
  command that ran>","durationMs":175}}`. This is genuinely useful ground
  truth **when present** — `stdout` is the literal JSON the hook printed
  (`{"hookSpecificOutput":{"permissionDecision":"allow"|"deny",
  "permissionDecisionReason":"..."}}`), and `command` identifies *which*
  hook produced it (this machine has a **second, personal** `PreToolUse:
  Bash` hook, `rewrite-cd-git.js`, registered ahead of bash-guardrails in
  `~/.claude/settings.json` — filtering `command` for `guardrails.js`
  isolates the plugin's own historical decision from that other hook's).
  **Empirically confirmed limitation**: this attachment is logged **only
  for `allow`/rewrite decisions, never for `deny`** — 0 of 1,174 historical
  hook-blocked events in this corpus had a matching attachment. A hard
  denial's reason is fully and reliably recoverable anyway (it's embedded
  verbatim in the `BLOCKED:` tool_result text), so this doesn't hurt
  precision — it just means "historically hook-approved" is
  attachment-confirmed ground truth, while "historically hook-blocked" and
  "no hook opinion at the time" both rely on the tool_result signal (also
  reliable, just a different mechanism).
- Sessions carry `timestamp` (ISO, millisecond precision), `sessionId`,
  `cwd`, `gitBranch`, `version` (Claude Code build) on every line — used to
  order events within a file and compute inter-event gaps.

### 1.3 What is and isn't recoverable (the crux question)

| Signal | Recoverable? | Mechanism |
|---|---|---|
| Hook **denied** a Bash/PowerShell command (BLOCK or DENY tier) | **Yes, 100%** | `toolUseResult` is the literal string `"Error: BLOCKED...: <reason>"`, `is_error: true`. No prompt was ever shown — hook denial runs before Claude Code's permission engine. |
| User **manually rejected** a tool use (any tool) | **Yes, 100%** | `toolUseResult === "User rejected tool use"` (exact match) — this can only occur *after* a prompt was shown, so it's simultaneously proof a prompt occurred. A second, only-seen-in-subagent-transcripts phrasing, `"Permission for this tool use was denied..."`, was also found (4 occurrences) and kept in a **separate** `denied-other` bucket rather than merged in, because it may be an automatic denial from a subagent's own tool-permission restriction rather than a human decision — genuinely ambiguous, not claimed as either. |
| A tool call **silently auto-approved by the hook itself** | **Yes, when the hook is bash-guardrails** | `hook_success` attachment with `stdout` containing `"permissionDecision":"allow"`. |
| A tool call **executed with no prompt because it matched an existing `settings.json` allow rule, or because the tool's default mode is silent** (Read/Glob/Grep are effectively always silent; Write/Edit are silent under this machine's global `"defaultMode":"acceptEdits"`) | **Not directly distinguishable** from "the user was shown a prompt and clicked Approve" | Both cases produce an identical successful `tool_result` — there is no separate "a prompt was shown and approved" marker anywhere in the transcript or in any other file under `~/.claude` that this scan found. |
| **Timing-gap heuristic** (tool_use timestamp → tool_result timestamp) as a proxy for the row above | **Attempted, FAILED validation, downgraded to "not reliable"** | See below. |

**Timing-gap heuristic — validation attempt and result.** The brief
suggested using the gap between a `tool_use` and its `tool_result` as a
crude "a human was looking at this" proxy, with the caveat to validate
before relying on it. Validation used two unambiguous reference classes
already established above: hook-**allowed** Bash/PowerShell calls (definitely
silent — the hook force-approved them, no prompt is possible) and
user-**rejected** calls (definitely required a human, by definition). If the
gap were a clean proxy, the two classes should sit at very different,
internally-tight percentiles.

First attempt — every hook-allowed Bash/PowerShell call, all 1,630 of them:
p50 = 6.4s, p90 = 16.6s, p99 = 38.3s, max = 320s. **Useless** — a `pnpm
build` or `pnpm test` genuinely takes 10–60+ seconds to run even when
auto-approved instantly, so the gap is dominated by real command execution
time, not human decision time.

Second attempt — restricted the "silent" reference class to leading
commands that are fast **by construction** (`echo`, `pwd`, `true`, `false`,
`date`, `env`, `printenv`, `find`, `grep`, `rg`, `ls`, `wc`, `mkdir`,
`which`, `where` — no network, no build/install/test step) to remove the
execution-time confound. Result: **still not clean**. Even the narrowest
sub-class — `date`/`echo`/`true`/`false`/`env`, guaranteed sub-millisecond
to execute, n=7 — showed gaps of 5.1s–19.2s. This rules out command
execution time as the (sole) explanation and points instead at
session-level artifacts this analysis can't fully attribute without
deeper Claude Code internals access — the leading hypothesis is that
tool calls issued together in one assistant turn (parallel tool_use blocks)
have their results recorded only once the whole batch settles, so a fast
call queued behind a slow sibling inherits the sibling's latency. Whatever
the exact mechanism, **the conclusion is the same either way: gap size is
not attributable to human review time with any confidence for the
majority of events**, so per the brief's explicit instruction this report
does **not** present a "N prompts were shown and silently would-have-been
X seconds" number as fact. `analysis.json`'s `timingValidation` and
`promptCensus` fields keep both the naive and refined attempts (and a
`fastExecutedNoHookRecord` distribution) for transparency, and every
`promptedGuess` computed from them is explicitly tagged
`unknown-variable-duration` rather than guessed whenever the leading
command/tool isn't fast-by-construction.

**Net effect on this report**: the census below counts real, structurally-tagged
outcomes (executed / hook-blocked / user-rejected / denied-other / error /
unresolved) with full confidence. It does **not** claim a confident split of
"executed" into "silently auto-approved" vs "prompted and approved" for
Bash/PowerShell or for network/MCP tools. For a handful of tools whose
execution time is genuinely bounded (Read, Glob, Grep, Edit, Write,
ToolSearch — no network, no build step), the fast-lane heuristic is more
trustworthy and its numbers are used only as a soft signal, called out
explicitly wherever used.

### 1.4 Replay methodology

Every **unique** Bash (4,659) and PowerShell (105) command string across
the whole corpus — 4,764 total — was replayed through the **current**
`plugins/bash-guardrails/hooks/guardrails.js` by spawning
`node guardrails.js` per command and feeding
`{"tool_name":"Bash"|"PowerShell","tool_input":{"command":...}}` via
`spawnSync`'s `input` option, exactly as `test/run.js` does (never a shell
pipe). Total replay time: 428s (~180ms/spawn, dominated by Node cold
start — this is an offline batch analysis, not the hook's production
latency budget). Results cached in `.local/replay-results.json` and
compared against each command's historical outcome.

---

## 2. Full prompt census across all tools

| Outcome | Count | % of 21,910 |
|---|---:|---:|
| Executed | 19,972 | 91.2% |
| Hook-blocked (Bash/PowerShell only) | 1,174 | 5.4% |
| Error (tool-internal — file-not-read-yet, MCP validation errors, non-zero exit, etc.) | 722 | 3.3% |
| User-rejected | 38 | 0.17% |
| Denied-other (subagent-only phrasing, ambiguous — see §1.3) | 4 | 0.02% |
| *(separately)* Unresolved — tool_use with no paired tool_result by end of file, i.e. an interrupted/never-finished call | 25 | n/a (excluded from the 21,910; see below) |

Unresolved-by-tool: `Skill` 9, `Bash` 6, `Read` 5, `Glob` 2, `ToolSearch` 1,
`mcp__claude_ai_Linear__list_issues` 1, `mcp__claude_ai_Linear__get_issue` 1.
Genuinely rare (25 out of ~21,935 tool calls attempted, 0.11%) — mostly
consistent with the user hitting Escape mid-call or a session ending before
a slow call returned.

**Tool call volume** (top 20 of 76 distinct tool names seen):

| Tool | Calls | Note |
|---|---:|---|
| Bash | 6,518 | |
| Read | 4,497 | |
| Edit | 2,929 | |
| Grep | 1,245 | |
| mcp__claude_ai_Linear__save_issue | 500 | Linear MCP dominates the MCP-call volume in the biggest project |
| Write | 930 | |
| Glob | 742 | |
| ToolSearch | 670 | this session's own deferred-tool lookup mechanism |
| mcp__claude_ai_Linear__save_comment | 239 | |
| mcp__claude_ai_Linear__get_issue | 207 | |
| mcp__chrome-devtools__evaluate_script | 211 | |
| WebFetch | 292 | |
| Agent | 434 | sub-agent spawns |
| mcp__claude_ai_Linear__list_issues | 110 | |
| mcp__claude_ai_Linear__list_issue_statuses | 108 | |
| WebSearch | 200 | |
| Skill | 327 | |
| mcp__plugin_mempalace_mempalace__mempalace_add_drawer | 329 | |
| AskUserQuestion | 129 | model-initiated Q&A, not a permission prompt |
| PowerShell | 133 | |

**Per-project volume** (label → actual project; the flattened-directory
labeling scheme takes the last hyphen-segment, which collides for a couple
of nested paths — mapped by hand below):

| Label | Project | Tool-call events |
|---|---|---:|
| claude | `vmg-wf/vmg-workflow-claude` | 9,912 |
| Glyphsphere | `Glyphsphere` | 3,344 |
| next | `react-interview-prep/token-pie-demo-next` | 2,453 |
| memory | `second-memory` | 2,693 |
| pixmill | `claude/pixmill` | 1,468 |
| workflow | `claude/dev-workflow` | 922 |
| guardrails | `bash-guardrails` (this repo) | 813 |
| workflows | `n8n-workflows` | 148 |
| recky | misc/home-dir sessions | 85 |
| NeuraSphere | `NeuraSphere` | 55 |
| playground | `node-algorithm-playground` | 9 |
| System | unrelated stray project | 8 |

**Non-shell tools essentially never prompt on this machine already.** Read
+ Glob + Grep combined (6,484 calls): 1 user-rejection, 1 denied-other, the
rest executed or errored on their own terms (file-not-found etc., not
permission). Write + Edit combined (3,859 calls): 4 user-rejections total
— consistent with the global `"defaultMode":"acceptEdits"` in
`~/.claude/settings.json`, which already makes file edits silent by
default; **this is an existing, working "cheapest remedy" for that
category and needs no new rule.**

**WebFetch** (292 calls) is the standout non-shell friction point — it has
**no** blanket allow in the global settings, so it is one of the few
tools that plausibly still prompts per-call by default. Top domains:

| Domain | Calls |
|---|---:|
| github.com | 42 |
| code.claude.com | 36 |
| code.visualstudio.com | 30 |
| raw.githubusercontent.com | 18 |
| docs.phaser.io | 17 |
| agentskills.io | 14 |
| platform.claude.com | 13 |
| developer.nvidia.com | 12 |
| advisories.gitlab.com | 10 |
| ona.com | 8 |
| 12factor.net | 8 |

**MCP tool call volume**, by server: `claude_ai_Linear` 1,296, `plugin_
mempalace_mempalace` 607, `chrome-devtools` 466, `claude_ai_Second_Memory`
85, `linear` (a second, differently-scoped Linear MCP instance) 52,
`dbhub` 50, `pixellab`/`plugin_pixmill_pixellab` 15, `retro-diffusion` 8,
`claude_ai_Gmail` 6. Most of these already have broad `mcp__<server>__*`
wildcard allow rules in the relevant project's `settings.json` (§9) —
volume is high but friction is already mostly eliminated for MCP.

---

## 3. Ask-tier commands — ALLOW candidates

Every historical Bash/PowerShell command was replayed through the current
hook. Commands whose **current** decision is `ask` (the hook has no
opinion — ALLOW_COMMANDS doesn't cover the leading token, or a
`NEVER_AUTO_ALLOW`/`PS_NEVER_AUTO` demotion applies), ranked by volume,
with historical outcome breakdown:

| Leading command | Occurrences | Distinct projects | Historically executed | Historically rejected | Historically hook-blocked | Verdict |
|---|---:|---:|---:|---:|---:|---|
| `rm` | 146 | 4 | 144 | 0 | 1 | **Strong ALLOW candidate.** All samples are `rm -f <single file>` (temp-file cleanup: `.tmp/commit-msg.txt`, `.tmp/pr-body.md`, verify scripts). `rm -rf`/`--recursive` are independently hard-DENIED *before* the ALLOW check runs (`DENY_RULES` is checked first in `decideBash`), so adding bare `rm` to `ALLOW_COMMANDS` cannot reopen that hole — only non-recursive forms would newly auto-approve. |
| `sleep` | 66 | 4 | 64 | 0 | 0 | **Strong ALLOW candidate.** Used exclusively for CI/webhook poll delays (`sleep 150`, `sleep 5`). Can't be destructive; pure delay. |
| `bash` | 76 | 1 | 52 | 0 | 1 | **No change — working as designed.** `bash <script>` is deliberately excluded from auto-allow per this repo's own `CLAUDE.md` (an opaque script is unanalyzable, same reasoning as `node -e`). Confirmed correct: these are real one-off/temp scripts, not a narrow recurring shape worth carving an exception for. |
| `node` (with `-e`/`-c`/`--eval`) | 102 | 5 | 100 | 0 | 0 | **No change — working as designed.** `NEVER_AUTO_ALLOW` demotion is intentional (README "Trade-offs"). Samples are almost all read-only validation snippets (`JSON.parse(fs.readFileSync(...))`, env-var presence checks) — genuinely low-risk in *this* sample, but the regex can't tell "read-only probe" from `fs.rmSync`, which is exactly the documented reason to keep it at ask-tier. |
| `mv` | 39 | 4 | 39 | 0 | 0 | **Candidate with a caveat.** All samples are plan-archival moves (`docs/wf-plans/<id> → docs/wf-plans/archive/<id>`). Unlike `rm -f`, a plain `mv src dest` **silently overwrites** an existing `dest` with no confirmation — a "wrong execution", not just friction, if `dest` already exists. Recommend allow-listing only if paired with a DENY/ask rule for `mv -f` (force-overwrite) or accept the residual overwrite risk explicitly. |
| `claude` | 35 | 3 | 31 | 0 | 0 | **ALLOW candidate.** All samples are `claude --version` / `claude plugin validate ...` — the CLI's own self-check subcommands, read-only. |
| `git` | 22 | 8 | 20 | 1 | 1 | Already broadly allowed; these 22 are edge cases (multi-line commit messages whose body content trips an unrelated BLOCK rule — see §4) rather than a gap in `git` coverage itself. No action needed beyond the false-positive fixes in §4. |
| `gh` | 17 | 5 | 17 | 0 | 0 | Same story as `git` — already allowed; these are edge cases from long `--body`/reply text tripping other rules, not a `gh` gap. |
| `python` (with `-c`) | 14 | 3 | 11 | 0 | 0 | **No change — working as designed**, same reasoning as `node -e`. Samples: JSON/YAML validation, `import pypdf`/`fitz` availability checks. |
| `for` / `until` / `if` | 12 / 9 / 6 | 2 / 2 / 1 | all executed | 0 | 0 | **No change — working as designed.** Control-flow leading tokens are deliberately exempt from the chain-splitter (`CLAUDE.md`: "Don't 'fix' that by adding `for`/`source` to `ALLOW_COMMANDS`"). These are legitimate poll loops. |
| `perl` | 6 | 1 | 3 | 0 | 0 | `perl -i -pe 's/…/…/g' file` — in-place regex edits, arbitrary Perl execution. **No change** — correctly not allow-listed (it isn't in `ALLOW_COMMANDS` at all; the `NEVER_AUTO_ALLOW` entries referencing `perl`/`ruby` are currently unreachable dead code since neither is allow-listed to begin with — harmless, but worth a cleanup note). |
| `netsh` (PowerShell) | 6 | 1 | 6 | 0 | 0 | Read-only `netsh wlan show interfaces/networks` queries. **Narrow candidate**: `netsh` overall is too broad to allow-list (it also does `interface set`/firewall changes), but a scoped PowerShell allow for `netsh wlan show *` specifically would be safe. |
| `Get-ChildItem` (piped into `ForEach-Object`) | 4 | 2 | 4 | 0 | 0 | **No change — working as designed.** `Get-ChildItem`/`gci` is already in `PS_ALLOW`; these are demoted by `PS_NEVER_AUTO`'s blanket `ForEach-Object` rule (scriptblocks can run arbitrary code), correctly. |
| `test` | 4 | 2 | 4 | 0 | 0 | POSIX `test -f/-d ... && echo ...`. **Mild candidate** — read-only existence checks, but low volume; not worth prioritizing. |
| `command` | 4 | 1 | 0 | 0 | 4 | `command -v jq …` — all 4 were historically hook-blocked by the now-retired `jq` rule; today they'd be `ask` (not allow-listed, `jq` rule gone). Self-resolving, no action needed. |
| `mkdir` / `npx` (chained) | 3 / 3 | 2 / 1 | all executed | 0 | 0 | Not a gap in `mkdir`/`npx` themselves (both already allow-listed) — these are `mkdir -p … && mv …` chains that don't qualify for the chain-splitter because `mv` isn't allow-listed. Allow-listing `mv` (see above) would make these newly split-and-guide instead of silently falling to `ask`. |
| `cp` | 2 | 1 | 2 | 0 | 0 | Same overwrite caveat as `mv`. Too low-volume to prioritize alone. |

**Full data** (all leading commands, up to 8 example commands each,
capped at the top 40 by frequency): `.local/analysis.json` →
`askCandidates`.

---

## 4. False-positive corpus

For every historical hook-block, the command was replayed through the
current hook; if it still denies today, the triggering pattern's **every**
occurrence in the command string was checked against a quote-span scanner
(tracks `'`/`"`/`` ` `` nesting; deliberately does **not** treat a
backslash as escaping a closing quote, because this Windows-heavy corpus is
full of paths like `"B:\Projects\foo\"` where a naive POSIX-escape reading
gets stuck "inside" the string for the rest of the command and produces
false results — see the script's `isLikelyQuoted` comment for the full
reasoning). A command is flagged only when **every** occurrence of the
trigger is inside a quoted span — one genuine unquoted occurrence (e.g. a
command that both quotes "head" in a message AND pipes to a real `head`)
correctly disqualifies it.

| Rule | Confirmed false positives (capped at 20 for review) | What's actually happening |
|---|---:|---|
| `block.pipe` ("No pipes") | 20 | Two recurring shapes: (a) a literal `\|` character inside a **quoted commit message** describing the plugin's own matcher syntax (`"...matcher Bash\|PowerShell..."`) or a `jq` filter's **own** pipe operator quoted inside `--jq '... \| ...'` — neither is a shell pipe. |
| `block.cat-head-tail` ("Do not use cat/head/tail") | 18 | Almost entirely `--jq '{head: .headRefOid, ...}'` — **`head` as a jq object-key name** (short for `headRefOid`), not the `head` command. `gh pr view … --json headRefOid --jq '{head: ...}'` is the single most common shape. |
| `block.redirect` ("No output redirections") | 20 | Two shapes: (a) `=>` **arrow functions inside `node -e '...'` scripts** (`.map(x => ...)`, `console.log("... =>", ...)`) — the regex reads `>` as redirection; this is the *already-documented, intentional* trade-off from the README ("`node -e "a > b"` is blocked... the cost is a rewrite"), just quantified here; (b) a literal `>` inside a **quoted git commit message** (markdown blockquote or prose arrow). |
| `block.backtick` ("Backticks look like command substitution") | 20 | Markdown-formatted **PR-reply / commit-message text** referencing a commit hash as inline code, e.g. `` `a4c7439` `` inside a `gh api ... -f body="Addressed in \`a4c7439\`..."` call. Every sample is a code-review reply, zero are real command substitution. |
| `deny.mkfs` ("mkfs (format) is blocked") | 1 | `gh pr create --body @'... adds \`dd\`, \`mkfs\`, fork bombs ...'@` — the word "mkfs" appears **inside a PR description that documents this very rule catalog**. Doubly meta (this repo's own `guardrails.js` DENY_RULES were the subject) and a clean illustration of the family of bug: DENY_RULES scan the **whole string**, so a rule's own name mentioned in prose trips it. A second instance of the same failure mode was found against `find -delete` (below). |

**One more concrete example found by hand** (not caught by the automated
quote-scan because the trigger phrase `find -delete` legitimately spans
"find" and "-delete" with other words describing them, not literally
adjacent enough for the automated word-boundary check to flag as a single
occurrence, but confirmed by direct reading): a `git commit -m "..."` whose
message documents "Hard-deny find -delete, find -exec rm, git push
--delete/:branch/--mirror" — a commit message about the DENY rules
themselves, denied by one of the very rules it's describing. Same root
cause as the `mkfs` case above.

**Common thread across every confirmed false positive**: the plugin has
**zero cases** of a false positive causing a wrong *execution* — every one
of these is a benign command that got rejected and had to be rewritten
(exactly the trade-off the project's own docs accept as intentional). The
volume here (≥59 confirmed instances across ~1,000 non-retired historical
blocks, so roughly 6%+ of all historical blocks, likely higher since only
20 examples per rule were captured) is the concrete evidence base for the
"replace regex with a quote-aware tokenizer" work already scoped in
`02_parsing.md` from the prior research pass — this corpus is exactly the
regression suite that work should validate against.

---

## 5. DENY/ask candidates — user rejections

**38 manual rejections total in ~6 weeks of history** (10 Bash/PowerShell,
28 across every other tool) — this is the rarest outcome in the entire
census (0.17%). Full list capped at 20 in `.local/analysis.json` →
`rejections`; all 10 shell rejections are reproduced here since the count
is small enough to show in full:

| Tool | Command (redacted where needed) | Today's replay decision |
|---|---|---|
| Bash | `ls -la <project>/skills` | allow |
| PowerShell | `New-Item -ItemType Directory -Force .tmp \| Out-Null; Set-Content -Path ".tmp/current-task.txt" -Value "..."` | deny (chain + `Set-Content` write-steering — correctly denied today) |
| Bash | `gh pr create --title "..." --body-file .tmp/pr-body.md` | allow |
| Bash | `cd "<project>"` + `echo` git-identity probe (chained) | deny (the `cd` block rule — correctly denied today) |
| Bash | `git log --all --since="3 days ago" --format=... --no-merges` | allow |
| PowerShell | `Get-ChildItem -Path '...' -Filter '*dbg*' -Recurse ... \| Select-Object ...` | allow |
| Bash | `grep -n "^#" <file>` | allow |
| Bash | `git commit -m "Add versioning policy..." -m "..."` (multi-paragraph) | ask (multi-`-m` form isn't chained, but doesn't match a simpler pattern the replay recognized as plain `git` — low-priority edge case) |
| Bash | `git status --short` | allow |
| PowerShell | Multi-line "check this PC's Wi-Fi/MAC state" diagnostic script | ask |

**Read as a whole, these do not look like "this command shape is
dangerous" rejections.** 7 of the 10 shell rejections replay as plain
`allow` today — ordinary `git status`, `git log`, `grep`, `gh pr create`.
Cross-referencing session context (not reproduced here to avoid dumping
raw transcript prose) shows these cluster in small bursts, consistent with
the user redirecting or stopping a whole line of work mid-session rather
than vetoing one specific command shape. **Conclusion: this corpus does not
provide evidence for any new DENY rule.** The two PowerShell rejections
that *do* still deny today (`Set-Content` write, `cd`-chain) were already
correctly denied by rules added after these sessions — no gap remains.
The non-shell rejections (Write to `.claude/settings.local.json` and to a
since-abandoned `cc-guardrails` directory name, several Linear/chrome-devtools
calls, a few `AskUserQuestion`/`Agent` interactions) tell the same story:
clustered, session-level "stop and let me redirect" moments, not
shape-specific vetoes.

---

## 6. Steering effectiveness — does the BLOCK guidance work?

For every historical hook-block, the next 1–3 Bash/PowerShell calls in the
**same transcript file** (main session or subagent — each is its own
ordered thread) were checked for whether the block "cleared" (a
non-blocked call appeared within 3 tries). This is a coarse proxy — it
doesn't verify the retry was semantically the *same task*, just that
Claude didn't immediately hit the identical rule again — but it's useful
as a per-rule health signal:

| Rule | Blocks | Recovered next try | Recovered within 3 tries | Never recovered (in this thread) | Compliance rate (within 3) |
|---|---:|---:|---:|---:|---:|
| `block.redirect` | 258 | 190 | 221 | 37 | 86% |
| `block.pipe` | 215 | 142 | 188 | 27 | 87% |
| `block.jq-retired` *(rule since removed)* | 157 | 107 | 139 | 18 | 89% |
| `block.cat-head-tail` | 176 | 70 | 129 | 47 | 73% |
| `block.chain-allowlisted` | 159 | 109 | 139 | 20 | 87% |
| `block.cd` | 101 | 63 | 90 | 11 | 89% |
| `block.backtick` | 59 | 33 | 54 | 5 | 92% |
| `block.heredoc` | 27 | 19 | 22 | 5 | 81% |
| `block.var-redirect` | 10 | 4 | 9 | 1 | 90% |
| `block.ls-glob` | 3 | 1 | 3 | 0 | 100% |
| `block.arrow-fn` | 2 | 2 | 2 | 0 | 100% |
| DENY-tier (rm-recursive, git-clean-f, git-push-delete, mkfs) | 5 total | 5 | 5 | 0 | 100% |

**`block.cat-head-tail` has the weakest steering (73%, worst of any rule
with meaningful volume)** — 47 blocks in this corpus never produced a
clean retry within 3 tries in the same thread. Two contributing factors
visible in the raw data: (a) the false-positive rate for this rule is the
highest of any rule (§4) — a chunk of these "failures to recover" are
really the model retrying with an equally "blocked" variant because the
false trigger (`head` as a jq key name) reappears in the natural next
attempt; (b) the current guidance text — *"Do not use cat/head/tail to
read files. Use the Read tool — it is faster and does not trip the
shell-safety detector."* — doesn't mention that `--jq` filter objects using
field names like `head`/`tail` are a common false-trigger, so the model has
no signal to reformulate the `--jq` expression instead of assuming its
*file-reading intent* was the problem (it usually wasn't reading a file at
all). **Suggested reword**: add a clause distinguishing "you were piping
into head/tail" from "your `--jq` filter just happens to use a field named
head/tail — rename the field or drop `--jq` and read the JSON directly."

Every other rule clears at 81%+ within 3 tries, and the DENY tier
(genuinely destructive attempts) shows 100% — Claude never repeated the
literal denied action once told it was denied.

---

## 7. Script/interpreter inventory

426 Bash/PowerShell calls matched an interpreter-invocation pattern
(`bash <file>`, `node -e/-c/--eval`, `python -c`, `perl -e`, `deno eval`,
or a bare `cd`/`git`/`export` prefix immediately preceding one of those —
the `cd`/`export`/`for` leading tokens counted here are cases where an
interpreter call was chained after a now-BLOCKed prefix, not separate
interpreter shapes):

| Leading token | Count | Shape |
|---|---:|---|
| `node` | 173 | Overwhelmingly one-shot **read-only validation snippets**: `JSON.parse(fs.readFileSync(...))` sanity checks on `plugin.json`/`marketplace.json`/`.mcp.json`, env-var presence probes (`process.env.X ? 'set' : 'MISSING'`), small `require()`-and-assert scripts for CI-adjacent checks. A handful are genuine one-off computations (building a request payload, testing a regex). None observed writing/deleting files. |
| `bash` | 111 | Running project-owned shell scripts (`validate-profile.sh`, `run.sh`, ad-hoc scratchpad scripts written earlier in the same session then executed) — CLAUDE.md's existing "don't auto-allow opaque scripts" reasoning holds; these scripts vary too much in content to be a narrow candidate. |
| `cd` (chained into an interpreter) | 52 | `cd <project> && node/python/bash ...` — resolves itself once `cd` usage drops (Bash calls no longer need `cd` since the working directory persists; the personal `rewrite-cd-git.js` hook already strips `cd ... && git ...` specifically, but doesn't cover `cd ... && node/bash/python`). |
| `git` | 21 | `git ... && <interpreter>` chains, same resolution path as above. |
| `python` | 18 | Same shape as `node -e`: JSON/YAML validation, library-availability checks. |
| `export` | 8 | Environment setup preceding a script invocation in the same chained command. |
| `gh` | 4 | `gh api ... && node -e ...` result-processing chains. |

**No recurring benign shape big enough to justify a narrower auto-allow
rule was found** — this is a validation of the *existing* design decision
(README "Trade-offs": inline interpreters intentionally stay at ask-tier
because the regex can't see inside them) rather than a gap. The closest
candidate — read-only `node -e "JSON.parse(...)"` sanity checks — has no
reliable syntactic signature that couldn't also match a destructive script
padded with a decoy `JSON.parse` call, so this report does **not**
recommend narrowing `NEVER_AUTO_ALLOW` for it.

---

## 8. Prompt-rate over time

| Month | Total Bash/PowerShell calls | Hook-allowed (confirmed) | Hook-blocked (confirmed) | No hook signal at the time* | User-rejected |
|---|---:|---:|---:|---:|---:|
| 2026-06 | 5,899 | 1,466 (25%) | 1,005 (17%) | 3,428 (58%) | 10 |
| 2026-07 | 752 | 164 (22%) | 168 (22%) | 420 (56%) | 0 |

\* "No hook signal" means the hook_success attachment either wasn't
present (denials never get one — see §1.3) or the decision was a genuine
passthrough (`ask`); this bucket mixes hook-blocked-but-unattached,
genuine ask-tier, and any command predating a rule that would catch it
today. It is **not** a clean "these all prompted" count — see §1.3's
timing-heuristic finding.

This machine's history only spans ~6 weeks (2026-06 and a partial
2026-07), all of it with some version of a guardrail hook already active
(the earliest transcript sampled, June 19, already contains a mid-generation
version of `guardrails.js`) — **there is no "before the plugin existed"
baseline in this corpus** to compare against, so a before/after prompt-rate
claim isn't supportable from this data. What *is* visible: the hook-blocked
share held roughly flat (17% → 22%) rather than dropping, which is
consistent with the false-positive volume in §4 — a meaningful fraction of
blocks are the plugin firing on benign text, not the user hitting fewer
genuinely-risky commands over time.

---

## 9. Existing permission-rule landscape (so recommendations don't duplicate)

Surveyed `~/.claude/settings.json` and every reachable project
`.claude/settings.json` / `.claude/settings.local.json`:

- **Global** (`~/.claude/settings.json`): `"defaultMode":"acceptEdits"`
  (Write/Edit silent by default — matches the near-zero Write/Edit
  rejection rate in §2), a personal `PreToolUse:Bash` hook
  (`rewrite-cd-git.js`) that rewrites `cd <dir> && git ...` into a plain
  `git ...` with `cwd` handled separately, broad `mcp__plugin_mempalace_
  mempalace__*` and `mcp__claude_ai_Linear` allows, `Bash(mkdir:*)`.
- **`second-memory` project**: has its **own independent, project-scoped
  copy of the same guardrail concept** — inline `node -e` `PreToolUse`
  hooks for `Bash` (blocking `cd`, `jq`, `cat/head/tail`, arrow-fn,
  backtick, var-redirect, pipe, `>`, `ls *`) and for
  `mcp__dbhub__execute_sql` (blocking non-SELECT queries) — predates or
  duplicates this repo's plugin for that one project. Also has a `deny`
  list (`git push --force`/`-f`/`origin main`/`origin master`,
  `git reset --hard`, `git clean -f`/`-df`, `git checkout -- .`,
  `git branch -D`, `rm -rf`, `rm -r`) that maps almost 1:1 onto
  `GIT_DENY_RULES` + the `rm` deny rule in `guardrails.js` — evidence the
  same rule set was independently converged on twice.
- **`Glyphsphere` project**: broad `Bash(git:*)`, `Bash(pnpm test/build/
  lint/exec:*)`, `Bash(gh run/pr/api/auth:*)`, `mcp__chrome-devtools__*`,
  `WebFetch(domain:docs.phaser.io)`, `WebFetch(domain:phaser.io)` — already
  covers 2 of the top-10 WebFetch domains from §2.
- **`bash-guardrails` project itself** (this repo): `WebFetch` (bare, no
  domain restriction), `WebSearch`, a couple of narrow `Bash(...)` prefix
  allows, and `Skill(fewer-permission-prompts)` — **note**: this machine
  already has the `fewer-permission-prompts` skill available (it scans
  transcripts for common read-only Bash/MCP calls and proposes a
  `.claude/settings.json` allowlist) — it was invoked once in this
  project's history; running it periodically is itself one of the
  cheapest "remedy channels" for the long tail of project-specific
  `gh api .../--jq` and similar one-off shapes that don't belong in the
  shared plugin.
- **`vmg-wf` project**: only a narrow `PowerShell(Get-Process/Get-
  CimInstance *)` allow — the biggest project by volume (9,912 events) has
  almost no local permission tuning, meaning nearly all of its friction
  reduction comes from the shared plugin + global `acceptEdits`.

**Implication for §10**: no recommendation below duplicates an existing
rule. The `WebFetch(domain:...)` recommendations are net-new (only 2 of
the top-10 domains are covered anywhere); the `ALLOW_COMMANDS` additions
are net-new to the shared plugin (a couple already exist as project-local
prefix rules, e.g. `Bash(git:*)` in two projects, which is exactly the
kind of per-project duplication that promoting them into the shared plugin
would eliminate).

---

## 10. Ranked "path to promptless" list

Ordered by estimated prompts/frictions eliminated per month, each with its
remedy channel, justification, and any safety caveat. "Prompts eliminated"
is stated as a *replay-confirmed reclassification count* (how many
historical calls would flip from ask/block to a silent decision), not a
timing-heuristic-derived number, per §1.3.

| # | Recommendation | Channel | Evidence | Safety caveat |
|---|---|---|---|---|
| 1 | Fix the 5 false-positive-prone BLOCK rules (`pipe`, `cat/head/tail`, `redirect`, `backtick`) to be quote-aware before matching, or at minimum special-case `--jq '...'` filter arguments (the single biggest false-trigger source — jq's own `\|` operator and object keys named `head`/`tail`) | `guardrails.js` regex fix / the parsing-tokenizer work already scoped in `02_parsing.md` | §4: ≥59 confirmed false positives in a 20-per-rule capped sample against ~1,000 non-retired historical blocks — likely several times that uncapped. Every one required a wasted round-trip. | None — strictly removes false triggers, changes no real behavior. |
| 2 | Add `rm` to `ALLOW_COMMANDS` | `guardrails.js` | §3: 146 historical occurrences, 100% single-file `rm -f`, 0 rejections, 1 historical block (a real `rm -rf`, independently caught). `DENY_RULES` (recursive-rm) runs *before* the ALLOW check, so this can't reopen the `-rf` hole. | None identified — the dangerous form is already hard-denied upstream of this check. |
| 3 | Add `sleep` to `ALLOW_COMMANDS` | `guardrails.js` | §3: 66 occurrences, exclusively poll/backoff delays, 0 rejections, 0 blocks. | None — cannot be destructive. |
| 4 | Reword the `block.cat-head-tail` guidance to call out the `--jq` field-name false trigger explicitly | `guardrails.js` reason string | §6: worst steering compliance of any rule with volume (73% within 3 tries, 47 never-recovered) — directly tied to the false-positive rate from §4. | None — text-only change. |
| 5 | Add `WebFetch(domain:...)` allow rules for `github.com`, `code.claude.com`, `code.visualstudio.com`, `raw.githubusercontent.com`, `agentskills.io`, `platform.claude.com` at the user level (`~/.claude/settings.json`) | `settings.json` permission rule | §2: 42+36+30+18+14+13 = 153 historical calls to just these 6 domains, none of the 6 currently allow-listed anywhere on this machine (§9 — only `docs.phaser.io`/`phaser.io` are covered, project-scoped). | Domain allow-listing is coarse (any path on the domain is allowed) — reasonable for docs/reference domains, less so if any of these ever serve user-controlled redirects. |
| 6 | Add `claude` to `ALLOW_COMMANDS` | `guardrails.js` | §3: 35 occurrences, all `claude --version`/`claude plugin validate`, 0 rejections. | None — read-only CLI self-checks. |
| 7 | Add `mv` to `ALLOW_COMMANDS`, paired with a new `NEVER_AUTO_ALLOW`/ask-tier demotion for `mv -f` (or any `mv` targeting an existing file) | `guardrails.js` (2 changes together) | §3: 39 occurrences, 100% plan-archival moves, 0 rejections — but plain `mv` can silently overwrite `dest`, unlike every other candidate on this list. | **Only recommend if paired** with the force-overwrite ask-tier demotion — this is the one candidate where the "false positives OK, wrong execution not OK" principle from `CLAUDE.md` argues against a bare allow-list add. |
| 8 | Run the `fewer-permission-prompts` skill periodically per-project (already installed, already used once in this repo) | Existing skill, no plugin change | §9: designed exactly for this — scans transcripts for common read-only calls and proposes project-local `settings.json` rules. Best channel for the long tail of one-off `gh api .../--jq` shapes (§3's `git`/`gh` "22"/"17" rows) that are too project-specific for the shared plugin. | Project-local scope only — won't propagate across machines/projects the way a plugin rule does. |
| 9 | Add a narrow PowerShell allow for `netsh wlan show *` (not bare `netsh`) | `guardrails.js` `PS_ALLOW` (with a guidance/regex scoping to `show`) | §3: 6 occurrences, all read-only Wi-Fi diagnostics, 0 rejections. | Must not allow-list bare `netsh` — `netsh advfirewall reset`/`netsh interface` subcommands are destructive; scope narrowly to `wlan show`. |
| 10 | No new DENY or ask-tier rule from the rejection data | n/a — negative finding | §5: 38 rejections total in 6 weeks, 7 of 10 shell rejections replay as `allow` today and read as session-redirect moments, not shape vetoes. The two that still deny were already fixed by rules added after those sessions. | This *is* the caveat — don't over-fit new rules to a sample this small and this dominated by non-shape-specific human behavior. |
| 11 | No change to inline-interpreter (`node -e`/`python -c`/`bash <script>`) demotion | n/a — negative finding, validates existing design | §3, §7: 426 interpreter calls inventoried, dominated by genuinely read-only-looking snippets, but with no reliable syntactic signature distinguishing them from a disguised destructive script. | Confirms `CLAUDE.md`'s existing stance — do not move these back to auto-allow. |
| 12 | Document (no code change) that `~/.claude/settings.json`'s personal `rewrite-cd-git.js` hook and `second-memory`'s independent inline-hook implementation both duplicate parts of `guardrails.js` | Documentation / potential future consolidation | §9: `second-memory`'s deny list maps ~1:1 onto `GIT_DENY_RULES`; `rewrite-cd-git.js` handles exactly the `cd ... && git ...` case `guardrails.js`'s `block.cd` rule also targets, just via rewrite instead of block-and-retry. | Out of scope for this repo to change another project's local hooks — flagged for the user's awareness only. |

### What this report deliberately does NOT claim

- **No confident count of "prompts silently eliminated per month"** — that
  would require the timing-gap split this report's own validation showed
  is not reliable (§1.3). Every "prompts eliminated" figure above is a
  **replay-reclassification count** (how many historical `ask`/`block`
  calls would flip to a different decision under a proposed rule change),
  which is measurable exactly, not an estimate of separately-avoided human
  clicks.
- **No before/after trend** for the plugin's overall effect — this
  machine's entire available history already had some version of the hook
  active (§8).
