#!/usr/bin/env node
'use strict';

/**
 * mine-transcripts.js — empirical permission-prompt mining for bash-guardrails.
 *
 * Reads Claude Code session transcripts under `~/.claude/projects/**\/*.jsonl`
 * (READ-ONLY — never writes/deletes anything there), extracts every tool call
 * with its historical outcome, replays every unique Bash/PowerShell command
 * through the CURRENT bash-guardrails hook, and writes analysis-ready JSON
 * into `docs/research/.local/` (gitignored — raw transcript content, paths,
 * commit messages etc. may appear there).
 *
 * This file itself contains NO secrets and NO raw transcript content — it may
 * be committed and re-run after rule changes.
 *
 * Usage (run each phase as its own `node` call — see CLAUDE.md, this repo's
 * own hook blocks chained/piped Bash commands, so run these one at a time):
 *   node docs/research/tools/mine-transcripts.js extract
 *   node docs/research/tools/mine-transcripts.js replay
 *   node docs/research/tools/mine-transcripts.js analyze
 *
 * Schema notes (verified empirically against real transcripts on this
 * machine before writing this script — see the report's Methodology
 * section for the full writeup):
 *   - One JSON object per line. Relevant line shapes:
 *     - {"type":"assistant", message:{role:"assistant", content:[...]}, uuid,
 *       timestamp, sessionId, cwd, ...}. content[] items of interest:
 *       {"type":"tool_use", id, name, input:{...}}.
 *     - {"type":"user", message:{role:"user", content:[...]}, toolUseResult,
 *       timestamp, ...}. content[] items of interest:
 *       {"type":"tool_result", tool_use_id, content, is_error}. `content` is
 *       either a plain string or an array of {"type":"text","text":...}.
 *       The sibling top-level `toolUseResult` field is a STRING for error
 *       outcomes ("Error: <hook reason>" for a hook denial, literally
 *       "User rejected tool use" for a manual rejection) and an OBJECT for
 *       successful tool results (tool-specific shape) — this is a reliable
 *       structural discriminator, not just text-matching.
 *     - {"type":"attachment", attachment:{type:"hook_success"|
 *       "hook_blocking_error", hookName:"PreToolUse:Bash"|"PreToolUse:
 *       PowerShell"|..., toolUseID, hookEvent:"PreToolUse", stdout, command,
 *       durationMs, ...}, timestamp, ...}. `stdout` is the hook's own raw
 *       stdout JSON string (e.g. the exact {hookSpecificOutput:{...}} the
 *       bash-guardrails hook emitted at the time) and `command` identifies
 *       WHICH hook script ran (this machine has a second, personal
 *       `rewrite-cd-git.js` PreToolUse:Bash hook registered in the user
 *       settings.json, so multiple hooks can match one event — filter on
 *       `command` containing "guardrails.js" to isolate bash-guardrails'
 *       own historical decision).
 *   - Sessions that spawn subagents (Task tool) get an additional
 *     `<sessionId>/subagents/agent-<agentId>.jsonl` file (isSidechain:true,
 *     agentId set) — same line schema, walked the same way.
 *
 * Permission-prompt recoverability (the crux question from the brief):
 *   - hook DENY (BLOCK or hard DENY tier) is 100% recoverable and precise:
 *     the hook_success/hook_blocking_error attachment (when its `command`
 *     is the bash-guardrails script) records the exact permissionDecision +
 *     reason the plugin emitted at the time, and the paired tool_result is a
 *     structurally-tagged error whose text starts with "BLOCKED". No prompt
 *     was ever shown for these — the hook denial happens before Claude
 *     Code's permission engine runs.
 *   - Manual user REJECTION is 100% recoverable and precise: toolUseResult
 *     (top-level string) is exactly "User rejected tool use". A rejection
 *     can only happen after a prompt was actually shown, so this is also
 *     definitive proof a prompt occurred (no heuristic needed).
 *   - AUTO-approval (hook said "allow", or the command/tool matches an
 *     existing settings.json permission rule, or the tool's default mode is
 *     silent e.g. Read/Glob/Grep, or `acceptEdits` covers Write/Edit) is
 *     OBSERVATIONALLY IDENTICAL in the transcript to a prompt the user
 *     looked at and approved — both just show a normal successful
 *     tool_result. There is no separate "prompt was shown and approved"
 *     marker anywhere in the transcript or in any sidecar file under
 *     `~/.claude` that this script found. This is a genuine gap: we fall
 *     back to the timing-gap heuristic suggested in the brief (tool_use
 *     timestamp -> tool_result timestamp), VALIDATED (not assumed) by
 *     comparing its distribution against the two unambiguous reference
 *     classes above (hook-denied = definitely no human, instant;
 *     user-rejected = definitely a human, seconds+) — see `analyze`'s
 *     `timingValidation` output and the report's Methodology section for
 *     the resulting threshold and its error bars. Treat every
 *     "likely-prompted-and-approved" count in this analysis as an ESTIMATE,
 *     not a hard fact.
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const readline = require('node:readline');
const { spawnSync } = require('node:child_process');

const HOME = os.homedir();
const TRANSCRIPTS_ROOT = path.join(HOME, '.claude', 'projects');
const OUT_DIR = path.join(__dirname, '..', '.local');
const HOOK_PATH = path.join(__dirname, '..', '..', '..', 'plugins', 'bash-guardrails', 'hooks', 'guardrails.js');

const EVENTS_FILE = path.join(OUT_DIR, 'events.jsonl');
const EXTRACT_SUMMARY_FILE = path.join(OUT_DIR, 'extract-summary.json');
const UNIQUE_COMMANDS_FILE = path.join(OUT_DIR, 'unique-commands.json');
const REPLAY_FILE = path.join(OUT_DIR, 'replay-results.json');
const ANALYSIS_FILE = path.join(OUT_DIR, 'analysis.json');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Recursively find all *.jsonl files under `dir`. */
function findJsonlFiles(dir) {
  const out = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...findJsonlFiles(full));
    } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      out.push(full);
    }
  }
  return out;
}

