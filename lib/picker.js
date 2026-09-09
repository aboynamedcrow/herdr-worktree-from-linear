import { createInterface } from 'node:readline';
import { runCmd } from './exec.js';

export function formatLine(issue) {
  return `${issue.identifier}  ${issue.title}  [${issue.stateName}] @${issue.assignee}`;
}

export function formatLines(issues) {
  return issues.map(formatLine);
}

export function lineToIssue(line, issues) {
  const m = /^(\S+)/.exec(line || '');
  if (!m) return null;
  return issues.find((i) => i.identifier === m[1]) ?? null;
}

function hasFzf(exec) {
  return exec('sh', ['-c', 'command -v fzf'], { timeout: 5000 }).status === 0;
}

function nodeSelect(issues, lines, prompt = 'Select an issue number (or blank to cancel): ') {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    lines.forEach((l, i) => process.stdout.write(`  ${i + 1}) ${l}\n`));
    rl.question(prompt, (answer) => {
      rl.close();
      const idx = Number(answer.trim()) - 1;
      resolve(Number.isInteger(idx) && idx >= 0 && idx < issues.length ? issues[idx] : null);
    });
  });
}

// fzfLayout "top" puts the search bar at the top (--layout=reverse); anything else
// (default "down") uses fzf's default bottom layout. --height=~40% keeps the picker
// a compact window that auto-shrinks to the list, capped at 40% of the pane.
export function fzfArgs(layout, prompt = 'issue> ') {
  const args = [];
  if (layout === 'top') args.push('--layout=reverse');
  args.push('--height=~40%', '--prompt', prompt);
  return args;
}

export async function select(issues, { exec = runCmd, layout = 'down' } = {}) {
  if (!issues.length) return null;
  const lines = formatLines(issues);
  if (hasFzf(exec)) {
    const res = exec('fzf', fzfArgs(layout), { input: lines.join('\n') });
    if (res.status !== 0) return null;
    return lineToIssue(res.stdout.trim(), issues);
  }
  return nodeSelect(issues, lines);
}

// Multiple existing issue branches need an explicit choice. Each id comes from
// Plus; this UI never computes a branch name or checkout path.
export async function selectWorktree(candidates, { exec = runCmd, layout = 'down' } = {}) {
  if (candidates.length === 1) return candidates[0];
  const lines = candidates.map((candidate) => `${candidate.id}  ${candidate.branch}  [${candidate.checkout ? 'open checkout' : candidate.existing ? 'check out branch' : 'create'}]  ${candidate.path}`);
  if (hasFzf(exec)) {
    const result = exec('fzf', fzfArgs(layout, 'worktree> '), { input: lines.join('\n') });
    if (result.status !== 0) return null;
    const id = result.stdout.trim().split(/\s+/)[0];
    return candidates.find((candidate) => candidate.id === id) ?? null;
  }
  return nodeSelect(candidates, lines, 'Select a worktree number (or blank to cancel): ');
}
