# B. Replace/augment regex with real parsing

Scope per the brief: is quote-blind regex the ceiling, or can real
tokenizing/parsing fit inside a fresh-`node`-process-per-command hook with
zero npm dependencies, offline, on Windows + Linux/macOS? Evaluates
`mvdan-sh`/`sh-syntax`, `bash-parser`, `web-tree-sitter` + `tree-sitter-bash`,
`shell-quote`, and a hand-rolled quote-aware redactor, plus the PowerShell
side and a migration sketch.

## Hard constraints recap (from the brief, restated so the table below is legible)

- Hook is spawned as a **fresh `node` process per shell command** — no module
  cache, no JIT warm-up, no WASM-instance reuse across invocations. Bare
  `node -e 0` process startup alone measures **~23 ms task-clock** in a
  hyperfine benchmark on Linux ([kvakil.me, "Measuring Startup"](https://www.kvakil.me/posts/2023-05-09-nodejs-startup-series-intro-and-measuring-startup-time.html)) —
  Windows process creation is typically slower still (**UNVERIFIED** exact
  Windows number; reasoning from general Win32 `CreateProcess` vs POSIX
  `fork`/`exec` overhead). Target is **<100 ms added** by the hook itself, on
  top of that baseline.
- Offline, Node-only, Windows + Linux/macOS.
- Strong preference for **zero npm dependencies** — today's install is a
  `git clone`/plugin-marketplace fetch with **no `npm install` step**, so
  anything needing `node_modules` at runtime needs a bundling story (single
  file, or WASM inlined as base64).

## Comparison table

| Candidate | Bundle/payload size | Cold-start cost (fresh process) | Maintenance | Windows-friendly | Correctness (POSIX + bashisms) | Bundleable to single dependency-free file |
|---|---|---|---|---|---|---|
| **`mvdan-sh`** (npm, GopherJS build of `mvdan.cc/sh`) | N/A — **archived** | N/A | **Dead.** Upstream README: *"we maintained an npm package called mvdan-sh which used GopherJS... That npm package is now archived given its poor performance and GopherJS not being as actively developed. Any existing or new users should look at sh-syntax instead."* Last npm publish 0.10.1, **4 years ago**. [github.com/mvdan/sh](https://github.com/mvdan/sh), [npmjs.com/package/mvdan-sh](https://www.npmjs.com/package/mvdan-sh) | N/A | Real bash/POSIX grammar (it's the parser bash's own `shfmt` is built on) but the JS build is measured by its own successor's benchmark at **~79.5 ms/iteration** vs. sh-syntax's ~18 ms ([un-ts/sh-syntax README benchmark](https://github.com/un-ts/sh-syntax)) | No — do not build on a deprecated, archived package. |
| **`sh-syntax`** (npm, WASM build of `mvdan.cc/sh`, successor to `mvdan-sh`) | 842 KB unpacked (registry `dist.unpackedSize`), 1 dependency (`tslib`) ([registry.npmjs.org/sh-syntax](https://registry.npmjs.org/sh-syntax/latest)) | **Async only** — `parse()`/`print()` return Promises because WASM instantiation is inherently async in this API; no sync entry point documented. Benchmark: **~18.3 ms/iteration** on Node 18.20.8 / Apple M1 Max, *warm* (repeated iterations in one process) ([un-ts/sh-syntax README](https://github.com/un-ts/sh-syntax)). That number does not include first-time WASM compile — in a **fresh process every command**, you pay compile+instantiate every single time, which this benchmark doesn't isolate. **UNVERIFIED** exact cold-compile cost for an ~800 KB-class Go→WASM binary in a brand-new Node process; general Node+WASM cold-start writeups report **sub-millisecond to low-double-digit-ms** compile times for *small* modules but explicitly call out that compile time scales with module size and that Node should cache compiled modules across invocations to avoid repeat cost — which this hook's execution model (fresh process, no cache) cannot do ([nodejs.org/learn/getting-started/nodejs-with-webassembly](https://nodejs.org/learn/getting-started/nodejs-with-webassembly)). Net: plausible the total (Node startup + WASM compile + parse) lands near or over the 100 ms budget; not disqualifying on its own but a real risk, and the **async API is a bigger practical blocker** — see below. | Real, actively maintained. v0.5.8 published 2025, **8 open issues / 4 open PRs**, 30 releases, GitHub Actions CI + Renovate ([un-ts/sh-syntax GitHub](https://github.com/un-ts/sh-syntax)). ~325 K weekly npm downloads ([api.npmjs.org](https://api.npmjs.org/downloads/point/last-week/sh-syntax)). | No Windows-specific caveats found; WASM execution is platform-neutral inside Node, so this is likely fine, but untested by this research (**UNVERIFIED**). | **Best correctness of any JS-reachable option** — it's a real bash/POSIX AST from the parser `shfmt`/`gopls`-adjacent tooling relies on. Handles nested quoting, `$()`, backslash escapes, `$'...'` correctly by construction (it's a real grammar, not a pattern). | Technically yes via esbuild's `binary` loader, which base64-embeds a `.wasm` into one JS file and decodes with `Buffer.from` at runtime ([esbuild `binary` loader docs](https://esbuild.github.io/content-types/#binary); [esbuild-plugin-wasm "embedded mode"](https://www.npmjs.com/package/esbuild-plugin-wasm)) — but this requires *adding a build step* to a project whose current install model is "clone the raw file," and the hook's synchronous, single-pass `decide()` function would need restructuring around `await`, which changes the hook's I/O model (see below). |
| **`bash-parser`** (npm, pure-JS, ANTLR-style POSIX grammar) | Unknown unpacked size (not present in registry metadata), but **16 production dependencies** (`babylon`, `magic-string`, `filter-obj`, `map-obj`, etc.) ([registry.npmjs.org/bash-parser](https://registry.npmjs.org/bash-parser/latest)) | Pure JS, synchronous, no WASM — cheapest cold-start of the "real parser" options in principle, but not benchmarked here. | **Dead.** Latest version 0.5.0, **published 2017** (9 years ago); no releases in the last 12 months; "could be considered a discontinued project" ([Snyk Advisor](https://snyk.io/advisor/npm-package/bash-parser)). Still gets ~12 K weekly downloads ([api.npmjs.org](https://api.npmjs.org/downloads/point/last-week/bash-parser)) — inertia, not active use. | No Windows-specific issues found, but also no evidence anyone has exercised it there recently. | Real POSIX grammar in principle, but a 9-year-unmaintained parser is a liability for a project whose entire value proposition is *catching* dangerous commands correctly — an unpatched parser bug becomes a silent bypass with no one watching. | Pure JS (no native/WASM), so in principle bundleable via esbuild into one file without a build-time WASM step — but bundling 16 transitive deps for an unmaintained parser is exactly the "adds a real dependency surface for stale code" trade this project has avoided since inception. |
| **`web-tree-sitter` + `tree-sitter-bash`** (WASM grammar, incremental parser) | `web-tree-sitter` runtime: 4.56 MB unpacked npm package (includes JS/TS/docs, not just the runtime WASM) ([registry.npmjs.org/web-tree-sitter](https://registry.npmjs.org/web-tree-sitter/latest)). The actual **grammar** WASM (`tree-sitter-bash.wasm`, prebuilt, hosted by the tree-sitter project) is **1.40 MB** ([GitHub Contents API on tree-sitter/tree-sitter.github.io](https://api.github.com/repos/tree-sitter/tree-sitter.github.io/contents/tree-sitter-bash.wasm)); the npm `tree-sitter-bash` package itself is 20.3 MB unpacked but that includes native bindings, test corpus, and source for the *non-WASM* Node addon build, not what you'd actually ship ([registry.npmjs.org/tree-sitter-bash](https://registry.npmjs.org/tree-sitter-bash/latest)). | Same structural problem as `sh-syntax`: `web-tree-sitter`'s `Parser.init()`/`Language.load()` are **async** WASM-instantiation calls, and tree-sitter's incremental-parse design is optimized for **many edits inside one long-lived process** (an editor), not one-shot parses in a process that dies after one command — every invocation pays full grammar-WASM load with none of tree-sitter's actual selling point (incremental re-parse) ever exercised. **UNVERIFIED** precise cold latency; combined WASM payload (~1.4 MB+ runtime) is larger than `sh-syntax`'s, so expect cold cost to be *at least* comparable, plausibly worse. | `web-tree-sitter` itself is actively maintained (Feb 2025-era 0.26.x releases, ~4.5 M weekly downloads — but that figure is dominated by editor/IDE tooling use, not this use case) ([api.npmjs.org](https://api.npmjs.org/downloads/point/last-week/web-tree-sitter)). `tree-sitter-bash` grammar is the one GitHub/Zed/Neovim/Helix actually ship — high real-world trust for *bash*. **No official PowerShell grammar**: community grammars exist ([wharflab/tree-sitter-powershell](https://github.com/wharflab/tree-sitter-powershell), [airbus-cert/tree-sitter-powershell](https://github.com/airbus-cert/tree-sitter-powershell), [jrsconfitto/tree-sitter-powershell](https://github.com/jrsconfitto/tree-sitter-powershell) — three competing, unofficial forks, no npm-published WASM for any of them; building one requires the tree-sitter CLI's Docker+Emscripten pipeline) ([tree-sitter build docs](https://tree-sitter.github.io/tree-sitter/cli/build.html)). | No Windows-specific issues found for the bash grammar; PowerShell grammars are too immature to assess. | Highest-trust grammar for bash specifically (same parser class that backs GitHub's code navigation). Massive overkill in engineering surface for what this hook needs (chain-splitting + quote-redaction), and the "incremental" design point is wasted in a one-shot-per-process model. | Same base64-embed trick works for a `.wasm` grammar file, but you'd be inlining ~1.4 MB+ of base64 (≈1.9 MB as text) into what is today a single readable, diffable source file — directly at odds with the project's "readable arrays, edit me" design goal stated in the README. |
| **`shell-quote`** (npm, pure JS, hand-tuned tokenizer for building/parsing argv arrays) | 33.5 KB unpacked, **zero dependencies** ([registry.npmjs.org/shell-quote](https://registry.npmjs.org/shell-quote/latest)) | Synchronous, pure string scanning — negligible (low-single-digit-ms at most for a short command string; no WASM, no I/O). | Very actively used: **~55.6 M weekly downloads** ([api.npmjs.org](https://api.npmjs.org/downloads/point/last-week/shell-quote)), maintained by `ljharb` (maintainer of a large swath of foundational npm infrastructure). 11 open issues, most recent opened within the last few months — normal churn for a heavily-used utility, not neglect ([ljharb/shell-quote issues](https://github.com/ljharb/shell-quote/issues)). | **Documented weak spot**: multiple open issues specifically about Windows path/backslash handling — *"1.8.3 breaks Windows code (backslash is not properly escaped)"*, *"Windows paths with backslashes are incorrectly parsed"* ([issues #25, #21, #10](https://github.com/ljharb/shell-quote/issues)). Directly relevant here since this repo's own test corpus uses Windows-style absolute paths inside Bash-tool commands (`/bin/rm -rf dist`, `bash "B:/x/run.sh"`). | Designed for building/parsing safe subprocess argv, **not** for security-grade shell-grammar fidelity: its operator list treats bare `(` / `)` as tokens without real subshell-grouping semantics, so `$(cmd with spaces)` does not tokenize the way bash actually groups it; its `parse()` output does not distinguish *which* quote style (`'` vs `"`) produced a given token, which matters a lot here because bash treats them very differently (single-quotes are fully inert, double-quotes still allow `$()`/`$VAR` expansion) — see failure-mode discussion below. Also actively does `$VAR` interpolation and glob-pattern recognition as a *feature*, which is the opposite of what a passive classifier wants (it mutates/interprets rather than just reporting spans). | Trivially — 33 KB, zero deps, could literally be vendored (copy-pasted) into the repo as a second plain file, no build step, no `node_modules`. Size is not the blocker; behavior is. |
| **Hand-rolled quote-aware redactor** (baseline, ~100–150 LOC, no dependency) | 0 — it's more code in the existing file(s) | Pure character-scan over a short string (typical command <500 chars) — effectively free relative to Node's own ~23 ms process-startup floor. | N/A — owned and maintained by this repo, same as every other rule array today. | No OS-specific behavior; it's pure string logic. | Only handles exactly what's needed (span classification: inert vs. live), not full shell semantics — see design below. Correctness is bounded by what *we* implement and test, which is both the risk and the point. | Yes by construction — it's not a "bundling story," it's just more source in `guardrails.js` (or one small sibling file, still copied verbatim, still zero deps, still no build step). |

**Not evaluated as a real candidate but worth naming**: `bashlex` (Python,
used by [idank/bashlex](https://github.com/idank/bashlex), the parser behind
`explainshell`) is the parser an actual sibling Claude Code guardrail project
uses — see prior-art section below — but it's Python, and shelling out to a
Python interpreter from the Node hook violates the "Node only" constraint and
adds a second runtime dependency the install story doesn't provision for.

## The realistic middle ground: prior art for "sanitize then regex"

This is an established pattern, not a novel idea — three directly relevant
precedents:

1. **A near-identical sibling project already ships a token-classification
   layer instead of a full parser.**
   [Dicklesworthstone/destructive_command_guard](https://github.com/Dicklesworthstone/destructive_command_guard)
   ("dcg", 1.1k stars, MIT, actively maintained, itself a Claude Code
   `PreToolUse` hook plus standalone CLI) runs a 4-stage pipeline — JSON parse
   of the hook payload → **normalization** (regex-strips path prefixes,
   `/usr/bin/git` → `git`) → quick-reject (substring check to skip the regex
   engine entirely for obviously-safe commands) → whitelist-then-blocklist
   pattern matching. Its normalization stage classifies every token into one
   of: `Executed | InlineCode | Argument | Data | HeredocBody | Comment |
   Unknown`, where **`Data` is explicitly defined as "single-quoted strings —
   shell cannot interpolate — can skip, treated as literal data."** That's the
   exact same "single-quotes are always inert" rule this research recommends
   below. It does **not** use a real parser library (no `bashlex`/`mvdan-sh`
   equivalent) — it's regex + token classification, written in Rust, with a
   documented <75 μs "fast path" latency budget and SIMD-accelerated matching.
   For embedded scripts (heredocs, `bash -c "..."`) it goes further and
   extracts the *inner* script text, then runs `tree-sitter`/`ast-grep` on
   just that extracted fragment — i.e., it reserves real parsing for the rare
   case (nested interpreter payload) rather than the common case (top-level
   command classification). This is strong validation that "classify spans,
   don't build an AST" is the right altitude for this problem, from a project
   solving literally the same problem for the same host (Claude Code).
2. **A second sibling project takes the opposite approach and depends on a
   real Python parser.**
   [RoaringFerrum/claude-code-bash-guardian](https://github.com/RoaringFerrum/claude-code-bash-guardian)
   is a Python `PreToolUse` hook that depends on `bashlex`
   ([idank/bashlex](https://github.com/idank/bashlex)) specifically because
   `bashlex` "automatically normalizes obfuscated patterns... distinguishes
   between actual commands and strings (e.g. `echo 'rm -rf /'` is safe)" —
   i.e., it solves exactly this project's quote-blindness bug, but by paying
   for a real grammar. It documents a real parser limitation worth noting:
   *"bashlex cannot parse heredoc syntax, [so] heredocs are stripped and
   replaced with `/dev/stdin` [before parsing]"* — even a from-Go, hand-built
   real bash parser has to special-case heredocs. This project is small (7
   stars, 3 commits, no releases) — not a maturity endorsement, but it does
   confirm that going the "real parser" route is a live design choice other
   authors have made, and what it costs (a second runtime, Python).
3. **Editor syntax highlighters have solved "classify spans as
   quoted/comment/live" for decades without building an AST.** TextMate
   grammars (adopted by VS Code, Sublime, Atom) are exactly a **begin/end
   regex state machine**: a `begin` pattern pushes a context (e.g. entering a
   `'...'` span), text inside is tokenized under that context's rules
   (typically "everything is literal") until an `end` pattern pops back out
   ([TextMate Language Grammars manual](https://macromates.com/manual/en/language_grammars);
   [VS Code Syntax Highlight Guide](https://code.visualstudio.com/api/language-extensions/syntax-highlight-guide)).
   This is architecturally the same idea as the redactor recommended below —
   push into a "quoted" state on `'`/`"`, classify everything until the
   matching close, pop out — just applied to safety classification instead of
   coloring.

### Known failure modes of "sanitize then regex" (why it's not free)

- **Nested/mixed quoting.** `"it's a 'test'"` — the inner `'` characters are
  literal once inside a double-quoted span (double quotes don't nest single
  quotes as a state change), but a naive scanner that flips a single "am I
  quoted" boolean on any `'` or `"` will mis-track state the moment quote
  styles mix. Any implementation must track *which* quote character opened
  the current span, not just "in a quote."
- **Command substitution `$(...)` and backticks *inside* double quotes still
  execute.** This is the sharpest failure mode for a naive "blank everything
  inside quotes" approach, and it's a real regression risk: bash evaluates
  `$(...)`, `` `...` ``, and `$VAR`/`${VAR}` **inside double-quoted strings**
  (only single quotes are fully inert). `git commit -m "$(rm -rf /)"` is a
  live destructive command hiding inside a double-quoted argument. A redactor
  that blanks the *entire* double-quoted span to fix the cat/head/tail false
  positive would simultaneously **open a hole** by hiding that payload from
  the DENY scan too — the opposite of the goal. The redactor must special-case
  `$(`/backtick/`${` spans *within* double quotes as "still live" and leave
  them un-redacted, recursing only far enough to find the matching
  close-paren/backtick.
- **Backslash escapes.** `\"`, `\'`, `` \` ``, `\$`, `\\` all consume the next
  character literally and must not be read as state transitions — this is
  the exact motivating bug (`git commit -m "docs: update \`README\`"`, where
  `` \` `` must be recognized as an *escaped*, inert backtick, not a live
  command-substitution open). Any hand-rolled scanner needs an explicit
  "next char is literal" state, entered on an unescaped `\` **outside single
  quotes** (backslash has no special meaning inside single quotes in POSIX
  sh/bash).
- **ANSI-C quoting `$'...'`.** Bash-specific, processes escape sequences
  (`\n`, `\t`, `\xHH`, …) but — unlike double quotes — does **not** perform
  command substitution or variable expansion inside; it's inert like single
  quotes, but its own closing-quote detection must still respect `\'` as an
  escaped literal quote *inside* the span, so it needs its own state, not
  reuse of the single-quote state verbatim.
- **`$(...)` balancing and quotes-inside-substitution.** `$(echo "a $(echo
  b)")` is valid, nested substitution containing its own quoted string that
  itself contains further substitution. A "good enough" redactor does not
  need to fully understand this (it just needs to not blank it — leaving live
  spans un-redacted is always the safe failure direction), but the
  paren-depth counter used to find the *end* of a `$(...)` span must not be
  fooled by a `)` that's actually inside a nested quoted string within the
  substitution. A byte-accurate depth counter needs at least primitive
  awareness of quoting while inside `$(...)`, which is where hand-rolled
  scanners start to approach "just parse it" — the pragmatic exit here is:
  the *deny* scan already reads the raw, un-redacted string wherever the
  redactor is unsure (fail toward "still visible to DENY/BLOCK," never toward
  "hidden").

## PowerShell: is Node-side parsing viable, or is quote-stripping the ceiling there too?

**Confirmed: quote-stripping is the practical ceiling.** No PowerShell parser
runs inside a Node process — the search turned up only `powershell`/
`node-powershell` npm packages, which are **execution** wrappers (they spawn
`powershell.exe`/`pwsh` and pipe output back), not parsers
([npmjs.com/package/powershell](https://www.npmjs.com/package/powershell),
[npmjs.com/package/node-powershell](https://www.npmjs.com/package/node-powershell)).
No JS/WASM port of the PowerShell language grammar exists on npm.

The real PowerShell AST API — `[System.Management.Automation.Language.
Parser]::ParseInput($code, [ref]$tokens, [ref]$errors)` — parses arbitrary
text into a `ScriptBlockAst` **without executing it**, which is exactly what
a safety hook wants: *"You can ask the PowerShell parser to parse arbitrary
code and return tokens and AST... it is not guaranteed the code is
syntactically correct, that's why the parser also returns syntax errors"*
([Microsoft Learn — Parser.ParseInput](https://learn.microsoft.com/en-us/dotnet/api/system.management.automation.language.parser.parseinput?view=powershellsdk-7.4.0)).
But reaching it from this hook means shelling out to `pwsh -Command
"[System.Management.Automation.Language.Parser]::ParseInput(...)"` — a
**second, full `pwsh.exe` cold start per Bash/PowerShell tool call**, on top
of the Node process already running the hook. Cold-start numbers found for
`pwsh` itself:

- Baseline CLR+`PSReadLine` load, no profile: reported around **~440 ms** in
  one measured breakdown ([ibnuhx.com — Cutting PowerShell startup time in
  half](https://ibnuhx.com/blog/cutting-powershell-startup-time-in-half)).
- A `Measure-Command { pwsh -Command 'exit' }`-style cold invocation is
  reported in the ~**200–440 ms** range depending on machine/profile state,
  and adding `-NoLogo` only shaves ~40 ms
  ([PowerShell/PowerShell#17734](https://github.com/PowerShell/PowerShell/issues/17734);
  [PowerShell/PowerShell#25025](https://github.com/PowerShell/PowerShell/issues/25025)).
- `pwsh` (PowerShell 7/Core) is documented as **~2× slower to load** than
  Windows PowerShell 5.1's `powershell.exe`
  ([PowerShell/PowerShell#6443](https://github.com/PowerShell/PowerShell/issues/6443)).

That's 2–5× the entire latency budget (<100 ms) just for the child process to
start, before it parses anything — not viable per-command. (It could
conceivably be viable as a one-time, cached, out-of-band linter rather than a
per-command hook, but that's a different feature, not this hook.)

One nuance the brief didn't anticipate: a **community `tree-sitter-powershell`
grammar does exist** (three independent, unofficial forks:
[wharflab](https://github.com/wharflab/tree-sitter-powershell),
[airbus-cert](https://github.com/airbus-cert/tree-sitter-powershell),
[jrsconfitto](https://github.com/jrsconfitto/tree-sitter-powershell)), so "no
parsing option at all" isn't quite accurate — but none publishes a
prebuilt WASM binary on npm; producing one requires the `tree-sitter build
--wasm` Docker+Emscripten pipeline yourself
([tree-sitter build docs](https://tree-sitter.github.io/tree-sitter/cli/build.html)),
against a grammar with no claim of security-review maturity. Not worth
the engineering cost given the `pwsh`-cold-start numbers above make even the
*official*, first-party PowerShell AST API impractical for this hook's
per-command model — a fortiori for an unofficial, unvetted, self-built one.

**Conclusion for PowerShell: build a second hand-rolled quote-aware
redactor with PowerShell's own quoting rules**, not reuse of the Bash one.
PowerShell quoting is genuinely different, not just cosmetically:
single-quoted strings are always literal, double-quoted strings interpolate
`$var`/`$(...)`,  backtick (`` ` ``) is PowerShell's escape character (not a
command-substitution operator the way it is in POSIX sh), and here-strings
(`@'...'@` literal, `@"..."@` interpolating) are multi-line quoted blocks with
their own termination rule (closing `'@`/`"@` must start a line). This is a
distinct, from-scratch state machine, not a port of the Bash one — flagged
explicitly as new scope, not a trivial reuse.

## Recommendation

**Build the hand-rolled quote-aware redactor. Do not add any of the npm
parser packages as a dependency.**

Justification, weighed against the candidates above:

- **`sh-syntax`/`tree-sitter-bash` (the two "real parser" options) are ruled
  out primarily by their async API**, not just raw latency. `decide()` today
  is a synchronous, single-pass function called once per stdin read; making
  it `async` to await WASM instantiation is a real, if small, architecture
  change, and it stacks an *unmeasured* per-process WASM cold-compile cost
  (UNVERIFIED, but plausible tens of ms — see table) on top of Node's own
  ~23 ms process-startup floor, eating into a 100 ms budget that a pure
  string-scan approach spends effectively none of. They're also the two
  hardest to keep as "one readable, diffable file" — the WASM payload (0.8–
  1.4+ MB) would have to be base64-inlined, turning `guardrails.js` from
  "readable arrays, edit me" (README's own framing) into an opaque blob with
  a build step, which contradicts the project's explicit customization model
  ("fork, edit the arrays, bump version").
- **`bash-parser` is ruled out on staleness** (9 years unmaintained, 16
  transitive deps) — for a project whose entire job is correctly catching
  dangerous commands, an unpatched, unwatched parser is a worse bet than
  regex you own and can fix same-day.
- **`shell-quote` is close, but its two weak points are exactly the two
  things that matter most here**: it doesn't distinguish single- vs.
  double-quote provenance in its output (needed for the `$()`-inside-
  double-quotes failure mode above), and it has open, unresolved Windows
  backslash-path bugs on a project that must run on Windows. It's good
  evidence that "quote-and-comment-aware pre-tokenizer" is a reasonable
  *size* of solution (33 KB, zero deps) — it's just not quite the *shape* of
  solution this hook needs, because it was built for constructing safe argv
  arrays, not for auditing dangerous ones.
- **The hand-rolled redactor wins on every hard constraint simultaneously**:
  zero bytes of new dependency, no build step, no async, no WASM, trivially
  stays inside the existing single-file "readable arrays" model, and — the
  decisive point — it only has to solve the *specific* problem this hook has
  (classify a span as inert-literal vs. still-live, for the purpose of
  redacting it before an existing regex runs over it), not general shell
  execution semantics. `destructive_command_guard`'s shipped, 1.1k-star
  design (regex + token classification, real parsing reserved only for
  extracted heredoc/`-c` payloads) is direct precedent that this is not an
  under-engineered choice for this problem class.

## Migration sketch

**What's new** — one function added to `guardrails.js` (or a same-directory
sibling file, still zero deps, still copied verbatim, no build step):

```js
// Classifies each character of `command` as "inert" (literal text that
// cannot execute — blank it) or "live" (leave visible to the regex rules
// below). Returns a same-length string: live characters are copied through
// unchanged (so all existing regexes, whitespace/operator positions, and
// leadingCommand()/isSplittableChain() keep working unmodified); inert
// characters are replaced with a filler ('#', chosen because no BLOCK/DENY
// pattern matches it) so string length and non-quoted structure survive.
function redactInert(command) {
  let out = '';
  let i = 0;
  const n = command.length;
  // state: null | "'" | '"' | "$'" — which quote (if any) is currently open
  let state = null;
  while (i < n) {
    const c = command[i];

    if (state === null) {
      if (c === '\\') { out += c; out += command[i + 1] ?? ''; i += 2; continue; }
      if (c === "'") { state = "'"; out += c; i++; continue; }
      if (c === '"') { state = '"'; out += c; i++; continue; }
      if (c === '$' && command[i + 1] === "'") { state = "$'"; out += "$'"; i += 2; continue; }
      out += c; i++; continue;
    }

    if (state === "'") {
      // Single quotes: fully inert, no escapes recognized (POSIX).
      if (c === "'") { state = null; out += c; i++; continue; }
      out += '#'; i++; continue;
    }

    if (state === "$'") {
      // ANSI-C quoting: inert (no command exec), but \\' is an escaped quote.
      if (c === '\\') { out += '#'; out += command[i + 1] != null ? '#' : ''; i += 2; continue; }
      if (c === "'") { state = null; out += c; i++; continue; }
      out += '#'; i++; continue;
    }

    // state === '"'  — double quotes: mostly inert, EXCEPT $(...), `...`,
    // and ${...}/$VAR remain live (bash still expands/executes them here).
    if (c === '\\') { out += c; out += command[i + 1] ?? ''; i += 2; continue; }
    if (c === '"') { state = null; out += c; i++; continue; }
    if (c === '`') {
      // Live backtick substitution inside "...": copy through verbatim
      // until the matching unescaped backtick.
      out += c; i++;
      while (i < n && command[i] !== '`') {
        if (command[i] === '\\') { out += command[i]; out += command[i + 1] ?? ''; i += 2; continue; }
        out += command[i]; i++;
      }
      if (i < n) { out += command[i]; i++; }
      continue;
    }
    if (c === '$' && command[i + 1] === '(') {
      // Live $(...) substitution: copy through, tracking paren depth.
      out += '$('; i += 2;
      let depth = 1;
      while (i < n && depth > 0) {
        if (command[i] === '(') depth++;
        if (command[i] === ')') depth--;
        out += command[i]; i++;
      }
      continue;
    }
    if (c === '$') { out += c; i++; continue; } // bare $VAR / ${VAR}: leave live
    out += '#'; i++; continue;
  }
  return out;
}
```

(This is a design sketch to accompany the recommendation, not a drop-in —
it needs the test-suite treatment described below before it ships.)

**What changes in `decideBash`/`decidePowershell`:** compute
`const masked = redactInert(command);` once per call, then pass `masked`
(not raw `command`) to:
- `BLOCK_RULES` tests — this is the actual fix for the motivating bugs
  (`cat.png`/`head.svg`/`"tail"` no longer match because the filenames sit
  inside a redacted double- or single-quoted argument only when they are
  themselves quoted — note `git add cat.png` has an *unquoted* filename, so
  the existing `(cat|head|tail)` rule needs an accompanying tightening, e.g.
  requiring the match be the leading token of a segment, which `redactInert`
  alone doesn't fix — flagging this as a **second, separate change** the
  redactor doesn't subsume).
- `isSplittableChain`'s segment split (`;`/`&&`) and `leadingCommand` — fixes
  quoted `;`/`&&` inside arguments being misread as chain operators.
- Optionally, `DENY_RULES`/`GIT_DENY_RULES` — **this is a deliberate,
  flagged change** to the stated invariant *"DENY_RULES scan the whole
  command string"* in `CLAUDE.md`. The invariant's actual intent (per its own
  stated reason — *"stops chaining from smuggling a destructive op past the
  gate"*) is preserved by scanning the whole **masked** string: a destructive
  op typed outside quotes is untouched by redaction and stays visible; only
  genuinely-inert quoted text is blanked, and (per the failure-mode section
  above) `$()`/backtick/`$VAR` spans inside double quotes are deliberately
  kept live specifically so a destructive payload can't hide there. Net
  effect: fixes the (currently real, currently untested) false-positive of
  `git commit -m "rm -rf notes"` denying a harmless commit, without
  reopening any hole — but this is a behavior change to a documented
  invariant and must be called out as such in the PR, not silently folded
  in.

**What stays exactly as-is:** every regex pattern string in `DENY_RULES`,
`GIT_DENY_RULES`, `BLOCK_RULES`, `NEVER_AUTO_ALLOW`, and the PS mirrors —
none of them need rewriting, only **which string they're tested against**
changes (masked vs. raw). Rough estimate: **~90% of the existing rule set is
unchanged text**; the ~10% that needs actual edits is the handful of rules
whose false positives come from something *other* than quote-blindness (e.g.
the `cat|head|tail` rule matching inside unquoted filenames like `cat.png`
needs a word-boundary/position tightening, not just redaction — redaction
only fixes the *quoted-string* half of that bug class, not the
*substring-of-a-filename* half).

**One documented behavior change worth flagging explicitly**, since
`CLAUDE.md` calls out `node -e "a > b"` as an intentional false positive:
after redaction, that specific example stops matching the `BLOCK_RULES`
redirect pattern (the `>` is inside a double-quoted, non-`$()`/backtick span,
so it gets blanked) — but the command is **still never auto-approved**,
because `NEVER_AUTO_ALLOW`'s `-e`/`-c` inline-interpreter pattern still
matches on `node -e` regardless of what's inside the quotes (that rule's
whole premise — the hook can't see inside the interpreter's *own* language —
is unrelated to shell quoting and is untouched by this change). The
user-visible result changes from *"BLOCKED: no output redirections"* (a
confusing, technically-wrong reason today) to a plain passthrough `ask`
(Claude Code's generic prompt, no custom reason) — arguably a strict
improvement, but it's a change to documented behavior and should be
called out in the PR description, per this repo's own convention of flagging
deliberate invariant changes rather than presenting them as neutral.

**Testing requirement before this ships:** `redactInert` needs its own
dedicated case table in `test/run.js` (or a sibling test file) covering, at
minimum, every failure mode enumerated above (mixed quote styles, `$()`/
backtick/`$var` inside double quotes, escaped quotes/backticks, `$'...'`
ANSI-C quoting, nested `$(...)`) *before* wiring it into `decideBash` — this
is exactly the kind of hand-rolled state machine that's easy to get subtly
wrong on the second or third quoting style, and the existing test corpus
(`test/run.js`) doesn't exercise any of this today.

**PowerShell**: a second, independent `redactInertPS` (different quote
rules: backtick-as-escape not substitution, here-strings `@'...'@`/`@"..."@`)
is new scope, not a port — build and test it separately, on its own
timeline, after the Bash redactor has proven itself.

## Sources

- [github.com/mvdan/sh](https://github.com/mvdan/sh) — official statement that `mvdan-sh` (GopherJS) is archived/deprecated in favor of `sh-syntax`
- [npmjs.com/package/mvdan-sh](https://www.npmjs.com/package/mvdan-sh), [registry.npmjs.org/sh-syntax](https://registry.npmjs.org/sh-syntax/latest)
- [github.com/un-ts/sh-syntax](https://github.com/un-ts/sh-syntax) — README benchmark numbers (sh-syntax ~18.3ms/iter vs mvdan-sh ~79.5ms/iter), async API, maintenance activity
- [registry.npmjs.org/bash-parser](https://registry.npmjs.org/bash-parser/latest), [Snyk Advisor — bash-parser](https://snyk.io/advisor/npm-package/bash-parser) — staleness, dependency count
- [registry.npmjs.org/web-tree-sitter](https://registry.npmjs.org/web-tree-sitter/latest), [registry.npmjs.org/tree-sitter-bash](https://registry.npmjs.org/tree-sitter-bash/latest)
- [api.github.com/repos/tree-sitter/tree-sitter.github.io/contents/tree-sitter-bash.wasm](https://api.github.com/repos/tree-sitter/tree-sitter.github.io/contents/tree-sitter-bash.wasm) — 1.40 MB prebuilt grammar WASM size
- [tree-sitter build docs](https://tree-sitter.github.io/tree-sitter/cli/build.html) — WASM build requires Docker+Emscripten
- [wharflab/tree-sitter-powershell](https://github.com/wharflab/tree-sitter-powershell), [airbus-cert/tree-sitter-powershell](https://github.com/airbus-cert/tree-sitter-powershell), [jrsconfitto/tree-sitter-powershell](https://github.com/jrsconfitto/tree-sitter-powershell) — competing unofficial PowerShell grammars, no published WASM
- [registry.npmjs.org/shell-quote](https://registry.npmjs.org/shell-quote/latest), [api.npmjs.org downloads — shell-quote](https://api.npmjs.org/downloads/point/last-week/shell-quote)
- [github.com/ljharb/shell-quote/issues](https://github.com/ljharb/shell-quote/issues) — open Windows backslash-path bugs (#25, #21, #10)
- [github.com/Dicklesworthstone/destructive_command_guard](https://github.com/Dicklesworthstone/destructive_command_guard) — sibling Claude Code guardrail hook; regex + token-classification pipeline (`Executed|InlineCode|Argument|Data|HeredocBody|Comment|Unknown`), `Data` = single-quoted = skip, real parsing reserved for extracted heredoc/`-c` payloads only
- [github.com/RoaringFerrum/claude-code-bash-guardian](https://github.com/RoaringFerrum/claude-code-bash-guardian) — sibling Python hook using `bashlex`; documents that even a real bash parser has to strip heredocs before parsing
- [github.com/idank/bashlex](https://github.com/idank/bashlex) — the Python bash parser used above
- [TextMate Language Grammars manual](https://macromates.com/manual/en/language_grammars), [VS Code Syntax Highlight Guide](https://code.visualstudio.com/api/language-extensions/syntax-highlight-guide) — begin/end regex state-machine prior art for quote-aware tokenization
- [Microsoft Learn — Parser.ParseInput](https://learn.microsoft.com/en-us/dotnet/api/system.management.automation.language.parser.parseinput?view=powershellsdk-7.4.0) — PowerShell AST parsing API
- [ibnuhx.com — Cutting PowerShell startup time in half](https://ibnuhx.com/blog/cutting-powershell-startup-time-in-half), [PowerShell/PowerShell#17734](https://github.com/PowerShell/PowerShell/issues/17734), [PowerShell/PowerShell#25025](https://github.com/PowerShell/PowerShell/issues/25025), [PowerShell/PowerShell#6443](https://github.com/PowerShell/PowerShell/issues/6443) — `pwsh` cold-start latency (~200–440ms+)
- [npmjs.com/package/powershell](https://www.npmjs.com/package/powershell), [npmjs.com/package/node-powershell](https://www.npmjs.com/package/node-powershell) — Node PowerShell packages are execution wrappers, not parsers
- [kvakil.me — Measuring Node.js Startup](https://www.kvakil.me/posts/2023-05-09-nodejs-startup-series-intro-and-measuring-startup-time.html) — bare `node -e 0` ≈23ms task-clock baseline
- [nodejs.org — Node.js with WebAssembly](https://nodejs.org/learn/getting-started/nodejs-with-webassembly) — WASM compile-time-scales-with-size caveat, cross-invocation caching guidance
- [esbuild content types — binary loader](https://esbuild.github.io/content-types/#binary), [esbuild-plugin-wasm](https://www.npmjs.com/package/esbuild-plugin-wasm) — base64-embedding a `.wasm` into a single JS file
