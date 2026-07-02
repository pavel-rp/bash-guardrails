# A. Ecosystem & obsolescence check

Search date: 2026-07-02. Claude Code version at time of research: **v2.1.198**
(published 2026-07-01) — [releases](https://github.com/anthropics/claude-code/releases).
Docs cited are the live pages at `code.claude.com/docs`, which are versioned
inline (e.g. "as of v2.1.195") rather than snapshotted, so re-check dates if
reading this later. This document answers Research Question A only; it does
not restate or duplicate B–E.

---

## 1. Claude Code's native command permission machinery

Claude Code's own permission stack turns out to be **four distinct, independently-evolving
layers**, not one. bash-guardrails' README describes only the middle two (the
undocumented safety classifier, and the `Bash(...)` allowlist). The other two —
auto mode's LLM classifier, and OS-level sandboxing — did not exist when this
project's threat model was written and materially change the obsolescence picture.

| Layer | What it is | Runs when | Documented? |
|---|---|---|---|
| Built-in Bash "safety heuristic" | String-pattern checks for obfuscation (heredocs, brace expansion, quote desync, control chars, etc.) that force a manual prompt even for allowlisted commands | Before permission rules, on every Bash/PowerShell call | **No** — not in any official doc page; only knowable via reverse-engineering and user bug reports |
| `permissions.allow/ask/deny` (`Bash(...)`) | User/project/managed allow-ask-deny rules with wildcard and compound-command matching | After the safety heuristic, before execution | Yes — [`/en/permissions`](https://code.claude.com/docs/en/permissions) |
| Auto mode classifier | A separate LLM call that judges each *already-permitted* action against intent/scope/infra-trust | Only in `auto` permission mode (research preview, gated) | Yes — [`/en/permission-modes`](https://code.claude.com/docs/en/permission-modes), [`/en/auto-mode-config`](https://code.claude.com/docs/en/auto-mode-config) |
| Sandboxed Bash (`/sandbox`) | OS-level filesystem/network isolation (Seatbelt / bubblewrap) for the Bash tool's process tree | Opt-in, wraps every sandboxed Bash command regardless of mode | Yes — [`/en/sandboxing`](https://code.claude.com/docs/en/sandboxing) |

### 1.1 `Bash(...)` permission rule syntax and matching semantics

Fully documented at [`/en/permissions`](https://code.claude.com/docs/en/permissions). Key
mechanics, several of which are more sophisticated than they were when
bash-guardrails' invariants were written:

- **Format**: `Tool` (all uses) or `Tool(specifier)`. `Bash` and `Bash(*)` are
  equivalent and both strip the tool from Claude's context as a deny rule.
- **Wildcards**: `*` matches any sequence including spaces, at any position.
  `Bash(ls *)` requires a word boundary (matches `ls -la`, not `lsof`);
  `Bash(ls*)` has no boundary. `:*` is sugar for a trailing ` *` but is *only*
  recognized at the end — `Bash(git:* push)` treats the `:` as literal.
- **Evaluation order is fixed**: deny → ask → allow, first match wins,
  specificity never reorders it. A broad `Bash(aws *)` deny beats a narrower
  matching allow.
- **Claude Code is shell-operator-aware for matching purposes.** It recognizes
  `&&`, `||`, `;`, `|`, `|&`, `&`, and newlines as separators and requires a
  rule to match *each subcommand independently* — `Bash(safe-cmd *)` does not
  license `safe-cmd && other-cmd`. When a user approves a compound command with
  "don't ask again," Claude Code decomposes it into up to 5 per-subcommand
  rules automatically.
- **Process-wrapper stripping**: `timeout`, `time`, `nice`, `nohup`, `stdbuf`,
  and bare (flagless) `xargs` are stripped before matching, so `Bash(npm test *)`
  covers `timeout 30 npm test`. This list is hardcoded and not configurable.
  Env-runners (`direnv exec`, `devbox run`, `npx`, `docker exec`) are explicitly
  **not** stripped, and the docs warn that a rule like `Bash(devbox run *)`
  therefore also matches `devbox run rm -rf .` — the same "allow-listed leading
  token, arbitrary trailing exec" hole bash-guardrails' `NEVER_AUTO_ALLOW` tier
  exists to catch for `node -e`/`python -c` etc.
- **Built-in always-allowed read-only set (Bash only, not configurable)**: `ls`,
  `cat`, `echo`, `pwd`, `head`, `tail`, `grep`, `find`, `wc`, `which`, `diff`,
  `stat`, `du`, `cd` (into an in-scope directory), and read-only `git` forms run
  with **zero prompt in every permission mode**, including `default`. This is a
  genuinely new (post-dates the project's design) native feature — see §1.5.
- **`find`/`sort`/`sed`/other write-capable-flag commands still prompt** on an
  unquoted glob because the glob could expand to a dangerous flag like `-delete`.
  `find -exec`/`find -delete` never match a prefix rule like `Bash(find *)` —
  they always require an exact-match rule. This directly parallels
  bash-guardrails' `NEVER_AUTO_ALLOW` treatment of `find -exec`.
- **Exec wrappers `watch`, `setsid`, `ionice`, `flock` always prompt**, can't be
  prefix-approved.
- **Parameter-matching escape hatch, explicitly closed**: `Bash(command:rm *)`
  is rejected at startup with a warning specifically because "a compound
  command" would bypass it — Claude Code's own docs state the same reasoning
  bash-guardrails' `DENY_RULES` invariant gives for scanning the whole string.
- **Fragile URL/argument-constraint patterns are called out directly** in a
  `<Warning>` block: `Bash(curl http://github.com/ *)` is shown failing against
  flag-reordering, protocol swaps, redirects, and variable indirection — the
  official recommended fix is a **PreToolUse hook**, i.e. exactly what
  bash-guardrails is.

### 1.2 PowerShell rule syntax — more advanced than Bash's

This is the single most important native-roadmap finding for this project,
since bash-guardrails maintains a hand-written PowerShell tier as a Windows-specific
mirror of its Bash rules.

> "Claude Code parses the PowerShell AST and checks each command in a compound
> command independently. Pipeline operators `|`, statement separators `;`, and
> on PowerShell 7+ the chain operators `&&` and `||` split a compound command
> into subcommands." — [`/en/permissions`](https://code.claude.com/docs/en/permissions)

So the *native* PowerShell matcher is already AST-based (not regex), already
splits pipelines/chains correctly, and already canonicalizes aliases (a rule
for `Get-ChildItem` also matches `gci`, `ls`, `dir`) and does so
case-insensitively. This is strictly more correct than bash-guardrails'
regex-over-string `decidePowershell`, and strictly more correct than Claude
Code's own *Bash* matcher (which is not shown anywhere to be AST-based — the
compound-splitting described in §1.1 reads as operator-tokenization, not a
full parse). **Native PowerShell permission matching is a plausible partial
obsolescence candidate** for the "get the allow/deny matching right" part of
bash-guardrails' PowerShell tier — but matching is not the same job as
*judgment*: Claude Code's AST parser decides whether a rule's pattern matches a
subcommand, not whether an unlisted subcommand is destructive. bash-guardrails'
`PS_NEVER_AUTO`/`PS_DENY_RULES` still supply judgment the platform doesn't ship
a default opinion on (see §1.5).

The PowerShell tool itself is **not universally on by default**: per
[`/en/tools-reference`](https://code.claude.com/docs/en/tools-reference) —
"On Windows without Git Bash, the tool is enabled automatically. On Windows
with Git Bash installed, the tool is rolling out progressively. On Linux,
macOS, and WSL, the tool is opt-in" via `CLAUDE_CODE_USE_POWERSHELL_TOOL=1`.
Preview limitations listed there include **"On Windows, sandboxing is not
supported"** for the PowerShell tool specifically, and "PowerShell profiles
are not loaded."

### 1.3 The built-in command-safety/obfuscation classifier — undocumented, but real and independently confirmed

bash-guardrails' own README quotes two exact classifier messages:
`"Contains brace with quote character (expansion obfuscation)"` and
`"Compound command contains cd with output redirection"`. Neither string
appears in any official Anthropic doc page. This is **not** documented
anywhere on `code.claude.com` — the closest official acknowledgment is the
generic bullet in [`/en/security`](https://code.claude.com/docs/en/security):
"**Command injection detection**: Suspicious bash commands require manual
approval even if previously allowlisted" and "**Fail-closed matching**:
Unmatched commands default to requiring manual approval." No rule list, no
message catalog, no config surface.

Independent, primary-source confirmation that this classifier is real, fires
pre-permission, and cannot be silenced by an allow rule comes from Claude Code's
own issue tracker (all four opened by unrelated users hitting it in production):

- [#203, Alishahryar1/free-claude-code](https://github.com/Alishahryar1/free-claude-code/issues/203) —
  "Command contains brace with quote character (expansion obfuscation)."
- [#30345, anthropics/claude-code](https://github.com/anthropics/claude-code/issues/30345) —
  quote-character-inside-a-`#`-comment desync prompts on safe commands.
- [#28183, anthropics/claude-code](https://github.com/anthropics/claude-code/issues/28183) —
  compound commands of individually-allowed safe commands still prompt, "with
  incorrect safety reason."
- [#43713, anthropics/claude-code](https://github.com/anthropics/claude-code/issues/43713) —
  `autoAllowBashIfSandboxed` bypassed for commands with shell expansions.
- [#30435, anthropics/claude-code](https://github.com/anthropics/claude-code/issues/30435) —
  feature request to let settings suppress "bash safety heuristic" prompts;
  open, unresolved as of this search.
- [#31523, anthropics/claude-code](https://github.com/anthropics/claude-code/issues/31523) —
  opened 2026-03-06, 13 linked duplicate issues, **open with no maintainer
  response** as of this search. Documents a user who accumulated 150+
  `settings.local.json` rules over 3 months specifically because compound
  `cd && git status` kept re-prompting despite both halves being individually
  allowed, and had to reverse-engineer the undiscoverable `Bash(*)` escape
  hatch from source to get relief.

A community reverse-engineering write-up,
[deep-dive-claude-code.vercel.app/source/bashSecurity](https://deep-dive-claude-code.vercel.app/source/bashSecurity)
(explicitly **not** an Anthropic source — reconstructed from the shipped,
obfuscated `cli.js`; treat as **UNVERIFIED in detail, though directionally
corroborated** by the issues above), claims the module is
`src/tools/BashTool/bashSecurity.ts` with 23 named checks: incomplete commands,
`jq` `system()`, `jq` dangerous file args, obfuscated flags, shell
metacharacters, dangerous vars in redirections, embedded newlines, command
substitution (`$()`, backticks, `${}`), input/output redirection, IFS
injection, git-commit substitution, `/proc/*/environ` access, malformed token
injection, backslash-escaped whitespace, brace-expansion obfuscation, control
characters, unicode whitespace, mid-word `#`, zsh-dangerous builtins,
backslash-escaped operators, comment-quote desync, and quoted newlines — plus
ANSI-C quoting, empty-quote obfuscation, heredoc detection, and process
substitution as additional pattern families. The write-up states the code
contains no Windows-specific branching and (per its read) is Bash-only, with no
documented interaction with `PreToolUse` hooks visible in the excerpt it
analyzed.

**Why this matters for bash-guardrails**: this confirms bash-guardrails' central
design thesis (block obfuscation-prone forms so Claude *stops writing them*,
rather than trying to approve them) is aimed at a real, still-undocumented,
still-user-hostile native subsystem — issue #31523 is dated 2026-03-06 and is
still open, i.e. the friction bash-guardrails exists to route around has **not**
been fixed by the platform. But note the asymmetry: the native heuristic
*always asks*, never *silently denies-with-guidance*. bash-guardrails' BLOCK
tier converts "ask forever" into "auto-reject once with a rewrite hint," which
the native classifier structurally cannot do (it has no channel back to the
model explaining *why*, beyond the terse message strings above) — this remains
bash-guardrails' most durable, hardest-to-replicate value.

### 1.4 Auto mode's classifier — a second, separate, LLM-based gate

Distinct from §1.3. [`/en/permission-modes`](https://code.claude.com/docs/en/permission-modes)
and [`/en/auto-mode-config`](https://code.claude.com/docs/en/auto-mode-config)
document this in detail (**research preview**, requires Claude Code ≥v2.1.83,
gated by plan/Owner-enablement on Team/Enterprise, and by model — Opus 4.6+/
Sonnet 4.6+ on the Anthropic API only; older models including Sonnet 4.5 and
Opus 4.5 are unsupported on any provider). It is a **model call**, not a rule
engine: "A separate classifier model reviews actions before they run, blocking
anything that escalates beyond your request, targets unrecognized
infrastructure, or appears driven by hostile content Claude read." Costs real
latency and tokens ("Each check sends a portion of the transcript plus the
pending action, adding a round-trip before execution") — the opposite of
bash-guardrails' <100ms/offline/zero-dependency constraint, so it is not a
substitute engineering approach, only a substitute *outcome* for users who can
afford it.

Directly relevant to this project's confirmed-holes list — **as of Claude Code
v2.1.182, auto mode's classifier defaults now explicitly block**:
`git reset --hard`, `git checkout -- .`, `git restore .`, `git clean -fd`,
`git stash drop`, `git stash clear` ("which the classifier presumes would
discard uncommitted changes"), plus force-push/push-to-main, and
`git commit --amend` on a commit not created in-session. These are close to a
one-for-one match with the "Confirmed holes" the research brief lists for
bash-guardrails (`git stash drop`/`clear`, `git restore .`, `git checkout .`).
**If a user has auto mode enabled**, several of bash-guardrails' proposed new
DENY rules (catalog work, section C) would be redundant with what the platform
already blocks. But auto mode is opt-in, gated, costs tokens/latency per
action, is explicitly "not a replacement for review on sensitive operations,"
and — critically — **user-stated intent can override its soft-deny rules**
("asking Claude to force-push this branch" authorizes it), which is a
deliberately different security posture from bash-guardrails' unconditional
DENY_RULES. It also has a fallback-to-prompting circuit breaker (3 consecutive
or 20 total blocks) and is a *default*-mode setting only in `~/.claude/settings.json`
(project settings cannot self-grant it, since v2.1.142).

Also notable: `autoMode.classifyAllShell` (≥v2.1.193) can force *every* Bash/
PowerShell command through the classifier, trading latency for coverage — this
is the platform's own acknowledgment that narrow allow rules can smuggle
destructive arguments through un-inspected, the same failure mode
bash-guardrails' `ALLOW`-only-for-non-chained-commands invariant defends
against.

### 1.5 Sandboxed Bash (`/sandbox`) — Windows is explicitly and permanently excluded from the *native binary*, but not from the ecosystem

Fully documented at [`/en/sandboxing`](https://code.claude.com/docs/en/sandboxing),
corroborated by [Anthropic's engineering post](https://www.anthropic.com/engineering/claude-code-sandboxing)
(84% reduction in permission prompts, internal usage figure).

| Platform | Mechanism | Status |
|---|---|---|
| macOS | Seatbelt (built-in, nothing to install) | Supported |
| Linux | bubblewrap + socat, optional seccomp helper | Supported |
| WSL2 | bubblewrap (same as Linux) | Supported |
| WSL1 | — | **Not supported** — "bubblewrap requires kernel features only available in WSL2" |
| **Native Windows** | — | **"Native Windows is not supported. On Windows, run Claude Code inside a WSL2 distribution."** (verbatim, `/en/sandboxing`) |
| PowerShell tool (any platform) | — | **"On Windows, sandboxing is not supported"** even when the PowerShell tool itself is enabled (`/en/tools-reference`, Preview limitations) |

The docs are direct about the intended remediation for fleets with Windows
hosts: "The sandbox does not run on native Windows, so if your fleet includes
Windows hosts, scope this configuration to macOS and Linux or have those users
run Claude Code inside WSL2 or a container."

**This is not an inherent platform ceiling** — worth flagging because it looks
durable but may not be permanent. OpenAI's Codex CLI already ships a *native*
Windows sandbox distinct from its Linux/WSL2 path: "Codex utilizes the native
Windows sandbox when you run in PowerShell" vs. "the Linux sandbox
implementation" under WSL2
([developers.openai.com/codex/concepts/sandboxing](https://developers.openai.com/codex/concepts/sandboxing)).
So a native-Windows OS-level sandbox for an agentic CLI is demonstrated
feasible by a direct competitor today; Claude Code choosing not to ship one
yet is a product-prioritization gap, not a technical wall. Treat "no native
Windows sandbox" as durable **for now**, not indefinitely.

Sandboxing and permission rules are explicitly described as complementary, not
substitutive, layers — sandboxing restricts *what a Bash command can touch at
the OS level*; it does nothing about *whether Claude decides to run a given
command* or about non-Bash tools. Even with sandboxing on, `rm`/`rmdir`
targeting `/`, home, or other critical paths still force a prompt as a "circuit
breaker," and `autoAllowBashIfSandboxed` (default true) auto-runs sandboxed
commands but content-scoped `ask` rules (e.g. `Bash(git push *)`) and explicit
deny rules still apply on top.

### 1.6 Anthropic's own "config without forking" move: the `hookify` plugin

Anthropic ships an official first-party plugin,
[`plugins/hookify`](https://github.com/anthropics/claude-code/tree/main/plugins/hookify),
that turns PreToolUse hook authoring into a conversational, markdown-frontmatter
workflow instead of hand-edited `hooks.json`/JS. Directly relevant context for
this project's own §D research (config-without-forking), and marginally
relevant here: **it ships zero default rules**. Its README uses `rm -rf`, `dd`,
`mkfs` purely as illustrative examples of rules a user *could* author — it is a
rule-authoring UX layer, not a maintained destructive-command ruleset. It does
not compete with bash-guardrails' actual content (the curated DENY/BLOCK/ALLOW
arrays); it competes, if anything, with the *installation/configuration*
mechanism (see the project's own §D deliverable).

### 1.7 Net effect: which parts of bash-guardrails does the native roadmap plausibly obsolete?

See the summary table at the end of this document. In prose: the native
platform has gotten meaningfully better since this project's design (real
Bash-operator-aware compound splitting, a genuinely AST-based PowerShell
matcher, a built-in always-safe read-only command list, and — for a gated
subset of paying/Opus-tier users — an LLM classifier that already blocks most
of the git-data-loss holes in the research brief). None of this replaces
bash-guardrails' core value (a maintained, offline, zero-latency, zero-cost,
*always-on-regardless-of-plan* default deny/block/allow list that fires for
every user on every plan), and the Windows-native gap (no sandbox, no built-in
read-only auto-allow list documented for PowerShell, no default PowerShell
deny list) is real and currently unaddressed by the platform.

---

## 2. Existing Claude Code guardrail hooks/plugins/marketplaces

GitHub search (`gh search repos "PreToolUse" guardrails`, `"claude code hooks" security bash`,
plus targeted lookups) surfaces a **large but extremely shallow and fragmented**
field: dozens of repos, nearly all created in 2026, nearly all at 0–2 stars,
nearly all single-contributor and inactive within weeks of creation. There is
no dominant, actively-maintained community project in this space as of this
search. The table below covers every candidate found with double-digit stars
or a genuinely distinct technical approach.

| Project | Stars | Created | Last push | Approach | Coverage | Config story | Notes |
|---|---|---|---|---|---|---|---|
| [lasso-security/claude-hooks](https://github.com/lasso-security/claude-hooks) | 254 | 2026-01-07 | 2026-01-08 | Python regex, **PostToolUse** (not PreToolUse) | Prompt-injection patterns in *tool output* (jailbreak phrases, encoding, context manipulation) — **not destructive-command detection** | `patterns.yaml`, severity levels, `test-defender.py` harness | Solves an adjacent, different problem (indirect prompt injection from file/web content), not shell-command safety. Highest star count in the search precisely because it's marketed for a broader/scarier threat (injection), not because it's a stronger guardrail. |
| [rulebricks/claude-code-guardrails](https://github.com/rulebricks/claude-code-guardrails) | 74 | 2026-01-15 | 2026-02-04 | **External cloud API** — PreToolUse hook calls the Rulebricks SaaS, which returns allow/deny/ask | User-defined via dashboard templates for Bash/Read-Write-Edit/MCP matchers | `RULEBRICKS_API_KEY` env var + dashboard-authored rules; self-host option exists | Introduces a network dependency and per-call latency/availability risk into every Bash command — directly opposed to this project's offline/cold-start constraints. Interesting as a "how far will people go to avoid regex" data point, not as prior art to copy. |
| [dwarvesf/claude-guardrails](https://github.com/dwarvesf/claude-guardrails) | 25 | 2026-03-01 | 2026-06-04 | Regex over raw string, plus a separate `UserPromptSubmit` credential scanner and (full variant only) a `PostToolUse` injection scanner | 21 deny rules (lite) / 40 (full) — SSH/AWS/GCP keys, shell profiles, wallets, `sudo`, `mkfs`, `dd`, `rm -rf`, pipe-to-shell; 4 (lite) / 6 (full) PreToolUse hooks | Two ready-made variants, no runtime config beyond choosing the variant | Closest philosophical match to bash-guardrails: README states verbatim **"Pattern-based hooks and deny rules are defense in depth, not a security boundary. A sufficiently clever prompt injection can rephrase or obfuscate commands around any regex we ship."** — nearly identical framing to this project's own Trade-offs section. Worth studying its lite/full split as a config-tiering pattern (relevant to §D). macOS/Linux only, no Windows mention. |
| [kylemillerbuilds/agent-guardrails](https://github.com/kylemillerbuilds/agent-guardrails) | 1 | ~2026-06 | 2026-06-28 | Regex with **command-start anchoring** (only matches a dangerous pattern when it begins a command — after `;`/`&`/`\|`/`(` or at string start) and explicit **heredoc-body stripping** before matching | Narrow, 7 rules: no git worktree/branch creation, no broad `git add -A`/`.`/`--all`, no rm/mv on a configurable protected-dirs list, `launchctl load` warning, plus 3 advisory-only checks | Single `guard.sh`, `GUARD_PROTECTED_DIRS` env var | **Two techniques worth stealing outright for §B/§C**: (1) command-start anchoring is a cheap, direct answer to this project's confirmed false positives like `grep -n "tail" ...` — anchor `DENY_RULES`/`BLOCK_RULES` patterns to only fire after a command boundary, not anywhere in the string; (2) explicit heredoc-body stripping before regex matching is exactly the "sanitize then regex" pattern §B is scoped to investigate. Its README states an explicit **"fail-open, always"** design principle: "Any parsing error, missing dependency, or unmatched input permits the command to execute" — worth weighing against bash-guardrails' current implicit fail-open-via-empty-`{}`-output behavior; making it an explicit, tested invariant (with a wrapped-try/catch at the hook's entry point) would be a cheap robustness win. |
| [mafiaguy/claude-security-guardrails](https://github.com/mafiaguy/claude-security-guardrails) | 2 | 2026-02-19 | 2026-02-19 (one day) | Regex, PreToolUse + PostToolUse, "30+ risky patterns" | `rm -rf`, force pushes, leaked API keys, SQL injection, `eval()` | Bundled with a React dashboard for reviewing blocked events | One-day project, effectively abandoned. Notable only for the dashboard idea (visualizing what got blocked) — tangential to §E telemetry, not core rule-engine prior art. |

**Long tail** (all 0–1 stars, listed for completeness of the search, not
individually analyzed): `OutBlade/claude-code-hooks`, `kubouchiyuya/komainu`
(clone-time malware/exfiltration scanning, a different lifecycle stage than
PreToolUse command gating), `Rouhaiseki/claude-safety-suite` ("EnvShield"/
"NoNuke"), `xaversebastian/claude-guardrails`, `web-werkstatt/claude-code-guardrails`,
`songxinjianqwe/claude-code-guardrails`, `MilesUzbekus/max-ops-hook`,
`javi-salazar/claudeops-guardrails-demo`, `vxfactor/business-os-guardrails-audit`,
`cocodding0723/claude-harness-boilerplate`, `otmanm/ai-agent-guardrails-kit`.
Also found: [`efij/awesome-claude-code-security`](https://github.com/efij/awesome-claude-code-security)
(a curated security-resource list, not a guardrail itself) and the general
[`hesreallyhim/awesome-claude-code`](https://github.com/hesreallyhim/awesome-claude-code)
list, neither of which currently features bash-guardrails or a
best-in-class command-guardrail entry prominently — **UNVERIFIED** whether
bash-guardrails is indexed there; not confirmed either way in this search.

**Cross-cutting findings for this survey**:

- **No community project uses a real shell parser or tree-sitter.** Every
  command-gating project found (as opposed to Anthropic's own native Bash
  matcher, §1.1–1.2) uses plain regex over the raw string, same as
  bash-guardrails. This somewhat de-risks the regex approach reputationally
  (it's the ecosystem norm, not an outlier), but doesn't validate it technically
  — see the project's own §B for the parsing-quality ceiling question.
- **No project ships stable rule IDs, a config schema, or a Claude-Code-native
  settings surface** beyond ad hoc env vars — relevant negative evidence for
  §D (nobody has solved "configuration without forking" better than this
  project already, so there's no prior art to copy there from this survey).
- **The self-declared "not a security boundary" framing is now common
  language** across at least three independent projects (bash-guardrails,
  dwarvesf/claude-guardrails, kylemillerbuilds/agent-guardrails) and echoed
  verbatim in Cursor's own official docs (§3) — this appears to be settling
  into a shared community/industry convention for how to talk about
  regex-based agent guardrails, not a one-off disclaimer.
- **Nothing worth adopting wholesale.** The two genuinely reusable ideas —
  command-start anchoring and heredoc-stripping-before-regex — are both small,
  targeted techniques from the 1-star `agent-guardrails` repo, not full
  systems. No project in this survey is more architecturally sophisticated
  than bash-guardrails; several (rulebricks, mafiaguy) are arguably worse
  engineering (network dependency; one-day abandonment).

---

## 3. Shell-command allowlisting conventions in other agent CLIs

| CLI | Classification mechanism | Rule format | Ships a default ruleset? | Windows | Sandboxing |
|---|---|---|---|---|---|
| **Codex CLI** (OpenAI) | Argument-list matching via `execvp`-style tokenization; **tree-sitter parses** linear `&&`/`\|\|`/`;`/`\|` chains into per-command decisions; anything with redirection/substitution/variables/control-flow is treated as one opaque `bash -lc "<script>"` invocation | Starlark DSL, `prefix_rule(pattern=[...], decision="allow"/"prompt"/"forbidden", justification=...)`. Most-restrictive-wins across matching rules. `codex execpolicy check` to test a rule set against a command. | **No** — `~/.codex/rules/` starts empty; approved commands during a session get written there as you go | **Native Windows sandbox** distinct from the Linux/WSL2 path — PowerShell sessions get a first-class native sandbox, WSL2 sessions get the Linux (bubblewrap-style) sandbox — [developers.openai.com/codex/concepts/sandboxing](https://developers.openai.com/codex/concepts/sandboxing) | Yes, all platforms including native Windows |
| **Gemini CLI** (Google) | Simple prefix/tool-name string matching, no evidence of parsing | `tools.allowed: ["run_shell_command(git)", "run_shell_command(npm test)"]`; `tools.core` (allowlist of built-in tools), `tools.exclude`, `tools.confirmationRequired` (takes precedence over allow) — [github.com/google-gemini/gemini-cli settings.md](https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/settings.md), [geminicli.com/docs/reference/configuration](https://geminicli.com/docs/reference/configuration/) | No — user-authored `settings.json` only | Not specifically documented in the fetched pages — **UNVERIFIED** | Optional Docker-based sandbox (`"sandbox": "docker"` config key); YOLO mode bypasses everything and can be locked off at a managed-policy level |
| **Cursor CLI/Agent** | **LLM classifier** in the default "Auto-review" mode ("runs allowlisted calls, sandboxes shell commands when it can, and routes the rest through an LLM classifier... returns allow or block based on safety and how well the call matches the user's intent") plus a separate best-effort allowlist mode | User-maintained allowlist of literal commands (`npm install`, `pip install`, `cargo build`, `make test`); a denylist mode existed and is explicitly being phased out in favor of allowlist | No | Not detailed in sources reviewed — **UNVERIFIED** | Sandboxing described as best-effort, "when it can" |
| **OpenHands** | **None at the command level.** No allowlist, no classifier, no regex layer found in current docs. Safety is delegated entirely to Docker container isolation (`DockerWorkspace`) | N/A | N/A | **UNVERIFIED** (not covered in sources reviewed) | Docker is the *only* isolation boundary; docs note local (non-Docker) mode "lacks the hardened features" of the Docker sandbox, and third-party writeups report destructive commands running directly on the host in local mode — [docs.openhands.dev/sdk/guides/agent-server/docker-sandbox](https://docs.openhands.dev/sdk/guides/agent-server/docker-sandbox) |

**Officially documented, explicit security caveats matching bash-guardrails'
own framing**, found in two competitors' own docs:

- Codex: "the most restrictive decision wins" — same first-match/most-restrictive
  precedence design as bash-guardrails' DENY-before-BLOCK-before-ALLOW ordering
  and Claude Code's own deny-then-ask-then-allow order (§1.1).
- Cursor, verbatim from its own enterprise docs: **"The allowlist is
  best-effort, not a security boundary. Determined agents or prompt injection
  might bypass it."** — [cursor.com/docs/enterprise/llm-safety-and-controls](https://cursor.com/docs/enterprise/llm-safety-and-controls).
  This is essentially bash-guardrails' own README disclaimer, independently
  arrived at by a different vendor.
- Cursor also has two published GitHub security advisories directly on this
  theme: allowlist bypass via backticks/`$(cmd)` substitution
  ([GHSA-534m-3w6r-8pqr](https://github.com/cursor/cursor/security/advisories/GHSA-534m-3w6r-8pqr))
  and terminal-tool allowlist bypass via environment variables
  ([GHSA-82wg-qcm4-fp2w](https://github.com/cursor/cursor/security/advisories/GHSA-82wg-qcm4-fp2w)),
  plus independent research ("The Denylist Delusion,"
  [backslash.security](https://www.backslash.security/blog/cursor-ai-security-flaw-autorun-denylist))
  showing quote-splitting (`"e"cho`) defeats naive denylists. These are exactly
  the class of bypass this project's own README already disclaims as
  out-of-scope for a non-adversarial mistake-model — useful **external
  validation that the mistake-model framing (not adversarial) is the right
  scope boundary**, since even well-resourced competitors' allowlists fail
  against a genuinely adversarial actor.

**No agent CLI surveyed publishes a reusable, engine-agnostic destructive-command
classifier or rule set** that could be imported into bash-guardrails directly —
Codex's `.rules` files are Starlark tied to its own tokenizer, Gemini's
allowlist is bare strings with no accompanying "here is what's dangerous" data,
Cursor's is closed-source/LLM-based, OpenHands has none. This is directly
relevant to the project's own §C (destructive-command catalog): there is no
shortcut import path from any of these ecosystems; the catalog work is
original curation, though Codex's `hard_deny`/`soft_deny`/hard-vs-soft split
(mirrored, incidentally, in Claude Code's own `autoMode.hard_deny`/`soft_deny`/
`allow` three-tier model, §1.4) is a useful **tiering vocabulary** to borrow
for §C's DENY/ask/ignore categorization, distinguishing "never, regardless of
stated intent" from "blocked unless the user's message specifically names this
exact action."

---

## Obsoletes vs. durable gaps

| bash-guardrails feature | Native Claude Code roadmap status | Verdict |
|---|---|---|
| Bash `BLOCK_RULES` for heredocs, backticks, `$()`, redirection, obfuscation-prone forms | Native "safety heuristic" (§1.3) already blocks/prompts on nearly all of these — but only by *asking*, forever, with terse unconfigurable messages, and it's undocumented and has an open, unaddressed UX complaint thread (#31523, since 2026-03-06) | **Partially obsoleted in intent, not in outcome.** Keep — bash-guardrails converts an endless native prompt into a one-time auto-reject-with-guidance, which the platform structurally cannot do itself. |
| Bash `cat`/`head`/`tail` block-and-redirect-to-Read-tool rule | Native built-in read-only list (§1.1) already free-passes `cat`/`head`/`tail`/`grep`/etc. with **zero prompt**, in every mode, unconditionally | **Largely obsoleted for its original prompt-avoidance purpose.** The remaining rationale (steering to a cleaner tool, avoiding quote-blind false positives on filenames like `cat.png`) is a style preference, not a permission-friction fix — reconsider whether this BLOCK rule should be demoted or reworked given the false positives already confirmed in the research brief. |
| `ALLOW_COMMANDS` for common dev tools (`git`, `gh`, `npm`, `ls`, `grep`, …) | Native read-only list covers a subset (Bash only); the rest still requires either a hand-written `Bash(...)` allow rule or this hook | **Durable** — native coverage is Bash-only and partial; nothing free for `npm`, `git` (non-read-only), `pnpm`, `node`, etc. |
| `GIT_DENY_RULES` (force-push, `reset --hard`, `stash drop/clear`, `checkout -- .`, etc.) | Auto mode's classifier (§1.4) already defaults to blocking most of these as of v2.1.182 — **but only for users on `auto` mode**, which is gated by plan, Owner-enablement, and Opus 4.6+/Sonnet 4.6+ models, costs latency/tokens per call, and lets stated user intent override it | **Durable for the general case.** Only obsoleted for a narrow, opted-in, paying-tier slice of users; the free/default-mode population (arguably the primary bash-guardrails audience) gets none of this natively. |
| PowerShell tier: `PS_DENY_RULES`, `PS_NEVER_AUTO`, `PS_ALLOW_COMMANDS` | Native PowerShell rule *matching* is now AST-based and more correct than this project's regex (§1.2) — but matching precision is orthogonal to having any default judgment about what's destructive; there is no built-in PowerShell equivalent of the Bash read-only auto-allow list, and sandboxing explicitly does not cover the PowerShell tool at all, on Windows, ever (§1.5) | **Durable, and the single most Windows-specific reason this project justifies its existence.** |
| Sandboxed execution as an alternative security layer | `/sandbox` is real, documented, and effective — but explicitly, permanently (for now) unsupported on native Windows; requires WSL2 | **Durable Windows gap**, though flagged as *not an inherent platform limit* — Codex CLI already ships a native Windows sandbox, so Anthropic shipping one later is plausible, not implausible. |
| Zero-dependency, offline, <100ms Node hook architecture itself | Nothing in the native roadmap (permissions, auto mode, sandboxing, hookify) is a zero-cost, always-on-for-every-user substitute; auto mode is the closest conceptual analog and it's explicitly a paid/gated LLM call | **Durable** — this is the architectural niche the whole project occupies, and no native or third-party alternative surveyed matches it. |
| Configuration-without-forking (§D territory, noted here for context) | Anthropic ships `hookify` as an official rule-*authoring* UX, but with zero default rules — it's a tool for building what bash-guardrails already has, not a replacement for it | **Orthogonal, not obsoleting** — worth tracking for packaging/UX ideas, not a reason to abandon the current arrays. |
