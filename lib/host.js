// The issue host: a process the user starts, in a pane they already own.
//
// It exists because a pane's shell cannot be asked whether it is at a prompt. A shell
// sitting in its own `read` builtin looks exactly like an idle one from the outside —
// same pid, same process group, same name — so "type the command for them" can never be
// made safe. This plugin therefore never types. Instead the user (or their layout's
// startup command) runs this host in the pane they want issues to appear in, and the
// picker asks it over a socket the host itself created and published.
//
// What that buys, concretely:
//
//   * There is no shell to get wrong. The host owns the tty for as long as it runs, and
//     `q` gives it back.
//   * A request names an issue, never a command. The host looks the issue up with the
//     same config and the same fetch as every other entrypoint; nothing in a request is
//     ever executed, and no key value is in a request, an argument list or the metadata.
//   * The socket lives in a directory this process created for itself, mode 0700, and is
//     unlinked on the way out. It is local same-user IPC — not a network endpoint, and
//     not a daemon: no TTY, no host.
import { chmodSync, lstatSync, mkdtempSync, realpathSync, rmdirSync, unlinkSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { loadConfig } from './config.js';
import { fetchIssue } from './linear.js';
import {
  HOST_CHECKOUT_TOKEN, HOST_ID_TOKEN, HOST_PID_TOKEN, HOST_PROTOCOL, HOST_SOCKET_TOKEN,
  HOST_SOURCE, SHOW_OP, checkoutDigest, newInstanceToken, takeFrame, validIdentifier,
} from './hostwire.js';
import { reportMetadataArgs } from './native.js';

// A connection that neither completes a frame nor closes is dropped; a fetch that never
// answers is aborted; publishing metadata to an unreachable herdr does not hold the pane.
// Every one of these is finite on purpose.
const CONNECTION_IDLE_MS = 5000;
const FETCH_TIMEOUT_MS = 20000;
const METADATA_TIMEOUT_MS = 5000;

// ---------------------------------------------------------------------------
// Context: who this host is

// A pane id herdr would recognize, and nothing that could be a flag or a path.
const PANE_ID = /^[A-Za-z0-9][A-Za-z0-9:_.-]{0,63}$/;

function flagValue(argv, name) {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null;
}

/**
 * Where this host is running, from its own argv and environment.
 *
 * Every field is explicit or refused. In particular there is no "the focused pane"
 * fallback: the focused pane belongs to whoever last clicked, which is not necessarily
 * this one, and publishing identity onto someone else's pane is exactly the failure this
 * whole design is avoiding. `HERDR_PANE_ID` is accepted because herdr sets it *in* the
 * pane's own environment, so inside that pane it is this pane.
 */
export function resolveHostContext(argv = [], env = {}, cwd = process.cwd()) {
  const paneId = flagValue(argv, '--pane') || env.HERDR_PANE_ID || '';
  const configDir = flagValue(argv, '--config-dir') || env.HERDR_PLUGIN_CONFIG_DIR || '';
  const checkout = flagValue(argv, '--cwd') || cwd || '';
  if (!PANE_ID.test(paneId)) {
    return { ok: false, error: 'issue host needs --pane (or HERDR_PANE_ID) naming the pane it runs in' };
  }
  if (!configDir || !isAbsolute(configDir)) {
    return { ok: false, error: 'issue host needs an absolute --config-dir (or HERDR_PLUGIN_CONFIG_DIR)' };
  }
  if (!checkout || !isAbsolute(checkout)) {
    return { ok: false, error: 'issue host needs an absolute --cwd' };
  }
  // The picker compares this against the checkout path herdr's own worktree reply named,
  // so both sides have to mean the same directory rather than two spellings of it.
  let canonical;
  try {
    canonical = realpathSync(checkout);
  } catch (err) {
    return { ok: false, error: `issue host cannot resolve ${checkout}: ${err.message}` };
  }
  return { ok: true, paneId, configDir, checkout: canonical };
}

// ---------------------------------------------------------------------------
// The socket, and the directory it lives in

// XDG_RUNTIME_DIR when it is really there and really ours — it is the per-user directory
// meant for exactly this — and the temporary directory otherwise. Either way the socket
// goes in a directory this process creates and verifies below, never straight into a
// shared one.
function runtimeBase(env = process.env) {
  const runtime = env.XDG_RUNTIME_DIR;
  if (runtime && isAbsolute(runtime)) {
    try {
      const stat = lstatSync(runtime);
      if (stat.isDirectory() && stat.uid === process.getuid()) return runtime;
    } catch { /* not usable; fall through */ }
  }
  return tmpdir();
}

/**
 * A private directory, verified after the fact, holding one randomly named socket path.
 *
 * mkdtemp gives an exclusive directory; the checks afterwards are what make it a promise
 * rather than an assumption. The socket file's own mode is set too, but the directory is
 * the protection that actually holds everywhere: several kernels ignore the permissions
 * on a unix socket when deciding who may connect.
 */
export function createSocketHome({
  base = runtimeBase(),
  random = () => randomBytes(6).toString('hex'),
  mkdtemp = mkdtempSync,
} = {}) {
  let dir;
  try {
    dir = realpathSync(mkdtemp(join(base, 'wfl-host-')));
    chmodSync(dir, 0o700);
  } catch (err) {
    return { ok: false, error: `issue host could not create its socket directory: ${err.message}` };
  }
  const stat = lstatSync(dir);
  if (!stat.isDirectory() || stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0) {
    try { rmdirSync(dir); } catch { /* leave what we cannot verify */ }
    return { ok: false, error: `issue host refuses ${dir}: it is not an owner-only directory` };
  }
  const socketPath = join(dir, `${random()}.sock`);
  // Nothing should be here — the directory was just created — so anything that is (a
  // file, a symlink, a leftover socket) means this path is not ours to bind.
  let existing = null;
  try {
    existing = lstatSync(socketPath);
  } catch { /* the expected case: nothing there */ }
  if (existing) {
    try { rmdirSync(dir); } catch { /* not empty; leave it */ }
    return { ok: false, error: `issue host refuses ${socketPath}: something is already there` };
  }
  return { ok: true, dir, socketPath };
}

// Verify what `listen` actually created, then narrow it.
function secureSocket(socketPath) {
  let stat;
  try {
    stat = lstatSync(socketPath);
  } catch (err) {
    return { ok: false, error: `issue host socket did not appear: ${err.message}` };
  }
  if (!stat.isSocket() || stat.uid !== process.getuid()) {
    return { ok: false, error: `issue host refuses ${socketPath}: it is not the socket this process owns` };
  }
  try {
    chmodSync(socketPath, 0o600);
  } catch (err) {
    return { ok: false, error: `issue host could not restrict its socket: ${err.message}` };
  }
  return { ok: true };
}

// Remove exactly what this host made, and only if it still is what this host made. No
// recursive delete, no globbing, no "clean up old sockets".
function removeSocketHome(dir, socketPath) {
  try {
    const stat = lstatSync(socketPath);
    if (stat.isSocket() && stat.uid === process.getuid()) unlinkSync(socketPath);
  } catch { /* already gone */ }
  try {
    rmdirSync(dir);
  } catch { /* not empty or already gone: leave it rather than delete more */ }
}

// ---------------------------------------------------------------------------
// Pane metadata

export function hostMetadataArgs(paneId, { pid, instance, socketPath, checkout }) {
  return reportMetadataArgs(paneId, HOST_SOURCE, {
    [HOST_PID_TOKEN]: String(pid),
    [HOST_ID_TOKEN]: instance,
    [HOST_SOCKET_TOKEN]: socketPath,
    [HOST_CHECKOUT_TOKEN]: checkoutDigest(checkout),
  });
}

export function hostMetadataClearArgs(paneId) {
  return reportMetadataArgs(paneId, HOST_SOURCE, {}, [
    HOST_PID_TOKEN, HOST_ID_TOKEN, HOST_SOCKET_TOKEN, HOST_CHECKOUT_TOKEN,
  ]);
}

// Both directions are bounded. Publishing is how the host becomes findable, so a failure
// there is worth reporting; clearing on the way out is best effort, because by then the
// pane is going back to its shell either way.
function reportMetadata(args, { herdrBin, exec }) {
  try {
    const res = exec(herdrBin, args, { timeout: METADATA_TIMEOUT_MS });
    if (!res || res.status !== 0) {
      const detail = String(res?.stderr || '').trim().slice(0, 200) || `status ${res?.status}`;
      return { ok: false, error: `herdr pane report-metadata ${res?.timedOut ? 'timed out' : 'failed'}: ${detail}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: `herdr pane report-metadata could not run: ${err.message}` };
  }
}

// ---------------------------------------------------------------------------
// The request state machine

/**
 * Decide what a parsed request means, given what this host is already doing.
 *
 * Split out from the socket so every rejection is testable without one, and written so
 * that taking an issue is a single synchronous state change: the caller sets `busy`
 * before it starts any asynchronous work, and a second request that arrives while that
 * work is in flight sees the state, not a gap.
 */
export function judgeRequest(request, self, state) {
  const refuse = (detail) => ({ status: 'refused', detail });
  if (!request || typeof request !== 'object' || Array.isArray(request)) return refuse('not a request object');
  if (request.protocol !== HOST_PROTOCOL) return refuse('unsupported protocol');
  if (request.op !== SHOW_OP) return refuse('unknown operation');
  if (typeof request.id !== 'string' || !request.id) return refuse('no request id');
  // Every one of these is the caller asserting who it thinks it is talking to. A request
  // meant for the host that used to own this pane must not land on the one that does now.
  if (request.pane !== self.paneId) return refuse('request names another pane');
  if (request.host !== self.instance) return refuse('request names another host instance');
  if (request.pid !== self.pid) return refuse('request names another process');
  if (request.checkout !== self.checkout) return refuse('request names another checkout');
  if (!validIdentifier(request.issue)) return refuse('request carries no valid issue identifier');
  // Same issue: whatever we are doing with it, the answer is "it is here" — the picker
  // focuses the pane and nothing restarts. This is the repeat-delivery path.
  if (state.issue === request.issue) return { status: 'showing', detail: state.phase };
  // A different issue while one is in flight or on screen. Replacing it would throw away
  // what the user is reading and start a second fetch; refusing says so instead.
  if (state.issue !== null) return { status: 'busy', detail: `showing ${state.issue}` };
  return { status: 'accepted', detail: 'starting' };
}

/**
 * Run an issue host until it is told to stop.
 *
 * Returns { ok: true, host } once the socket exists, is verified and is listening.
 * `host.close()` removes exactly what was created. The caller owns the terminal: this
 * module never writes to it, it calls back with what to show.
 */
export async function startHost({
  paneId,
  configDir,
  checkout,
  onShow,
  onFail,
  pid = process.pid,
  instance = newInstanceToken(),
  home = createSocketHome(),
  fetchFn = fetch,
  fetchTimeoutMs = FETCH_TIMEOUT_MS,
  connectionIdleMs = CONNECTION_IDLE_MS,
  load = loadConfig,
  fetchOne = fetchIssue,
}) {
  if (!home.ok) return home;
  const self = { paneId, instance, pid, checkout, protocol: HOST_PROTOCOL };
  const state = { issue: null, phase: 'idle' };

  const reply = (id, verdict) => ({
    protocol: HOST_PROTOCOL,
    id,
    ok: verdict.status === 'accepted' || verdict.status === 'showing',
    status: verdict.status,
    pane: paneId,
    host: instance,
    pid,
    checkout,
    issue: state.issue,
    detail: verdict.detail,
  });

  // One issue, fetched with this plugin's own config and this host's own checkout. The
  // request contributed the identifier and nothing else.
  const show = async (identifier) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), fetchTimeoutMs);
    try {
      const config = load(configDir, checkout, process.env, identifier);
      const bounded = (url, options) => fetchFn(url, { ...options, signal: controller.signal });
      const issue = await fetchOne(config, identifier, bounded);
      state.phase = 'showing';
      onShow(issue);
    } catch (err) {
      state.phase = 'failed';
      const reason = controller.signal.aborted
        ? `worktree-from-linear: ${identifier} took longer than ${fetchTimeoutMs}ms to load`
        : err.message;
      onFail(identifier, reason);
    } finally {
      clearTimeout(timer);
    }
  };

  const handleLine = (line) => {
    let request = null;
    try {
      request = JSON.parse(line);
    } catch {
      return { frame: reply(null, { status: 'refused', detail: 'unparseable request' }), issue: null };
    }
    const verdict = judgeRequest(request, self, state);
    if (verdict.status === 'accepted') {
      // Before the reply is even serialized, and before anything awaits: a second request
      // arriving in the same tick sees a busy host, not an idle one.
      state.issue = request.issue;
      state.phase = 'fetching';
    }
    const id = typeof request?.id === 'string' ? request.id : null;
    return { frame: reply(id, verdict), issue: verdict.status === 'accepted' ? request.issue : null };
  };

  const server = createServer((conn) => {
    let buffer = '';
    let answered = false;
    conn.setEncoding('utf8');
    conn.setTimeout(connectionIdleMs, () => conn.destroy());
    conn.on('error', () => { /* a client that vanishes is not this host's problem */ });
    conn.on('data', (chunk) => {
      if (answered) return;
      buffer += chunk;
      const taken = takeFrame(buffer);
      // A frame that never ends, one that arrives complete but enormous, and a connection
      // carrying more than the single frame it is allowed are all refused without being
      // parsed. The cap is on bytes and does not care whether a newline came with them.
      if (taken.state === 'incomplete') return;
      answered = true;
      if (taken.state !== 'frame') {
        const detail = taken.state === 'oversized' ? 'oversized request' : 'more than one request';
        return conn.end(`${JSON.stringify(reply(null, { status: 'refused', detail }))}\n`);
      }
      const { frame, issue } = handleLine(taken.frame);
      conn.end(`${JSON.stringify(frame)}\n`);
      // Only after the answer is on its way: the picker learns "accepted" without waiting
      // for a network fetch, and this host is already busy as far as anyone else is
      // concerned.
      if (issue) show(issue);
    });
  });

  const listening = await new Promise((resolve) => {
    server.once('error', (err) => resolve({ ok: false, error: `issue host could not listen: ${err.message}` }));
    server.listen(home.socketPath, () => resolve({ ok: true }));
  });
  if (!listening.ok) {
    removeSocketHome(home.dir, home.socketPath);
    return listening;
  }
  const secured = secureSocket(home.socketPath);
  if (!secured.ok) {
    server.close();
    removeSocketHome(home.dir, home.socketPath);
    return secured;
  }
  // Nothing here should keep node alive on its own; the terminal does that.
  server.unref();

  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    try { server.close(); } catch { /* already closed */ }
    removeSocketHome(home.dir, home.socketPath);
  };

  return {
    ok: true,
    host: {
      paneId, instance, pid, checkout,
      socketPath: home.socketPath,
      dir: home.dir,
      state: () => ({ ...state }),
      close,
    },
  };
}

// Publish and clear, exported so the entrypoint can bound both without knowing the wire.
export function publishHost(host, { herdrBin, exec = spawnSyncExec }) {
  return reportMetadata(hostMetadataArgs(host.paneId, {
    pid: host.pid, instance: host.instance, socketPath: host.socketPath, checkout: host.checkout,
  }), { herdrBin, exec });
}

export function unpublishHost(host, { herdrBin, exec = spawnSyncExec }) {
  return reportMetadata(hostMetadataClearArgs(host.paneId), { herdrBin, exec });
}

// The default executor for the two metadata calls. Deliberately not lib/exec.js's runCmd:
// this one discards output entirely, because a stray line from herdr must not land in the
// middle of a rendered issue.
export function spawnSyncExec(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { encoding: 'utf8', stdio: 'ignore', killSignal: 'SIGKILL', ...opts });
  return {
    status: res.status ?? 1,
    stdout: '',
    stderr: res.error ? String(res.error.message) : '',
    timedOut: res.error?.code === 'ETIMEDOUT',
  };
}
