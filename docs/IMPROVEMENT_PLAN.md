# bash-guardrails — improvement plan

Synthesized 2026-07-02 from the two research passes (`docs/research/SUMMARY.md`,
`06_transcript-mining.md`) plus the same-day audit. Every item below was
re-verified against the **current working tree** (v0.2.0, uncommitted) by
replaying commands through the actual hook — the research ran against v0.1.8,
so several of its recommendations are already done and are crossed off here
rather than re-planned.

## Already delivered by v0.2.0 (in the working tree — do not re-plan)

- Quote-aware masking (`maskQuotes`) for BLOCK/ALLOW tiers — kills the entire
  §4 false-positive corpus's biggest classes, **replay-confirmed**:
  `--jq '{head: …}'`, `--jq '… | …'`, pipes/`;`/`>` in commit messages, and
  filename hits (`cat.png`) all now `allow`.
- Catalog holes closed: `+refspec` force-push, `stash drop/clear`,
  `restore .`/`--worktree`/`checkout <dotpath>`, `branch --delete --force`/`-fd`
  → DENY; `npx`/`bunx`/`pnpm|yarn dlx`/`npm exec` → ask;
  PS `New-Item -Value` → BLOCK; PS pipe-into-interpreter → ask.
- cat/head/tail rule narrowed to command position (research SUMMARY #3's
  "separate smaller change", and most of #6's concern).
- Tests 65 → 94, all passing.

## Phase 0 — Ship it (now, no new code)

1. **Commit v0.2.0 on a `feat/` branch** (it's currently sitting on the
   `docs/readme-remote-marketplace` branch uncommitted), PR to `develop`,
   push, `/plugin marketplace update bash-guardrails`, restart. Until then
   every machine still runs cached 0.1.8 — all of the above is theoretical.
2. **Add CI**: a GitHub Actions workflow running `node test/run.js` on every
   PR. Trivial, and PR #1 already merged rule changes ungated.
3. **Fold the mined FP corpus into the test suite**: add the top historical
   false-positive shapes from `06_…` §4 as regression cases (the `--jq`
   object-key shape, the jq-pipe filter, the markdown-backtick PR-reply
   body). The masking work is only provably durable if these are pinned.

## Phase 1 — Remaining catalog rules → v0.3.0 (small, verified-open by probe)

All of these currently **silently allow** (or ask when they should deny):

| Change | Tier | Source |
|---|---|---|
| `git switch -f` / `--discard-changes` | DENY | 03_catalog (same data-loss class as `checkout <path>`) |
| PS `Stop-Computer` / `Restart-Computer` | DENY | 03_catalog |
| `git update-ref -d`, `reflog expire`, `gc --prune=now`, `filter-branch`, `worktree remove --force` | ask (`NEVER_AUTO_ALLOW`) | 03_catalog — ref surgery: rare, legitimate sometimes, never silent |
| `rm` → `ALLOW_COMMANDS` | allow | 06 §3: 146 uses, all single-file `rm -f`; recursive forms are hard-DENIED *before* the allow check, so this cannot reopen `-rf` |
| `sleep` → `ALLOW_COMMANDS` | allow | 06 §3: 66 uses, pure poll delays |
| `claude` → `ALLOW_COMMANDS` | allow | 06 §3: 35 uses, `--version`/`plugin validate` self-checks |
| `mv` → `ALLOW_COMMANDS` **paired with** `mv -f` → ask | allow+ask | 06 §3: 39 uses, all archival moves; bare `mv` can silently overwrite → the force form must prompt (the one candidate where "wrong execution" is possible) |
| PS `netsh wlan show *` (narrow — NOT bare `netsh`) | allow | 06 §3: 6 uses, read-only Wi-Fi diagnostics; bare netsh does firewall/interface writes |
| Document the **nested-shell invariant** in CLAUDE.md: `bash`/`sh`/`pwsh`/`powershell`/`cmd` must never enter `ALLOW_COMMANDS`/`PS_ALLOW` | docs | 03_catalog item 14 — the danger is a future mistake, not a present gap |
| Cleanup note: `perl`/`ruby` entries in `NEVER_AUTO_ALLOW` are unreachable (neither is allow-listed) — keep as defense-in-depth but comment why | docs | 06 §3 |

Replay-confirmed payoff: ~290 historical ask-prompts over 6 weeks (~48/week)
flip to silent allow, with zero rejected-command evidence against any of them.

## Phase 2 — Stable rule ids → v0.4.0 (refactor, no behavior change)

Give every entry in `DENY_RULES`/`GIT_DENY_RULES`/`BLOCK_RULES`/
`NEVER_AUTO_ALLOW` and the PS mirrors a kebab-case `id` plus a tier tag
(`deny`/`block`/`never-auto`). Add a wire-test asserting ids are unique.
This is the prerequisite for Phase 3 and for any future "which rule fired"
measurement; doing it *after* Phase 1 means the new rules are born with ids.

## Phase 3 — Config without forking → v0.5.0

Per `04_config.md` §2 (schema + failure matrix):

- Two-tier JSON merged over built-ins: `~/.claude/bash-guardrails.json`
  (user) ← `<CLAUDE_PROJECT_DIR>/.claude/bash-guardrails.json` (project,
  wins). Surface: `disabledRules`, `ruleOverrides` (`deny|ask|off`),
  `extraAllowCommands`, `extraDenyRules`/`extraBlockRules` (`{id, pattern,
  reason}`), `powershell.*` mirror.
- Fail-safe invariants: malformed JSON or unknown `version` → whole file
  ignored (built-ins only); one bad regex entry → drop that entry only;
  `"off"` on a `deny`-tagged id → **clamped to `"ask"`** (config can loosen
  friction, never disable a hard deny); any uncaught load error → built-ins.
- Then (v0.5.x) the native `plugin.json` `userConfig` surface as a
  discoverability on-ramp: `extra_allow_commands` via
  `CLAUDE_PLUGIN_OPTION_<KEY>` env vars, feeding the same merge function.
  Supplementary only — the feature is young (two open issues).

## Phase 4 — Settings-side quick wins (this machine, no plugin code)

- **WebFetch domain allows** in `~/.claude/settings.json` for `github.com`,
  `code.claude.com`, `code.visualstudio.com`, `raw.githubusercontent.com`,
  `agentskills.io`, `platform.claude.com` — 153 historical calls, only
  phaser.io domains are covered anywhere today (06 §2/§9). WebFetch is the
  single biggest *non-shell* friction source found.
- **Run `/fewer-permission-prompts` periodically per project** — the right
  channel for project-specific long-tail shapes that don't belong in the
  shared plugin (06 #8).
- **Consolidation awareness** (no action forced): `second-memory`'s inline
  hooks duplicate this plugin's rule set almost 1:1 and can be retired once
  the plugin is installed there; the personal `rewrite-cd-git.js` hook
  overlaps `block.cd` but *rewrites* instead of blocking — complementary,
  keep, but it doesn't cover `cd … && node/bash/python` (52 historical
  cases fall through it into this plugin's cd-block).

## Measurement loop (instead of building telemetry)

`05_telemetry.md`'s verdict stands: don't build a decision log now —
`PostToolUse` carries no permission-decision field and `PermissionRequest`
outcomes aren't observable, so the approve-rate loop can't be closed live.
The substitute is already built: **re-run
`docs/research/tools/mine-transcripts.js` after each release** and compare
(a) hook-blocked share of shell calls (was 17–22%/month — should drop
sharply now that ~6%+ of blocks were false positives), (b) the ask-tier
leaderboard (new ALLOW candidates surface by volume), (c) steering
compliance per rule (cat-head-tail's 73% should rise now that its FP
driver is fixed — re-measure before doing any guidance reword; the planned
"--jq reword" from 06 #4 is **moot**, masking already fixed those shapes).

## Deliberate non-goals (decided, documented — don't revisit without new data)

| Not building | Why |
|---|---|
| WASM/native shell parser (`sh-syntax`, `tree-sitter-bash`) | Async-API mismatch with the sync hook, cold-start + payload cost, kills "readable arrays, edit me" (02_parsing) |
| PS AST via `pwsh -Command` | 200–440 ms cold start — 2–5× the whole latency budget (02_parsing) |
| In-hook LLM classifier | Duplicates the platform's gated "auto mode" while abandoning the offline/zero-latency niche (01_ecosystem §1.4) |
| Windows sandboxing | OS-isolation problem; native is WSL2-only, but that's Anthropic's gap to close (01_ecosystem §1.5) |
| New DENY rules from rejection data | 38 rejections in 6 weeks; 7/10 shell ones replay as `allow` — they're session redirects, not shape vetoes (06 §5) |
| Loosening inline-interpreter ask tier | 426 interpreter calls inventoried; no syntactic signature separates read-only probes from disguised destructive scripts (06 §7) |
| Masking the DENY scan | Would downgrade `bash -c "rm -rf /"` from deny to ask. Accepted cost: the rare meta-commit FP (a commit message *describing* the deny rules trips them — observed exactly twice in 6 weeks, both in this repo) |

## Sequencing summary

```
Phase 0  ship v0.2.0 + CI + FP regression cases      (today)
Phase 1  catalog rules + ALLOW promotions → v0.3.0   (small; next session)
Phase 2  rule ids → v0.4.0                            (refactor)
Phase 3  config file (+ userConfig on-ramp) → v0.5.0  (the real build)
Phase 4  settings.json wins + periodic re-mining      (parallel, anytime)
```
