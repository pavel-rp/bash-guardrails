#!/usr/bin/env node
'use strict';

/**
 * bash-guardrails — a PreToolUse hook for Claude Code Bash commands.
 *
 * Why this exists
 * ---------------
 * Claude Code prompts for permission constantly because Claude tends to write
 * gnarly compound shell commands — heredocs, pipes, redirects, `cd`, `jq`,
 * `&& echo PASS || { ... }` blocks. Those blobs (a) trip Claude Code's BUILT-IN
 * obfuscation detector, which fires BEFORE any allowlist and cannot be silenced
 * by a `Bash(...)` allow rule, and (b) don't match simple allowlist prefixes
 * (a compound command is matched against the whole string).
 *
 * The fix is NOT to try to auto-approve the blobs (the built-in detector blocks
 * them anyway). It's to make Claude stop writing them. This hook makes three
 * decisions per Bash command:
 *
 *   DENY   — genuinely destructive ops (rm -rf, git push --force, reset --hard).
 *            Hard-blocked. `permissionDecision: "deny"` is enforced even under
 *            --dangerously-skip-permissions.
 *
 *   BLOCK  — obfuscation-prone patterns (pipes, redirects, cd, heredocs, jq,
 *            cat/head/tail, backticks). Also returned as "deny", but the reason
 *            is instructive: it tells Claude to rewrite the command as clean,
 *            single-purpose calls and to use the Read/Write/Glob tools. Claude
 *            reads the reason and self-corrects on the next attempt.
 *
 *   ALLOW  — known-safe dev commands (git, gh, pnpm, node, ...). Auto-approved,
 *            so they never prompt, in any project, with no per-repo allowlist.
 *
 * Anything else falls through to Claude Code's normal permission prompt.
 *
 * Net effect: Claude stops emitting `gh api ... --jq ... | tail` and heredoc
 * blobs, and instead runs `pnpm test`, `git add`, `gh pr view --json` as
 * separate calls — each of which auto-approves silently.
 *
 * Hook protocol: read the PreToolUse event JSON on stdin, write a decision JSON
 * on stdout.  Docs: https://code.claude.com/docs/en/hooks-guide
 */

