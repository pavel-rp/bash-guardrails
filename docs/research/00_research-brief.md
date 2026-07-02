# Research brief — bash-guardrails next iteration

You are doing deep research for the **bash-guardrails** project in this repo
(`B:\Projects\bash-guardrails`). Before anything else, read these files to
understand what exists today:

- `README.md` — concept, three-tier model (DENY / BLOCK-with-guidance / ALLOW /
  ask-passthrough), trade-offs section.
- `plugins/bash-guardrails/hooks/guardrails.js` — the entire implementation:
  regex rule arrays over the raw command string, for both Bash and PowerShell.
- `CLAUDE.md` — invariants and deliberate design decisions (do not propose
  breaking these without flagging that you are).
- `test/run.js` — the test corpus; shows what's covered.

## Project context (so you don't re-derive it)

The plugin is a Claude Code `PreToolUse` hook that reads each Bash/PowerShell
command as a **string** and emits deny/allow/ask. It is explicitly a
**friction-reducer and mistake-catcher, not a security boundary** — the threat
model is "Claude makes a destructive or obfuscated mistake", not "an adversary
crafts a bypass". Keep that framing for everything below.

Hard constraints on any recommendation:
- The hook is **spawned as a fresh `node` process per shell command** —
  cold-start latency matters. Target < ~100 ms added per command.
- Must run **offline**, on Windows + Linux/macOS, with Node only.
- Strong preference for **zero npm dependencies** (today it's a single
  dependency-free file, installed by cloning a repo — no `npm install` step
  runs at install time, so anything requiring `node_modules` needs a bundling
  story).

## Known weaknesses motivating this research (already confirmed by probing)

False positives from quote-blind regexes (each of these is wrongly blocked):
- `git add cat.png`, `git mv head.svg logo.svg`, `grep -n "tail" src/app.js`
  — the cat/head/tail rule matches inside filenames and quoted strings.
- `git commit -m "docs: update \`README\`"` — backtick rule fires inside a
  quoted commit message. Same for `|` inside a message.

Confirmed holes (silently auto-approved though destructive or arbitrary-exec):
- `npx rimraf dist`, `pnpm dlx …` — package runners execute arbitrary code.
- `git push origin +main` — force-push via `+refspec`, dodges the force regex.
- `git stash drop` / `git stash clear`, `git restore .`, `git checkout .`
  (only the `checkout -- .` spelling is denied), `git branch --delete --force`.
- PowerShell: `echo hi | node hook.js` (pipe into an interpreter script),
  `New-Item -ItemType File a.ts -Value "x"` (silent file write).

## Research questions

Work each of these into its own markdown file in `docs/research/` (see
Deliverables). Cite sources (URLs) for every non-obvious claim. Prefer primary
sources: official Anthropic docs/changelogs, project READMEs/source, issue
trackers — over blog posts.

### A. Ecosystem & obsolescence check → `01_ecosystem.md`

1. What is the current state (as of your search date) of **Claude Code's native
   command permission machinery**: permission rules syntax and matching
   semantics for `Bash(...)`, the built-in command-safety/obfuscation
   classifier (is it documented anywhere? changelog mentions?), sandboxed bash
   (bubblewrap/Seatbelt-based `/sandbox`), and Windows support for any of it.
   Which parts of bash-guardrails does the native roadmap plausibly obsolete,
   and which gaps (especially on Windows) look durable?
