'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

/**
 * Two-tier JSON config (~/.claude/bash-guardrails.json <- <project>/.claude/
 * bash-guardrails.json) merged over the built-in rule catalog. See
 * docs/research/04_config.md for the design. Every field is SHELL-SCOPED:
 * top-level fields apply to decideBash only, `powershell.*` applies to
 * decidePowershell only — a shared rule id (e.g. a GIT_DENY_RULES entry that
 * appears in both DENY_RULES and PS_DENY_RULES) needs its own override in
 * BOTH sections to loosen it for both shells. This is deliberate: a mistake
 * in one section can't silently change the other shell's behavior.
 *
 * Fail-safe invariant, enforced at every layer below: any load/parse/merge
 * failure degrades to the built-in defaults (emptyShellConfig()), never to a
 * silent allow. `loadConfig()` never throws.
 */

const EMPTY_SHELL_CONFIG_RAW = () => ({
  disabledRules: [],
  ruleOverrides: {},
  extraAllowCommands: [],
  extraDenyRules: [],
  extraBlockRules: [],
});

function emptyShellConfig() {
  return {
    disabledRules: new Set(),
    ruleOverrides: {},
    extraAllowCommands: new Set(),
    extraDenyRules: [],
    extraBlockRules: [],
  };
}

function emptyConfig() {
  return { ...emptyShellConfig(), powershell: emptyShellConfig() };
}

/**
 * Read + parse one config file. Any failure (missing, unreadable, malformed
 * JSON, unknown/missing `version`) returns null — the WHOLE file is ignored
 * rather than partially trusted, since a parse failure means the structure
 * itself can't be relied on.
 */
function loadConfigFile(filePath) {
  if (!filePath) return null;
  if (!fs.existsSync(filePath)) return null;
  let raw;
  try { raw = fs.readFileSync(filePath, 'utf8'); }
  catch { return null; }
  let parsed;
  try { parsed = JSON.parse(raw); }
  catch { return null; }
  if (!parsed || typeof parsed !== 'object' || parsed.version !== 1) return null;
  return parsed;
}

/**
 * Compile one extraDenyRules/extraBlockRules entry. Per-entry try/catch: a
 * bad regex or wrong shape drops just this entry, not the whole file. An id
 * colliding with a built-in rule id is rejected too — it would make
 * `ruleOverrides`/`disabledRules` ambiguous about which rule they target.
 * `g`/`y` flags are rejected: they make `RegExp.prototype.test()` STATEFUL
 * (via `lastIndex`), so the same compiled rule could silently skip a match
 * it already found once. These rules only ever need a plain match test.
 */
function compileExtraRule(entry, tier, builtinIds) {
  try {
    if (!entry || typeof entry.id !== 'string' || !entry.id
        || typeof entry.pattern !== 'string' || !entry.pattern
        || typeof entry.reason !== 'string' || !entry.reason) return null;
    if (builtinIds.has(entry.id)) return null;
    const flags = typeof entry.flags === 'string' ? entry.flags : 'i';
    if (/[gy]/.test(flags)) return null;
    return { id: entry.id, tier, pattern: new RegExp(entry.pattern, flags), reason: entry.reason };
  } catch {
    return null;
  }
}

/** Concat two string arrays, de-duplicated, preserving first-seen order. */
function dedupeArray(a, b) {
  return Array.from(new Set([...(a || []), ...(b || [])]));
}

/** Concat two extra-rule arrays, de-duplicated by id (project tier wins). */
function dedupeById(userRules, projectRules) {
  const byId = new Map();
  for (const r of userRules || []) if (r && typeof r.id === 'string') byId.set(r.id, r);
  for (const r of projectRules || []) if (r && typeof r.id === 'string') byId.set(r.id, r);
  return Array.from(byId.values());
}

/**
 * Merge one shell-scoped section (user tier <- project tier). Mirrors Claude
 * Code's own settings cascade: scalars/objects deep-merge with the later
 * (project) tier winning per key; arrays concatenate + de-duplicate.
 */
function mergeRawShellConfig(userShell, projectShell) {
  const u = userShell || EMPTY_SHELL_CONFIG_RAW();
  const p = projectShell || EMPTY_SHELL_CONFIG_RAW();
  return {
    disabledRules: dedupeArray(u.disabledRules, p.disabledRules),
    ruleOverrides: { ...(u.ruleOverrides || {}), ...(p.ruleOverrides || {}) },
    extraAllowCommands: dedupeArray(u.extraAllowCommands, p.extraAllowCommands),
    extraDenyRules: dedupeById(u.extraDenyRules, p.extraDenyRules),
    extraBlockRules: dedupeById(u.extraBlockRules, p.extraBlockRules),
  };
}

