# D. Configuration without forking

Research date: 2026-07-02 (Claude Code docs/changelog as of that date). Scope:
how `bash-guardrails` could expose user/project-level rule configuration
without requiring a fork. Threat model stays as stated project-wide: mistake
catcher, not a security boundary; any config-loading failure must degrade to
**passthrough ("ask")**, never fail-open into a silent allow.

---

## 1. What a hook actually receives, and what other hooks/plugins do with it

### 1.1 Official env vars and stdin fields (verified against `code.claude.com`)

Fetched directly from the official hooks reference and plugins reference
(2026-07-02): [Hooks reference](https://code.claude.com/docs/en/hooks),
[Plugins reference](https://code.claude.com/docs/en/plugins-reference).

**Path placeholders, exported as real env vars to every `command`-type hook
subprocess** (this includes `guardrails.js` today — it is spawned exactly
this way per `hooks/hooks.json`):

| Var | Resolves to | Notes |
|---|---|---|
| `CLAUDE_PROJECT_DIR` | Project root | Same value the hook's `cwd` stdin field normally holds; stable even if the session's cwd moves (this plugin blocks `cd` anyway, so cwd drift is a non-issue here). Also settable as a path placeholder inside hook `command` strings: `${CLAUDE_PROJECT_DIR}`. |
| `CLAUDE_PLUGIN_ROOT` | This plugin's install dir in the version cache | Changes on every version bump — **never** a place to read/write user config, only to read files shipped with the plugin itself. |
| `CLAUDE_PLUGIN_DATA` | `~/.claude/plugins/data/{id}/` — persistent across plugin updates | New in the docs; not currently used by this plugin. Good fit for anything the hook wants to *cache* (e.g. compiled regex, decision logs — see `05_telemetry.md`) since, unlike `CLAUDE_PLUGIN_ROOT`, it survives a version bump. |

**PreToolUse stdin JSON** (full shape, from the same fetch):

```json
{
  "session_id": "abc123",
  "prompt_id": "550e8400-...",
  "transcript_path": "/home/user/.claude/projects/.../transcript.jsonl",
  "cwd": "/home/user/my-project",
  "permission_mode": "default",
  "hook_event_name": "PreToolUse",
  "tool_name": "Bash",
  "tool_input": { "command": "npm test" }
}
```

`guardrails.js` already reads `tool_name`/`tool_input.command`; `cwd` is
present too and is a viable fallback for locating a project config file if
`CLAUDE_PROJECT_DIR` were ever absent (it shouldn't be, for a plugin hook —
see table above), but `CLAUDE_PROJECT_DIR` is the documented, authoritative
one and should be preferred.

**`~/.claude` convention**: there is no special env var for the user's home
`.claude` directory — Claude Code's own settings cascade
(`~/.claude/settings.json` → `.claude/settings.json` → `.claude/settings.local.json`,
precedence local > project > user, confirmed at
[Settings](https://code.claude.com/docs/en/settings)) is built by joining
`os.homedir()` with `.claude/...` in the CLI itself. A Node hook has no
special primitive for this beyond `os.homedir()` (zero-dependency, built in,
correct on Windows/macOS/Linux) — which is exactly what's proposed below.

Claude Code's own settings merge algorithm (cite same page): *"Later files
override earlier ones for scalar values, arrays are concatenated and
de-duplicated, and objects are deep-merged"* — with two documented
exceptions (`fallbackModel`, `availableModels`, which replace instead of
merge). This is a reasonable model to imitate for a `bash-guardrails.json`
cascade, and reuses a convention Claude Code users already have a mental
model for.

### 1.2 What real, in-the-wild Claude Code guardrail hooks do today

Searched GitHub for PreToolUse-based Bash guardrail projects (2026-07-02):

| Project | Approach | Config story |
|---|---|---|
| [`dwarvesf/claude-guardrails`](https://github.com/dwarvesf/claude-guardrails) | `permissions.deny` glob rules + `hooks.PreToolUse` pattern rules, installed *into* the user's own `~/.claude/settings.json` (merged, not replaced) plus a `~/.claude/CLAUDE.md` of natural-language instructions. | No separate config file — the "config" *is* `settings.json` itself. Install/uninstall scripts do a scripted merge/subtract so hand-added user rules survive an uninstall. No stable rule ids; matching is by literal string diff of the rule content. |
| [`rulebricks/claude-code-guardrails`](https://github.com/rulebricks/claude-code-guardrails) | A PreToolUse hook script (`~/.claude/hooks/guardrail.py`) that calls out to a **cloud-hosted rules engine** (Rulebricks) rather than evaluating rules locally. | Config lives in a hosted decision table, edited via a web UI; local `~/.claude/settings.json` only carries an API key (`env.RULEBRICKS_API_KEY`) and a verbosity flag. Explicitly pitched against file-based config: *"policy changes need to apply instantly across your team — no git pull, no restart."* Not applicable to this project's zero-dependency/offline constraint, but confirms "env-var-for-secrets + external config source" is a real pattern others use. |
| [`mafiaguy/claude-security-guardrails`](https://github.com/mafiaguy/claude-security-guardrails) | Regex pattern bank (30+ patterns) for `rm -rf`, force-push, leaked keys, SQLi, `eval()`, plus a companion dashboard. | UNVERIFIED in detail (not fetched past the listing) — surfaced by search as a comparable regex-bank hook; worth a follow-up read if a bigger catalog pass happens (see `03_catalog.md`). |

Takeaway: **no examined project ships a dedicated, merged, two-tier JSON
config file the way ESLint/Prettier do.** The dominant pattern in the wild is
"the config *is* `settings.json`" (edit the allow/deny lists Claude Code
already reads) or "config lives in an external service." Neither gives
`bash-guardrails` what it needs (structured rule objects: pattern + reason +
id + severity), which is why a dedicated `bash-guardrails.json` — described
below — is still the right shape, even though it isn't a copied convention.

---

## 2. Config file design: merged JSON over defaults

### 2.1 Locations and merge order

Two tiers, read by the hook at the top of `decide()`, mirroring Claude Code's
own settings precedence (user < project, confirmed in §1.1):

1. **User**: `path.join(os.homedir(), '.claude', 'bash-guardrails.json')`
2. **Project**: `path.join(process.env.CLAUDE_PROJECT_DIR, '.claude', 'bash-guardrails.json')`
   (skip if `CLAUDE_PROJECT_DIR` is unset — should not happen for a plugin
   hook per §1.1, but treat as "no project config" rather than throwing)

Merge semantics, copying Claude Code's own rule (§1.1): scalars = last file
wins (project overrides user); arrays (`extraAllowCommands`, `extraDenyRules`,
`extraBlockRules`, `disabledRules`) = concatenated + de-duplicated by id/value;
`ruleOverrides` (an object keyed by rule id) = deep-merged key-by-key, project
wins per key. Built-in defaults are always the base layer underneath both.

### 2.2 Schema sketch

```jsonc
// ~/.claude/bash-guardrails.json  (user tier)
// <project>/.claude/bash-guardrails.json  (project tier, overrides user)
{
  "$schema": "https://raw.githubusercontent.com/pavel-rp/bash-guardrails/main/schema/config.schema.json",
  "version": 1,

  // Turn a built-in rule off entirely (id refers to a stable id added to
  // DENY_RULES / GIT_DENY_RULES / BLOCK_RULES / NEVER_AUTO_ALLOW — see §3).
  // Rarely what you want for a DENY_RULES id; prefer ruleOverrides for those
  // so the demotion is visible and deliberate rather than silent.
  "disabledRules": ["cat-head-tail-guard"],

  // Change a built-in rule's severity without deleting it.
  //   "deny"  — hard block (only meaningful for demoting BLOCK -> DENY, or
  //             re-promoting something a lower tier had softened)
  //   "ask"   — fall through to Claude Code's normal permission prompt
  //             (this is how you demote a DENY_RULES / NEVER_AUTO_ALLOW
  //             entry without fully disabling it)
  //   "off"   — auto-allow silently (== disabledRules for an ALLOW-adjacent
  //             rule; DANGEROUS for anything in DENY_RULES — the hook should
  //             refuse "off" for ids tagged tier:"deny" in the built-in
  //             catalog and clamp to "ask" instead, see §2.3)
  "ruleOverrides": {
    "npx-arbitrary-exec": "ask",
    "chmod-chown-recursive": "ask"
  },

  // Extra leading commands to auto-approve once a command has passed the
  // deny+block gates (same trust tier as the built-in ALLOW_COMMANDS set).
  "extraAllowCommands": ["docker", "kubectl", "terraform"],

  // Extra hard-deny patterns. Matched the same way as DENY_RULES: anywhere
  // in the command string. `flags` defaults to "i" if omitted.
  "extraDenyRules": [
    {
      "id": "org-terraform-destroy",
      "pattern": "\\bterraform\\s+destroy\\b",
      "reason": "terraform destroy is blocked by team policy.",
      "flags": "i"
    }
  ],

  // Extra BLOCK rules (deny-with-instructive-reason, first-match-wins,
  // appended after the built-in BLOCK_RULES so built-ins still take
  // priority on overlap).
  "extraBlockRules": [
    {
      "id": "org-no-curl-pipe-sh",
      "pattern": "curl[^\\n]*\\|\\s*sh\\b",
      "reason": "Do not pipe curl output into sh. Download to a file and inspect it first.",
      "flags": "i"
    }
  ],

  // Same shape, applied to the PowerShell tier only.
  "powershell": {
    "disabledRules": [],
    "ruleOverrides": {},
    "extraAllowCommands": ["kubectl"],
    "extraDenyRules": [],
    "extraBlockRules": []
  }
}
```

Field summary:

| Field | Type | Effect |
|---|---|---|
| `version` | number | Config schema version; unknown version → treat whole file as invalid (fail to defaults, §2.4) rather than guess-parsing it. |
| `disabledRules` | string[] | Rule ids to fully skip. |
| `ruleOverrides` | `{ [ruleId]: "deny" \| "ask" \| "off" }` | Change a rule's tier without deleting it. |
| `extraAllowCommands` | string[] | Extra leading tokens added to `ALLOW_COMMANDS`. |
| `extraDenyRules` / `extraBlockRules` | `{id, pattern, reason, flags?}[]` | User-authored regex rules, same shape as the built-in arrays plus a required `id`. |
| `powershell.*` | same shape | Applies to `decidePowershell` instead of `decideBash`. |

### 2.3 The danger of user-supplied regex, and why "off" needs clamping

Two distinct risks, both real given this is hand-authored JSON, not a linter
extension published/reviewed by anyone:

1. **Syntax errors.** `new RegExp(pattern, flags)` throws a `SyntaxError` for
   malformed input (e.g. an unbalanced `(`). Trivial to catch per-entry.
2. **ReDoS / catastrophic backtracking.** A pattern with nested quantifiers
   (`(a+)+b`) can make `.test()` take exponential time on a pathological
   input. There is no reliable static detector: the well-known `safe-regex`
   npm package is known to both false-positive and false-negative in
   practice ([Snyk, "ReDoS and catastrophic backtracking"](https://snyk.io/blog/redos-and-catastrophic-backtracking/);
   [Sonar, "the dangers of Regular Expressions in JavaScript"](https://www.sonarsource.com/blog/vulnerable-regular-expressions-javascript/)).
   Node has no built-in per-call regex timeout — the standard mitigations are
   input-length caps, a worker-thread-with-timeout, or Google's RE2 engine
   (linear-time, no backtracking, but a native/WASM dependency this project
   deliberately avoids). See also
   [`davisjam/vuln-regex-detector`](https://github.com/davisjam/vuln-regex-detector)
   for the state of static detection tooling generally.

   Given the **non-adversarial** threat model (the user is authoring their
   *own* config, not receiving hostile input from an attacker), full ReDoS
   defense is disproportionate. The pragmatic mitigation already exists in
   this repo: `hooks/hooks.json` sets `"timeout": 10` on the hook process.
   Per the official exit-code semantics
   ([Hooks reference](https://code.claude.com/docs/en/hooks)) — *"Exit 2
   means a blocking error... Any other exit code is a non-blocking error for
   most hook events"* — a killed/timed-out hook process is a non-blocking
   error, which the docs and third-party write-ups describe as falling
   through rather than hanging the session
   ([TECHSY hooks guide](https://techsy.io/en/blog/claude-code-hooks-guide),
   UNVERIFIED against an official doc line specific to *timeout* rather than
   generic non-zero exit — the general non-blocking-error framing is
   verified, the timeout-specific framing is inferred from secondary
   sources). Worst case with a pathological user regex: one extra permission
   prompt after a 10s stall, not a silent allow and not an unrecoverable
   hang. Document the risk (avoid nested quantifiers, keep custom patterns
   short and anchored) rather than trying to sandbox it.

3. **`ruleOverrides: "off"` on a DENY_RULES id.** This is the one place a
   *syntactically valid, successfully-loaded* config can do real harm: a
   user (or a checked-in project file a teammate didn't scrutinize) turns
   off `rm-recursive`. Recommend the built-in rule catalog tag each id with
   its native tier (`"deny"` for `DENY_RULES`/`GIT_DENY_RULES`, `"block"` for
   `BLOCK_RULES`, `"never-auto-allow"` for that array), and have the merge
   step **clamp** `"off"` to `"ask"` for any id tagged `"deny"` — i.e. a
   config can always *loosen a DENY down to a prompt*, never *straight past
   the user entirely*. This is a design opinion, not sourced from any
   external convention — flagging it as a recommendation, not a verified
   fact.

### 2.4 Failure story — must degrade to passthrough, never fail-open

Mirrors the existing top-level pattern in `guardrails.js` (`decide()` is
already wrapped in try/catch at the stdin handler, falling back to
`passthrough()` — see `hooks/guardrails.js` lines 386–392). Config loading
should nest the same guarantee one level in:

```js
function loadUserConfig() {
  try {
    const userCfg = readConfigFile(path.join(os.homedir(), '.claude', 'bash-guardrails.json'));
    const projectDir = process.env.CLAUDE_PROJECT_DIR;
    const projectCfg = projectDir
      ? readConfigFile(path.join(projectDir, '.claude', 'bash-guardrails.json'))
      : null;
    return mergeConfigs(userCfg, projectCfg); // compiles regexes; see below
  } catch {
    // Any unexpected throw anywhere in the load/merge/compile path discards
    // ALL user config for this run. Built-in defaults (already reviewed,
    // deny-safe) are what ships without this function ever being called, so
    // returning null here is equivalent to "config disabled this run."
    return null;
  }
}

function readConfigFile(filePath) {
  if (!fs.existsSync(filePath)) return null;         // expected: no config yet
  let raw;
  try { raw = fs.readFileSync(filePath, 'utf8'); }
  catch { return null; }                              // unreadable -> ignore file
  let parsed;
  try { parsed = JSON.parse(raw); }
  catch { return null; }                               // malformed JSON -> ignore file
  if (parsed.version !== 1) return null;               // unknown schema -> ignore file
  return parsed;
}

// Per-entry, not per-file: one bad regex in extraDenyRules should not cost
// the user their other nine custom rules, unlike a JSON parse error (which
// makes the whole structure untrustworthy and forces an all-or-nothing
// discard above).
function compileExtraRule(entry) {
  try {
    if (!entry || typeof entry.id !== 'string' || typeof entry.pattern !== 'string'
        || typeof entry.reason !== 'string') return null;   // shape check
    return { id: entry.id, pattern: new RegExp(entry.pattern, entry.flags || 'i'), reason: entry.reason };
  } catch {
    return null; // bad regex syntax -> drop just this entry
  }
}
```

Failure matrix:

| Failure | Behavior | Net effect |
|---|---|---|
| No config file at either tier | `readConfigFile` returns `null` for both | Built-in defaults only (today's behavior, unchanged) |
| File exists, unreadable (permissions, race) | Caught, file ignored | Built-in defaults only |
| Malformed JSON syntax | `JSON.parse` throws, caught, **whole file** ignored | Built-in defaults only — deliberately coarse: a truncated/corrupt file can't be partially trusted |
| Unknown/missing `version` | File ignored | Built-in defaults only — forward-compat: a future schema v2 doesn't get misparsed as v1 |
| One `extraDenyRules`/`extraBlockRules` entry has bad regex or wrong shape | That **entry** dropped, rest of file still applies | Other custom rules + all built-ins still active |
| `ruleOverrides` sets `"off"` on a `deny`-tagged built-in id | Clamped to `"ask"` (§2.3) | Never silently disables a hard deny |
| Uncaught exception anywhere else in load/merge | Outer try/catch → `loadUserConfig()` returns `null` | Built-in defaults only, same as "no config" |
| `decide()` itself throws (existing behavior, unchanged) | Outer try/catch in the stdin handler → `passthrough()` | Empty `{}` → Claude Code's normal prompt |

Every row lands on "built-in defaults" or "normal prompt" — never on a
config-authored silent allow that wasn't validated. This satisfies the
project's stated invariant (`CLAUDE.md`: *"Empty `{}` output means 'no
opinion'"*) by construction: a broken config can only ever subtract
optional, additive behavior, never bypass the try/catch boundary that
already guarantees passthrough-on-error.

---

## 3. Should rules get stable ids? (ESLint comparison)

Today `DENY_RULES`, `GIT_DENY_RULES`, `BLOCK_RULES`, and `NEVER_AUTO_ALLOW` in
`guardrails.js` are anonymous — each entry is `{ pattern, reason }` or
`{ test, reason }` with no identifier a config file could reference. Any
config scheme in §2 needs stable ids added as a prerequisite (out of scope
for this doc to implement, but it's the one required code change).

ESLint's convention, confirmed at
[Configure Rules](https://eslint.org/docs/latest/use/configure/rules)
(2026-07-02):

- Every rule has a **string id** (`"no-unused-vars"`, or
  `"pluginNamespace/ruleName"` for plugin rules).
- **Severity** is `"off"`/`0`, `"warn"`/`1`, `"error"`/`2`. *"If the severity
  is off or 0, then the rule is disabled and validation stops, ignoring any
  other elements of the rule config array."*
- Rules with options use array form: `["error", { ignoreReadBeforeAssign: true }]`.
- **Cascade**: *"the rule configuration is merged with the later object
  taking precedence over any previous objects"* — and critically, overriding
  just the severity **preserves prior options**: a base config's
  `semi: ["error", "never"]` overridden by `semi: "warn"` resolves to
  `["warn", "never"]`, not `["warn"]` with options reset to default.

Mapping to this project:

| ESLint concept | bash-guardrails analog | Fit |
|---|---:|---|
| Rule id (`"no-unused-vars"`) | Kebab-case id per array entry (`rm-recursive`, `git-force-push`, `find-delete`, `chmod-recursive`, `pipe-block`, `heredoc-block`, `cat-head-tail-guard`, `chain-splittable`, …) | Direct fit — same purpose, same naming convention. |
| Severity `off`/`warn`/`error` | `off`/`ask`/`deny` (§2.2) — **not** a literal `warn`, since this hook has no post-hoc reporting mode; `ask` is the closest equivalent ("don't block silently, but don't stay silent either") | Direct fit conceptually; different vocabulary because the two tools have different failure modes (linter reports after the fact, this hook gates before execution). |
| Severity-preserving override (`semi: "warn"` keeps `["never"]`) | Not directly applicable — this project's rules don't carry configurable *options* beyond pattern/reason, so there's nothing to preserve across an override | N/A today; would matter if a future `ruleOverrides` entry could also override `reason` text, but that's out of scope here. |
| `extends` + `overrides` (cascading files, glob-scoped overrides) | The two-tier user/project file (§2.1) is a much smaller version of this — no glob-scoped per-directory overrides | Deliberately simpler; ESLint's `overrides` solves "different rules per subfolder," which has no analog for a single-repo-wide Bash-command gate. |
| Config comments override everything (`/* eslint-disable */`) | No analog, and shouldn't get one — an inline comment inside a shell command is attacker/mistake-controlled input, not a trusted config source | Deliberately not copied — would reopen exactly the kind of "trust the command string" hole the project's threat model excludes by design. |

Net: yes, add ids — cheap, additive, and the `off`/`ask`/`deny` vocabulary
is a natural, narrower translation of ESLint's `off`/`warn`/`error`, not a
verbatim copy.

---

## 4. Is there a Claude Code-native plugin configuration mechanism?

**Yes — `userConfig` in `plugin.json`, VERIFIED.** This is the single
biggest finding of this section: the brief assumed this might not exist yet;
it does, as of Claude Code **v2.1.83**
([turboai.dev changelog note](https://www.turboai.dev/blog/claude-code-env-vars-v2-1-83);
schema confirmed directly against
[Plugins reference — "User configuration"](https://code.claude.com/docs/en/plugins-reference), 2026-07-02).

### 4.1 What it is

`plugin.json` can declare a `userConfig` object; Claude Code **prompts the
user for each value when the plugin is enabled**, instead of requiring a
hand-edited file:

```json
{
  "userConfig": {
    "extra_allow_commands": {
      "type": "string",
      "title": "Extra safe commands",
      "description": "Additional leading commands to auto-approve (comma-separated).",
      "multiple": true
    },
    "config_path": {
      "type": "file",
      "title": "Custom rules file",
      "description": "Optional path to a bash-guardrails.json with extra/overridden rules."
    }
  }
}
```

Field schema (from the same doc): `type` (`string`/`number`/`boolean`/
`directory`/`file`, required), `title` (required), `description` (required),
`sensitive` (masks input, routes to system keychain instead of
`settings.json` — 2KB keychain budget, shared with OAuth tokens), `required`,
`default`, `multiple` (string type only — array of strings), `min`/`max`
(number type only).

**Delivery to the hook, both confirmed in the same doc:**
- Substitutable as `${user_config.KEY}` directly inside a hook's `command`
  string in `hooks/hooks.json`.
- **Every value is also exported as `CLAUDE_PLUGIN_OPTION_<KEY>`** to the
  hook's subprocess environment — meaning `guardrails.js` could read
  `process.env.CLAUDE_PLUGIN_OPTION_EXTRA_ALLOW_COMMANDS` directly with zero
  changes to `hooks.json`'s `command` line. This is the cleanest integration
  point available: no shell-quoting concerns (unlike `${user_config.*}`
  substituted into the command string), no extra parsing of CLI args.
- Non-sensitive values persist in `settings.json` under
  `pluginConfigs[<plugin-id>].options`; sensitive ones go to the OS keychain
  (or `~/.claude/.credentials.json` as fallback).

### 4.2 Fit and limits for this project

`userConfig` is a flat, typed key-value bag (plus `multiple` for a bare
array of strings) — it cannot natively express the nested rule-object shape
(`{id, pattern, reason}[]`) that `extraDenyRules`/`ruleOverrides` need. Two
real bugs are open against the feature as of this search
([#39455 — userConfig values not prompted on enable](https://github.com/anthropics/claude-code/issues/39455),
[#39827 — substitution fails with "Missing required user configuration
value"](https://github.com/anthropics/claude-code/issues/39827)), suggesting
it's a relatively young, still-settling surface — worth treating as
supplementary rather than load-bearing for now.

**Recommended combination, not either/or:**

- Keep the JSON file (§2) as the **expressive** path — it's the only way to
  author `{id, pattern, reason}` rule objects, and it doesn't require
  re-enabling the plugin (editing `.claude/bash-guardrails.json` takes
  effect on the next hook invocation; no `/reload-plugins` needed since it's
  read fresh from disk on every `node guardrails.js` cold start).
- Add a **small `userConfig` surface** as the discoverable, no-file-editing
  on-ramp for the common cases: `extra_allow_commands` (string, `multiple:
  true`) for the 80% case of "I just want to allow `docker`/`kubectl` too,"
  and optionally a `config_path` (`type: "file"`) field so a user who wants
  the full schema can point-and-click to a file instead of remembering the
  `~/.claude/bash-guardrails.json` convention. Both routes should feed the
  *same* internal merge function from §2, so there's one code path to keep
  fail-safe, not two.

### 4.3 What is NOT a general plugin-config mechanism (checked, ruled out)

- **`settings.json` at the plugin root** — real, but scoped to exactly two
  keys today (`agent`, `subagentStatusLine`; confirmed in the plugins
  reference's "Standard plugin layout" / file-locations table). Not a
  general config surface, and not user-editable per-install — it's a
  plugin-shipped default, the opposite direction of what's needed here.
- **`marketplace.json` plugin entries** — carries `name`, `source`,
  `description`, and `version`/`defaultEnabled` overrides
  ([Plugin marketplaces](https://code.claude.com/docs/en/plugin-marketplaces),
  cross-checked against this repo's own
  `.claude-plugin/marketplace.json`). No mechanism for arbitrary
  plugin-behavior config — it's a catalog format, not a settings format.
- **`pluginConfigs` in `settings.json`** — this key exists but is described
  in the plugins-reference doc purely as the **storage backend** for
  `userConfig` answers (§4.1); it is not a separately documented
  user-facing config surface a plugin author edits directly. A general
  `settings.json` fetch on 2026-07-02 did not surface `pluginConfigs` as a
  standalone documented key outside that context — treat it as an
  implementation detail of `userConfig`, not a second mechanism.

---

## Bottom line for question D

1. `CLAUDE_PROJECT_DIR` (env var, confirmed exported to hook subprocesses)
   + `os.homedir()` are sufficient, zero-dependency primitives to locate a
   two-tier `bash-guardrails.json` cascade — no undocumented or fragile
   plumbing required.
2. No examined prior-art hook ships this exact pattern (they either edit
   `settings.json` directly or defer to a hosted service) — the schema in
   §2.2 is original design, not a copy, but it's a small, defensible
   surface: `disabledRules` / `ruleOverrides` / `extraAllowCommands` /
   `extraDenyRules` / `extraBlockRules`, each keyed by a new stable rule
   `id` field that should be added to the existing rule arrays regardless of
   whether config ships.
3. The fail-safe story reuses the try/catch boundary the hook already has
   (`decide()` → `passthrough()` on any throw) one level deeper: any
   config-loading failure — missing file, unreadable file, malformed JSON,
   unknown schema version, bad regex in one entry — degrades to "use
   built-in defaults" or, worst case, "empty `{}` → normal prompt." Nothing
   in the failure matrix (§2.4) produces a silent allow.
4. **A native mechanism exists and was previously unverified — now
   confirmed**: `userConfig` in `plugin.json` (Claude Code v2.1.83+),
   delivering typed values to the hook via `CLAUDE_PLUGIN_OPTION_<KEY>` env
   vars or `${user_config.*}` substitution. It's a good complementary
   on-ramp for scalar/array knobs (extra allow-commands) but not expressive
   enough to replace the JSON file for structured rule objects — recommend
   both, feeding one shared merge function.
