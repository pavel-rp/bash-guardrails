#!/usr/bin/env node
'use strict';

/**
 * analyze.js — data collector for the `tune-rules` skill.
 *
 * Walks Claude Code session transcripts under `~/.claude/projects/**\/*.jsonl`
 * (READ-ONLY — never writes anything there), extracts every Bash/PowerShell
 * tool call inside a recent time window, replays each unique command through
 * the hook that ships NEXT TO THIS SCRIPT, and prints ONE JSON report to
 * stdout. Progress goes to stderr so stdout stays parseable.
 *
 * Run as a single command (this plugin blocks pipes/chains):
 *   node "${CLAUDE_SKILL_DIR}/scripts/analyze.js" --days 30
 *
 * The script only COLLECTS. All judgment — which candidates are safe, what to
 * propose, what to write where — belongs to the skill reading the report.
 *
 * Transcript schema (verified empirically — see docs/research/06 in the repo):
 *   - assistant lines: message.content[] holds {type:"tool_use", id, name, input}.
 *   - user lines: message.content[] holds {type:"tool_result", tool_use_id};
 *     the SIBLING top-level `toolUseResult` is a STRING for failures
 *     ("User rejected tool use" exactly for a manual rejection, "Error:
 *     BLOCKED…" for a hook denial) and an OBJECT for successes. That
 *     string-vs-object split is a structural discriminator, not text-matching.
 *   - "Silently auto-approved" vs "prompted then approved" is NOT recoverable
 *     from transcripts (validated negative finding) — so candidate ranking
 *     uses frequency × project spread, never approval counts.
 *
 * Examples in the report pass through redact() (secrets/token shapes blanked,
 * home dir → ~, 200-char cap). The report is still LOCAL data: the skill must
 * sanity-check anything it quotes onward.
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const readline = require('node:readline');
const { spawnSync } = require('node:child_process');

const PLUGIN_ROOT = path.join(__dirname, '..', '..', '..');
const HOOK = path.join(PLUGIN_ROOT, 'hooks', 'guardrails.js');
const TRANSCRIPTS_ROOT = path.join(os.homedir(), '.claude', 'projects');
const USER_CONFIG = path.join(os.homedir(), '.claude', 'bash-guardrails.json');
const USER_SETTINGS = path.join(os.homedir(), '.claude', 'settings.json');

// Leading tokens that must never be proposed for ALLOW_COMMANDS: an opaque
// nested shell/elevation defeats the whole string-scan model (the deny scan
// cannot see inside `bash run.sh`). Kept in the report but flagged, so the
// skill can explain the friction instead of proposing to remove it.
const NESTED_SHELL_TOKENS = new Set([
  'bash', 'sh', 'zsh', 'dash', 'ksh', 'pwsh', 'powershell', 'cmd', 'su', 'sudo', 'doas',
]);

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const args = { days: 30, maxExamples: 8 };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--days' && argv[i + 1]) args.days = Math.max(1, parseInt(argv[++i], 10) || 30);
    if (argv[i] === '--max-examples' && argv[i + 1]) args.maxExamples = Math.max(1, parseInt(argv[++i], 10) || 8);
  }
  return args;
}

// ---------------------------------------------------------------------------
// Redaction — examples only. Aggregate counts never need redaction.
// ---------------------------------------------------------------------------
const SECRET_PATTERNS = [
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g,          // GitHub tokens
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bsk-[A-Za-z0-9_-]{16,}\b/g,                             // API-key shapes
  /\beyJ[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, // JWT
  /\b(?:token|secret|password|passwd|api[_-]?key|bearer|authorization)\s*[=:]\s*\S+/gi,
  /\b[A-Fa-f0-9]{32,}\b/g,                                  // long hex blobs
  /\b[A-Za-z0-9+/]{48,}={0,2}\b/g,                          // long base64 blobs
];
// Match the home dir under either separator spelling (C:\Users\x and C:/Users/x).
const HOME_RE = new RegExp(
  os.homedir().split(/[\\/]/).map((seg) => seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[\\\\/]'),
  'gi'
);

function redact(command) {
  let out = String(command).replace(HOME_RE, '~');
  for (const re of SECRET_PATTERNS) out = out.replace(re, '«redacted»');
  if (out.length > 200) out = out.slice(0, 200) + '…';
  return out;
}

// Mirrors guardrails.js's leadingCommand() — for GROUPING only, never for
// decisions (decisions always come from a real replay through the hook).
function leadingCommand(command) {
  const withoutEnv = String(command || '').replace(/^\s*(\w+=(?:"[^"]*"|'[^']*'|\S+)\s+)+/, '');
  const match = withoutEnv.match(/^\s*(\S+)/);
  if (!match) return '';
  return match[1].split(/[\\/]/).pop().toLowerCase();
}

// ---------------------------------------------------------------------------
// Extract — shell tool calls + outcomes from windowed transcripts
// ---------------------------------------------------------------------------
function findJsonlFiles(dir, newerThanMs) {
  const out = [];
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...findJsonlFiles(full, newerThanMs));
    } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      // mtime = last append; a file older than the window can't contain
      // in-window events, so skip it without opening.
      try { if (fs.statSync(full).mtimeMs >= newerThanMs) out.push(full); } catch { /* skip */ }
    }
  }
  return out;
}

