#!/usr/bin/env node
'use strict';

/**
 * bash-guardrails — a PreToolUse hook for Claude Code Bash commands.
 *
 * Why this exists
 * ---------------
 * Claude Code prompts for permission constantly because Claude tends to write
 * gnarly compound shell commands — heredocs, pipes, redirects, `cd`,
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
 *   BLOCK  — obfuscation-prone patterns (pipes, redirects, cd, heredocs,
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
 * Net effect: Claude stops emitting `gh api ... | tail` pipes and heredoc
 * blobs, and instead runs `pnpm test`, `git add`, `gh pr view --json` as
 * separate calls — each of which auto-approves silently.
 *
 * Hook protocol: read the PreToolUse event JSON on stdin, write a decision JSON
 * on stdout.  Docs: https://code.claude.com/docs/en/hooks-guide
 *
 * Optional config file (see config.js + README "Customize"): a two-tier
 * ~/.claude/bash-guardrails.json <- <project>/.claude/bash-guardrails.json
 * can loosen a rule to "ask", disable a block/never-auto-allow rule, add
 * extra allow-commands, or add extra deny/block patterns — all shell-scoped
 * (top-level = Bash, `powershell.*` = PowerShell). No config file present ->
 * built-in defaults only, identical to pre-config behavior.
 */

const config = require('./config.js');

// ---------------------------------------------------------------------------
// Destructive git operations. git behaves identically in any shell, so these
// are shared by the Bash and PowerShell deny sets below.
// ---------------------------------------------------------------------------
const GIT_DENY_RULES = [
  { id: 'git-push-force', tier: 'deny', pattern: /\bgit\s+push\b[^\n]*(--force\b|--force-with-lease\b|\s-f\b)/i, reason: 'force-push is blocked.' },
  { id: 'git-push-main-master', tier: 'deny', pattern: /\bgit\s+push\s+\S+\s+(main|master)\b/i, reason: 'pushing directly to main/master is blocked. Push a feature branch and open a PR.' },
  // Remote-destructive pushes: branch deletion (`--delete`/`-d`/`origin :ref`)
  // and `--mirror` (which can delete remote refs to match local).
  { id: 'git-push-delete-branch', tier: 'deny', pattern: /\bgit\s+push\b[^\n]*\s(?:--delete\b|-d\b)/i, reason: 'deleting a remote branch (git push --delete) is blocked.' },
  { id: 'git-push-delete-colon-branch', tier: 'deny', pattern: /\bgit\s+push\b[^\n]*\s:[^\s/]/i,         reason: 'deleting a remote branch (git push origin :branch) is blocked.' },
  { id: 'git-push-mirror', tier: 'deny', pattern: /\bgit\s+push\b[^\n]*--mirror\b/i,        reason: 'git push --mirror can delete remote refs and is blocked.' },
  // A leading `+` on a refspec forces exactly like --force and must not dodge
  // the force rule above. `\s\+` requires the plus to START a token, so branch
  // names merely containing `+` (c++-fix) still pass.
  { id: 'git-push-force-refspec', tier: 'deny', pattern: /\bgit\s+push\b[^\n]*\s\+\S/,            reason: 'force-push via +refspec (git push origin +branch) is blocked.' },
  { id: 'git-reset-hard', tier: 'deny', pattern: /\bgit\s+reset\s+--hard\b/i,             reason: 'git reset --hard discards work and is blocked.' },
  { id: 'git-clean-force', tier: 'deny', pattern: /\bgit\s+clean\s+(-\S+\s+)*-\S*f/i,      reason: 'git clean -f deletes untracked files and is blocked.' },
  { id: 'git-stash-drop-clear', tier: 'deny', pattern: /\bgit\s+stash\s+(?:drop|clear)\b/i,     reason: 'git stash drop/clear permanently discards stashed work and is blocked.' },
  // Worktree-discarding restore/checkout. The dot must directly follow the
  // subcommand (or `--`), so `git restore --staged .` — an unstage that keeps
  // the worktree — still auto-allows. Dot-leading checkout args are always
  // pathspecs (refs cannot start with a dot), i.e. a discard, never a switch.
  { id: 'git-restore-path', tier: 'deny', pattern: /\bgit\s+restore\s+(?:--\s+)?\./,        reason: 'git restore <path> discards local changes and is blocked.' },
  { id: 'git-restore-worktree', tier: 'deny', pattern: /\bgit\s+restore\b[^\n]*\s(?:--worktree|-W)\b/, reason: 'git restore --worktree discards local changes and is blocked.' },
  { id: 'git-checkout-path', tier: 'deny', pattern: /\bgit\s+checkout\s+(?:--\s+)?\./,       reason: 'git checkout <path> discards local changes and is blocked.' },
  // git switch is git's newer checkout replacement; -f/--discard-changes is
  // the same working-tree-discard class as restore/checkout above.
  { id: 'git-switch-force', tier: 'deny', pattern: /\bgit\s+switch\b[^\n]*\s(?:--discard-changes\b|-f\b)/i, reason: 'git switch -f/--discard-changes discards local changes and is blocked.' },
  { id: 'git-branch-force-delete', tier: 'deny', pattern: /\bgit\s+branch\s+-D\b/,                 reason: 'force-deleting a branch (git branch -D) is blocked.' },
  // Same op spelled differently: --delete + --force in either order, or a
  // combined short flag carrying both letters (-fd, -df, -f -d). Two
  // lookaheads = "a delete-ish token AND a force-ish token both present".
  { id: 'git-branch-force-delete-combined', tier: 'deny', pattern: /\bgit\s+branch\b(?=[^\n]*(?:--delete\b|\s-[a-z]*d))(?=[^\n]*(?:--force\b|\s-[a-z]*f))/i, reason: 'force-deleting a branch (git branch --delete --force / -fd) is blocked.' },
];

