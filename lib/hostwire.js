// The wire between the picker (driver) and an issue host running in a pane.
//
// Nothing here ever reaches a terminal. The driver does not type, and the host does not
// execute anything a request names: a request carries one known operation and one
// validated issue identifier, and the host decides entirely on its own what to do with
// it. That is the whole point of this transport — a pane's shell is never the API.
//
// One short-lived connection, one line in, one line out, a deadline, then close. Both
// sides bound the frame they will read so neither can be made to buffer without limit.
import { createHash, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

// Bumped when the request or reply shape changes. Both sides check it, so an old host and
// a new driver refuse each other instead of half-understanding one another.
export const HOST_PROTOCOL = 'wfl-host-1';

// The only operation there is. A request can ask for exactly this, and the host still
// validates every field of it.
export const SHOW_OP = 'show';

// What the host publishes on its own pane so a driver can find it without asking a shell
// anything. Names are within herdr's [A-Za-z0-9_-]{1,32}; values are short on purpose.
// The checkout is published as a digest, not a path: the exact path is compared over the
// socket, where it is the host's own answer rather than something left behind in metadata.
export const HOST_SOURCE = 'tdi.worktree-from-linear';
export const HOST_PID_TOKEN = 'wfl-host-pid';
export const HOST_ID_TOKEN = 'wfl-host-id';
export const HOST_SOCKET_TOKEN = 'wfl-host-sock';
export const HOST_CHECKOUT_TOKEN = 'wfl-host-cwd';

// The host's script, resolved from this module's own location. It is the argv the driver
// requires to see in the pane's foreground, so it must not depend on anyone's cwd.
export const HOST_SCRIPT = fileURLToPath(new URL('../bin/slot-host.js', import.meta.url));

// A request is a single short line; a reply is too. Anything larger is a malformed or
// hostile frame, not a bigger message. The cap is in bytes, and it applies to a frame that
// arrived complete in one chunk exactly as it applies to one still being streamed —
// otherwise a single oversized line ending in a newline would walk straight past it.
export const MAX_FRAME_BYTES = 4096;

/**
 * Take the one frame a connection is allowed to carry.
 *
 * Both sides speak the same shape: exactly one newline-terminated JSON line per
 * connection. Anything after that newline is a second frame nobody asked for, and a frame
 * over the cap is refused whether or not it is terminated.
 */
export function takeFrame(buffer) {
  const newline = buffer.indexOf('\n');
  if (newline < 0) {
    return Buffer.byteLength(buffer, 'utf8') > MAX_FRAME_BYTES
      ? { state: 'oversized' }
      : { state: 'incomplete' };
  }
  const frame = buffer.slice(0, newline);
  if (Buffer.byteLength(frame, 'utf8') > MAX_FRAME_BYTES) return { state: 'oversized' };
  // The newline ends the frame and the connection's turn. A trailing byte means the peer
  // is not speaking this protocol, and guessing which frame it meant is not this code's
  // job.
  if (buffer.length > newline + 1) return { state: 'trailing' };
  return { state: 'frame', frame };
}

const REQUEST_TIMEOUT_MS = 5000;

// Identifiers are the only free-form thing that crosses the wire, and the host looks one
// up rather than running it. Keep the accepted shape to what Linear actually issues.
const IDENTIFIER = /^[A-Za-z][A-Za-z0-9_]{0,15}-[0-9]{1,9}$/;

export function validIdentifier(value) {
  return typeof value === 'string' && IDENTIFIER.test(value);
}

// Short, stable, and not a path: what goes into pane metadata should identify a checkout
// without publishing where it is.
export function checkoutDigest(path) {
  return createHash('sha256').update(String(path)).digest('hex').slice(0, 16);
}

export function newInstanceToken() {
  return randomBytes(16).toString('hex');
}

export function newNonce() {
  return randomBytes(16).toString('hex');
}

/**
 * The exact request the driver sends.
 *
 * Everything except `issue` is an assertion about who the driver believes it is talking
 * to. The host compares each one against itself and refuses on any disagreement, so a
 * request aimed at a host that has since been replaced cannot land on the new one.
 */
export function buildShowRequest({ issue, pane, host, pid, checkout, id = newNonce() }) {
  return { protocol: HOST_PROTOCOL, id, op: SHOW_OP, issue, pane, host, pid, checkout };
}

const STATUSES = new Set(['accepted', 'showing', 'busy', 'refused']);

/**
 * Read a reply against the request that produced it.
 *
 * `expected` is the same identity the request asserted. A reply that agrees with the
 * request but not with the host we inspected is not this host's answer.
 */
export function readHostReply(line, expected) {
  let reply;
  try {
    reply = JSON.parse(line);
  } catch {
    return { ok: false, error: 'issue host returned unparseable output' };
  }
  if (!reply || typeof reply !== 'object' || Array.isArray(reply)) {
    return { ok: false, error: 'issue host returned no reply object' };
  }
  if (reply.protocol !== HOST_PROTOCOL) {
    return { ok: false, error: `issue host speaks ${JSON.stringify(reply.protocol ?? null)}, not ${HOST_PROTOCOL}` };
  }
  if (reply.id !== expected.id) {
    return { ok: false, error: `issue host replied to ${JSON.stringify(reply.id ?? null)}` };
  }
  for (const [field, value] of [
    ['pane', expected.pane], ['host', expected.host], ['pid', expected.pid], ['checkout', expected.checkout],
  ]) {
    if (reply[field] !== value) {
      return { ok: false, error: `issue host answered for ${field} ${JSON.stringify(reply[field] ?? null)}` };
    }
  }
  if (!STATUSES.has(reply.status)) {
    return { ok: false, error: `issue host returned an unknown status ${JSON.stringify(reply.status ?? null)}` };
  }
  const detail = typeof reply.detail === 'string' ? reply.detail.slice(0, 200) : '';
  if (reply.status === 'accepted' || reply.status === 'showing') {
    if (reply.issue !== expected.issue) {
      return { ok: false, error: `issue host accepted ${JSON.stringify(reply.issue ?? null)}` };
    }
    return { ok: true, status: reply.status, issue: reply.issue, detail };
  }
  return { ok: false, error: `issue host is ${reply.status}${detail ? `: ${detail}` : ''}` };
}

/**
 * Ask a host to show an issue. Returns { ok: true, status } or { ok: false, error }.
 *
 * `connect` is injectable so tests can drive a real temporary socket without node:net's
 * default lookup; the default is node:net over `socketPath`.
 */
export async function askHost(socketPath, request, expected, { timeoutMs = REQUEST_TIMEOUT_MS, connect } = {}) {
  if (typeof socketPath !== 'string' || !socketPath) {
    return { ok: false, error: 'the issue host published no socket path' };
  }
  const open = connect || (await import('node:net')).connect;
  return new Promise((resolve) => {
    let socket;
    let settled = false;
    let buffer = '';
    const finish = (outcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { socket?.destroy(); } catch { /* already gone */ }
      resolve(outcome);
    };
    // A host that accepts the connection and then says nothing must not hang the picker.
    const timer = setTimeout(() => finish({ ok: false, error: `issue host did not answer within ${timeoutMs}ms` }), timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
    try {
      socket = open(socketPath);
    } catch (err) {
      return finish({ ok: false, error: `issue host socket could not be opened: ${err.message}` });
    }
    socket.setEncoding('utf8');
    socket.on('error', (err) => finish({ ok: false, error: `issue host socket error: ${err.message}` }));
    socket.on('close', () => finish({ ok: false, error: 'issue host closed the socket before replying' }));
    socket.on('end', () => finish({ ok: false, error: 'issue host closed the socket before replying' }));
    socket.on('data', (chunk) => {
      buffer += chunk;
      const taken = takeFrame(buffer);
      // Bounded either way: a host that streams without ever ending a line, and one that
      // sends a single enormous line, are both refused rather than buffered or parsed.
      if (taken.state === 'incomplete') return;
      if (taken.state === 'oversized') return finish({ ok: false, error: 'issue host reply was oversized' });
      if (taken.state === 'trailing') return finish({ ok: false, error: 'issue host sent more than one reply' });
      finish(readHostReply(taken.frame, expected));
    });
    const write = () => socket.write(`${JSON.stringify(request)}\n`);
    if (typeof socket.connecting === 'boolean' && socket.connecting) socket.once('connect', write);
    else write();
  });
}