function classifyOutcome(toolUseResult) {
  if (typeof toolUseResult === 'object' && toolUseResult !== null) return { outcome: 'executed' };
  if (typeof toolUseResult !== 'string') return { outcome: 'unknown' };
  if (toolUseResult === 'User rejected tool use') return { outcome: 'user-rejected' };
  if (/BLOCKED \(dangerous\):/.test(toolUseResult)) return { outcome: 'hook-denied', reason: toolUseResult };
  if (/BLOCKED:/.test(toolUseResult)) return { outcome: 'hook-blocked', reason: toolUseResult };
  if (/interrupt/i.test(toolUseResult)) return { outcome: 'interrupted' };
  return { outcome: 'error' };
}

async function extract(cutoffMs) {
  const files = findJsonlFiles(TRANSCRIPTS_ROOT, cutoffMs);
  process.stderr.write(`Scanning ${files.length} transcript files (window-fresh) under ${TRANSCRIPTS_ROOT}\n`);

  const events = []; // {tool, command, project, file, seq, ts, outcome, reason?}
  let filesScanned = 0;

  for (const file of files) {
    filesScanned++;
    const rel = path.relative(TRANSCRIPTS_ROOT, file);
    const project = rel.split(path.sep)[0];
    const pending = new Map(); // tool_use_id -> {tool, command, ts, seq}
    let seq = 0;

    const rl = readline.createInterface({
      input: fs.createReadStream(file, { encoding: 'utf8' }),
      crlfDelay: Infinity,
    });
    for await (const line of rl) {
      if (!line.trim()) continue;
      let obj;
      try { obj = JSON.parse(line); } catch { continue; }

      const content = obj.message && Array.isArray(obj.message.content) ? obj.message.content : [];
      if (obj.type === 'assistant') {
        for (const item of content) {
          if (item && item.type === 'tool_use' && (item.name === 'Bash' || item.name === 'PowerShell')) {
            const command = String((item.input && item.input.command) || '').trim();
            if (command) pending.set(item.id, { tool: item.name, command, ts: obj.timestamp, seq: seq++ });
          }
        }
      } else if (obj.type === 'user') {
        for (const item of content) {
          if (item && item.type === 'tool_result' && pending.has(item.tool_use_id)) {
            const use = pending.get(item.tool_use_id);
            pending.delete(item.tool_use_id);
            if (typeof use.ts === 'string' && Date.parse(use.ts) < cutoffMs) continue; // event predates window
            const { outcome, reason } = classifyOutcome(obj.toolUseResult);
            events.push({ ...use, project, file: rel, outcome, reason });
          }
        }
      }
    }
  }
  return { events, filesScanned };
}