2. Survey **existing Claude Code guardrail hooks / plugins / marketplaces**
   that police shell commands (GitHub search: PreToolUse hooks, "claude code
   hooks" security/guardrails projects, awesome-claude-code lists). For the 3–6
   most serious ones: approach (regex? parser? LLM-judge?), rule coverage,
   config story, activity/maintenance. What do they do better or worse than
   this project? Anything worth stealing outright?
3. Any guidance or emerging convention for **agent shell-command allowlisting**
   in other agent CLIs (Codex CLI, Gemini CLI, Cursor CLI, OpenHands…) —
   how do they classify safe vs destructive commands? Do any publish reusable
   rule sets or classifiers?

### B. Replace/augment regex with real parsing → `02_parsing.md`

The single biggest quality ceiling is quote-blind regex. Evaluate options for
**tokenizing/parsing shell commands inside the Node hook**:

1. Candidates to evaluate (at minimum): `mvdan-sh` (the Go shell parser's
   JS/WASM distribution, npm `mvdan-sh` or `sh-syntax`), `bash-parser` (npm),
   `tree-sitter-bash` via `web-tree-sitter` (WASM), `shell-quote` (npm),
   and "write a minimal hand-rolled quote-aware splitter" as a baseline.
2. For each: bundle size, cold-start/parse latency (find benchmarks or
   reason from architecture), maintenance status (last release, open issues),
   Windows friendliness, correctness on POSIX + bashisms, and whether it can be
   **bundled into a single dependency-free file** (esbuild single-file output?
   WASM inlined as base64?).
3. The realistic middle ground: not a full AST, but a **quote-and-comment-aware
   pre-tokenizer** that (a) strips quoted string contents before running the
   BLOCK regexes, and (b) splits top-level `;`/`&&`/`|` correctly. Is there
   prior art for this exact "sanitize then regex" pattern in linters/hooks?
   What are its known failure modes (nested quoting, `$(...)`, escapes)?
4. PowerShell side: options for parsing PS from Node are presumably poor —
   confirm. Is shelling out to `pwsh -Command` with the PSParser/AST API viable
   latency-wise, or is quote-stripping the practical ceiling there too?
5. Recommend one approach with a migration sketch: what changes in
   `guardrails.js`, what stays.

### C. Destructive-command catalog → `03_catalog.md`

Build a **reference catalog of destructive / arbitrary-execution command forms**
the rule set should consider, under the mistake-model (not adversarial). Mine
existing curated sources rather than inventing: safe-rm / trash-cli docs,
shellcheck wiki, "dangerous linux commands" curated lists, git documentation
(every command that discards data), existing agent-guardrail rule sets found in
(A), and any academic/industry work on LLM shell-agent safety (e.g. papers or
posts cataloging agent-executed destructive commands).

Organize as a table per family with suggested tier (DENY / ask / ignore):
1. **Filesystem**: rm variants, xargs/parallel + rm, truncate, shred, `cp/mv`
   overwrite forms, `rsync --delete`, `ln -sf`, `chmod/chown -R`, `mktemp` abuse… 
2. **Git data-loss**: complete the set — stash drop/clear, restore/checkout/
   switch discard forms, `+refspec` force push, `update-ref -d`, reflog expire,
   filter-branch/filter-repo, worktree remove --force, clean, gc --prune=now…
3. **Arbitrary-exec reachable through allow-listed tools**: npx / pnpm dlx /
   yarn dlx / bunx, `npm exec`, `npm run` scripts (inherent — document the trust
   boundary), pip install (setup.py), `go run`, `cargo run` — which deserve
   demotion to the ask tier, and what's the false-friction cost of each?
4. **PowerShell**: complete the mutating-cmdlet inventory (Move-Item/Copy-Item
   -Force, Set-Acl, Stop-Computer, Restart-Service, registry writes,
   `New-Item -Value`, WMI/CIM destructive methods…), plus `cmd.exe /c` passthroughs.
5. For each proposed new DENY, note the **legitimate-use frequency** — the
   project deliberately tolerates false positives only when the cost is a
   rewrite, not a lost capability.

### D. Configuration without forking → `04_config.md`

Today the only customization path is forking the repo. Research how a Claude
Code **plugin hook can expose user/project-level configuration**:
1. What do hooks receive in env/stdin that could locate a config file
   (`CLAUDE_PROJECT_DIR`? cwd? `~/.claude`?). What do other configurable
   plugins/hooks in the wild actually do (search for prior art)?
2. Evaluate: a JSON/JS config file merged over defaults (e.g.
   `~/.claude/bash-guardrails.json` + `<project>/.claude/bash-guardrails.json`)
   — schema sketch: extra allow commands, demotions, disabled rule ids, extra
   deny patterns. What's the failure story if the config is malformed
   (must fail to "ask", never fail-open)?
3. Should rules get stable **ids** so config can reference them? Any convention
   from eslint-style rule systems worth copying (severity levels, `off`)?
4. Is there any Claude Code-native mechanism (plugin settings, marketplace
   metadata) for plugin configuration, shipped or announced?

### E. Decision telemetry & tuning loop → `05_telemetry.md` (smaller, best-effort)

1. Prior art for hooks writing a local **decision log** (JSONL of command →
   decision → rule id) for later tuning; any privacy/size pitfalls.
2. Can a PostToolUse hook (or transcript files under `~/.claude/projects`) be
   used to measure how often the "ask" tier got approved by the user — i.e.
   which prompts are candidates for auto-allow? Feasibility only, no build plan.

## Deliverables

Write all output into `docs/research/` in this repo:

- `01_ecosystem.md`, `02_parsing.md`, `03_catalog.md`, `04_config.md`,
  `05_telemetry.md` — one per section above.
- `SUMMARY.md` — a 1–2 page synthesis: ranked recommendations (what to build
  next, in what order, and what NOT to build because the platform will do it),
  each with a one-line justification and pointers into the detail files.

Style: dense and factual, tables where they help, every external claim cited
with a URL, and clearly mark anything you could not verify as UNVERIFIED.
Do not modify any file outside `docs/research/`.