function mergeRawConfigs(userCfg, projectCfg) {
  return {
    ...mergeRawShellConfig(userCfg, projectCfg),
    powershell: mergeRawShellConfig(userCfg && userCfg.powershell, projectCfg && projectCfg.powershell),
  };
}

/** Turn a merged raw shell section into its runtime shape (Sets, compiled extra rules). */
function compileShellConfig(rawShell, builtinIds) {
  return {
    disabledRules: new Set(rawShell.disabledRules),
    ruleOverrides: rawShell.ruleOverrides,
    extraAllowCommands: new Set(rawShell.extraAllowCommands),
    extraDenyRules: rawShell.extraDenyRules
      .map((e) => compileExtraRule(e, 'deny', builtinIds)).filter(Boolean),
    extraBlockRules: rawShell.extraBlockRules
      .map((e) => compileExtraRule(e, 'block', builtinIds)).filter(Boolean),
  };
}

/**
 * Load + merge + compile the two-tier config. Never throws — any uncaught
 * failure anywhere in this path returns emptyConfig(), which is exactly
 * "built-in defaults only" (identical to today's pre-config behavior).
 *
 * Paths are injectable for tests (explicit `userConfigPath`/`projectConfigPath`
 * bypass os.homedir()/CLAUDE_PROJECT_DIR entirely, so a unit test never
 * touches the real ~/.claude/bash-guardrails.json).
 */
function loadConfig({ userConfigPath, projectConfigPath, builtinIds = new Set() } = {}) {
  try {
    const uPath = userConfigPath !== undefined
      ? userConfigPath
      : path.join(os.homedir(), '.claude', 'bash-guardrails.json');
    const projectDir = process.env.CLAUDE_PROJECT_DIR;
    const pPath = projectConfigPath !== undefined
      ? projectConfigPath
      : (projectDir ? path.join(projectDir, '.claude', 'bash-guardrails.json') : null);
    const userCfg = loadConfigFile(uPath);
    const projectCfg = loadConfigFile(pPath);
    const merged = mergeRawConfigs(userCfg || {}, projectCfg || {});
    return {
      ...compileShellConfig(merged, builtinIds),
      powershell: compileShellConfig(merged.powershell, builtinIds),
    };
  } catch {
    return emptyConfig();
  }
}

const VALID_OVERRIDES = new Set(['deny', 'ask', 'off']);

/**
 * Resolve the EFFECTIVE tier for one rule under one shell-scoped config:
 *   'deny' — hard-block (native behavior for a `deny`-tier rule; a promotion
 *            for a `never-auto-allow`-tier rule the user wants fully blocked)
 *   'ask'  — never silently allow: the caller must return passthrough()
 *            directly on match, NOT continue evaluating for auto-allow
 *            (skipping straight to "next check" could let an ALLOW_COMMANDS
 *            leading token silently approve the very thing being demoted)
 *   'off'  — rule doesn't fire at all; caller continues normally
 *
 * `disabledRules` and `ruleOverrides: "off"` are equivalent and go through
 * the SAME clamp: a `deny`-tier id can NEVER resolve to 'off' — it clamps to
 * 'ask'. This is the one invariant a config file can't override: it can
 * loosen a hard deny down to a prompt, never remove it outright.
 *
 * An unrecognized `ruleOverrides` value (e.g. a typo like `"allow"`, or a
 * non-string) is treated as NO override, not passed through — callers
 * (`applyDenyRule`/`applyBlockRule`) only branch on the exact strings
 * 'deny'/'ask', so any other value would fall through their `return null`
 * and silently behave like 'off' on a rule the clamp is specifically meant
 * to protect. Per-entry validation (same philosophy as compileExtraRule):
 * one bad value doesn't take down the whole config, it's just ignored.
 */
function effectiveTier(rule, shellConfig) {
  let override = shellConfig.ruleOverrides[rule.id];
  if (!VALID_OVERRIDES.has(override)) override = undefined;
  if (override === undefined && shellConfig.disabledRules.has(rule.id)) override = 'off';
  if (override === undefined) {
    // No config override: `tier` is a CATEGORY, not the emitted outcome —
    // both 'deny' and 'block' rules natively emit a 'deny' decision (block
    // rules just phrase the reason as instructive guidance, not a hard-deny
    // reason). 'never-auto-allow's native effect IS "ask" — that's what
    // demoting from auto-allow means today.
    return rule.tier === 'never-auto-allow' ? 'ask' : 'deny';
  }
  if (rule.tier === 'deny' && override === 'off') return 'ask'; // the clamp
  return override;
}

module.exports = {
  loadConfig, loadConfigFile, compileExtraRule, mergeRawConfigs, mergeRawShellConfig,
  compileShellConfig, effectiveTier, emptyConfig, emptyShellConfig,
};