// ---------------------------------------------------------------------------
// Replay — every unique (tool, command) through the ADJACENT hook.
// CLAUDE_PROJECT_DIR is stripped so replay reflects the USER-level config
// only, not whichever project the skill happens to run from.
// ---------------------------------------------------------------------------
function replayAll(events) {
  const unique = new Map(); // key -> {tool, command}
  for (const e of events) {
    const key = `${e.tool} ${e.command}`;
    if (!unique.has(key)) unique.set(key, { tool: e.tool, command: e.command });
  }
  process.stderr.write(`Replaying ${unique.size} unique commands through ${HOOK}\n`);

  const env = { ...process.env };
  delete env.CLAUDE_PROJECT_DIR;

  const decisions = new Map(); // key -> {decision: allow|deny|block|ask|error, reason?}
  let done = 0;
  for (const [key, { tool, command }] of unique) {
    const res = spawnSync(process.execPath, [HOOK], {
      input: JSON.stringify({ tool_name: tool, tool_input: { command } }),
      encoding: 'utf8', env, timeout: 10000,
    });
    let entry = { decision: 'error' };
    if (res.status === 0 && res.stdout) {
      try {
        const out = JSON.parse(res.stdout);
        const d = out.hookSpecificOutput && out.hookSpecificOutput.permissionDecision;
        const reason = out.hookSpecificOutput && out.hookSpecificOutput.permissionDecisionReason;
        if (!d) entry = { decision: 'ask' };
        else if (d === 'allow') entry = { decision: 'allow' };
        else entry = { decision: /BLOCKED \(dangerous\)/.test(reason || '') ? 'deny' : 'block', reason };
      } catch { /* keep error */ }
    }
    decisions.set(key, entry);
    if (++done % 200 === 0) process.stderr.write(`  ${done}/${unique.size}\n`);
  }
  return decisions;
}

// ---------------------------------------------------------------------------
// Analyze
// ---------------------------------------------------------------------------
function ruleIdForReason(reasonText, rules) {
  if (!reasonText) return 'unknown';
  for (const rule of rules) {
    if (rule.reason && reasonText.includes(rule.reason)) return rule.id;
  }
  const promoted = reasonText.match(/rule '([^']+)' promoted to deny/);
  return promoted ? promoted[1] : 'retired-or-unknown';
}

