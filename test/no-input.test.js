// Proof that delivery cannot type, and proof that a stalled CLI cannot hold it.
//
// The first half is the P1 finding turned into a regression: a real shell, in a real pty,
// really blocked in its own `read` builtin, is put in front of the delivery driver. It
// must receive nothing — and the same shell is then shown to consume input readily when
// the test itself sends some, so "it received nothing" means the path is gone, not that
// the fixture was inert.
//
// The second half is the P2 finding: a herdr that accepts a command and never returns is
// killed on the caller's deadline, and leaves no process behind.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyForeground, deliverIssueDetails } from '../lib/slot.js';
import * as native from '../lib/native.js';
import { PTY_WRAPPER, ptyAvailable, until } from './pty.mjs';

const WS = 'w9';
const TAB = 'w9:t1';
const PANE = 'w9:p2';
const CONFIG = { issueTabLabel: 'Crew', issuePaneLabel: 'Issue', issueSlotSettleMs: 500, issueSlotCommandMs: 500 };
const MARKER = 'WFL_TEST_INPUT_MARKER';

const tabs = { type: 'tab_list', tabs: [{ tab_id: TAB, workspace_id: WS, label: 'Crew' }] };
const panes = { type: 'pane_list', panes: [{ pane_id: PANE, tab_id: TAB, workspace_id: WS, label: 'Issue' }] };
const worktreeStdout = JSON.stringify({ result: {
  type: 'worktree_created',
  workspace: { workspace_id: WS, active_tab_id: TAB },
  worktree: { path: '/' },
} });

