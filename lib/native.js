// The herdr wire: CLI argument builders, reply readers, and the one socket call the
// issue slot needs that the CLI cannot make.
//
// Kept apart from the delivery policy in lib/slot.js so the wire shape has one home.
// Every form below was read out of herdr 0.9.0's own sources (`src/cli/pane.rs`
// argument parsers and `print_pane_help`, `src/app/api/panes.rs` handlers) and its
// protocol-22 API schema — not inferred from a sibling command. herdr prints JSON by
// default, there is no --json to add, and it answers a server error as JSON on stderr
// with status 1 and a usage error with status 2. Commands that only act (run,
// report-metadata) may print nothing at all, so those are judged by exit status alone.

// `pane list`/`tab list` take the workspace explicitly. Never omit it: without a target
// herdr answers about whichever pane some client happens to have focused, which may be
// the user's own window rather than the worktree we just opened.
export function tabListArgs(workspaceId) {
  return ['tab', 'list', '--workspace', workspaceId];
}

export function paneListArgs(workspaceId) {
  return ['pane', 'list', '--workspace', workspaceId];
}

// Pane-scoped commands are NOT uniform, so each one follows its own parser:
//
//   `pane process-info [--pane ID|--current]` takes a FLAG. A positional id is rejected
//     as "unknown option" with status 2, and — worse — omitting the target entirely makes
//     the server fall back to the focused pane (`resolve_optional_pane(None)`), which can
//     belong to another client. Always pass --pane.
//   `pane get <pane_id>` takes exactly one positional argument.
//   `pane report-metadata <pane_id> --source ID ...` is positional plus flags.
//
// `pane run` and `pane send-input` are deliberately absent. Nothing in this plugin writes
// to a pane's terminal: the issue host is started by the user and asked over its own
// socket, so there is no code path here that could type into anybody's shell.
export function paneProcessInfoArgs(paneId) {
  return ['pane', 'process-info', '--pane', paneId];
}

export function paneGetArgs(paneId) {
  return ['pane', 'get', paneId];
}

// tokens: { name: value } to set, clear: [name] to remove. Names are limited by the
// server to [A-Za-z0-9_-]{1,32}.
export function reportMetadataArgs(paneId, source, tokens = {}, clear = []) {
  const args = ['pane', 'report-metadata', paneId, '--source', source];
  for (const [name, value] of Object.entries(tokens)) args.push('--token', `${name}=${value}`);
  for (const name of clear) args.push('--clear-token', name);
  return args;
}

export function notificationArgs(title, body) {
  return ['notification', 'show', title, '--body', body];
}

// A short label for diagnostics: "pane list", "tab list", "pane process-info".
function label(args) {
  return args.slice(0, 2).join(' ');
}

// Callers own the deadline, because only they know how much of it is left. A budget that
// is given is always applied, and never rounds down to "no timeout": a caller with 0.4ms
// left gets 1ms, not forever.
function execOpts(timeoutMs) {
  if (timeoutMs === undefined) return {};
  return { timeout: Math.max(1, Math.floor(timeoutMs)) };
}

// Run a herdr command whose reply we need to read, and hand back its `result` object.
// Both failure modes the caller must report differently are distinguished here: the
// command failed, or it succeeded and said something we cannot parse.
export function callJson(exec, herdrBin, args, { timeoutMs } = {}) {
  let res;
  try {
    res = exec(herdrBin, args, execOpts(timeoutMs));
  } catch (err) {
    return { ok: false, error: `herdr ${label(args)} could not run: ${err.message}` };
  }
  if (!res || res.status !== 0) {
    // herdr's own stderr, trimmed. It carries ids and reasons, never plugin config.
    const detail = String(res?.stderr || '').trim().slice(0, 200) || `status ${res?.status}`;
    const what = res?.timedOut ? 'timed out' : 'failed';
    return { ok: false, error: `herdr ${label(args)} ${what}: ${detail}` };
  }
  let parsed;
  try {
    parsed = JSON.parse(res.stdout);
  } catch {
    return { ok: false, error: `herdr ${label(args)} returned unparseable output` };
  }
  const result = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed.result : null;
  // Every reply's `result` is a keyed payload ({ type, ... }); a bare array or scalar is
  // some other program's output, not a herdr reply.
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    return { ok: false, error: `herdr ${label(args)} returned no result` };
  }
  return { ok: true, result };
}