function analyze(events, decisions, maxExamples) {
  const mod = require(HOOK); // rule arrays only — require.main guard keeps stdin detached
  const reasonRules = [
    ...mod.DENY_RULES, ...mod.BLOCK_RULES,
    ...mod.PS_DENY_RULES, ...mod.PS_GUIDANCE_RULES,
  ];
  const keyOf = (e) => `${e.tool} ${e.command}`;

  // --- ALLOW candidates: commands that land on the ask tier today ----------
  const byToken = new Map();
  for (const e of events) {
    const { decision } = decisions.get(keyOf(e)) || {};
    const token = leadingCommand(e.command) || '(empty)';
    let g = byToken.get(`${e.tool} ${token}`);
    if (!g) {
      g = { token, tool: e.tool, runs: 0, askRuns: 0, denyRuns: 0, blockRuns: 0,
            commands: new Set(), askCommands: new Set(), projects: new Set(), examples: new Set() };
      byToken.set(`${e.tool} ${token}`, g);
    }
    g.runs++;
    g.commands.add(e.command);
    g.projects.add(e.project);
    if (decision === 'ask') {
      g.askRuns++;
      g.askCommands.add(e.command);
      if (g.examples.size < maxExamples) g.examples.add(redact(e.command));
    } else if (decision === 'deny') g.denyRuns++;
    else if (decision === 'block') g.blockRuns++;
  }
  const allowCandidates = [...byToken.values()]
    .filter((g) => g.askRuns > 0)
    .map((g) => ({
      token: g.token, tool: g.tool,
      askRuns: g.askRuns, totalRuns: g.runs,
      uniqueAskCommands: g.askCommands.size,
      projects: g.projects.size,
      denyRunsSameToken: g.denyRuns, blockRunsSameToken: g.blockRuns,
      nestedShell: NESTED_SHELL_TOKENS.has(g.token),
      examples: [...g.examples],
    }))
    .sort((a, b) => b.askRuns * b.projects - a.askRuns * a.projects)
    .slice(0, 25);

  // --- Historical blocks: fixed already vs still blocking (FP review) ------
  const stillBlocked = new Map();
  let blocksNowAllowedOrAsk = 0;
  let blocksTotal = 0;
  for (const e of events) {
    if (e.outcome !== 'hook-blocked' && e.outcome !== 'hook-denied') continue;
    blocksTotal++;
    const now = decisions.get(keyOf(e)) || {};
    if (now.decision === 'allow' || now.decision === 'ask') { blocksNowAllowedOrAsk++; continue; }
    const id = ruleIdForReason(now.reason || e.reason, reasonRules);
    let g = stillBlocked.get(id);
    if (!g) { g = { ruleId: id, count: 0, examples: new Set() }; stillBlocked.set(id, g); }
    g.count++;
    if (g.examples.size < maxExamples) g.examples.add(redact(e.command));
  }
  const blockReview = [...stillBlocked.values()]
    .map((g) => ({ ...g, examples: [...g.examples] }))
    .sort((a, b) => b.count - a.count);

  // --- Manual rejections: DENY/ask-rule evidence ----------------------------
  const rejections = events
    .filter((e) => e.outcome === 'user-rejected')
    .slice(0, 20)
    .map((e) => ({
      tool: e.tool, project: e.project,
      command: redact(e.command),
      replayNow: (decisions.get(keyOf(e)) || {}).decision || 'unknown',
    }));

  // --- Steering: after a block, did a shell command run soon after? --------
  // Approximation: within the next 3 shell events of the same transcript file.
  const byFile = new Map();
  for (const e of events) {
    if (!byFile.has(e.file)) byFile.set(e.file, []);
    byFile.get(e.file).push(e);
  }
  const steering = new Map();
  for (const list of byFile.values()) {
    list.sort((a, b) => a.seq - b.seq);
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      if (e.outcome !== 'hook-blocked' && e.outcome !== 'hook-denied') continue;
      const id = ruleIdForReason(e.reason, reasonRules);
      let s = steering.get(id);
      if (!s) { s = { ruleId: id, blocks: 0, recoveredWithin3: 0 }; steering.set(id, s); }
      s.blocks++;
      if (list.slice(i + 1, i + 4).some((n) => n.outcome === 'executed')) s.recoveredWithin3++;
    }
  }
  const steeringRates = [...steering.values()]
    .map((s) => ({ ...s, recoveryRate: s.blocks ? +(s.recoveredWithin3 / s.blocks).toFixed(2) : null }))
    .sort((a, b) => b.blocks - a.blocks);

  return { allowCandidates, blockReview, blocksTotal, blocksNowAllowedOrAsk, rejections, steering: steeringRates };
}

// ---------------------------------------------------------------------------
// Existing config — so the skill never proposes a duplicate.
// ---------------------------------------------------------------------------
function readJsonOrNull(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function existingConfig() {
  const userConfig = readJsonOrNull(USER_CONFIG);
  const settings = readJsonOrNull(USER_SETTINGS);
  const permissionAllow = settings && settings.permissions && Array.isArray(settings.permissions.allow)
    ? settings.permissions.allow.filter((r) => typeof r === 'string' && /^(Bash|PowerShell)\(/.test(r))
    : null;
  return { userConfigPath: redact(USER_CONFIG), userConfig, shellPermissionAllowRules: permissionAllow };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cutoffMs = Date.now() - args.days * 86400000;

  const { events, filesScanned } = await extract(cutoffMs);
  process.stderr.write(`Extracted ${events.length} shell tool calls in the last ${args.days} days\n`);

  const decisions = replayAll(events);
  const analysis = analyze(events, decisions, args.maxExamples);

  const pluginMeta = readJsonOrNull(path.join(PLUGIN_ROOT, '.claude-plugin', 'plugin.json'));
  const report = {
    meta: {
      generatedAt: new Date().toISOString(),
      windowDays: args.days,
      filesScanned,
      shellEvents: events.length,
      uniqueCommands: decisions.size,
      hookVersion: (pluginMeta && pluginMeta.version) || 'unknown',
      note: 'auto-approved vs prompted-then-approved is indistinguishable in transcripts; ranking uses frequency × project spread only',
    },
    existingConfig: existingConfig(),
    ...analysis,
  };
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
}

main().catch((err) => {
  process.stderr.write(`analyze.js failed: ${err && err.stack || err}\n`);
  process.exit(1);
});
