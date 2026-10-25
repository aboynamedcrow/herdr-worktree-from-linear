import { createInterface } from 'node:readline';
import { spawn as spawnChild } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { request } from 'node:http';
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

// Typed identifiers always leave the list and require a Linear lookup.
export function resolveSelection(query, selected, issues, { idTeamKey, teamKey, numbered = false } = {}) {
  const typed = query.trim();
  if (/^[a-z][a-z0-9]*-[1-9][0-9]*$/i.test(typed)) return typed.toUpperCase();
  if (numbered && selected) return selected;
  const team = idTeamKey || teamKey;
  if (/^[1-9][0-9]*$/.test(typed) && typeof team === 'string' && /^[a-z][a-z0-9]*$/i.test(team)) {
    return `${team.toUpperCase()}-${typed}`;
  }
  if (/^[1-9][0-9]*$/.test(typed) && selected) return selected.identifier;
  return selected || null;
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
      resolve(identifiers ? resolveSelection(answer, selected, issues, { ...options, numbered: true }) : selected);
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

// fzf may create the endpoint after the fetch ends. Retry connection failures
// until it starts or exits. HTTP errors fail immediately. No shell runs here.
export async function postAction(socketPath, key, body, isOpen, { requestFn = request,
  wait = () => new Promise((resolve) => setTimeout(resolve, 20)) } = {}) {
  for (let attempt = 0; attempt < 100 && isOpen(); attempt++) {
    try {
      await new Promise((resolve, reject) => {
        const req = requestFn({ socketPath, path: '/', method: 'POST', headers: { 'x-api-key': key } }, (res) => {
          res.resume();
          res.on('error', reject);
          res.on('end', () => res.statusCode === 200 ? resolve() : reject(new Error('fzf rejected the reload')));
        });
        req.setTimeout(1000, () => req.destroy(new Error('fzf reload timed out')));
        req.on('error', reject);
        req.end(body);
      });
      return;
    } catch (error) {
      if (!['ENOENT', 'ECONNREFUSED'].includes(error.code)) throw error;
      if (isOpen()) await wait();
    }
  }
  if (isOpen()) throw new Error('fzf listen endpoint unavailable');
}

const shellQuote = (value) => "'" + value.replaceAll("'", "'\"'\"'") + "'";

async function refreshingSelect(issues, { layout, env, refresh, header, spawn, sendAction, ...options }) {
  const directory = mkdtempSync(join(tmpdir(), 'wfl-'));
  chmodSync(directory, 0o700);
  const socketPath = join(directory, 'f.sock');
  const rowsPath = join(directory, 'rows');
  const key = randomBytes(32).toString('hex');
  let open = true;
  let rows = issues;
  let child;
  let refreshing;
  const cleanup = () => { open = false; rmSync(directory, { recursive: true, force: true }); };
  try {
    child = spawn('fzf', [...fzfArgs(layout), '--ansi', '--print-query', '--bind', 'enter:accept-or-print-query',
      `--header=${header}`, `--listen=${socketPath}`],
    { env: { ...env, FZF_API_KEY: key }, stdio: ['pipe', 'pipe', 'inherit'] });
    const result = new Promise((resolve, reject) => {
      let stdout = '';
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => { stdout += chunk; });
      child.stdin.on('error', () => {});
      child.once('error', (error) => { cleanup(); reject(error); });
      child.once('close', (status) => { cleanup(); resolve({ status, stdout }); });
    });
    child.stdin.end(formatLines(issues).join('\n'));
    refreshing = (async () => {
      let live;
      try { live = await refresh(); } catch {
        if (open) await sendAction(socketPath, key, `change-header(${header} | refresh failed)`, () => open).catch(() => {});
        return;
      }
      if (!open) return;
      writeFileSync(rowsPath, formatLines(live).join('\n'), { mode: 0o600 });
      try {
        // Both versions remain valid while fzf executes the reload command.
        rows = [...live, ...issues.filter((issue) => !live.some((row) => row.identifier === issue.identifier))];
        await sendAction(socketPath, key, `reload(cat ${shellQuote(rowsPath)})+change-header(live)`, () => open);
      } catch { /* The disk cache still holds the successful fetch. */ }
    })().catch(() => {});
    const res = await result;
    if (res.status !== 0) return null;
    const [query = '', line = ''] = res.stdout.split('\n');
    return resolveSelection(query, lineToIssue(line, rows), rows, options);
  } finally {
    cleanup();
    // bin/picker.js calls process.exit. Finish the cache write before returning.
    await refreshing;
  }
}

export async function select(issues, { exec = runCmd, layout = 'down', env = process.env,
  refresh, header = 'live', spawn = spawnChild, sendAction = postAction, ...options } = {}) {
  const lines = formatLines(issues);
  if (hasFzf(exec)) {
    if (refresh) return refreshingSelect(issues, { layout, env, refresh, header, spawn, sendAction, ...options });
    const res = exec('fzf', [...fzfArgs(layout), '--ansi', '--print-query', '--bind', 'enter:accept-or-print-query',
      `--header=${header}`], { input: lines.join('\n'), env });
    if (res.status !== 0) return null;
    const [query = '', line = ''] = res.stdout.split('\n');
    return resolveSelection(query, lineToIssue(line, issues), issues, options);
  }
  // The numbered prompt keeps its initial rows. Refresh only the disk cache.
  const refreshing = refresh ? refresh().catch(() => {
    (options.output || process.stdout).write(`${header} | refresh failed\n`);
  }) : null;
  try { return await nodeSelect(issues, lines, undefined, { ...options, identifiers: true }); }
  finally { await refreshing; }
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

// Keep a failed picker visible until a keypress or the deadline.
export function pauseOnFailure({
  input = process.stdin, output = process.stderr,
  setTimer = setTimeout, clearTimer = clearTimeout, timeoutMs = 30000,
} = {}) {
  if (!input.isTTY) return Promise.resolve();
  return new Promise((resolve) => {
    output.write('press any key to close\n');
    const wasRaw = input.isRaw;
    const done = () => {
      clearTimer(timer);
      input.removeListener('data', done);
      input.pause();
      input.setRawMode(Boolean(wasRaw));
      resolve();
    };
    const timer = setTimer(done, timeoutMs);
    input.setRawMode(true);
    input.resume();
    input.once('data', done);
  });
}
