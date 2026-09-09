// The whole delivery path, with a real host process on a real socket.
//
// What is real here: a node process running bin/slot-host.js in a real pty, the unix
// socket it created for itself, the metadata it published, its own pid and its own OS
// argv (read back with ps), the driver in lib/slot.js, and the socket client in
// lib/hostwire.js. What is faked: herdr itself (a stub binary that logs its calls and
// answers inventory from fixtures) and Linear (a fetch replaced inside the host process).
//
// So this proves the plugin's own end-to-end behavior. It is not a native Herdr test:
// no herdr server was run, and nothing here touches a real pane.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deliverIssueDetails } from '../lib/slot.js';
import { HOST_SCRIPT } from '../lib/hostwire.js';
import { PTY_WRAPPER, ptyAvailable, until } from './pty.mjs';

const WS = 'w9';
const TAB = 'w9:t1';
const PANE = 'w9:p2';



function tempDir(t, prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// A stand-in for the herdr CLI that only records what it was asked to do. The host reaches
// herdr exclusively through HERDR_BIN_PATH, so an empty log proves no native call happened.
function stubHerdr(t, { body = 'exit 0' } = {}) {
  const dir = tempDir(t, 'wfl-e2e-stub-');
  const bin = join(dir, 'herdr-stub');
  const log = join(dir, 'calls.log');
  writeFileSync(bin, `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(log)}\n${body}\n`);
  chmodSync(bin, 0o755);
  return { bin, log, calls: () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) : []) };
}

// A Linear answer installed inside the host process. NODE_OPTIONS rather than a command
// line flag on purpose: the driver identifies a host by its exact OS argv, and a node
// option on the command line would (correctly) make it unrecognizable.
function fakeLinear(issues) {
  return `globalThis.fetch = async () => ({
    ok: true, status: 200,
    text: async () => JSON.stringify({ data: { issues: { nodes: ${JSON.stringify(issues)} } } }),
  });`;
}

const failingLinear = 'globalThis.fetch = async () => { throw new Error("network is down"); };';

// python's pty.spawn relays this process's stdin into the pty and stops only when BOTH
// the pty and that stdin reach EOF, so a test that never intends to type closes stdin
// immediately; one that does, closes it with the keystroke.
function hostProcess(t, { configDir, checkout, herdrBin, api, pane = PANE, keepStdin = false, path = '/usr/bin:/bin' }) {
  const child = spawn('python3', [
    '-c', PTY_WRAPPER,
    process.execPath, HOST_SCRIPT, '--pane', pane, '--config-dir', configDir, '--cwd', checkout,
  ], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      PATH: path,
      HOME: process.env.HOME,
      TMPDIR: process.env.TMPDIR,
      HERDR_BIN_PATH: herdrBin,
      KEY_IC: 'synthetic-ic',
      NODE_OPTIONS: `--import data:text/javascript,${encodeURIComponent(api)}`,
    },
  });
  let out = '';
  let err = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (c) => { out += c; });
  child.stderr.on('data', (c) => { err += c; });
  const exit = new Promise((res) => child.on('exit', (code, signal) => res({ code, signal })));
  if (!keepStdin) child.stdin.end();
  // A failed assertion must not leave a host holding a pty and a socket: the pid it
  // published is killed too, not only the pty wrapper.
  const owned = { pid: null };
  t.after(() => {
    for (const pid of [child.pid, owned.pid]) {
      try { if (pid) process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
    }
  });
  return { child, out: () => out, err: () => err, exit, owned, quit: () => child.stdin.end('q') };
}

// The tokens the host published, read back out of the stub's log exactly as herdr would
// have received them.
function publishedTokens(stub) {
  const line = stub.calls().find((c) => c.includes('--token wfl-host-pid='));
  if (!line) return null;
  const tokens = {};
  for (const match of line.matchAll(/--token ([A-Za-z0-9_-]+)=(\S+)/g)) tokens[match[1]] = match[2];
  return { line, tokens };
}

// The host's real command line, from the OS, so the driver's identity check is matched
// against what was actually started rather than against a fixture of it.
function osArgv(pid) {
  const res = spawnSync('ps', ['-ww', '-o', 'command=', '-p', String(pid)], { encoding: 'utf8' });
  assert.equal(res.status, 0, `ps could not see ${pid}`);
  return res.stdout.trim().split(/\s+/);
}