// Run a herdr command that only acts. `pane report-metadata` and `notification show` can
// legitimately print nothing, so status is the only signal available.
export function callVoid(exec, herdrBin, args, { timeoutMs } = {}) {
  let res;
  try {
    res = exec(herdrBin, args, execOpts(timeoutMs));
  } catch (err) {
    return { ok: false, error: `herdr ${label(args)} could not run: ${err.message}` };
  }
  if (!res || res.status !== 0) {
    const detail = String(res?.stderr || '').trim().slice(0, 200) || `status ${res?.status}`;
    const what = res?.timedOut ? 'timed out' : 'failed';
    return { ok: false, error: `herdr ${label(args)} ${what}: ${detail}` };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// One socket call, because the CLI cannot make it
//
// `herdr pane focus` is DIRECTIONAL: its parser is parse_pane_neighbor_args and its
// usage line is `--direction left|right|up|down [--pane ID|--current]`. There is no CLI
// that focuses one named pane, and `agent focus` is not a substitute — an owned shell has
// no agent, so it answers agent_not_found. The socket method `pane.focus` does take
// { pane_id } (src/app/api/panes.rs handle_pane_focus) and answers with the pane it
// focused, so this one call goes over the socket rather than inventing a CLI flag.
//
// Deliberately minimal: one short-lived connection, one request, one reply, a deadline,
// then close. No connection is kept, nothing is subscribed to, and nothing here owns any
// lifecycle. The transport is the documented one — HERDR_SOCKET_PATH, newline-delimited
// JSON, { id, method, params } in and { id, result } or { id, error: { code, message } }
// back — matching herdr's own plugin clients.
const FOCUS_TIMEOUT_MS = 3000;

let requestSeq = 0;

// Unique per process AND per call, so a reply can be matched to the request that asked
// for it rather than to whatever arrived first.
function requestId() {
  requestSeq += 1;
  return `tdi.worktree-from-linear:${process.pid}:${requestSeq}`;
}

export function paneFocusRequest(paneId, id = requestId()) {
  return { id, method: 'pane.focus', params: { pane_id: paneId } };
}

// Validate a reply against the request that produced it. Split out from the transport so
// every rejection reason is testable without a socket.
export function readFocusReply(line, requestedId, paneId) {
  let reply;
  try {
    reply = JSON.parse(line);
  } catch {
    return { ok: false, error: 'herdr pane.focus returned unparseable output' };
  }
  if (!reply || typeof reply !== 'object' || Array.isArray(reply)) {
    return { ok: false, error: 'herdr pane.focus returned no reply object' };
  }
  // A reply carrying someone else's id is not an answer to this request.
  if (reply.id !== requestedId) {
    return { ok: false, error: `herdr pane.focus replied to ${JSON.stringify(reply.id ?? null)}` };
  }
  if (reply.error) {
    const { code, message } = reply.error;
    return { ok: false, error: `herdr pane.focus failed: ${code || 'error'}: ${String(message || '').slice(0, 200)}` };
  }
  const result = reply.result;
  if (!result || typeof result !== 'object' || result.type !== 'pane_info' || !result.pane) {
    return { ok: false, error: 'herdr pane.focus returned no pane' };
  }
  // The server answers with the pane it actually focused. Anything else means the id we
  // asked about is not the pane that now has focus.
  if (result.pane.pane_id !== paneId) {
    return { ok: false, error: `herdr pane.focus focused ${result.pane.pane_id ?? 'an unnamed pane'}, not ${paneId}` };
  }
  return { ok: true, pane: result.pane };
}

// Focus exactly `paneId`. `connect` is injectable so tests can drive a real temporary
// unix socket; the default is node:net over HERDR_SOCKET_PATH.
export async function focusPane(paneId, { socketPath, timeoutMs = FOCUS_TIMEOUT_MS, connect } = {}) {
  if (typeof socketPath !== 'string' || !socketPath) {
    return { ok: false, error: 'HERDR_SOCKET_PATH is not set, so the issue slot cannot be focused' };
  }
  const request = paneFocusRequest(paneId);
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
    // A server that accepts the connection and then says nothing must not hang the
    // picker: the deadline is the only thing that guarantees this call returns.
    const timer = setTimeout(() => finish({ ok: false, error: `herdr pane.focus timed out after ${timeoutMs}ms` }), timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
    try {
      socket = open(socketPath);
    } catch (err) {
      return finish({ ok: false, error: `herdr socket could not be opened: ${err.message}` });
    }
    socket.setEncoding('utf8');
    socket.on('error', (err) => finish({ ok: false, error: `herdr socket error: ${err.message}` }));
    socket.on('close', () => finish({ ok: false, error: 'herdr socket closed before replying' }));
    socket.on('end', () => finish({ ok: false, error: 'herdr socket closed before replying' }));
    socket.on('data', (chunk) => {
      buffer += chunk;
      // Newline-delimited JSON: the first complete line is this request's reply.
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      finish(readFocusReply(buffer.slice(0, newline), request.id, paneId));
    });
    const write = () => socket.write(`${JSON.stringify(request)}\n`);
    if (typeof socket.connecting === 'boolean' && socket.connecting) socket.once('connect', write);
    else write();
  });
}
