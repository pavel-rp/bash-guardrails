# Research brief — mine Claude Code transcripts for permission-prompt data

You are doing empirical research for the **bash-guardrails** project in this
repo (`B:\Projects\bash-guardrails`). Read first:

- `README.md` — what the plugin does: a `PreToolUse` hook that classifies each
  Bash/PowerShell command as DENY (destructive), BLOCK (obfuscation-prone,
  with rewrite guidance), ALLOW (auto-approve), or fall-through to Claude
  Code's normal permission prompt (the "ask" tier).
- `plugins/bash-guardrails/hooks/guardrails.js` — the classifier itself.
- `test/run.js` — shows how to invoke the hook programmatically: spawn
  `node guardrails.js` and feed `{"tool_name":"Bash","tool_input":{"command":…}}`
  JSON via the spawnSync `input` option (**never a shell pipe** — the plugin is
  installed on this machine and blocks pipes; a single `node yourscript.js`
  call auto-approves).

## Goal

The user's end goal is a **promptless-as-possible** Claude Code: every
permission prompt, for ANY tool, is friction to be eliminated — by a plugin
rule, a `settings.json` permission rule, or a new hook matcher. The plugin
currently polices only Bash and PowerShell, but a `PreToolUse` hook can match
**any tool** (Write, Edit, WebFetch, MCP tools, …), so do not scope the mining
to shell commands. This machine has months of real conversation history. Mine
it to answer, with counts, not vibes:

1. **The full prompt census**: which tools prompted the user, how often, in
   which projects — Bash/PowerShell commands, file writes/edits outside the
   project, WebFetch domains, MCP tool calls, script executions, everything.
   Rank every distinct prompt shape by annoyance (frequency × how often the
   user approved it anyway).
2. **Which shell commands hit the ask tier** (prompted), and which of those
   are frequent + safe enough to promote to auto-ALLOW?
3. **Which commands did the plugin BLOCK that look like false positives** (the
   command was benign; the regex fired on a quoted string, a filename, a commit
   message)?
4. **Which tool calls did the user manually reject** — evidence for new DENY or
   ask-tier rules (anything the user consistently approves is auto-allow
   evidence; anything consistently rejected is deny evidence).
5. **Does the BLOCK-with-guidance steering actually work** — after a block, did
   Claude retry with a clean, compliant command in the same session?