// herdr's inventory replies for a workspace whose Crew tab holds one Issue slot, plus the
// process-info that describes the live host process.
function herdrFixture(pid, argv, tokens) {
  const reply = (result) => ({ status: 0, stdout: JSON.stringify({ result }), stderr: '' });
  const calls = [];
  const exec = (cmd, args = []) => {
    calls.push([cmd, ...args]);
    const key = `${args[0]} ${args[1]}`;
    if (key === 'tab list') return reply({ type: 'tab_list', tabs: [{ tab_id: TAB, workspace_id: WS, label: 'Crew' }] });
    if (key === 'pane list') {
      return reply({ type: 'pane_list', panes: [{ pane_id: PANE, tab_id: TAB, workspace_id: WS, label: 'Issue' }] });
    }
    if (key === 'pane process-info') {
      return reply({ type: 'pane_process_info', process_info: {
        pane_id: PANE,
        shell_pid: 1,
        foreground_process_group_id: pid,
        foreground_processes: [{ pid, name: 'node', argv0: 'node', argv }],
      } });
    }
    if (key === 'pane get') {
      return reply({ type: 'pane_info', pane: { pane_id: PANE, tab_id: TAB, workspace_id: WS, label: 'Issue', tokens } });
    }
    return { status: 1, stdout: '', stderr: `unexpected ${key}` };
  };
  return { exec, calls };
}

const worktreeStdout = (checkout) => JSON.stringify({ result: {
  type: 'worktree_created',
  workspace: { workspace_id: WS, active_tab_id: TAB },
  tab: { tab_id: TAB, workspace_id: WS, label: 'Crew' },
  worktree: { path: checkout },
} });

test('an issue reaches a real host over its own socket, and nothing is ever typed', async (t) => {
  if (!ptyAvailable()) return t.skip('python3 pty module unavailable');
  const stub = stubHerdr(t);
  const configDir = tempDir(t, 'wfl-e2e-cfg-');
  writeFileSync(join(configDir, 'config.json'), JSON.stringify({ linearApiKeyEnvByTeam: { IC: 'KEY_IC' } }));
  const checkout = tempDir(t, 'wfl-e2e-wt-');

  const host = hostProcess(t, {
    configDir, checkout, herdrBin: stub.bin,
    api: fakeLinear([{ identifier: 'IC-72', title: 'Delivered without typing', description: 'body' }]),
    keepStdin: true,
  });

  // It says it is ready before anything is delivered, and it publishes itself exactly once.
  assert.ok(await until(() => /Ready in/.test(host.out())), host.out() + host.err());
  const published = await until(() => publishedTokens(stub));
  assert.ok(published, stub.calls().join(' | '));
  const { tokens } = published;
  const pid = Number(tokens['wfl-host-pid']);
  host.owned.pid = pid;

  // The published socket is real, owner-only, and inside an owner-only directory.
  assert.equal(lstatSync(tokens['wfl-host-sock']).isSocket(), true);
  assert.equal(lstatSync(tokens['wfl-host-sock']).mode & 0o077, 0);
  const socketDir = tokens['wfl-host-sock'].slice(0, tokens['wfl-host-sock'].lastIndexOf('/'));
  assert.equal(lstatSync(socketDir).mode & 0o077, 0);
  // No key value is anywhere in what it published.
  assert.equal(published.line.includes('synthetic-ic'), false);

  // The pid it published is a live process, and its OS command line is the host script.
  const argv = osArgv(pid);
  assert.equal(argv[0], process.execPath);
  assert.equal(argv[1], HOST_SCRIPT);

  const deliver = (identifier, over = {}) => {
    const { exec, calls } = herdrFixture(pid, argv, tokens);
    const focused = [];
    return deliverIssueDetails({
      worktreeStdout: worktreeStdout(checkout),
      identifier,
      config: { issueTabLabel: 'Crew', issuePaneLabel: 'Issue', issueSlotSettleMs: 2000 },
      configDir,
      exec,
      herdrBin: stub.bin,
      focus: async (paneId) => { focused.push(paneId); return { ok: true, pane: { pane_id: paneId } }; },
      ...over,
    }).then((res) => ({ res, calls, focused }));
  };

  // A real request over the real socket: the host takes it and renders in its own pane.
  const first = await deliver('IC-72');
  assert.equal(first.res.ok, true, first.res.error);
  assert.equal(first.res.action, 'accepted');
  assert.ok(await until(() => /Delivered without typing/.test(host.out())), host.out());
  assert.deepEqual(first.focused, []);

  // The same issue again is the repeat path: the host confirms it already has it, and the
  // pane is focused rather than anything being restarted.
  const repeat = await deliver('IC-72');
  assert.equal(repeat.res.ok, true, repeat.res.error);
  assert.equal(repeat.res.action, 'focused');
  assert.deepEqual(repeat.focused, [PANE]);

  // A different issue is refused: what the user is reading is not replaced.
  const other = await deliver('IC-99');
  assert.equal(other.res.ok, false);
  assert.match(other.res.error, /busy: showing IC-72/);
  assert.deepEqual(other.focused, []);

  // Across all three deliveries, not one call could put a character into a terminal.
  const everyCall = [...first.calls, ...repeat.calls, ...other.calls, ...stub.calls().map((c) => c.split(' '))];
  for (const call of everyCall) {
    for (const verb of ['run', 'send-input', 'send-keys', 'paste', 'split', 'swap', 'close']) {
      assert.equal(call.includes(verb), false, `must not run: ${call.join(' ')}`);
    }
  }

  // q gives the pane back: the process exits 0, clears its tokens, and removes exactly the
  // socket and the directory it made.
  host.quit();
  const exit = await host.exit;
  assert.deepEqual(exit, { code: 0, signal: null }, host.out() + host.err());
  assert.ok(stub.calls().some((c) => c.includes('--clear-token wfl-host-pid')), stub.calls().join(' | '));
  assert.equal(existsSync(tokens['wfl-host-sock']), false, 'the socket is gone');
  assert.equal(existsSync(socketDir), false, 'and so is the directory it lived in');
});