// ---------------------------------------------------------------------------
// DENY — destructive operations. Matched anywhere in the command string so
// they're caught even inside a chain like `pnpm build && rm -rf dist`.
// ---------------------------------------------------------------------------
const DENY_RULES = [
  // rm is matched with an optional path prefix so `/bin/rm -rf` and `$(which
  // rm) -rf` can't slip past by not starting at a word separator.
  { pattern: /(^|[\s;&|(=])(?:\S*\/)?rm\s+-[a-z]*r/i,  reason: 'recursive rm (rm -r / -rf) is blocked.' },
  { pattern: /(^|[\s;&|(=])(?:\S*\/)?rm\s+[^\n]*--recursive/i, reason: 'recursive rm (--recursive) is blocked.' },
  // find can delete a whole tree as effectively as rm -rf; these forms are
  // irreversible and have no safe-by-default reading, so they're hard-denied.
  { pattern: /\bfind\b[^\n]*\s-delete\b/i,            reason: 'find -delete recursively deletes and is blocked. Use the Glob/Read tools to inspect, then delete deliberately.' },
  { pattern: /\bfind\b[^\n]*-exec(?:dir)?\s+(?:\S*\/)?rm\b/i, reason: 'find -exec rm is blocked.' },
  { pattern: /\bgit\s+push\b[^\n]*(--force\b|--force-with-lease\b|\s-f\b)/i, reason: 'force-push is blocked.' },
  { pattern: /\bgit\s+push\s+\S+\s+(main|master)\b/i, reason: 'pushing directly to main/master is blocked. Push a feature branch and open a PR.' },
  // Remote-destructive pushes: branch deletion (`--delete`/`-d`/`origin :ref`)
  // and `--mirror` (which can delete remote refs to match local).
  { pattern: /\bgit\s+push\b[^\n]*\s(?:--delete\b|-d\b)/i, reason: 'deleting a remote branch (git push --delete) is blocked.' },
  { pattern: /\bgit\s+push\b[^\n]*\s:[^\s/]/i,         reason: 'deleting a remote branch (git push origin :branch) is blocked.' },
  { pattern: /\bgit\s+push\b[^\n]*--mirror\b/i,        reason: 'git push --mirror can delete remote refs and is blocked.' },
  { pattern: /\bgit\s+reset\s+--hard\b/i,             reason: 'git reset --hard discards work and is blocked.' },
  { pattern: /\bgit\s+clean\s+(-\S+\s+)*-\S*f/i,      reason: 'git clean -f deletes untracked files and is blocked.' },
  { pattern: /\bgit\s+checkout\s+--\s+\./,            reason: 'git checkout -- . discards all local changes and is blocked.' },
  { pattern: /\bgit\s+branch\s+-D\b/,                 reason: 'force-deleting a branch (git branch -D) is blocked.' },
  { pattern: /\bdd\s+if=/i,                           reason: 'raw dd writes are blocked.' },
  { pattern: /\bmkfs\b/i,                             reason: 'mkfs (format) is blocked.' },
  { pattern: /:\s*\(\s*\)\s*\{[^}]*\}\s*;/,           reason: 'fork bomb pattern is blocked.' },
];

// ---------------------------------------------------------------------------
// BLOCK — obfuscation-prone / multi-purpose patterns. Each returns a "deny"
// with an instructive reason so Claude rewrites into clean commands + tools.
// Order matters: the first match wins, so more specific rules come first.
// ---------------------------------------------------------------------------
const BLOCK_RULES = [
  {
    test: (cmd) => /(^|;|&&|\|\|)\s*cd\s+/.test(cmd),
    reason: 'Do not use `cd` — the working directory persists between Bash calls. Use a relative or absolute path instead.',
  },
  {
    test: (cmd) => /<</.test(cmd),
    reason: 'Do not use heredocs (`<<`). They trip the obfuscation detector and silently mangle content (e.g. backticks). To write a file, use the Write tool.',
  },
  {
    test: (cmd) => /\bjq\b/.test(cmd),
    reason: 'Do not use `jq` (not guaranteed available). Request JSON (e.g. `gh ... --json`) and parse it with `node -e` using JSON.parse, or read the output with the Read tool.',
  },
  {
    test: (cmd) => /(?<![-/])\b(cat|head|tail)\b/.test(cmd) && !/<</.test(cmd),
    reason: 'Do not use cat/head/tail to read files. Use the Read tool — it is faster and does not trip the shell-safety detector.',
  },
  {
    test: (cmd) => /=>\s*\(\s*\{/.test(cmd),
    reason: 'Arrow functions written as `=>({...})` look like process substitution to the safety detector. Use `=>{ return {...} }` instead.',
  },
  {
    test: (cmd) => /`/.test(cmd),
    reason: 'Backticks look like command substitution and are blocked. To write file content that contains backticks, use the Write tool.',
  },
  {
    test: (cmd) => /\$\w+.*[<>]|[<>].*\$\w+/.test(cmd),
    reason: 'Do not combine shell variables with redirections. Split this into separate Bash calls.',
  },
  {
    test: (cmd) => /\|/.test(cmd),
    reason: 'No pipes (`|`). Run each command as a separate Bash call. To process output, capture it from the first call and act on it in the next.',
  },
  {
    test: (cmd) => /[0-9]*>[^&]/.test(cmd),
    reason: 'No output redirections (`>`). Let stdout return the result. To write a file, use the Write tool. (`2>&1` is fine.)',
  },
  {
    test: (cmd) => /^\s*ls\b/.test(cmd) && /\*/.test(cmd),
    reason: 'Do not use `ls` with glob patterns to find files. Use the Glob tool instead.',
  },
];

// ---------------------------------------------------------------------------
// ALLOW — leading commands that are safe to auto-approve once a command has
// passed the deny + block gates (so it's a single, non-piped, non-redirected
// command). Dangerous git/rm forms are already denied above.
// ---------------------------------------------------------------------------
const ALLOW_COMMANDS = new Set([
  // git & GitHub
  'git', 'gh',
  // node ecosystem
  'pnpm', 'npm', 'npx', 'yarn', 'node', 'deno', 'bun',
  // common dev tools
  'tsc', 'vitest', 'jest', 'eslint', 'prettier', 'tsx', 'ts-node',
  // other languages / package managers
  'python', 'python3', 'pip', 'pip3', 'cargo', 'rustc', 'go',
  // read-only / harmless shell builtins & utils
  'ls', 'dir', 'pwd', 'echo', 'grep', 'rg', 'find', 'wc', 'mkdir',
  'which', 'where', 'true', 'false', 'date', 'env', 'printenv',
]);

// Chaining operators that, if present, mean we should NOT auto-approve (we
// can't vouch for every segment). `|` and `||` are already blocked above, so
// here we only need to guard against `&&` and `;`.
const HAS_CHAIN = /&&|;/;

// Dangerous *forms* of otherwise-allowed tools. A leading token like `node` or
// `find` is on ALLOW_COMMANDS, but these flag combinations turn it into
// arbitrary code execution or a delete — so we refuse to AUTO-approve them and
// let them fall through to Claude Code's normal permission prompt instead.
// This is the "ask" tier: not destructive enough to hard-deny, not safe enough
// to run silently. The deny scan can't see inside an interpreter (`node -e`
// runs JS, not a shell token a regex on `rm -rf` would catch), so inline-eval
// must prompt rather than auto-run. See README "Trade-offs".
const NEVER_AUTO_ALLOW = [
  // interpreters running inline code (node -e, python -c, perl/ruby -e, bun -e)
  /\b(?:node|bun|python|python3|perl|ruby)\b[^\n]*\s-(?:e|c)\b/i,
  /\b(?:node)\b[^\n]*\s--eval\b/i,
  /\bdeno\s+eval\b/i,
  // find running an arbitrary command per match (-exec rm is already denied)
  /\bfind\b[^\n]*-exec(?:dir)?\b/i,
  // recursive permission/ownership changes
  /\bch(?:mod|own)\b[^\n]*\s-[a-z]*R\b/i,
];

/**
 * Strip leading `VAR=value` env assignments, then return the base name of the
 * first token. e.g. `NODE_OPTIONS=--max-old-space-size=4096 pnpm test`
 * -> `pnpm`; `node_modules/.bin/vitest run` -> `vitest`.
 */
function leadingCommand(command) {
  const withoutEnv = command.replace(/^\s*(\w+=(?:"[^"]*"|'[^']*'|\S+)\s+)+/, '');
  const match = withoutEnv.match(/^\s*(\S+)/);
  if (!match) return '';
  return match[1].split(/[\\/]/).pop().toLowerCase();
}

function isAutoApprovable(command) {
  if (HAS_CHAIN.test(command)) return false;
  if (NEVER_AUTO_ALLOW.some((re) => re.test(command))) return false;
  return ALLOW_COMMANDS.has(leadingCommand(command));
}

// ---------------------------------------------------------------------------
// Decision helpers — PreToolUse output schema.
// ---------------------------------------------------------------------------
const passthrough = () => ({}); // empty object => normal permission prompt ("ask")

function emit(permissionDecision, permissionDecisionReason) {
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision,
      permissionDecisionReason,
    },
  };
}

function decide(rawInput) {
  const event = JSON.parse(rawInput || '{}');

  // Only police Bash. Everything else is none of our business.
  if (event.tool_name !== 'Bash') return passthrough();

  const command = ((event.tool_input || {}).command || '').trim();
  if (!command) return passthrough();

  for (const rule of DENY_RULES) {
    if (rule.pattern.test(command)) {
      return emit('deny', `BLOCKED (dangerous): ${rule.reason}`);
    }
  }

  for (const rule of BLOCK_RULES) {
    if (rule.test(command)) {
      return emit('deny', `BLOCKED: ${rule.reason}`);
    }
  }

  if (isAutoApprovable(command)) {
    return emit('allow', 'Auto-approved by bash-guardrails (known-safe dev command).');
  }

  return passthrough();
}

// ---------------------------------------------------------------------------
// Entry point.
// ---------------------------------------------------------------------------
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  let decision;
  try {
    decision = decide(input);
  } catch (err) {
    // Never break the session because the hook threw — fall through to a prompt.
    decision = passthrough();
  }
  process.stdout.write(JSON.stringify(decision));
});