// Git ref-surgery: not destructive enough to hard-deny (plumbing-level, rarely
// typed by accident — the command name itself signals deliberate intent), but
// forecloses recovery or rewrites history, so silent auto-approval is wrong.
// Demoted to ask, not DENY. Shared by both shells via NEVER_AUTO_ALLOW below.
const GIT_NEVER_AUTO_ALLOW = [
  { id: 'git-update-ref-delete', tier: 'never-auto-allow', pattern: /\bgit\s+update-ref\s+-d\b/i },
  { id: 'git-reflog-expire-delete', tier: 'never-auto-allow', pattern: /\bgit\s+reflog\s+(?:expire|delete)\b/i },
  { id: 'git-gc-prune-aggressive', tier: 'never-auto-allow', pattern: /\bgit\s+gc\b[^\n]*(?:--prune=now\b|--aggressive\b)/i },
  { id: 'git-filter-branch-repo', tier: 'never-auto-allow', pattern: /\bgit\s+filter-(?:branch|repo)\b/i },
  { id: 'git-worktree-remove-force', tier: 'never-auto-allow', pattern: /\bgit\s+worktree\s+remove\b[^\n]*(?:--force\b|\s-[a-z]*f\b)/i },
];

// ---------------------------------------------------------------------------
// DENY (Bash) — destructive Unix ops + the shared git rules. Matched anywhere
// in the command string so they're caught even inside a chain like
// `pnpm build && rm -rf dist`.
// ---------------------------------------------------------------------------
const DENY_RULES = [
  // rm is matched with an optional path prefix so `/bin/rm -rf` and `$(which
  // rm) -rf` can't slip past by not starting at a word separator.
  { id: 'rm-recursive', tier: 'deny', pattern: /(^|[\s;&|(=])(?:\S*\/)?rm\s+-[a-z]*r/i,  reason: 'recursive rm (rm -r / -rf) is blocked.' },
  { id: 'rm-recursive-long', tier: 'deny', pattern: /(^|[\s;&|(=])(?:\S*\/)?rm\s+[^\n]*--recursive/i, reason: 'recursive rm (--recursive) is blocked.' },
  // find can delete a whole tree as effectively as rm -rf; these forms are
  // irreversible and have no safe-by-default reading, so they're hard-denied.
  { id: 'find-delete', tier: 'deny', pattern: /\bfind\b[^\n]*\s-delete\b/i,            reason: 'find -delete recursively deletes and is blocked. Use the Glob/Read tools to inspect, then delete deliberately.' },
  { id: 'find-exec-rm', tier: 'deny', pattern: /\bfind\b[^\n]*-exec(?:dir)?\s+(?:\S*\/)?rm\b/i, reason: 'find -exec rm is blocked.' },
  { id: 'dd-write', tier: 'deny', pattern: /\bdd\s+if=/i,                           reason: 'raw dd writes are blocked.' },
  { id: 'mkfs-format', tier: 'deny', pattern: /\bmkfs\b/i,                             reason: 'mkfs (format) is blocked.' },
  { id: 'fork-bomb', tier: 'deny', pattern: /:\s*\(\s*\)\s*\{[^}]*\}\s*;/,           reason: 'fork bomb pattern is blocked.' },
  ...GIT_DENY_RULES,
];

// ---------------------------------------------------------------------------
// BLOCK — obfuscation-prone / multi-purpose patterns. Each returns a "deny"
// with an instructive reason so Claude rewrites into clean commands + tools.
// Order matters: the first match wins, so more specific rules come first.
// ---------------------------------------------------------------------------
const BLOCK_RULES = [
  {
    id: 'chain-splittable', tier: 'block',
    test: (cmd) => isSplittableChain(cmd, (t) => ALLOW_COMMANDS.has(t)),
    reason: 'Do not chain commands with `;`/`&&`. Run each as a SEPARATE Bash call — every known-safe command auto-approves on its own, so splitting removes the permission prompt entirely. Independent calls can be sent in one message to run in parallel.',
  },
  {
    id: 'exit-code-echo-probe', tier: 'block',
    // `cmd; echo "...$?"` — Claude appends an exit-code probe to be sure of
    // pass/fail. The Bash tool already returns the exit status, so it's pure
    // noise AND it turns an otherwise-single command into a chain that can't
    // auto-approve (and splits the "don't ask again" allowlist onto the useless
    // echo half). Steer Claude to drop it.
    test: (cmd) => /(?:;|&&)\s*echo\b[^\n]*\$\?/.test(cmd),
    reason: 'Do not append `; echo "...$?"` to read the exit code — the Bash tool already reports it. Run the command on its own.',
  },
  {
    id: 'cd-block', tier: 'block',
    test: (cmd) => /(^|;|&&|\|\|)\s*cd\s+/.test(cmd),
    reason: 'Do not use `cd` — the working directory persists between Bash calls. Use a relative or absolute path instead.',
  },
  {
    id: 'heredoc-block', tier: 'block',
    test: (cmd) => /<</.test(cmd),
    reason: 'Do not use heredocs (`<<`). They trip the obfuscation detector and silently mangle content (e.g. backticks). To write a file, use the Write tool.',
  },
  {
    id: 'cat-head-tail-guard', tier: 'block',
    // Command position only: leading the string or right after |, ;, &, `(`,
    // a backtick, or `$(` — and followed by whitespace/end. `git add cat.png`
    // and `git mv head.svg logo.svg` are arguments, not invocations.
    test: (cmd) => /(^|[|;&`(]|\$\()\s*(cat|head|tail)(?=\s|$)/.test(cmd),
    reason: 'Do not use cat/head/tail to read files. Use the Read tool — it is faster and does not trip the shell-safety detector.',
  },
  {
    id: 'arrow-fn-paren', tier: 'block',
    // Runs on the RAW string (see `raw` flag): the pattern lives inside
    // `node -e "…"` quotes, which masking strips.
    raw: true,
    test: (cmd) => /=>\s*\(\s*\{/.test(cmd),
    reason: 'Arrow functions written as `=>({...})` look like process substitution to the safety detector. Use `=>{ return {...} }` instead.',
  },
  {
    id: 'backtick-block', tier: 'block',
    test: (cmd) => /`/.test(cmd),
    reason: 'Backticks ARE command substitution in bash — even inside double quotes. For literal backticks (e.g. in a commit message), use single quotes around the text; for file content, use the Write tool.',
  },
  {
    id: 'var-redirect-block', tier: 'block',
    test: (cmd) => /\$\w+.*[<>]|[<>].*\$\w+/.test(cmd),
    reason: 'Do not combine shell variables with redirections. Split this into separate Bash calls.',
  },
  {
    id: 'pipe-block', tier: 'block',
    test: (cmd) => /\|/.test(cmd),
    reason: 'No pipes (`|`). Run each command as a separate Bash call. To process output, capture it from the first call and act on it in the next.',
  },
  {
    id: 'redirect-block', tier: 'block',
    test: (cmd) => /[0-9]*>[^&]/.test(cmd),
    reason: 'No output redirections (`>`). Let stdout return the result. To write a file, use the Write tool. (`2>&1` is fine.)',
  },
  {
    id: 'ls-glob-block', tier: 'block',
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
  // json processing (read-only; a `> file` redirect is still blocked)
  'jq',
  // recursive forms are hard-DENIED above before this check ever runs, so
  // allow-listing bare `rm` only opens up single-file/non-recursive removal.
  'rm',
  // pure delay, cannot be destructive.
  'sleep',
  // the CLI's own read-only self-checks (`claude --version`, `claude plugin validate`).
  'claude',
  // paired with a NEVER_AUTO_ALLOW demotion below: `mv -f` can silently
  // overwrite an existing destination, so only the non-force form auto-runs.
  'mv',
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
  // interpreters running inline code (node -e, python -c, perl/ruby -e, bun -e).
  // perl/ruby are unreachable dead code today — neither is in ALLOW_COMMANDS,
  // so leadingCommand(command) can never be 'perl'/'ruby' in the first place —
  // kept as defense-in-depth in case either is ever allow-listed.
  { id: 'inline-eval-interpreter', tier: 'never-auto-allow', pattern: /\b(?:node|bun|python|python3|perl|ruby)\b[^\n]*\s-(?:e|c)\b/i },
  { id: 'node-eval-flag', tier: 'never-auto-allow', pattern: /\b(?:node)\b[^\n]*\s--eval\b/i },
  { id: 'deno-eval', tier: 'never-auto-allow', pattern: /\bdeno\s+eval\b/i },
  // find running an arbitrary command per match (-exec rm is already denied)
  { id: 'find-exec-arbitrary', tier: 'never-auto-allow', pattern: /\bfind\b[^\n]*-exec(?:dir)?\b/i },
  // recursive permission/ownership changes
  { id: 'chmod-chown-recursive', tier: 'never-auto-allow', pattern: /\bch(?:mod|own)\b[^\n]*\s-[a-z]*R\b/i },
  // mv silently overwrites an existing destination with -f; only the bare
  // (non-force) form is safe to auto-run. Paired with `mv` on ALLOW_COMMANDS.
  { id: 'mv-force', tier: 'never-auto-allow', pattern: /\bmv\b[^\n]*\s(?:--force\b|-[a-z]*f\b)/i },
  ...GIT_NEVER_AUTO_ALLOW,
];

// Package runners execute an arbitrary (possibly just-downloaded) package —
// `npx rimraf dist` is the same class of hole as `node -e`, so it must prompt,
// not auto-run. Checked against the LEADING token / leading subcommand (not a
// whole-string regex) so a commit message mentioning "npx" doesn't demote.
const EXEC_RUNNER_TOKENS = new Set(['npx', 'bunx']);
const PKG_EXEC_SUBCOMMAND = /^\s*(?:\w+=(?:"[^"]*"|'[^']*'|\S+)\s+)*(?:pnpm|yarn|npm)\s+(?:dlx|exec)\b/i;

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

/**
 * Blank out the CONTENTS of quoted strings so the pattern rules stop firing on
 * quoted text — `git commit -m "feat: a | b"` is not a pipe, `grep "tail" f`
 * is not a file read. What stays in the masked string:
 *   - bash double quotes: backticks, `$(`, and `$name`/`${…}`/`$?` expansions
 *     are still SHELL-ACTIVE inside double quotes, so they are kept — a
 *     backtick in a double-quoted commit message really would substitute.
 *   - single quotes (both shells) are fully literal: contents dropped.
 *   - PowerShell double quotes: `-escapes handled, `$…` kept (still expands).
 * Unbalanced quotes → return the string unmasked. That's the conservative
 * direction: identical to the pre-masking hook, which can only over-block.
 *
 * DENY rules deliberately keep scanning the RAW string; masking is only for
 * the guidance/allow tiers, where a false positive costs a prompt, not data.
 */
function maskQuotes(command, shell) {
  let out = '';
  for (let i = 0; i < command.length; ) {
    const ch = command[i];
    if (shell === 'bash' && ch === '\\') { out += command.slice(i, i + 2); i += 2; continue; }
    // PS backtick escapes the NEXT char even outside a string — e.g. `abc`"def`
    // is the literal bareword `abc"def`, not a string open. Without this, the
    // loop below would misread that `"` as a real string delimiter and pair it
    // with a LATER, unrelated `"`, masking away everything between them —
    // including a real `;` or a dangerous command hidden in that span.
    if (shell === 'ps' && ch === '`') { out += command.slice(i, i + 2); i += 2; continue; }
    if (ch === "'") {
      let j = i + 1;
      while (j < command.length) {
        if (command[j] === "'") {
          if (shell === 'ps' && command[j + 1] === "'") { j += 2; continue; } // '' = escaped quote in PS
          break;
        }
        j++;
      }
      if (j >= command.length) return command; // unbalanced
      out += "''";
      i = j + 1;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let kept = '';
      while (j < command.length && command[j] !== '"') {
        const c = command[j];
        if (shell === 'bash' && c === '\\') { j += 2; continue; }
        if (shell === 'ps' && c === '`') { j += 2; continue; }
        if (c === '`') { kept += '`'; j++; continue; }
        if (c === '$') {
          kept += '$';
          j++;
          while (j < command.length && command[j] !== '"' && /[\w?{}()]/.test(command[j])) {
            kept += command[j];
            j++;
          }
          continue;
        }
        j++;
      }
      if (j >= command.length) return command; // unbalanced
      out += '"' + kept + '"';
      i = j + 1;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/**
 * Split a command on top-level `;` / `&&` (pipes are blocked separately) and
 * report whether it's a chain (>=2 segments) whose EVERY segment leads with an
 * allow-listed command. Such a chain is a pure sequence of known-safe commands
 * that would each auto-approve on its own, so we block it with guidance to run
 * the parts as separate calls. Control-flow (`for`/`if`) and shell-state chains
 * (`source`/`export`) are NOT affected: their leading tokens (`for`, `source`,
 * …) aren't allow-listed, so the chain doesn't qualify and falls through.
 * Naive splitting can mis-handle `;` inside quotes, but that only makes a chain
 * fail to qualify (→ a prompt), never a wrong execution.
 */
function isSplittableChain(command, tokenAllowed) {
  const segments = command.split(/\s*(?:;|&&)\s*/).map((s) => s.trim()).filter(Boolean);
  if (segments.length < 2) return false;
  return segments.every((seg) => tokenAllowed(leadingCommand(seg)));
}

function isAutoApprovable(command, masked, cfg) {
  if (HAS_CHAIN.test(masked)) return false;   // masked: a `;` inside a commit message is not a chain
  // raw: a false hit here only costs a prompt
  if (NEVER_AUTO_ALLOW.some((rule) => rule.pattern.test(command) && config.effectiveTier(rule, cfg) !== 'off')) return false;
  const token = leadingCommand(command);
  if (EXEC_RUNNER_TOKENS.has(token)) return false;
  if (PKG_EXEC_SUBCOMMAND.test(command)) return false;
  return ALLOW_COMMANDS.has(token) || cfg.extraAllowCommands.has(token);
}

// ===========================================================================
// PowerShell coverage. On Windows the agent has a PowerShell tool SEPARATE from
// Bash; without this it was unguarded (`Remove-Item -Recurse` slipped past the
// Bash-only rules) AND never auto-approved (so every cmdlet prompted). These
// mirror the Bash tiers in PowerShell syntax. Two deliberate differences:
//   - The object pipeline `|` is idiomatic and is NOT blocked. Only file
//     redirects (`>`, Out-File, Set-Content) are steered to the Write tool.
//   - `;` is a statement separator (like `&&`), so it blocks auto-approve.
// The deny scan still runs over the WHOLE string, so `gci -Recurse |
// Remove-Item -Force` is caught despite being a single pipeline.
// ===========================================================================
const PS_REMOVE = 'Remove-Item|rm|ri|rd|rmdir|del|erase';
const PS_DENY_RULES = [
  // Recursive Remove-Item (any alias). `-r` is an unambiguous abbreviation of
  // -Recurse for Remove-Item. `[^;|\n]*` keeps the flag in the same pipeline
  // segment so `rm a.txt; gci -Recurse` isn't misread as a recursive delete.
  { id: 'ps-remove-recursive', tier: 'deny', pattern: new RegExp(`(^|[\\s;|(=])(?:${PS_REMOVE})\\b[^;|\\n]*\\s-r(?:ec(?:urse)?)?\\b`, 'i'),
    reason: 'recursive Remove-Item (-Recurse) is blocked.' },
  // Anything piped into a removal WITH -Recurse/-Force is a bulk delete.
  { id: 'ps-pipe-into-remove-bulk', tier: 'deny', pattern: new RegExp(`\\|\\s*(?:${PS_REMOVE})\\b[^;\\n]*\\s-(?:Recurse|Force|r|f)\\b`, 'i'),
    reason: 'piping into Remove-Item -Recurse/-Force is a bulk delete and is blocked.' },
  { id: 'ps-clear-content', tier: 'deny', pattern: /(^|[\s;|(=])(?:Clear-Content|clc)\b/i, reason: 'Clear-Content wipes a file’s contents and is blocked. Use the Write tool to replace a file.' },
  { id: 'ps-disk-partition-ops', tier: 'deny', pattern: /\b(?:Format-Volume|Clear-Disk|Remove-Partition|Initialize-Disk|Reset-PhysicalDisk)\b/i, reason: 'disk/partition operations are blocked.' },
  { id: 'ps-registry-delete', tier: 'deny', pattern: /(^|[\s;|(=])(?:Remove-Item|rm|ri)\b[^;\n]*\b(?:HKLM|HKCU|HKCR|HKU):/i, reason: 'registry key deletion is blocked.' },
  { id: 'ps-del-rd-recursive', tier: 'deny', pattern: /(^|[\s;|(=])(?:del|rd|rmdir)\b[^;\n]*\/s\b/i, reason: 'recursive del/rd /s is blocked.' },
  // Shuts down or reboots the whole machine — kills the session itself. No
  // legitimate reason for a coding agent to do this; ask-tier is too weak.
  { id: 'ps-stop-restart-computer', tier: 'deny', pattern: /(^|[\s;|(=])(?:Stop-Computer|Restart-Computer)\b/i, reason: 'shutting down or restarting the machine is blocked.' },
  ...GIT_DENY_RULES,
];

// File-writing → steer to the Write tool (mirrors the Bash redirect block).
const PS_GUIDANCE_RULES = [
  {
    id: 'ps-chain-splittable', tier: 'block',
    test: (cmd) => isSplittableChain(cmd, (t) => PS_ALLOW.has(t) || ALLOW_COMMANDS.has(t)),
    reason: 'Do not chain commands with `;`/`&&`. Run each as a SEPARATE PowerShell call — known-safe cmdlets auto-approve on their own, so splitting removes the permission prompt. Independent calls can be sent in one message to run in parallel.',
  },
  {
    id: 'ps-out-file-set-content', tier: 'block',
    test: (cmd) => /(^|[\s;|(=])(?:Out-File|Set-Content|Add-Content|Tee-Object|tee)\b/i.test(cmd),
    reason: 'Do not write files with Out-File/Set-Content/Add-Content. Use the Write tool.',
  },
  {
    id: 'ps-new-item-value', tier: 'block',
    // New-Item is allow-listed for mkdir, but `-Value` makes it a file write.
    test: (cmd) => /(^|[\s;|(=])(?:New-Item|ni)\b[^;\n]*\s-Value\b/i.test(cmd),
    reason: 'Do not write file contents with New-Item -Value. Use the Write tool.',
  },
  {
    id: 'ps-redirect', tier: 'block',
    test: (cmd) => /[0-9]*>[^&]/.test(cmd),
    reason: 'No output redirections (`>`/`>>`) to files. Let stdout return the result, or use the Write tool. (`2>&1` is fine.)',
  },
  {
    id: 'ps-cd-block', tier: 'block',
    test: (cmd) => /(^|;|&&|\|\|)\s*(?:cd|sl|Set-Location|Push-Location|pushd)\b/i.test(cmd),
    reason: 'Do not use `cd`/Set-Location — the working directory persists between PowerShell calls. Use a full path instead.',
  },
];

// Safe read-only / inspection cmdlets + aliases (lower-cased to match
// leadingCommand). Dev tools (git, node, npm, …) come from ALLOW_COMMANDS.
const PS_ALLOW = new Set([
  'get-childitem', 'gci', 'ls', 'dir',
  'get-content', 'gc', 'cat', 'type',
  'get-item', 'gi', 'get-itemproperty', 'gip',
  'test-path',
  'get-location', 'pwd', 'gl',
  'resolve-path', 'split-path', 'join-path',
  'select-string', 'sls',
  'select-object', 'select',
  'where-object', 'where',
  'sort-object', 'sort',
  'measure-object', 'measure',
  'group-object', 'group',
  'get-unique', 'gu',
  'get-command', 'gcm', 'get-help', 'help', 'get-member', 'gm', 'get-module', 'gmo',
  'get-process', 'gps', 'ps',
  'get-date',
  'compare-object', 'diff',
  'convertto-json', 'convertfrom-json',
  'format-table', 'ft', 'format-list', 'fl', 'format-wide', 'fw',
  'out-string', 'out-host',
  'write-output', 'echo', 'write', 'write-host', 'write-verbose', 'write-warning',
  'new-item', 'ni', 'md', 'mkdir',
]);

// Narrow, pattern-based exception: `netsh wlan show ...` is a read-only
// Wi-Fi diagnostic query. `netsh` itself is NOT allow-listed — it also does
// firewall/interface writes — so this is checked separately, not added to
// PS_ALLOW's leading-token set.
const PS_NETSH_WLAN_SHOW = /^\s*netsh(?:\.exe)?\s+wlan\s+show\b/i;

// Constructs that must never auto-approve in PowerShell — even when the leading
// cmdlet is on PS_ALLOW (e.g. a safe `gci` piped into a mutating cmdlet, or a
// scriptblock that runs arbitrary code). They fall through to a prompt.
const PS_NEVER_AUTO = [
  // Text piped into an external interpreter/shell. The object-pipeline
  // exemption is for typed cmdlet flow — feeding a script is not that.
  { id: 'ps-pipe-into-interpreter', tier: 'never-auto-allow', pattern: /\|\s*(?:node|python|python3|perl|ruby|bun|deno|bash|sh|cmd|pwsh|powershell)(?:\.exe)?\b/i },
  { id: 'ps-invoke-expression', tier: 'never-auto-allow', pattern: /\b(?:iex|Invoke-Expression|icm|Invoke-Command|Invoke-Item|Add-Type)\b/i },
  { id: 'ps-start-process', tier: 'never-auto-allow', pattern: /\b(?:saps|Start-Process)\b/i },
  { id: 'ps-web-fetch', tier: 'never-auto-allow', pattern: /\b(?:iwr|Invoke-WebRequest|irm|Invoke-RestMethod|Start-BitsTransfer|curl|wget)\b/i },
  { id: 'ps-foreach-object', tier: 'never-auto-allow', pattern: /\bForEach-Object\b/i },
  { id: 'ps-scriptblock-percent', tier: 'never-auto-allow', pattern: /(^|[\s|;(=])%[\s({]/ },                 // % { … } scriptblock (ForEach-Object alias)
  { id: 'ps-call-operator-variable', tier: 'never-auto-allow', pattern: /&\s+[$(]/ },                            // call operator on a variable / expression
  { id: 'ps-dot-source-variable', tier: 'never-auto-allow', pattern: /(^|[\s;])\.\s+[$(]/ },                  // dot-source a variable / expression
  // Any mutating verb anywhere blocks auto-approve. Recursive/forced forms are
  // already hard-denied above; this catches the non-recursive ones so a delete
  // never runs silently (e.g. `gci | Remove-Item`).
  { id: 'ps-mutating-verb', tier: 'never-auto-allow', pattern: /(^|[\s|;(=])(?:Remove-Item|rm|ri|rd|rmdir|del|erase|Clear-Item|Clear-Content|clc|Move-Item|mv|move|Rename-Item|ren|rni|Set-Item|Set-ItemProperty|Set-Content|Add-Content|Stop-Process|kill|spps|Stop-Service)\b/i },
  { id: 'ps-new-item-force', tier: 'never-auto-allow', pattern: /\bNew-Item\b[^;\n]*\s-Force\b/i },      // New-Item -Force can truncate an existing file
];

// Every built-in rule id, across every array — used to reject a config
// extraDenyRules/extraBlockRules entry that reuses one (see config.js).
const BUILTIN_IDS = new Set(
  [...DENY_RULES, ...BLOCK_RULES, ...NEVER_AUTO_ALLOW, ...PS_DENY_RULES, ...PS_GUIDANCE_RULES, ...PS_NEVER_AUTO]
    .map((rule) => rule.id)
);

function isAutoApprovablePS(command, masked, psCfg) {
  if (HAS_CHAIN.test(masked)) return false;                          // masked: `;` inside a string is not a chain
  // shared: node -e, python -c, … + PS-only never-auto rules. Both resolved
  // against the PowerShell-scoped config, even the shared list — see config.js.
  if (NEVER_AUTO_ALLOW.some((rule) => rule.pattern.test(command) && config.effectiveTier(rule, psCfg) !== 'off')) return false;
  if (PS_NEVER_AUTO.some((rule) => rule.pattern.test(command) && config.effectiveTier(rule, psCfg) !== 'off')) return false;
  const token = leadingCommand(command);
  if (EXEC_RUNNER_TOKENS.has(token)) return false;
  if (PKG_EXEC_SUBCOMMAND.test(command)) return false;
  if (PS_NETSH_WLAN_SHOW.test(command)) return true;
  return PS_ALLOW.has(token) || ALLOW_COMMANDS.has(token) || psCfg.extraAllowCommands.has(token);
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

/**
 * Apply one DENY-tier rule (built-in or a config extraDenyRules entry) under
 * a resolved shell config. Returns an emit()/passthrough() result to return
 * immediately, or null to keep checking the next rule. An 'ask' override
 * returns passthrough() DIRECTLY rather than just skipping the rule — if it
 * only skipped, a later ALLOW_COMMANDS leading-token match could silently
 * auto-approve the very command being demoted (see config.js effectiveTier).
 */
function applyDenyRule(rule, command, cfg) {
  if (!rule.pattern.test(command)) return null;
  const eff = config.effectiveTier(rule, cfg);
  if (eff === 'deny') return emit('deny', `BLOCKED (dangerous): ${rule.reason}`);
  if (eff === 'ask') return passthrough();
  return null; // 'off' is unreachable for deny-tier (clamped in effectiveTier)
}

/**
 * Apply one BLOCK-tier rule (built-in or a config extraBlockRules entry).
 * Built-ins carry a `test(cmd)` function (and an optional `raw` flag);
 * compiled extra rules carry a `pattern` regex tested against the masked
 * string only. 'off' means "keep checking the next BLOCK rule", unlike DENY's
 * clamp — block-tier rules are a friction reducer, not a hard safety boundary.
 */
function applyBlockRule(rule, raw, masked, cfg) {
  const matched = rule.test ? rule.test(rule.raw ? raw : masked) : rule.pattern.test(masked);
  if (!matched) return null;
  const eff = config.effectiveTier(rule, cfg);
  if (eff === 'deny') return emit('deny', `BLOCKED: ${rule.reason}`);
  if (eff === 'ask') return passthrough();
  return null;
}

/** A never-auto-allow rule the config promotes to 'deny' short-circuits to a hard block. */
function checkPromotedDeny(rules, command, cfg) {
  for (const rule of rules) {
    if (rule.pattern.test(command) && config.effectiveTier(rule, cfg) === 'deny') {
      return emit('deny', `BLOCKED (dangerous): rule '${rule.id}' promoted to deny by config.`);
    }
  }
  return null;
}

function decideBash(command) {
  // DENY scans the raw string (conservative: a quoted "rm -rf" over-blocks,
  // never under-blocks). Guidance + allow tiers see the quote-masked string
  // so quoted text (commit messages, grep patterns) can't trip them.
  const masked = maskQuotes(command, 'bash');
  const cfg = config.loadConfig({ builtinIds: BUILTIN_IDS });
  for (const rule of [...DENY_RULES, ...cfg.extraDenyRules]) {
    const result = applyDenyRule(rule, command, cfg);
    if (result) return result;
  }
  for (const rule of [...BLOCK_RULES, ...cfg.extraBlockRules]) {
    const result = applyBlockRule(rule, command, masked, cfg);
    if (result) return result;
  }
  const promoted = checkPromotedDeny(NEVER_AUTO_ALLOW, command, cfg);
  if (promoted) return promoted;
  if (isAutoApprovable(command, masked, cfg)) {
    return emit('allow', 'Auto-approved by bash-guardrails (known-safe dev command).');
  }
  return passthrough();
}

function decidePowershell(command) {
  // Same split as decideBash: deny on raw, guidance/allow on masked.
  const masked = maskQuotes(command, 'ps');
  const cfg = config.loadConfig({ builtinIds: BUILTIN_IDS });
  const psCfg = cfg.powershell;
  for (const rule of [...PS_DENY_RULES, ...psCfg.extraDenyRules]) {
    const result = applyDenyRule(rule, command, psCfg);
    if (result) return result;
  }
  for (const rule of [...PS_GUIDANCE_RULES, ...psCfg.extraBlockRules]) {
    const result = applyBlockRule(rule, command, masked, psCfg);
    if (result) return result;
  }
  const promoted = checkPromotedDeny([...NEVER_AUTO_ALLOW, ...PS_NEVER_AUTO], command, psCfg);
  if (promoted) return promoted;
  if (isAutoApprovablePS(command, masked, psCfg)) {
    return emit('allow', 'Auto-approved by bash-guardrails (known-safe PowerShell command).');
  }
  return passthrough();
}

function decide(rawInput) {
  const event = JSON.parse(rawInput || '{}');
  const command = ((event.tool_input || {}).command || '').trim();
  if (!command) return passthrough();

  // Police the shell tools. Anything else (Read, Write, Edit, …) is not ours.
  if (event.tool_name === 'Bash') return decideBash(command);
  if (/^(?:powershell|pwsh)$/i.test(event.tool_name || '')) return decidePowershell(command);
  return passthrough();
}

// ---------------------------------------------------------------------------
// Entry point. Guarded by require.main so `require()`-ing this file (e.g. from
// test/run.js, to introspect rule ids) doesn't attach a stdin listener —
// spawning it directly as the hook (`node guardrails.js`) is unaffected.
// ---------------------------------------------------------------------------
if (require.main === module) {
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
}

module.exports = {
  GIT_DENY_RULES, GIT_NEVER_AUTO_ALLOW, DENY_RULES, BLOCK_RULES, NEVER_AUTO_ALLOW,
  PS_DENY_RULES, PS_GUIDANCE_RULES, PS_NEVER_AUTO,
};