test('a failed fetch returns the pane to its shell and cleans up after itself', async (t) => {
  if (!ptyAvailable()) return t.skip('python3 pty module unavailable');
  const stub = stubHerdr(t);
  const configDir = tempDir(t, 'wfl-e2e-cfg-');
  writeFileSync(join(configDir, 'config.json'), JSON.stringify({ linearApiKeyEnvByTeam: { IC: 'KEY_IC' } }));
  const checkout = tempDir(t, 'wfl-e2e-wt-');
  const host = hostProcess(t, { configDir, checkout, herdrBin: stub.bin, api: failingLinear });

  assert.ok(await until(() => /Ready in/.test(host.out())), host.out() + host.err());
  const { tokens } = await until(() => publishedTokens(stub));
  const pid = Number(tokens['wfl-host-pid']);
  host.owned.pid = pid;
  const { exec } = herdrFixture(pid, osArgv(pid), tokens);

  const res = await deliverIssueDetails({
    worktreeStdout: worktreeStdout(checkout),
    identifier: 'IC-72',
    config: { issueTabLabel: 'Crew', issuePaneLabel: 'Issue', issueSlotSettleMs: 2000 },
    configDir,
    exec,
    herdrBin: stub.bin,
  });
  // Delivery reports what actually happened: the host accepted the issue. It does not
  // claim the fetch succeeded, because at that point nobody knows whether it will.
  assert.equal(res.ok, true, res.error);
  assert.equal(res.action, 'accepted');

  // The host is the one that finds out, and it hands the pane back rather than parking on
  // an error the user then has to dismiss.
  const exit = await host.exit;
  assert.equal(exit.code, 1, host.out() + host.err());
  assert.match(host.out(), /Could not load IC-72: .*network is down/);
  assert.equal(host.out().includes('synthetic-ic'), false);
  assert.ok(stub.calls().some((c) => c.includes('--clear-token wfl-host-pid')));
  assert.equal(existsSync(tokens['wfl-host-sock']), false);
});