function tempDir(t, prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// A real process on a real pty, with its pid, exactly as the OS sees it.
function ptyProcess(t, argv) {
  const child = spawn('python3', ['-c', PTY_WRAPPER, ...argv], { stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '';
  let err = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (c) => { out += c; });
  child.stderr.on('data', (c) => { err += c; });
  const pid = () => Number(/CHILDPID:(\d+)/.exec(err)?.[1] || 0);
  t.after(() => {
    for (const p of [child.pid, pid()]) {
      try { if (p) process.kill(p, 'SIGKILL'); } catch { /* already gone */ }
    }
  });
  return { child, out: () => out, pid, write: (s) => child.stdin.write(s) };
}

// What herdr would report for that pane: one foreground process, which is the shell
// itself, as its own process group leader — the shape that used to mean "safe to type
// into". The pid and group are read back from the OS rather than asserted.
function foregroundOf(pid) {
  const res = spawnSync('ps', ['-o', 'pid=,pgid=,comm=,args=', '-p', String(pid)], { encoding: 'utf8' });
  assert.equal(res.status, 0, `ps could not see ${pid}`);
  const [reported, pgid, comm, ...rest] = res.stdout.trim().split(/\s+/);
  assert.equal(Number(reported), pid);
  return {
    info: {
      pane_id: PANE,
      shell_pid: pid,
      foreground_process_group_id: Number(pgid),
      foreground_processes: [{ pid, name: comm.split('/').pop(), argv0: comm, argv: [comm, ...rest] }],
    },
    pgid: Number(pgid),
    comm,
  };
}

// Records every native call, and refuses to be a socket client.
function recorder(processInfo) {
  const calls = [];
  const exec = (cmd, args = []) => {
    calls.push([cmd, ...args]);
    const key = `${args[0]} ${args[1]}`;
    const reply = (result) => ({ status: 0, stdout: JSON.stringify({ result }), stderr: '' });
    if (key === 'tab list') return reply(tabs);
    if (key === 'pane list') return reply(panes);
    if (key === 'pane process-info') return reply({ type: 'pane_process_info', process_info: processInfo });
    if (key === 'pane get') return reply({ type: 'pane_info', pane: { pane_id: PANE, tab_id: TAB, workspace_id: WS, label: 'Issue', tokens: {} } });
    return { status: 1, stdout: '', stderr: `unexpected ${key}` };
  };
  return { exec, calls };
}

const FORBIDDEN = ['run', 'send-input', 'send-keys', 'paste', 'write', 'type', 'split', 'swap', 'close'];

async function deliverAgainst(processInfo) {
  const { exec, calls } = recorder(processInfo);
  const asked = [];
  const res = await deliverIssueDetails({
    worktreeStdout,
    identifier: 'BIT-1',
    config: CONFIG,
    configDir: '/cfg',
    exec,
    herdrBin: 'herdr',
    ask: async (...args) => { asked.push(args); return { ok: false, error: 'unreachable' }; },
    focus: async () => { throw new Error('focus must not be reached'); },
  });
  return { res, calls, asked };
}

// ---------------------------------------------------------------------------
// A shell that is not at a prompt

test('a shell blocked in its own read builtin is sent nothing at all', async (t) => {
  if (!ptyAvailable()) return t.skip('python3 pty module unavailable');
  // Not at a prompt: this shell is inside `read`, and anything delivered to it would be
  // answering that read.
  // What the shell reads is written to a file, not to the terminal: the pty echoes what
  // is typed into it, so a terminal-side marker could not tell an echo from a consumption.
  const answerFile = join(tempDir(t, 'wfl-read-'), 'answer');
  const shell = ptyProcess(t, ['/bin/bash', '--noprofile', '--norc', '-c',
    `printf 'READY\\n'; read -r answer; printf '%s' "$answer" > ${answerFile}`]);
  assert.ok(await until(() => /READY/.test(shell.out())), shell.out());
  const pid = shell.pid();
  assert.ok(pid > 0, 'the pty child reported its pid');

  const { info, pgid, comm } = foregroundOf(pid);
  // Precondition: from the outside this is indistinguishable from an idle prompt — the
  // shell is the only foreground process and it leads its own process group.
  assert.equal(pgid, pid);
  assert.match(comm, /bash/);

  const { res, calls, asked } = await deliverAgainst(info);
  assert.equal(res.ok, false);
  assert.match(res.error, /is not running the issue host/);
  assert.deepEqual(asked, [], 'no request was sent anywhere');
  for (const call of calls) {
    for (const verb of FORBIDDEN) assert.equal(call.includes(verb), false, `must not run: ${call.join(' ')}`);
  }
  // Nothing at all reached the terminal, and the read is still waiting.
  assert.equal(existsSync(answerFile), false, 'the blocked read consumed nothing');
  assert.equal(shell.out().includes('BIT-1'), false, shell.out());
  assert.equal(shell.out().includes('slot-host.js'), false, shell.out());

  // And the read really was live: what the test sends itself is consumed immediately.
  // Without this, "received nothing" could just mean the fixture was already finished.
  shell.write(`${MARKER}\n`);
  assert.ok(await until(() => existsSync(answerFile) && readFileSync(answerFile, 'utf8') === MARKER), 'the same read consumed the test\'s own input');
});

test('an interactive shell sitting in a builtin is refused for the same reason', async (t) => {
  if (!ptyAvailable()) return t.skip('python3 pty module unavailable');
  const answerFile = join(tempDir(t, 'wfl-read-i-'), 'answer');
  const shell = ptyProcess(t, ['/bin/bash', '--noprofile', '--norc', '-i']);
  // Drive it to a prompt, then into `read` — the interactive form of the same trap. Here
  // the shell is a real interactive shell, so it is at a prompt one moment and inside a
  // builtin the next, with nothing observable from outside distinguishing the two.
  shell.write('PS1=">>> "\n');
  assert.ok(await until(() => />>> /.test(shell.out())), shell.out());
  shell.write(`read -r answer; printf '%s' "$answer" > ${answerFile}\n`);
  await new Promise((r) => setTimeout(r, 300));
  const pid = shell.pid();
  const { info } = foregroundOf(pid);

  const { res, asked } = await deliverAgainst(info);
  assert.equal(res.ok, false);
  assert.match(res.error, /is not running the issue host/);
  assert.deepEqual(asked, []);
  assert.equal(existsSync(answerFile), false, 'the interactive read consumed nothing');

  shell.write(`${MARKER}\n`);
  assert.ok(await until(() => existsSync(answerFile) && readFileSync(answerFile, 'utf8') === MARKER), 'the same read consumed the test\'s own input');
});

test('csh and tcsh are refused like every other shell, with nothing quoted for them', async (t) => {
  if (!ptyAvailable()) return t.skip('python3 pty module unavailable');
  let checked = 0;
  for (const shellPath of ['/bin/csh', '/bin/tcsh']) {
    if (!existsSync(shellPath)) continue;
    checked += 1;
    const shell = ptyProcess(t, [shellPath, '-f']);
    await new Promise((r) => setTimeout(r, 400));
    const pid = shell.pid();
    assert.ok(pid > 0);
    const { info } = foregroundOf(pid);
    // There is no shell-specific escaping anywhere any more, because there is no command:
    // csh's history expansion, and every other shell's parsing quirk, is simply not
    // reachable from here.
    assert.equal(classifyForeground(info, PANE).kind, 'busy');
    const { res, calls, asked } = await deliverAgainst(info);
    assert.equal(res.ok, false, shellPath);
    assert.deepEqual(asked, []);
    for (const call of calls) {
      for (const verb of FORBIDDEN) assert.equal(call.includes(verb), false, `must not run: ${call.join(' ')}`);
    }
  }
  if (checked === 0) t.diagnostic('neither /bin/csh nor /bin/tcsh is installed');
});

// ---------------------------------------------------------------------------
// The input path is gone, not merely unused

test('no argument builder in the plugin can produce an input command', () => {
  const builders = Object.entries(native).filter(([name, value]) => typeof value === 'function' && name.endsWith('Args'));
  assert.ok(builders.length >= 4, 'the wire module still builds arguments');
  assert.equal(Object.keys(native).includes('paneRunArgs'), false, 'pane run has no builder at all');
  for (const [name, build] of builders) {
    const argv = build('w9:p2', 'tdi.worktree-from-linear', {}, []);
    for (const verb of ['run', 'send-input', 'send-keys', 'paste']) {
      assert.equal(argv.includes(verb), false, `${name} produced: ${argv.join(' ')}`);
    }
  }
});

test('the command-building code is deleted from the source, not left dormant', async () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const slot = await import('../lib/slot.js');
  for (const gone of ['buildViewerCommand', 'shellQuote', 'VIEWER_SCRIPT']) {
    assert.equal(gone in slot, false, `lib/slot.js still exports ${gone}`);
  }
  // Comments in these files discuss what was removed and why; the check is about code.
  const stripComments = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').split('\n')
    .filter((line) => !/^\s*(\/\/|\*)/.test(line)).join('\n');
  for (const file of [
    'lib/slot.js', 'lib/native.js', 'lib/run.js', 'lib/host.js', 'lib/hostwire.js',
    'bin/issue.js', 'bin/slot-host.js', 'bin/open.js', 'bin/picker.js',
  ]) {
    const code = stripComments(readFileSync(join(root, file), 'utf8'));
    for (const pattern of [/buildViewerCommand/, /shellQuote/, /'send-input'/, /'send-keys'/, /\['pane',\s*'run'/]) {
      assert.equal(pattern.test(code), false, `${file} still contains ${pattern}`);
    }
  }
});

// ---------------------------------------------------------------------------
// A herdr that never answers

test('a stalled herdr command is killed on the deadline and leaves nothing behind', async (t) => {
  const dir = tempDir(t, 'wfl-stall-');
  const pidFile = join(dir, 'pids');
  const bin = join(dir, 'herdr-stall');
  // Answers the inventory, then stalls forever on the very next command. Each invocation
  // records its own pid first, and `exec` keeps that pid: whatever is killed on the
  // deadline is exactly what was started.
  writeFileSync(bin, [
    '#!/bin/sh',
    `echo $$ >> ${JSON.stringify(pidFile)}`,
    'case "$1 $2" in',
    `  "tab list") printf '%s' ${JSON.stringify(JSON.stringify({ result: tabs }))} ;;`,
    `  "pane list") printf '%s' ${JSON.stringify(JSON.stringify({ result: panes }))} ;;`,
    '  *) exec sleep 120 ;;',
    'esac',
  ].join('\n'));
  chmodSync(bin, 0o755);

  const started = Date.now();
  const res = await deliverIssueDetails({
    worktreeStdout,
    identifier: 'BIT-1',
    config: CONFIG,
    configDir: '/cfg',
    herdrBin: bin,
    ask: async () => { throw new Error('no request can be made without a host'); },
  });
  const elapsed = Date.now() - started;

  assert.equal(res.ok, false);
  assert.match(res.error, /pane process-info timed out/);
  // 500ms of budget for the stalled command, not 120 seconds of sleep.
  assert.ok(elapsed < 10000, `delivery took ${elapsed}ms`);

  const pids = readFileSync(pidFile, 'utf8').trim().split('\n').filter(Boolean).map(Number);
  assert.ok(pids.length >= 3, `expected the stalling command to have run: ${pids.join(',')}`);
  // Nothing was left running: the stalled child was signalled, not abandoned.
  for (const pid of pids) {
    assert.throws(() => process.kill(pid, 0), /ESRCH/, `pid ${pid} is still alive`);
  }
});
