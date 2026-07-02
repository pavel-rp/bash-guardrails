# E. Decision telemetry & tuning loop (best-effort)

Scope per the brief: prior art for local decision logs, and feasibility (not
design) of measuring "ask"-tier approval rates via PostToolUse / transcripts.

## 1. Prior art for decision logs

No project logs the exact `command → decision → rule id` triple `guardrails.js`
would need, but several close analogs exist, and one is a near-identical tool
to bash-guardrails itself.

| Project | What it logs | Format/location | Redaction | Rotation/size |
|---|---|---|---|---|
| **GitHub Copilot CLI hooks** (official docs) | `preToolUse` attempts as `{"event":"preToolUse","toolName":...,"toolArgs":"[redacted]"}`; denials as `{"event":"policyDeny","toolName":"bash","command":"[redacted]","reason":...}` | `audit.jsonl`, local file | Explicit worked example: regex-redact GitHub token prefixes (`ghp_`, `gho_`, `ghu_`, `ghs_`), bearer tokens, `--password=`/`--token=` flags, *before* writing the line. Docs state GitHub provides **no built-in redaction** — it's the hook author's job. Also warns local log files are "not intended to be committed to the repository" and recommends forwarding to a centralized log/observability system for org-wide redaction and retention control instead of ad hoc local files. [docs.github.com/en/copilot/tutorials/copilot-cli-hooks](https://docs.github.com/en/copilot/tutorials/copilot-cli-hooks) | Not discussed — no rotation/retention guidance given. |
| **Dicklesworthstone/destructive_command_guard (dcg)** | A close sibling of bash-guardrails: 4-stage pipeline (parse → normalize → quick-reject → whitelist-then-blocklist pattern match), each verdict tagged with the rule that produced it. But this is **stdout/stderr only** — no persistent decision log. The only durable state is a config file and a `pending_exceptions.jsonl` for one-time "allow-once" override codes, not a decision history. [github.com/Dicklesworthstone/destructive_command_guard](https://github.com/Dicklesworthstone/destructive_command_guard) | n/a (ephemeral) | n/a | n/a |
| **disler/claude-code-hooks-mastery** | Raw hook payloads (tool name, tool input, tool response) dumped per-event | `logs/pre_tool_use.json`, `logs/post_tool_use.json` (append behavior/JSONL-vs-JSON not clearly documented) | None documented | None documented |
| **timoconnellaus/define-claude-code-hooks** | TS wrapper library; predefined hooks log `{timestamp, event type, session id, transcript path, tool name, tool input}` | JSON log file | None documented | None documented |
| **OpenAI Codex CLI** | Opt-in OTel log events: `codex.tool_decision` (approved/denied **plus whether the decision source was config or user**), `codex.tool_result` (duration, success, output snippet), `codex.tool.call`/`.duration_ms` | Exported via OTLP (http/grpc) to a collector you control — not a local file by default; disabled unless `[otel]` is configured | **Deliberately excludes the raw command/patch by default** — the metrics catalog states the event "doesn't contain the actual shell command or patch codex is trying to apply," and prompts are redacted unless explicitly enabled (`log_user_prompt = false` is the documented safe default: "Prompts can include source code and sensitive data"). [developers.openai.com/codex/config-advanced](https://developers.openai.com/codex/config-advanced), [developers.openai.com/codex/agent-approvals-security](https://developers.openai.com/codex/agent-approvals-security) | N/A (telemetry, not a growing local file) |

Takeaways for bash-guardrails if a decision log were ever added:

- **The approved/config-vs-user distinction Q2 is looking for already exists as
  a first-class field in a comparable tool** (`codex.tool_decision`'s source:
  config vs. user) — strong evidence the concept is sound, but Codex gets it
  for free because its approval system is native to the CLI. bash-guardrails is
  an external hook bolted onto Claude Code's permission system and does not
  have equivalent first-party access to that signal (see §2).
- **Every prior-art example that ships a working redaction story does it by
  regex-scrubbing known-secret shapes (token prefixes, `--password=` flags)
  before the write**, not by omitting fields wholesale — except Codex, which
  goes further and drops the command/patch entirely by default. Given
  bash-guardrails' commands are exactly the payload of interest (that's the
  point of the log), full omission defeats the purpose; targeted redaction
  (GitHub Copilot's pattern) is the more applicable model.
- **None of the surveyed examples document log rotation, size caps, or
  retention** — this is a real, unaddressed gap across the ecosystem, not
  something to assume is "handled" by borrowing an existing pattern. A
  bash-guardrails implementation would need to invent its own cap (e.g. size-
  or count-bounded ring file) rather than follow prior art, because there
  isn't any to follow.
- **PII-in-paths is not discussed anywhere found.** Every example redacts
  credential-shaped strings but not usernames-in-paths (`C:\Users\alice\...`,
  `/home/bob/...`) or repo/project names that a command's arguments would
  reveal. This is a genuine unaddressed gap, not just an omission in these
  particular docs — flag it as an open risk if bash-guardrails logs full
  command strings.

## 2. Feasibility: measuring ask-tier approval rate via PostToolUse / transcripts

### 2a. What PostToolUse actually receives

Per the official hooks reference, PostToolUse's input is the common fields
(`session_id`, `transcript_path`, `cwd`, `permission_mode`, `hook_event_name`,
...) plus `tool_name` and `tool_output`/`tool_response`.
**It does not include any field naming the permission decision, its source, or
whether a prompt was shown.** `permission_mode` is a session-wide setting
(`default`/`acceptEdits`/`bypassPermissions`/`plan`), not a per-call approval
record. [code.claude.com/docs/en/hooks](https://code.claude.com/docs/en/hooks)

This confirms the brief's suspicion: **PostToolUse alone cannot answer the
question.** It only fires after a tool call *succeeds*, so by construction it
can't distinguish "auto-allowed by bash-guardrails," "auto-allowed by the
user's own `Bash(...)` settings.json rule," and "user clicked Approve on a
prompt" — all three look identical to PostToolUse (a successful tool call with
no decision metadata attached).

### 2b. A better signal exists, but it's not what the brief asked about: `PermissionRequest`

The current official hooks reference (fetched during this research, so this
reflects the July 2026 doc state) lists a hook event not mentioned in the
brief: **`PermissionRequest`** — "When a permission dialog appears" — plus
`PermissionDenied` — "When a tool call is denied by the auto mode classifier."
[code.claude.com/docs/en/hooks](https://code.claude.com/docs/en/hooks)

This is materially more useful than PostToolUse for the stated goal, because
it fires **exactly when bash-guardrails' own "ask" tier is reached** (i.e.
when the hook returns `{}` and Claude Code's native prompt takes over — see
`guardrails.js`'s "Empty `{}` output means no opinion" invariant in
`CLAUDE.md`). A second hook registered on `PermissionRequest` would see the
`tool_name`/`tool_input` for every command that actually reached a human
prompt, which is the numerator's precondition.

What's still missing to close the loop, based on available documentation:

- **`PermissionRequest`'s own output can only pre-empt the dialog** (return
  `{"hookSpecificOutput":{"decision":{"behavior":"allow"|"deny", ...}}}`) — it
  has no "defer and tell me what the user picked" mode documented. If the hook
  does nothing, the docs don't explicitly state whether Claude Code later
  reports the human's choice back to *any* hook. **UNVERIFIED**: no field or
  later event carrying "user approved this PermissionRequest" was found in the
  official docs during this pass.
- The **`PermissionDenied` hook is documented as firing after "the auto mode
  classifier"** denies a call — its wording and a related GitHub issue thread
  suggest it is scoped to the built-in safety classifier's automatic denials,
  not necessarily to a human manually clicking "Deny" on a prompt. Community
  reports (GitHub issues, not official docs) describe manual user rejection
  producing a specific literal tool-result string surfaced back to the model:
  *"The user doesn't want to proceed with this tool use. The tool use was
  rejected."* — seen in issue discussions such as
  [anthropics/claude-code#29499](https://github.com/anthropics/claude-code/issues/29499)
  and [anthropics/claude-code#29238](https://github.com/anthropics/claude-code/issues/29238).
  **UNVERIFIED as a stable, documented API** — this is inferred from bug-report
  text, not from the hooks reference, and issue #29499's own title ("rejected
  when user didn't reject") shows this exact string is *also* emitted by
  unrelated bugs, so it's not a clean signal to grep for.

### 2c. Transcript JSONL: what's confirmed vs. not

Transcripts at `~/.claude/projects/<encoded-path>/<session-id>.jsonl` contain
one JSON object per turn, with `tool_use` blocks (`id`, `name`, `input`) and
matching `tool_result` blocks in the following user turn referencing the same
`id`. This structure is corroborated by multiple third-party write-ups (e.g.
[Inside Claude Code: The Session File Format](https://databunny.medium.com/inside-claude-code-the-session-file-format-and-how-to-inspect-it-b9998e66d56b))
but **no official schema page for the transcript file format was found** —
Anthropic does not appear to publish it, and the community docs consulted
explicitly caveat that "exact type values evolve with Claude Code versions."
**UNVERIFIED**: whether a `tool_use`/`tool_result` pair in the transcript
carries any field distinguishing "auto-approved (no prompt)" from
"prompted-and-approved" — no such field was found documented anywhere. The
only asymmetry found is the *content of the rejection tool_result* described
in §2b, which is a string match on model-facing text, not a structured field,
and is corroborated only by bug reports, not a schema reference.

### 2d. Bottom line

- **PostToolUse alone: not feasible** — it has no permission-decision field
  (confirmed against official docs).
- **PermissionRequest + PostToolUse/transcript correlation: plausible but only
  partially confirmed.** `PermissionRequest` reliably identifies the
  numerator's precondition (a dialog was shown for this command). Whether the
  *outcome* (approved vs. denied) is then obtainable through any documented,
  version-stable API is **UNVERIFIED** — the best available signal (a specific
  rejection string surfacing in the transcript/model context) is undocumented,
  version-fragile per the linked GitHub issues, and not something to build a
  tuning pipeline on today.
- Net assessment: **do not build this now.** The one clean building block
  (`PermissionRequest`) is a genuine, useful discovery beyond what the brief
  assumed existed, and is worth re-checking if Anthropic documents the outcome
  side of it later — but closing the loop currently requires depending on
  either an undocumented transcript detail or scraping model-facing rejection
  text, both fragile. This lands the same place as §1's rotation/PII gaps: real
  gaps, not solved by any prior art found, and not worth a bespoke solution for
  a "best-effort" section.

## Sources

- [Hooks reference — code.claude.com](https://code.claude.com/docs/en/hooks) (official; PostToolUse/PreToolUse/PermissionRequest/PermissionDenied schemas and event list)
- [GitHub Copilot CLI hooks tutorial — docs.github.com](https://docs.github.com/en/copilot/tutorials/copilot-cli-hooks) (official; audit.jsonl redaction example)
- [Dicklesworthstone/destructive_command_guard](https://github.com/Dicklesworthstone/destructive_command_guard)
- [disler/claude-code-hooks-mastery](https://github.com/disler/claude-code-hooks-mastery)
- [timoconnellaus/define-claude-code-hooks](https://github.com/timoconnellaus/define-claude-code-hooks)
- [Codex CLI Advanced Configuration (OTel) — developers.openai.com](https://developers.openai.com/codex/config-advanced) (official)
- [Codex CLI Agent approvals & security — developers.openai.com](https://developers.openai.com/codex/agent-approvals-security) (official)
- [anthropics/claude-code#19115](https://github.com/anthropics/claude-code/issues/19115) — PreToolUse vs PostToolUse output schema inconsistency
- [anthropics/claude-code#29499](https://github.com/anthropics/claude-code/issues/29499) and [#29238](https://github.com/anthropics/claude-code/issues/29238) — informal evidence of the manual-rejection tool-result string (UNVERIFIED as stable API)
- [Inside Claude Code: The Session File Format — databunny.medium.com](https://databunny.medium.com/inside-claude-code-the-session-file-format-and-how-to-inspect-it-b9998e66d56b) (third-party, transcript structure)