test('a host that cannot publish itself says so instead of sitting there undiscoverable', async (t) => {
  if (!ptyAvailable()) return t.skip('python3 pty module unavailable');
  // A herdr that accepts the report-metadata call and never returns. The publish is
  // bounded, so the host gives up and returns the pane rather than hanging on it.
  const stub = stubHerdr(t, { body: 'exec sleep 120' });
  const configDir = tempDir(t, 'wfl-e2e-cfg-');
  writeFileSync(join(configDir, 'config.json'), JSON.stringify({ linearApiKey: 'k' }));
  const checkout = tempDir(t, 'wfl-e2e-wt-');
  const started = Date.now();
  const host = hostProcess(t, { configDir, checkout, herdrBin: stub.bin, api: fakeLinear([]) });
  const exit = await host.exit;
  assert.equal(exit.code, 1, host.out() + host.err());
  assert.match(host.err() + host.out(), /could not publish itself/);
  assert.ok(Date.now() - started < 30000, 'it gave up on a bound rather than waiting for the CLI');
  // The socket it had already made is removed on the way out.
  const dirs = stub.calls();
  assert.ok(dirs.length >= 1, 'it did try to publish');
});

test('a renderer that hangs is given up on, and never outlives the host', async (t) => {
  if (!ptyAvailable()) return t.skip('python3 pty module unavailable');
  const stub = stubHerdr(t);
  const configDir = tempDir(t, 'wfl-e2e-cfg-');
  writeFileSync(join(configDir, 'config.json'), JSON.stringify({ linearApiKeyEnvByTeam: { IC: 'KEY_IC' } }));
  const checkout = tempDir(t, 'wfl-e2e-wt-');

  // A `glow` that takes the terminal and never gives it back. While it runs, this process
  // has stdin paused — so without a bound on the render, `q` would never be read and the
  // pane could not be closed.
  const binDir = tempDir(t, 'wfl-e2e-bin-');
  const glowPid = join(binDir, 'glow.pid');
  writeFileSync(join(binDir, 'glow'), `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(glowPid)}, String(process.pid));\nprocess.on('SIGTERM', () => {});\nprocess.on('SIGHUP', () => {});\nsetInterval(() => {}, 1000);\n`);
  chmodSync(join(binDir, 'glow'), 0o755);

  const host = hostProcess(t, {
    configDir, checkout, herdrBin: stub.bin, keepStdin: true, path: `${binDir}:/usr/bin:/bin`,
    api: fakeLinear([{ identifier: 'IC-72', title: 'Rendered by a hung renderer', description: 'body' }]),
  });
  assert.ok(await until(() => /Ready in/.test(host.out())), host.out() + host.err());
  const { tokens } = await until(() => publishedTokens(stub));
  const pid = Number(tokens['wfl-host-pid']);
  host.owned.pid = pid;
  const { exec } = herdrFixture(pid, osArgv(pid), tokens);

  const res = await deliverIssueDetails({
    worktreeStdout: worktreeStdout(checkout),
    identifier: 'IC-72',
    config: { issueTabLabel: 'Crew', issuePaneLabel: 'Issue', issueSlotSettleMs: 2000 },
    configDir,
    exec,
    herdrBin: stub.bin,
  });
  assert.equal(res.ok, true, res.error);

  // The hung renderer really did start, and really is still running.
  assert.ok(await until(() => existsSync(glowPid)), 'the fake glow was started');
  const renderer = Number(readFileSync(glowPid, 'utf8').trim());
  t.after(() => { try { process.kill(renderer, 'SIGKILL'); } catch { /* already gone */ } });
  assert.doesNotThrow(() => process.kill(renderer, 0), 'precondition: it is hanging, not finished');

  // The render deadline passes: the plain panel is printed instead and the terminal comes
  // back, so the issue is on screen and the pane is usable again.
  assert.ok(await until(() => /Rendered by a hung renderer/.test(host.out()), 20000), host.out());

  // Quit during the kill grace while this renderer ignores SIGTERM. It must
  // remain owned even though fallback presentation has already completed.
  host.quit();
  const exit = await host.exit;
  assert.deepEqual(exit, { code: 0, signal: null }, host.out() + host.err());
  assert.equal(existsSync(tokens['wfl-host-sock']), false, 'it still cleaned up its socket');
  // The renderer it owned is gone with it, rather than left holding a pty forever.
  assert.ok(await until(() => { try { process.kill(renderer, 0); return false; } catch { return true; } }, 5000),
    `renderer ${renderer} outlived the host`);
});