/** tool_result.content can be a string or an array of {type:'text',text}. */
function resultText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => (c && typeof c === 'object' && typeof c.text === 'string' ? c.text : ''))
      .join('\n');
  }
  return '';
}

function monthOf(iso) {
  return typeof iso === 'string' ? iso.slice(0, 7) : 'unknown';
}

// Mirrors guardrails.js's leadingCommand() — duplicated here ONLY for
// grouping/display in this analysis script, never for decisions (decisions
// always come from an actual replay through the real hook).
function leadingCommand(command) {
  const withoutEnv = String(command || '').replace(/^\s*(\w+=(?:"[^"]*"|'[^']*'|\S+)\s+)+/, '');
  const match = withoutEnv.match(/^\s*(\S+)/);
  if (!match) return '';
  return match[1].split(/[\\/]/).pop().toLowerCase();
}

// Prompt-shape key per tool, per the brief: command for shells, file_path for
// Write/Edit/Read/NotebookEdit, domain for WebFetch, tool name for MCP/other.
function promptShapeKey(name, input) {
  if (name === 'Bash' || name === 'PowerShell') return String((input && input.command) || '').trim();
  if (['Write', 'Edit', 'Read', 'NotebookEdit'].includes(name)) return (input && input.file_path) || '(no file_path)';
  if (name === 'WebFetch') {
    try {
      return new URL((input && input.url) || '').hostname || '(no host)';
    } catch {
      return '(unparseable url)';
    }
  }
  return name; // Glob/Grep/Task/TodoWrite/mcp__*/Skill/etc. — the tool name IS the shape.
}

function projectLabelFromDir(dirName) {
  // Flattened project dirs look like "B--Projects-bash-guardrails" or
  // "b--Projects-second-memory" -> take the last path segment as a label.
  const parts = dirName.split('-').filter(Boolean);
  return parts.length ? parts[parts.length - 1] : dirName;
}

// ---------------------------------------------------------------------------
// EXTRACT
// ---------------------------------------------------------------------------

async function extract() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const files = findJsonlFiles(TRANSCRIPTS_ROOT);
  console.log(`Found ${files.length} transcript files under ${TRANSCRIPTS_ROOT}`);

  const eventsOut = fs.createWriteStream(EVENTS_FILE, { encoding: 'utf8' });
  const uniqueBash = new Set();
  const uniquePowershell = new Set();

  let totalLines = 0;
  let totalEvents = 0;
  let parseErrors = 0;
  let unresolvedTotal = 0;
  const perTool = {};
  const perOutcome = {};
  const perProject = {};
  const unresolvedPerTool = {};

  for (const file of files) {
    const rel = path.relative(TRANSCRIPTS_ROOT, file);
    const projectDir = rel.split(path.sep)[0];
    const projectLabel = projectLabelFromDir(projectDir);
    const isSubagent = /subagents[\\/]/.test(rel);

    // Per-file state (each file is an independently-ordered thread).
    const pendingToolUses = new Map(); // tool_use_id -> {name, input, timestamp, seq}
    const hookAttachments = new Map(); // toolUseID -> {decision, reason, raw, timestamp, command}
    let seq = 0;

    const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });

    for await (const line of rl) {
      totalLines++;
      if (!line.trim()) continue;
      let obj;
      try {
        obj = JSON.parse(line);
      } catch {
        parseErrors++;
        continue;
      }

      // --- hook attachment: ground-truth historical decision ---
      if (obj.type === 'attachment' && obj.attachment && /^PreToolUse:/.test(obj.attachment.hookName || '')) {
        const att = obj.attachment;
        if (att.type === 'hook_success' && /guardrails\.js/i.test(att.command || '')) {
          let decision = 'passthrough';
          let reason = null;
          try {
            const parsedStdout = JSON.parse(att.stdout || '{}');
            const hso = parsedStdout.hookSpecificOutput;
            if (hso && hso.permissionDecision) {
              decision = hso.permissionDecision; // 'allow' | 'deny'
              reason = hso.permissionDecisionReason || null;
            }
          } catch {
            /* leave as passthrough if stdout wasn't parseable JSON */
          }
          hookAttachments.set(att.toolUseID, { decision, reason, timestamp: obj.timestamp, command: att.command, durationMs: att.durationMs });
        }
        continue;
      }

      // --- assistant turn: harvest tool_use ---
      if (obj.type === 'assistant' && obj.message && Array.isArray(obj.message.content)) {
        for (const item of obj.message.content) {
          if (item && item.type === 'tool_use') {
            pendingToolUses.set(item.id, {
              name: item.name,
              input: item.input || {},
              timestamp: obj.timestamp,
              seq: seq++,
            });
          }
        }
        continue;
      }

      // --- user turn: harvest tool_result and finalize events ---
      if (obj.type === 'user' && obj.message && Array.isArray(obj.message.content)) {
        for (const item of obj.message.content) {
          if (!item || item.type !== 'tool_result') continue;
          const use = pendingToolUses.get(item.tool_use_id);
          if (!use) continue; // result for a tool_use outside this file/window
          pendingToolUses.delete(item.tool_use_id);

          const isError = !!item.is_error;
          const text = resultText(item.content);
          const topLevelResult = obj.toolUseResult;
          const topLevelIsString = typeof topLevelResult === 'string';

          let outcome;
          if (topLevelIsString && topLevelResult === 'User rejected tool use') {
            outcome = 'user-rejected';
          } else if (isError && /^The user doesn['’]t want to proceed/.test(text.trim())) {
            outcome = 'user-rejected';
          } else if (isError && /^BLOCKED( \(dangerous\))?:/.test(text.trim())) {
            outcome = 'hook-blocked';
          } else if (isError && /^Permission for this tool use was denied/.test(text.trim())) {
            // Distinct from the confirmed-human "User rejected tool use" string — this
            // phrasing was only observed inside SUBAGENT transcripts and may be an
            // automatic denial (subagent tool-permission restriction) rather than a
            // human sitting on a prompt. Kept separate; see report Methodology.
            outcome = 'denied-other';
          } else if (isError) {
            outcome = 'error';
          } else {
            outcome = 'executed';
          }

          const hookInfo = hookAttachments.get(item.tool_use_id) || null;
          const gapMs = obj.timestamp && use.timestamp ? Date.parse(obj.timestamp) - Date.parse(use.timestamp) : null;

          const shapeKey = promptShapeKey(use.name, use.input);
          const record = {
            project: projectLabel,
            projectDir,
            file: path.basename(file),
            subagent: isSubagent,
            tool: use.name,
            shape: shapeKey,
            leadingCommand: (use.name === 'Bash' || use.name === 'PowerShell') ? leadingCommand(shapeKey) : null,
            timestampUse: use.timestamp,
            timestampResult: obj.timestamp,
            gapMs,
            outcome,
            resultTextHead: text.slice(0, 200),
            hookDecision: hookInfo ? hookInfo.decision : 'no-record',
            hookReason: hookInfo ? hookInfo.reason : null,
            hookDurationMs: hookInfo ? hookInfo.durationMs : null,
            seq: use.seq,
          };

          eventsOut.write(JSON.stringify(record) + '\n');
          totalEvents++;
          perTool[use.name] = (perTool[use.name] || 0) + 1;
          perOutcome[outcome] = (perOutcome[outcome] || 0) + 1;
          perProject[projectLabel] = (perProject[projectLabel] || 0) + 1;

          if (use.name === 'Bash') uniqueBash.add(shapeKey);
          if (use.name === 'PowerShell') uniquePowershell.add(shapeKey);
        }
      }
    }

    // Any tool_use left with no paired tool_result by EOF means the
    // conversation/subagent stream ended before a result came back — most
    // commonly a user-interrupted (Escape) tool call, or a truncated/still
    // -open session at the time of this scan. Counted, not written as full
    // events (no outcome/timing signal available beyond "never resolved").
    for (const use of pendingToolUses.values()) {
      unresolvedTotal++;
      unresolvedPerTool[use.name] = (unresolvedPerTool[use.name] || 0) + 1;
    }
  }

  eventsOut.end();
  await new Promise((resolve) => eventsOut.on('finish', resolve));

  fs.writeFileSync(
    UNIQUE_COMMANDS_FILE,
    JSON.stringify({ bash: [...uniqueBash], powershell: [...uniquePowershell] }, null, 0)
  );

  const summary = {
    generatedAt: new Date().toISOString(),
    filesScanned: files.length,
    totalLines,
    parseErrors,
    totalToolCallEvents: totalEvents,
    uniqueBashCommands: uniqueBash.size,
    uniquePowershellCommands: uniquePowershell.size,
    perTool,
    perOutcome,
    perProject,
    unresolvedTotal,
    unresolvedPerTool,
  };
  fs.writeFileSync(EXTRACT_SUMMARY_FILE, JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
  console.log(`\nEvents written to ${EVENTS_FILE}`);
  console.log(`Unique commands written to ${UNIQUE_COMMANDS_FILE}`);
}

// ---------------------------------------------------------------------------
// REPLAY — run every unique Bash/PowerShell command through the CURRENT hook.
// Spawns `node guardrails.js` per command via spawnSync's `input` option,
// exactly like test/run.js — never a shell pipe.
// ---------------------------------------------------------------------------

function decisionFor(command, tool) {
  const payload = JSON.stringify({ tool_name: tool, tool_input: { command } });
  const res = spawnSync(process.execPath, [HOOK_PATH], { input: payload, encoding: 'utf8' });
  if (res.error || res.signal || (res.status !== 0 && !res.stdout)) {
    const reason = res.error ? String(res.error) : (res.signal ? `killed by ${res.signal}` : `exit ${res.status}`);
    return { decision: 'spawn-error', reason };
  }
  let out = {};
  try {
    out = JSON.parse(res.stdout || '{}');
  } catch {
    return { decision: 'parse-error', reason: res.stdout };
  }
  const hso = out.hookSpecificOutput;
  if (hso && hso.permissionDecision) {
    return { decision: hso.permissionDecision, reason: hso.permissionDecisionReason || null };
  }
  return { decision: 'ask', reason: null };
}

function replay() {
  if (!fs.existsSync(UNIQUE_COMMANDS_FILE)) {
    console.error(`${UNIQUE_COMMANDS_FILE} not found — run 'extract' first.`);
    process.exit(1);
  }
  if (!fs.existsSync(HOOK_PATH)) {
    console.error(`Hook not found at ${HOOK_PATH}`);
    process.exit(1);
  }
  const { bash, powershell } = JSON.parse(fs.readFileSync(UNIQUE_COMMANDS_FILE, 'utf8'));
  console.log(`Replaying ${bash.length} unique Bash + ${powershell.length} unique PowerShell commands through ${HOOK_PATH} ...`);

  const results = { bash: {}, powershell: {} };
  let i = 0;
  const total = bash.length + powershell.length;
  const start = Date.now();

  for (const cmd of bash) {
    results.bash[cmd] = decisionFor(cmd, 'Bash');
    i++;
    if (i % 250 === 0) console.log(`  ${i}/${total} (${Math.round((Date.now() - start) / 1000)}s)`);
  }
  for (const cmd of powershell) {
    results.powershell[cmd] = decisionFor(cmd, 'PowerShell');
    i++;
    if (i % 250 === 0) console.log(`  ${i}/${total} (${Math.round((Date.now() - start) / 1000)}s)`);
  }

  fs.writeFileSync(REPLAY_FILE, JSON.stringify(results));
  console.log(`Done in ${Math.round((Date.now() - start) / 1000)}s. Wrote ${REPLAY_FILE}`);
}

// ---------------------------------------------------------------------------
// ANALYZE — read events.jsonl + replay-results.json, produce report-ready
// aggregates (counts + capped example lists) into analysis.json.
// ---------------------------------------------------------------------------

function pct(arr, p) {
  if (!arr.length) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

function cap(arr, n = 20) {
  return arr.slice(0, n);
}

// BLOCK/DENY rule fingerprints, matched against reason text by stable
// keyword fragments (reasons have been reworded across versions; keywords
// are chosen to be stable across the observed history).
const RULE_FINGERPRINTS = [
  ['deny.rm-recursive', /recursive rm/i],
  ['deny.find-delete', /find -delete/i],
  ['deny.find-exec-rm', /find -exec rm/i],
  ['deny.dd', /raw dd writes/i],
  ['deny.mkfs', /mkfs/i],
  ['deny.forkbomb', /fork bomb/i],
  ['deny.git-force-push', /force-push/i],
  ['deny.git-push-main', /main\/master/i],
  ['deny.git-push-delete', /deleting a remote branch/i],
  ['deny.git-push-mirror', /--mirror/i],
  ['deny.git-reset-hard', /reset --hard/i],
  ['deny.git-clean-f', /clean -f/i],
  ['deny.git-checkout-dot', /checkout -- \./i],
  ['deny.git-branch-D', /force-deleting a branch/i],
  ['block.chain-allowlisted', /Do not chain commands/i],
  ['block.exit-code-echo', /append.*echo.*\$\?/i],
  ['block.cd', /Do not use `?cd`?\b.*(working directory persists|persists between)/i],
  ['block.heredoc', /heredocs/i],
  ['block.cat-head-tail', /cat\/head\/tail/i],
  ['block.arrow-fn', /Arrow functions/i],
  ['block.backtick', /Backticks/i],
  ['block.var-redirect', /shell variables (with|in) redirections/i],
  ['block.pipe', /No pipe(s|d commands)/i],
  ['block.redirect', /output redirections/i],
  ['block.ls-glob', /ls`? with glob/i],
  // Retired rule (removed in the most recent commit on this repo, "feat: treat
  // jq as a safe command, drop its block rule") — kept here ONLY so historical
  // transcript data classifies correctly instead of falling into "unknown".
  // This is NOT a live rule and needs no fix; see report Methodology.
  ['block.jq-retired', /\bjq\b.*(not guaranteed available|not available|JSON output is plain text)|jq is not available/i],
  ['ps.deny.remove-recurse', /recursive Remove-Item/i],
  ['ps.deny.pipe-remove', /bulk delete/i],
  ['ps.deny.clear-content', /Clear-Content/i],
  ['ps.deny.disk', /disk\/partition/i],
  ['ps.deny.registry', /registry key deletion/i],
  ['ps.deny.del-s', /recursive del\/rd/i],
  ['ps.block.chain', /Do not chain commands/i],
  ['ps.block.write', /Out-File\/Set-Content/i],
  ['ps.block.redirect', /output redirections.*to files/i],
  ['ps.block.cd', /Set-Location/i],
];

function fingerprintReason(reason) {
  if (!reason) return null;
  for (const [id, re] of RULE_FINGERPRINTS) {
    if (re.test(reason)) return id;
  }
  return 'unknown';
}

// Heuristic: is the char range around `index` inside a quoted (', ", `)
// span of `command`? Used to flag likely false-positive BLOCK matches
// (trigger keyword only appears inside a quoted string / commit message).
//
// Deliberately does NOT treat a leading backslash as escaping a quote
// character. That's correct POSIX shell semantics in general, but this
// corpus is full of Windows paths like `"B:\Projects\foo\"` where the
// trailing backslash is a path separator, not an escape — treating it as
// an escape leaves the scanner stuck "inside" a quote for the rest of the
// command and produces false "quoted" verdicts for everything after. Since
// guardrails.js's own BLOCK_RULES are plain regexes with zero quote/escape
// awareness to begin with, a simple (unescaped) quote-toggle scanner is a
// closer proxy for "would a quote-aware tokenizer treat this as inside a
// string" for THIS corpus than strict POSIX escaping would be.
function isLikelyQuoted(command, index) {
  let inS = false, inD = false, inB = false;
  for (let i = 0; i < index && i < command.length; i++) {
    const c = command[i];
    if (c === "'" && !inD && !inB) inS = !inS;
    else if (c === '"' && !inS && !inB) inD = !inD;
    else if (c === '`' && !inS && !inD) inB = !inB;
  }
  return inS || inD || inB;
}

function analyze() {
  if (!fs.existsSync(EVENTS_FILE)) {
    console.error(`${EVENTS_FILE} not found — run 'extract' first.`);
    process.exit(1);
  }
  const replayExists = fs.existsSync(REPLAY_FILE);
  const replay = replayExists ? JSON.parse(fs.readFileSync(REPLAY_FILE, 'utf8')) : { bash: {}, powershell: {} };

  const lines = fs.readFileSync(EVENTS_FILE, 'utf8').split('\n').filter(Boolean);
  const events = lines.map((l) => JSON.parse(l));

  // ---- 1. Full prompt census across all tools ----
  const byToolMonth = {}; // tool -> month -> count
  const byToolOutcome = {}; // tool -> outcome -> count
  const byShapePerTool = {}; // tool -> shape -> count (top shapes)
  const byProjectTool = {}; // project -> tool -> count

  for (const e of events) {
    byToolMonth[e.tool] = byToolMonth[e.tool] || {};
    byToolMonth[e.tool][monthOf(e.timestampUse)] = (byToolMonth[e.tool][monthOf(e.timestampUse)] || 0) + 1;

    byToolOutcome[e.tool] = byToolOutcome[e.tool] || {};
    byToolOutcome[e.tool][e.outcome] = (byToolOutcome[e.tool][e.outcome] || 0) + 1;

    byShapePerTool[e.tool] = byShapePerTool[e.tool] || {};
    const key = e.tool === 'Bash' || e.tool === 'PowerShell' ? e.leadingCommand : e.shape;
    byShapePerTool[e.tool][key] = (byShapePerTool[e.tool][key] || 0) + 1;

    byProjectTool[e.project] = byProjectTool[e.project] || {};
    byProjectTool[e.project][e.tool] = (byProjectTool[e.project][e.tool] || 0) + 1;
  }

  // ---- Timing-gap heuristic VALIDATION ----
  // Reference class A: hook-allowed (historically hookDecision === 'allow')
  //   -> ground truth SILENT (the hook itself force-approved, no prompt possible).
  // Reference class B: hook-blocked -> ground truth SILENT (denied before any
  //   prompt could show).
  // Reference class C: user-rejected -> ground truth PROMPTED (a rejection can
  //   only happen after a human was shown a prompt).
  // FIRST ATTEMPT (kept in the JSON as `timingValidation.naive` for the
  // report's methodology section) used ALL hook-allowed Bash/PowerShell
  // events as the "definitely silent" reference class. That FAILED
  // validation: gap = hookOverhead + [possible human wait] + ACTUAL COMMAND
  // EXECUTION TIME, and for hook-allowed commands the execution time itself
  // varies from milliseconds (echo) to tens of seconds (pnpm build/test) —
  // it swamps any human-wait signal. p99 came out to ~38s, which would
  // misclassify long BUILDS as "likely prompted" and is useless as a
  // threshold. Confirmed by comparing against the hook-BLOCKED reference
  // class (pure hook overhead, command never runs, no human) which stays
  // tight (p50 ~200ms) — the two "definitely silent" classes should agree
  // if gap were a clean signal, and they didn't, which is what exposed the
  // confound.
  //
  // FIX: restrict the "silent" reference class (and every promptedGuess
  // computed from it) to LEADING COMMANDS THAT ARE FAST BY CONSTRUCTION —
  // local, no network, no build/install/test step — so command-execution
  // time can't swamp the human-wait signal. Anything led by a
  // variable-duration command (git, gh, node, pnpm, python, cargo, go, a
  // bare script, ...) is reported as `unknown-variable-duration` rather
  // than guessed — an honest "not recoverable" rather than a fabricated
  // number, per the brief's instruction.
  const FAST_LEAD_COMMANDS = new Set(['echo', 'pwd', 'ls', 'dir', 'wc', 'mkdir', 'which', 'where', 'true', 'false', 'date', 'env', 'printenv', 'find', 'grep', 'rg']);
  // Fast-by-construction NON-shell tools: local filesystem / in-memory ops
  // with no network or long-running work. WebFetch and MCP tools that call
  // external APIs are excluded (network latency alone can be seconds).
  const FAST_TOOLS = new Set(['Read', 'Glob', 'Grep', 'Edit', 'Write', 'ToolSearch', 'TaskList', 'TaskOutput']);

  function isFastByConstruction(e) {
    if (e.tool === 'Bash' || e.tool === 'PowerShell') return FAST_LEAD_COMMANDS.has(e.leadingCommand);
    return FAST_TOOLS.has(e.tool);
  }

  const gapsHookAllowNaive = events.filter((e) => e.tool === 'Bash' || e.tool === 'PowerShell')
    .filter((e) => e.hookDecision === 'allow' && e.gapMs != null).map((e) => e.gapMs);
  const gapsHookAllowFast = events.filter((e) => e.hookDecision === 'allow' && e.gapMs != null && isFastByConstruction(e)).map((e) => e.gapMs);
  const gapsHookBlocked = events.filter((e) => e.outcome === 'hook-blocked' && e.gapMs != null).map((e) => e.gapMs);
  const gapsUserRejected = events.filter((e) => e.outcome === 'user-rejected' && e.gapMs != null).map((e) => e.gapMs);
  const gapsFastExecutedNoRecord = events.filter((e) => e.outcome === 'executed' && e.hookDecision !== 'allow' && e.gapMs != null && isFastByConstruction(e)).map((e) => e.gapMs);

  const timingValidation = {
    naive_hookAllowAllCommands: { n: gapsHookAllowNaive.length, p50: pct(gapsHookAllowNaive, 50), p90: pct(gapsHookAllowNaive, 90), p99: pct(gapsHookAllowNaive, 99), max: gapsHookAllowNaive.length ? Math.max(...gapsHookAllowNaive) : null, note: 'CONFOUNDED by command execution time — not used for the threshold. Kept for the report to show why.' },
    hookAllowFastOnly: { n: gapsHookAllowFast.length, p50: pct(gapsHookAllowFast, 50), p90: pct(gapsHookAllowFast, 90), p99: pct(gapsHookAllowFast, 99), max: gapsHookAllowFast.length ? Math.max(...gapsHookAllowFast) : null },
    hookBlocked: { n: gapsHookBlocked.length, p50: pct(gapsHookBlocked, 50), p90: pct(gapsHookBlocked, 90), p99: pct(gapsHookBlocked, 99), max: gapsHookBlocked.length ? Math.max(...gapsHookBlocked) : null },
    userRejected: { n: gapsUserRejected.length, p10: pct(gapsUserRejected, 10), p50: pct(gapsUserRejected, 50), min: gapsUserRejected.length ? Math.min(...gapsUserRejected) : null },
    fastExecutedNoHookRecord: { n: gapsFastExecutedNoRecord.length, p50: pct(gapsFastExecutedNoRecord, 50), p90: pct(gapsFastExecutedNoRecord, 90), p99: pct(gapsFastExecutedNoRecord, 99), max: gapsFastExecutedNoRecord.length ? Math.max(...gapsFastExecutedNoRecord) : null },
  };
  // Threshold derived ONLY from the fast-by-construction "definitely silent"
  // reference classes (hook-allow-fast and hook-blocked), floored at a sane
  // minimum. Only ever applied to other fast-by-construction events.
  const silentP99 = Math.max(timingValidation.hookAllowFastOnly.p99 || 0, timingValidation.hookBlocked.p99 || 0);
  const threshold = Math.max(1500, silentP99 * 2);
  timingValidation.thresholdMsUsed = threshold;
  timingValidation.thresholdBasis = 'max(1500ms, 2x the higher p99 of {hook-allow on fast leading commands, hook-blocked})';

  function promptedGuess(e) {
    if (e.outcome === 'user-rejected') return 'prompted'; // definitional
    if (e.outcome === 'hook-blocked') return 'not-prompted'; // definitional
    if (e.hookDecision === 'allow') return 'not-prompted'; // definitional (hook force-approved)
    if (e.outcome !== 'executed') return 'unknown';
    if (e.gapMs == null) return 'unknown';
    if (!isFastByConstruction(e)) return 'unknown-variable-duration'; // honest: can't separate human-wait from build/network time
    return e.gapMs >= threshold ? 'likely-prompted' : 'likely-silent';
  }
  for (const e of events) e.promptedGuess = promptedGuess(e);

  const promptCensus = {}; // tool -> {prompted, notPrompted, unknownVariableDuration, unknown}
  for (const e of events) {
    promptCensus[e.tool] = promptCensus[e.tool] || { prompted: 0, notPrompted: 0, unknownVariableDuration: 0, unknown: 0 };
    if (e.promptedGuess === 'prompted' || e.promptedGuess === 'likely-prompted') promptCensus[e.tool].prompted++;
    else if (e.promptedGuess === 'not-prompted' || e.promptedGuess === 'likely-silent') promptCensus[e.tool].notPrompted++;
    else if (e.promptedGuess === 'unknown-variable-duration') promptCensus[e.tool].unknownVariableDuration++;
    else promptCensus[e.tool].unknown++;
  }

  // ---- 2 & false-positive corpus: replay vs history for Bash/PowerShell ----
  const shellEvents = events.filter((e) => e.tool === 'Bash' || e.tool === 'PowerShell');
  const replayFor = (e) => (e.tool === 'Bash' ? replay.bash[e.shape] : replay.powershell[e.shape]) || null;

  const askCandidates = {}; // leadingCommand -> {count, projects:Set, examples:[], approvedCount, rejectedCount}
  const falsePositives = {}; // ruleId -> [{command, reason, project}]
  const denyToday = [];
  const rejections = [];

  for (const e of shellEvents) {
    const r = replayFor(e);
    e._replayDecision = r ? r.decision : 'not-replayed';
    e._replayReason = r ? r.reason : null;

    if (r && r.decision === 'ask') {
      const lc = e.leadingCommand || '(empty)';
      askCandidates[lc] = askCandidates[lc] || { count: 0, projects: new Set(), examples: [], executed: 0, rejected: 0, hookBlockedHist: 0 };
      const bucket = askCandidates[lc];
      bucket.count++;
      bucket.projects.add(e.project);
      if (bucket.examples.length < 20) bucket.examples.push(e.shape);
      if (e.outcome === 'executed') bucket.executed++;
      if (e.outcome === 'user-rejected') bucket.rejected++;
      if (e.outcome === 'hook-blocked') bucket.hookBlockedHist++;
    }

    if (r && r.decision === 'deny' && e.outcome !== 'hook-blocked') {
      // Would be blocked TODAY but historically wasn't recorded as blocked
      // (predates the plugin, or the rule changed) — informational.
      denyToday.push({ command: e.shape, tool: e.tool, reason: r.reason, historicalOutcome: e.outcome, project: e.project });
    }

    if (r && r.decision === 'deny' && r.reason) {
      const ruleId = fingerprintReason(r.reason);
      // A command is flagged as a likely FALSE POSITIVE only if EVERY
      // occurrence of the triggering pattern falls inside a quoted span —
      // one unquoted occurrence anywhere means the rule had a genuine,
      // unrelated reason to fire (e.g. `... 'text with head in it' | head -3`
      // has "head" both inside a quoted string AND as a real trailing pipe
      // target — checking only the FIRST occurrence would wrongly call that
      // a false positive; checking ALL occurrences gets it right).
      let allQuoted = null; // null = rule not handled by this heuristic
      if (ruleId === 'block.cat-head-tail') {
        const matches = [...e.shape.matchAll(/\b(cat|head|tail)\b/g)];
        if (matches.length) allQuoted = matches.every((m) => isLikelyQuoted(e.shape, m.index));
      } else if (ruleId === 'deny.mkfs') {
        const matches = [...e.shape.matchAll(/\bmkfs\b/gi)];
        if (matches.length) allQuoted = matches.every((m) => isLikelyQuoted(e.shape, m.index));
      } else if (ruleId === 'deny.dd') {
        const matches = [...e.shape.matchAll(/\bdd\b/gi)];
        if (matches.length) allQuoted = matches.every((m) => isLikelyQuoted(e.shape, m.index));
      } else if (ruleId === 'block.pipe') {
        const idxs = [...e.shape.matchAll(/\|/g)].map((m) => m.index);
        if (idxs.length) allQuoted = idxs.every((i) => isLikelyQuoted(e.shape, i));
      } else if (ruleId === 'block.backtick') {
        const idxs = [...e.shape.matchAll(/`/g)].map((m) => m.index);
        if (idxs.length) allQuoted = idxs.every((i) => isLikelyQuoted(e.shape, i));
      } else if (ruleId === 'block.redirect') {
        const idxs = [...e.shape.matchAll(/[0-9]*>[^&]/g)].map((m) => m.index);
        if (idxs.length) allQuoted = idxs.every((i) => isLikelyQuoted(e.shape, i));
      } else if (ruleId === 'block.ls-glob') {
        const idxs = [...e.shape.matchAll(/\*/g)].map((m) => m.index);
        if (idxs.length) allQuoted = idxs.every((i) => isLikelyQuoted(e.shape, i));
      }
      if (allQuoted === true) {
        falsePositives[ruleId] = falsePositives[ruleId] || [];
        if (falsePositives[ruleId].length < 20) {
          falsePositives[ruleId].push({ command: e.shape, reason: r.reason, project: e.project, tool: e.tool });
        }
      }
    }

    if (e.outcome === 'user-rejected') {
      rejections.push({ command: e.shape, tool: e.tool, project: e.project, replayDecisionToday: e._replayDecision });
    }
  }

  const askCandidatesOut = Object.entries(askCandidates)
    .map(([lc, v]) => ({
      leadingCommand: lc,
      count: v.count,
      distinctProjects: v.projects.size,
      executed: v.executed,
      userRejected: v.rejected,
      historicallyHookBlocked: v.hookBlockedHist,
      examples: cap(v.examples, 8),
    }))
    .sort((a, b) => b.count - a.count);

  // ---- Steering effectiveness: per hook-block, look at next 1-3 shell calls
  // in the SAME file (already sequential via `seq`), grouped by file.
  const byFile = {};
  for (const e of shellEvents) {
    const key = `${e.projectDir}//${e.file}`;
    (byFile[key] = byFile[key] || []).push(e);
  }
  for (const key of Object.keys(byFile)) byFile[key].sort((a, b) => a.seq - b.seq);

  const steering = {}; // ruleId -> {blocks, recoveredWithin3, examples:[]}
  for (const key of Object.keys(byFile)) {
    const seqArr = byFile[key];
    for (let i = 0; i < seqArr.length; i++) {
      const e = seqArr[i];
      if (e.outcome !== 'hook-blocked') continue;
      const ruleId = fingerprintReason(e.hookReason || e.resultTextHead);
      steering[ruleId] = steering[ruleId] || { blocks: 0, recoveredWithin1: 0, recoveredWithin3: 0, neverRecovered: 0, sampleReason: e.hookReason || e.resultTextHead };
      steering[ruleId].blocks++;
      let recoveredAt = null;
      for (let k = 1; k <= 3 && i + k < seqArr.length; k++) {
        const next = seqArr[i + k];
        if (next.outcome !== 'hook-blocked') { recoveredAt = k; break; }
      }
      if (recoveredAt === 1) steering[ruleId].recoveredWithin1++;
      if (recoveredAt !== null) steering[ruleId].recoveredWithin3++;
      else steering[ruleId].neverRecovered++;
    }
  }

  // ---- Prompt-rate over time (ask-tier hits vs total shell commands / month) ----
  // NOTE: the hook_success attachment sidecar (ground truth for `hookDecision`)
  // is populated by Claude Code ONLY for "allow"/rewrite decisions, never for
  // "deny" ones (confirmed empirically — 0 of 1174 historically hook-blocked
  // events had a matching attachment; the denial's own tool_result error text
  // is the only — but fully reliable — record of a deny). So `hookAllow` here
  // is ground-truth-precise, `hookBlocked` comes from the outcome classifier
  // (also precise, just via a different signal), and `noHookSignal` is
  // everything else (no attachment AND not a recognized block/deny outcome —
  // i.e. genuinely ask-tier passthrough at the time, OR predates this hook
  // entirely, OR a hook version whose "allow" reason text didn't match).
  const monthly = {};
  for (const e of shellEvents) {
    const m = monthOf(e.timestampUse);
    monthly[m] = monthly[m] || { total: 0, hookAllow: 0, hookBlocked: 0, noHookSignal: 0, userRejected: 0 };
    monthly[m].total++;
    if (e.hookDecision === 'allow') monthly[m].hookAllow++;
    else if (e.outcome === 'hook-blocked') monthly[m].hookBlocked++;
    else monthly[m].noHookSignal++;
    if (e.outcome === 'user-rejected') monthly[m].userRejected++;
  }

  // ---- Script/interpreter inventory ----
  const interpreterPattern = /\b(?:bash|sh)\s+\S|(?:node|python|python3|perl|ruby|bun|deno)\b[^\n]*\s-(?:e|c)\b|--eval\b|deno\s+eval/i;
  const interpreterCalls = shellEvents.filter((e) => interpreterPattern.test(e.shape));
  const interpreterByLead = {};
  for (const e of interpreterCalls) {
    const lc = e.leadingCommand;
    interpreterByLead[lc] = interpreterByLead[lc] || { count: 0, examples: [] };
    interpreterByLead[lc].count++;
    if (interpreterByLead[lc].examples.length < 20) interpreterByLead[lc].examples.push(e.shape);
  }

  const analysis = {
    generatedAt: new Date().toISOString(),
    totals: {
      events: events.length,
      shellEvents: shellEvents.length,
      byTool: Object.fromEntries(Object.entries(byToolOutcome).map(([t, o]) => [t, Object.values(o).reduce((a, b) => a + b, 0)])),
    },
    byToolMonth,
    byToolOutcome,
    topShapesPerTool: Object.fromEntries(
      Object.entries(byShapePerTool).map(([t, m]) => [t, Object.entries(m).sort((a, b) => b[1] - a[1]).slice(0, 25)])
    ),
    byProjectTool,
    timingValidation,
    promptCensus,
    askCandidates: askCandidatesOut.slice(0, 40),
    falsePositives,
    denyTodayNotHistoricallyBlocked: cap(denyToday, 20),
    rejections: cap(rejections, 20),
    rejectionCount: rejections.length,
    steering,
    monthly,
    interpreterByLead,
    interpreterTotal: interpreterCalls.length,
  };

  fs.writeFileSync(ANALYSIS_FILE, JSON.stringify(analysis, null, 2));
  console.log(`Wrote ${ANALYSIS_FILE}`);
  console.log(`Totals: ${JSON.stringify(analysis.totals)}`);
}

// ---------------------------------------------------------------------------
const cmd = process.argv[2];
if (cmd === 'extract') extract().catch((err) => { console.error(err); process.exit(1); });
else if (cmd === 'replay') replay();
else if (cmd === 'analyze') analyze();
else {
  console.log('Usage: node mine-transcripts.js <extract|replay|analyze>');
  process.exit(1);
}
