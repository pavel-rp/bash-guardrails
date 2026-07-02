---
name: tune-rules
description: Analyzes recent Claude Code transcripts on this machine to find permission-prompt hotspots and proposes bash-guardrails rule or config changes — ALLOW candidates from frequent ask-tier commands, false-positive review of BLOCK rules, deny evidence from manual rejections, and per-rule steering effectiveness. Use when the user asks to tune the guardrails, check whether new rules should be added, review permission prompts, or reduce prompting friction.
---

<objective>
Turn real usage data into guardrail tuning proposals. A bundled analyzer mines
the machine's Claude Code transcripts (read-only), replays every unique shell
command through the CURRENT hook, and reports where prompts actually happen.
You interpret that report, present ranked proposals with evidence, and — only
with explicit per-item approval — apply them via the right channel.
</objective>

<context>
The hook (hooks/guardrails.js next to this skill's plugin root) classifies
each Bash/PowerShell command: DENY (destructive), BLOCK (obfuscation-prone,
instructive reason), ALLOW (auto-approve), or fall through to Claude Code's
normal prompt (the "ask" tier). Every rule has a stable id and tier.

Two apply channels exist, and they are not interchangeable:
- **User/project config** (`~/.claude/bash-guardrails.json` or
  `<project>/.claude/bash-guardrails.json`, schema `"version": 1` — see the
  plugin README "Configure without forking"): personal tuning. Fields:
  `extraAllowCommands`, `ruleOverrides` (`"deny"|"ask"|"off"`),
  `disabledRules`, `extraDenyRules`, `extraBlockRules`; PowerShell-scoped
  variants under `"powershell"`. A deny-tier rule can be loosened to ask but
  never turned off (the hook clamps it).
- **Plugin change** (edit rule arrays in `guardrails.js` + add tests + bump
  `version` in BOTH `plugin.json` and `marketplace.json`): only when the
  finding generalizes beyond this user AND you are working inside the
  bash-guardrails repo checkout. Follow that repo's CLAUDE.md invariants.
</context>

<quick_start>
Run the analyzer as ONE plain command — never wrap it in pipes, chains, or
redirects (this plugin blocks those):

```
node "${CLAUDE_SKILL_DIR}/scripts/analyze.js" --days 30
```

It prints one JSON report to stdout (progress on stderr; a large history can
take a minute or two — it replays every unique command through the hook).
Flags: `--days N` widens/narrows the window, `--max-examples N` caps example
lists.
</quick_start>

<workflow>
1. **Collect**: run the analyzer (quick_start). If it fails, report the stderr
   output and stop — do not hand-mine transcripts as a fallback.
2. **Interpret** each report section with the judgment criteria below. The
   script only counts; safety judgment is yours.
3. **Report** to the user, ranked by prompts eliminated: for each proposal
   give the evidence (counts, projects, sanitized examples), the recommended
   channel (user config / project config / plugin change / keep as prompt),
   and any safety caveat. Include a "leave alone" section for hotspots that
   should stay prompts, with the reason.
4. **Apply only what the user approves, item by item.** For config changes:
   read the existing config file first, merge (never clobber unrelated keys),
   write, then remind the user the hook picks it up on the next command — but
   an updated PLUGIN (vs config) needs a Claude Code restart. For plugin
   changes: rule + test/run.js cases + version bump, on a feature branch.
</workflow>

<judgment_criteria>
**ALLOW candidates** (`allowCandidates`): propose a token for
`extraAllowCommands` (or plugin `ALLOW_COMMANDS`) only when ALL hold:
- Meaningful volume: as a guide, ≥10 ask-tier runs across ≥2 projects for a
  user-config proposal; near-universal, any-machine usefulness for a plugin
  proposal.
- You can articulate why the command class is safe (read-only, or its
  destructive forms are already denied / would get a paired deny or
  never-auto-allow rule — say which, e.g. `mv` was only allow-listed together
  with an `mv -f` demotion).
- `nestedShell: true` candidates (bash, sh, pwsh, cmd, sudo, …) are NEVER
  proposed for allow-listing, whatever the count — an opaque script or nested
  shell defeats the string-scan model. Explain this in the report instead. A
  user who trusts one specific script can add a narrow
  `Bash(bash /path/to/that-script.sh:*)` rule to settings.json themselves.
- High `denyRunsSameToken`/`blockRunsSameToken` alongside the ask runs is a
  danger signal: the token has risky forms; check what they were before
  proposing anything.

**Block review** (`blockReview`): for each rule still blocking, decide from
the examples whether the hits are true positives (the guidance is doing its
job — steering away from pipes/heredocs), false positives (pattern fires
inside a quoted string or filename — candidate for a masking/regex fix in the
plugin), or a workflow the user should change. Never propose deleting a rule
just because it fires often — firing often can mean it is working. Check
`steering`: a rule with high blocks but a LOW recoveryRate has guidance text
that is not steering successfully — propose better wording for its `reason`.

**Rejections** (`rejections`): commands the user manually refused. Recurring
shapes are deny/ask-rule evidence. A handful of one-offs usually just means
the user redirected the session — say so rather than inventing rules.

**Deny-tier loosening**: if the data shows a deny rule repeatedly hitting
legitimate work, the remedy is `ruleOverrides: {"<rule-id>": "ask"}` in the
user config — never propose removing a deny rule from the plugin.
</judgment_criteria>

<privacy>
The report's examples are pre-redacted, but you must still eyeball anything
you quote — commit messages and paths can carry project-private context. Keep
the raw JSON local: never paste the full report into a PR, issue, or commit.
Aggregate counts are always fine to share.
</privacy>

<anti_patterns>
- Applying any change — config or plugin — without explicit per-item approval.
  A guardrails plugin that silently loosens itself is broken by design.
- Proposing allow-listing for nested shells/interpreters or inline-eval forms
  (`node -e`, `python -c`, package runners like `npx`). These are ask-tier on
  purpose: the deny scan cannot see inside them.
- Overwriting `bash-guardrails.json` wholesale instead of merging into it.
- Running the analyzer through a pipe/chain, or re-implementing it with ad-hoc
  shell one-liners (`grep`+`jq` over transcripts) — one `node` call is the
  supported, auto-approved path.
- Treating executed-command counts as "user approved this" evidence — the
  report cannot distinguish auto-approval from prompted approval, and says so.
</anti_patterns>

<success_criteria>
- The analyzer ran as a single command and its JSON parsed.
- Every proposal in the report carries counts + at least one sanitized
  example + a channel + a safety judgment; nested-shell and interpreter
  candidates were explained, not proposed.
- Nothing was written without the user approving that specific item; config
  writes merged rather than replaced; plugin edits came with tests and a
  version bump in both manifests.
</success_criteria>