6. **Scripts and interpreters**: what did Claude want to run when it reached
   for `bash run.sh`, `node -e`, `python -c`, temp scripts written then
   executed? These land in the ask tier by design — but if the history shows
   recurring benign shapes (e.g. always the project's own test runner), that's
   data for narrower auto-allow rules.

## Data source

Claude Code stores session transcripts on this machine at:

```
C:\Users\recky\.claude\projects\<flattened-project-path>\*.jsonl
```

One JSON object per line. **Verify the schema empirically on a few files
before writing the extractor** — expect roughly (UNVERIFIED, confirm):

- Assistant turns contain `message.content[]` arrays with
  `{"type":"tool_use","name":<any tool name>,...,"input":{…}}` — capture ALL
  tool names, not just Bash/PowerShell. For non-shell tools keep the fields
  that identify the prompt shape (Write/Edit → `file_path`; WebFetch → URL
  domain; MCP tools → full tool name).
- **Figure out how a permission prompt is distinguishable in the transcript**
  — this is the crux of the census. An auto-approved call and a
  user-approved-after-prompt call may look identical in the main transcript;
  check for permission markers, hook outputs, `decision` fields, sidecar
  files, or timing gaps between tool_use and tool_result (a multi-second gap
  on an otherwise-instant tool suggests a human sat on a prompt — crude but
  usable; validate before relying on it). Document what is and isn't
  recoverable — if approved-prompts genuinely can't be distinguished from
  auto-approvals for some tool, say so explicitly and fall back to replaying
  the hook + reasoning about Claude Code's default permission behavior for
  that tool.
- The following user-turn entry carries the matching `tool_result`
  (match on `tool_use_id`).
- A hook denial appears as an error tool_result whose text contains the
  plugin's `BLOCKED:` / `BLOCKED (dangerous):` reason string.
- A manual user rejection appears as a tool_result containing text like
  "The user doesn't want to proceed with this tool use" (exact wording may
  vary by version — grep a sample to find the real markers).
- Entries carry timestamps and a session/uuid — keep both so you can order
  events within a session (needed for question 4).

Also check for other useful stores under `C:\Users\recky\.claude\`
(e.g. `history.jsonl`) — use them if they add signal, ignore otherwise.

**Read-only**: never modify or delete anything under `~/.claude`.

## Method

Write a Node analysis script (keep it in `docs/research/tools/`, it may be
committed — no secrets inside) that:

1. **Extract**: walk every project's `*.jsonl`, pull **every tool call**:
   tool name, prompt-shape key (command for shells; file path for Write/Edit;
   domain for WebFetch; tool name for MCP), timestamp, project, session id,
   and outcome (`executed` / `hook-blocked` (+reason) / `user-rejected` /
   `interrupted` / `error`, plus `prompted-then-approved` where detectable).
   Expect tens of thousands of lines — stream, don't slurp.
2. **Replay** (shell commands only): run every **unique** Bash/PowerShell
   command through the CURRENT hook (spawn
   per command like `test/run.js` does) to get today's classification:
   deny / block / allow / ask. Historical outcomes tell you what happened
   then; the replay tells you what would happen now. Both matter — some
   history predates the plugin or ran under older rule versions.
3. **Analyze** (each with counts and concrete command examples):
   - **Prompt census across ALL tools**: prompts per tool per month, top
     prompt shapes overall. For each major shape, name the cheapest remedy:
     (a) a bash-guardrails rule, (b) a `settings.json` permission rule
     (document the exact syntax — `Bash(git:*)`, `WebFetch(domain:…)`,
     `mcp__server__tool`, etc.), (c) a new hook matcher for a non-shell tool,
     or (d) unavoidable / should stay a prompt. Check what permission rules
     already exist in `~/.claude/settings.json` and the per-project
     `.claude/settings*.json` files, so you don't recommend duplicates.
   - **Script/interpreter inventory**: everything Claude ran via `bash <file>`,
     `sh`, `node -e/--eval`, `python -c`, or wrote-to-temp-then-executed.
     Cluster by intent (test runner? one-off probe? build step?) and flag
     recurring benign shapes that could earn a narrow allow rule.
   - **ALLOW candidates**: commands classified `ask` today, ranked by
     frequency × distinct projects × whether the user historically approved
     them. For each candidate leading command (e.g. `docker`, `dotnet`,
     `pytest`, whatever the data shows): occurrence count, sample commands,
     and your safety judgment (any destructive forms that would need a
     paired DENY/ask rule before allow-listing the token?).
   - **False-positive corpus**: historically `hook-blocked` commands where the
     block reason doesn't match the command's actual intent (pipe/backtick/
     cat-head-tail rules firing inside quotes or filenames). Group by rule.
     This becomes the regression corpus for the planned quote-aware tokenizer.
   - **DENY/ask candidates**: user-rejected commands — what was Claude trying
     to do that the user refused? Any recurring shapes the plugin should catch
     earlier?
   - **Steering effectiveness**: for each hook-block, look at the next 1–3
     Bash/PowerShell calls in the same session. Did Claude produce a compliant
     rewrite? Report the compliance rate per BLOCK rule — a rule with a low
     rate has bad guidance text (quote its current reason string and suggest
     better wording).
   - **Prompt-rate over time**: rough monthly trend of ask-tier hits vs total
     commands — is the plugin measurably reducing prompts?

## Privacy

Transcripts contain real project code, paths, and possibly tokens/URLs. The
repo is public. Therefore:

- Raw extracted data (full command corpus) goes to `docs/research/.local/`
  — create it and add a `.gitignore` inside containing `*` so it can never be
  committed.
- The report may quote **individual sanitized example commands** (redact
  anything that looks like a secret, token, hostname, or personal path beyond
  `B:\Projects\<name>`). Aggregate counts are fine.

## Deliverables

- `docs/research/06_transcript-mining.md` — the report: methodology (including
  the verified transcript schema and what prompt signals were/weren't
  recoverable), the analyses above with tables, and a final **ranked
  "path to promptless" list**: every recommendation (plugin `ALLOW_COMMANDS`
  additions, new DENY/ask rules, BLOCK-reason rewordings, `settings.json`
  permission rules, new hook matchers for non-shell tools) ordered by prompts
  eliminated per month, each justified by counts, with its remedy channel and
  any safety caveat.
- `docs/research/tools/mine-transcripts.js` — the (re-runnable, secrets-free)
  extraction+replay script, so the analysis can be repeated after rule changes.
- `docs/research/.local/` — raw corpus + intermediate JSON (gitignored).

Do not modify anything outside `docs/research/`. If the transcript volume is
huge, process everything for counts but cap per-category example lists at ~20.
