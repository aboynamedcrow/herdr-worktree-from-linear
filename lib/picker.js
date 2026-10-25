import { createInterface } from 'node:readline';
import { runCmd } from './exec.js';

export function formatLine(issue) {
  const icons = { triage: '◇', backlog: '◌', unstarted: '○', started: '◐', completed: '●', canceled: '⊘', duplicate: '⊘' };
  let icon = issue.stateType === 'started' && /review/i.test(issue.stateName) ? '◕'
    : Object.hasOwn(icons, issue.stateType) ? icons[issue.stateType] : '';
  if (icon && /^#[0-9a-f]{6}$/i.test(issue.stateColor ?? '')) {
    const rgb = [1, 3, 5].map((offset) => parseInt(issue.stateColor.slice(offset, offset + 2), 16));
    icon = `\x1b[38;2;${rgb.join(';')}m${icon}\x1b[0m`;
  }
  const state = [icon, issue.stateName].filter(Boolean).join(' ');
  const points = Array.from(issue.title ?? '');
  const title = points.length > 60 ? `${points.slice(0, 59).join('')}…` : points.join('');
  const extra = [issue.project && `[${issue.project}]`, issue.assignee && `@${issue.assignee}`].filter(Boolean).join(' ');
  return [issue.identifier, state, title, extra].filter(Boolean).join('  ');
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

// A full ID wins over the highlighted row. A number uses the team only without a row.
// Return an identifier string when run() must fetch an issue outside the list.
export function resolveSelection(query, selected, issues, { idTeamKey, teamKey } = {}) {
  const typed = query.trim();
  if (/^[a-z][a-z0-9]*-[1-9][0-9]*$/i.test(typed)) {
    const identifier = typed.toUpperCase();
    return issues.find((issue) => issue.identifier.toUpperCase() === identifier) ?? identifier;
  }
  if (selected) return selected;
  const team = idTeamKey || teamKey;
  if (/^[1-9][0-9]*$/.test(typed) && typeof team === 'string' && /^[a-z][a-z0-9]*$/i.test(team)) {
    return `${team.toUpperCase()}-${typed}`;
  }
  return null;
}

export function nodeSelect(issues, lines, prompt = 'Select a row number or issue ID (blank cancels): ',
  { input = process.stdin, output = process.stdout, identifiers = false, ...options } = {}) {
  return new Promise((resolve) => {
    const rl = createInterface({ input, output });
    rl.once('close', () => resolve(null));
    lines.forEach((l, i) => output.write(`  ${i + 1}) ${l}\n`));
    rl.question(prompt, (answer) => {
      const idx = Number(answer.trim()) - 1;
      const selected = Number.isInteger(idx) && idx >= 0 && idx < issues.length ? issues[idx] : null;
      resolve(identifiers ? resolveSelection(answer, selected, issues, options) : selected);
      rl.close();
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

export async function select(issues, { exec = runCmd, layout = 'down', ...options } = {}) {
  const lines = formatLines(issues);
  if (hasFzf(exec)) {
    const res = exec('fzf', [...fzfArgs(layout), '--ansi', '--print-query', '--bind', 'enter:accept-or-print-query'], { input: lines.join('\n') });
    if (res.status !== 0) return null;
    const [query = '', line = ''] = res.stdout.split('\n');
    return resolveSelection(query, lineToIssue(line, issues), issues, options);
  }
  return nodeSelect(issues, lines, undefined, { ...options, identifiers: true });
}

// Multiple existing issue branches need an explicit choice. Each id comes from
// Plus; this UI never computes a branch name or checkout path.
export async function selectWorktree(candidates, { exec = runCmd, layout = 'down', remoteState } = {}) {
  // Lifecycle-aware plans always show the choice, including unknown PR state.
  if (candidates.length === 1 && !candidates[0].source) return candidates[0];
  const lines = candidates.map((candidate) => {
    const legacy = candidate.checkout ? 'open checkout' : candidate.existing ? 'check out branch' : 'create';
    const detail = candidate.source
      ? `${candidate.action} · ${candidate.source} · PR ${candidate.pr_state}${candidate.recommended ? ' · recommended' : ''} · ${candidate.start_commit.slice(0, 12)}${remoteState === 'UNKNOWN' ? ' · remote UNKNOWN' : ''}`
      : legacy;
    return `${candidate.id}  ${candidate.branch}  [${detail}]  ${candidate.path}`;
  });
  if (hasFzf(exec)) {
    const result = exec('fzf', fzfArgs(layout, 'worktree> '), { input: lines.join('\n') });
    if (result.status !== 0) return null;
    const id = result.stdout.trim().split(/\s+/)[0];
    return candidates.find((candidate) => candidate.id === id) ?? null;
  }
  return nodeSelect(candidates, lines, 'Select a worktree number (or blank to cancel): ');
}
