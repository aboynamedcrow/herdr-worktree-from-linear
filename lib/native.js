// Argument builders and reply readers for the herdr CLI calls the issue slot needs.
//
// Kept apart from the delivery policy in lib/slot.js so the wire shape has one home:
// every call here was read off herdr 0.9.0's API schema (version 22) and captured CLI
// replies. herdr prints JSON by default — there is no --json to add — and it answers a
// server error as JSON on stderr with status 1, a usage error with status 2. Commands
// that only act (focus, run, report-metadata) may print nothing at all, so those are
// judged by exit status alone and never parsed.

// `pane list`/`tab list` take the workspace explicitly. Never omit it: without a target
// herdr answers about whichever pane some client happens to have focused, which may be
// the user's own window rather than the worktree we just opened.
export function tabListArgs(workspaceId) {
  return ['tab', 'list', '--workspace', workspaceId];
}

export function paneListArgs(workspaceId) {
  return ['pane', 'list', '--workspace', workspaceId];
}

// Pane-scoped commands take the pane id positionally.
export function paneProcessInfoArgs(paneId) {
  return ['pane', 'process-info', paneId];
}

export function paneGetArgs(paneId) {
  return ['pane', 'get', paneId];
}

export function paneFocusArgs(paneId) {
  return ['pane', 'focus', paneId];
}

// `pane run` writes the command text and Enter as one submission, which is why the text
// must be a single line: a newline inside it would submit two commands.
export function paneRunArgs(paneId, command) {
  return ['pane', 'run', paneId, command];
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

// Run a herdr command whose reply we need to read, and hand back its `result` object.
// Both failure modes the caller must report differently are distinguished here: the
// command failed, or it succeeded and said something we cannot parse.
export function callJson(exec, herdrBin, args) {
  let res;
  try {
    res = exec(herdrBin, args);
  } catch (err) {
    return { ok: false, error: `herdr ${label(args)} could not run: ${err.message}` };
  }
  if (!res || res.status !== 0) {
    // herdr's own stderr, trimmed. It carries ids and reasons, never plugin config.
    const detail = String(res?.stderr || '').trim().slice(0, 200) || `status ${res?.status}`;
    return { ok: false, error: `herdr ${label(args)} failed: ${detail}` };
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

// Run a herdr command that only acts. `pane run` and friends can legitimately print
// nothing, so status is the only signal available.
export function callVoid(exec, herdrBin, args) {
  let res;
  try {
    res = exec(herdrBin, args);
  } catch (err) {
    return { ok: false, error: `herdr ${label(args)} could not run: ${err.message}` };
  }
  if (!res || res.status !== 0) {
    const detail = String(res?.stderr || '').trim().slice(0, 200) || `status ${res?.status}`;
    return { ok: false, error: `herdr ${label(args)} failed: ${detail}` };
  }
  return { ok: true };
}
