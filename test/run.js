#!/usr/bin/env node
'use strict';

/**
 * Self-hosted test runner for the bash-guardrails hook.
 *
 * It spawns hooks/guardrails.js and feeds each command as stdin via the
 * `input` option of spawnSync — NOT a shell pipe — so this runner is itself a
 * single `node test/run.js` invocation that the plugin auto-allows. That means
 * you can run the tests even while bash-guardrails is installed and active
 * (which would otherwise block a `printf … | node …` pipe). See CLAUDE.md.
 */

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const HOOKS_DIR = path.join(__dirname, '..', 'plugins', 'bash-guardrails', 'hooks');
const HOOK = path.join(HOOKS_DIR, 'guardrails.js');
const HOOKS_JSON = path.join(HOOKS_DIR, 'hooks.json');

// [label, command, expected decision: 'deny' | 'allow' | 'ask']
const CASES = [
  // BLOCK -> deny with guidance
  ['build blob (cd)',       'cd "B:/x" && pnpm build >/tmp/b.log 2>&1 && echo PASS || { echo FAIL; tail -20 /tmp/b.log; }', 'deny'],
  ['gh api | tail',         'gh api repos/x/pulls/4/comments | tail -3', 'deny'],
  ['gh --jq',               'gh pr view 4 --json headRefOid --jq .headRefOid', 'deny'],
  ['heredoc write',         'cat > .tmp/m.txt <<EOF\nhi\nEOF', 'deny'],
  ['ls glob',               'ls src/*.ts', 'deny'],
  ['backtick',              'echo `whoami`', 'deny'],

  // DENY -> destructive
  ['rm -rf',                'rm -rf dist', 'deny'],
  ['rm -rf via path',       '/bin/rm -rf dist', 'deny'],
  ['force push',            'git push --force origin feat', 'deny'],
  ['push main',             'git push origin main', 'deny'],
  ['reset --hard',          'git reset --hard HEAD~1', 'deny'],
  ['chain hides rm',        'pnpm build && rm -rf dist', 'deny'],
  ['find -delete',          'find ~ -name "*.js" -delete', 'deny'],
  ['find -exec rm',         'find . -name node_modules -exec rm -rf {} +', 'deny'],
  ['push --delete',         'git push origin --delete feature', 'deny'],
  ['push :branch',          'git push origin :old-branch', 'deny'],
  ['push --mirror',         'git push --mirror backup', 'deny'],

  // ASK -> dangerous form of an allowed tool (demoted from auto-allow)
  ['node -e rmSync',        'node -e "require(\'fs\').rmSync(process.env.HOME,{recursive:true})"', 'ask'],
  ['python -c rmtree',      'python3 -c "import shutil,os; shutil.rmtree(os.path.expanduser(\'~\'))"', 'ask'],
  ['find -exec mv',         'find . -name "*.tmp" -exec mv {} /tmp \\;', 'ask'],
  ['chmod -R',              'chmod -R 777 .', 'ask'],

  // ALLOW -> safe single commands
  ['pnpm test',             'pnpm test', 'allow'],
  ['git add',               'git add src/layout.ts', 'allow'],
  ['gh pr view --json',     'gh pr view 4 --json headRefOid', 'allow'],
  ['env-prefixed pnpm',     'NODE_OPTIONS=--max-old-space-size=4096 pnpm type-check', 'allow'],
  ['push feature branch',   'git push origin feat/gly-4', 'allow'],
  ['node script file',      'node build.js', 'allow'],
  ['find by name',          'find src -name "*.ts"', 'allow'],
  ['push refspec',          'git push origin local:remote', 'allow'],

  // ASK -> passthrough (empty {})
  ['chained safe',          'pnpm build && pnpm test', 'ask'],
  ['unknown command',       'frobnicate --now', 'ask'],
];

function decisionFor(command) {
  const payload = JSON.stringify({ tool_name: 'Bash', tool_input: { command } });
  const res = spawnSync(process.execPath, [HOOK], { input: payload, encoding: 'utf8' });
  const out = JSON.parse(res.stdout || '{}');
  return (out.hookSpecificOutput && out.hookSpecificOutput.permissionDecision) || 'ask';
}

let failed = 0;
for (const [label, command, expected] of CASES) {
  const actual = decisionFor(command);
  const ok = actual === expected;
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${expected.padEnd(5)} ${ok ? '' : `(got ${actual}) `}${label}`);
}

// Validate hooks.json WIRING, not just guardrails.js logic. Claude Code requires
// a top-level `hooks` record ({ "hooks": { "PreToolUse": [...] } }); putting the
// event at the root fails to load with `expected record at path ["hooks"]`. The
// command cases above spawn guardrails.js directly, so they'd never catch this.
let wiringFailed = 0;
function wiringCheck(label, ok) {
  if (!ok) { wiringFailed++; failed++; }
  console.log(`${ok ? 'PASS' : 'FAIL'}  wire  ${label}`);
}
try {
  const cfg = JSON.parse(fs.readFileSync(HOOKS_JSON, 'utf8'));
  wiringCheck('hooks.json has top-level "hooks" record', cfg.hooks && typeof cfg.hooks === 'object' && !Array.isArray(cfg.hooks));
  const pre = cfg.hooks && cfg.hooks.PreToolUse;
  wiringCheck('hooks.PreToolUse is an array', Array.isArray(pre));
  const entry = Array.isArray(pre) ? pre[0] : null;
  wiringCheck('PreToolUse[0] matches Bash', !!entry && entry.matcher === 'Bash');
  const inner = entry && Array.isArray(entry.hooks) ? entry.hooks[0] : null;
  wiringCheck('command references guardrails.js', !!inner && inner.type === 'command' && /guardrails\.js/.test(inner.command || ''));
} catch (err) {
  wiringCheck(`hooks.json parses (${err.message})`, false);
}

const total = CASES.length + 4;
console.log(`\n${total - failed}/${total} passed`);
process.exit(failed ? 1 : 0);
