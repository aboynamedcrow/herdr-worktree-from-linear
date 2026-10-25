// The list view's state: the ids from Git, the selection, and the details for each id.
//
// The details come from the shared fetcher (lib/fetcher.js). This module decides what the
// pane wants, and at which rate: 60 s for an issue in an open full view or in a focused
// pane, 5 min for a background list. It asks herdr whether its pane is focused at most
// once per 10 s, and only while it shows an id.
import { loadConfig } from './config.js';
import { runCmd } from './exec.js';
import { FAST_MS, SLOW_MS, createSharedFetcher, shortError } from './fetcher.js';
import { readIssueIds } from './issue-list.js';
import { callJson, paneGetArgs } from './native.js';

const same = (a, b) => a.length === b.length && a.every((id, index) => id === b[index]);
const FOCUS_MS = 10000;
const FOCUS_TIMEOUT_MS = 5000;

export function createListMode({
  checkout, configDir, onUpdate, paneId = '', herdrBin = 'herdr', env = process.env,
  read = readIssueIds, load = loadConfig, exec = runCmd, fetchFn = fetch,
  fetcher = null, fetcherFactory = createSharedFetcher,
  now = Date.now, pollMs = 2000, focusMs = FOCUS_MS, fastMs = FAST_MS, slowMs = SLOW_MS,
  setTimer = setInterval, clearTimer = clearInterval,
}) {
  let ids = [];
  let selected = null;
  let override = null;
  let fullId = null;
  let focused = false;
  let lastFocusAt = -Infinity;
  let data = new Map();
  let error = '';
  let gitError = '';
  let lastEmitted = '';
  let timer = null;
  let closed = false;

  const shared = fetcher ?? fetcherFactory({ configDir, checkout, env, fetchFn, load, now, onChange: () => sync() });
  const view = () => ({ ids: [...ids], selected, issues: new Map(data), error, override });
  const emit = () => {
    if (closed) return;
    const next = view();
    const signature = JSON.stringify([next.ids, next.selected, next.override, [...next.issues], next.error]);
    if (signature === lastEmitted) return;
    lastEmitted = signature;
    onUpdate(next);
  };

  // The ids this pane shows: the list, plus a delivered id outside it.
  const shown = () => (override && !ids.includes(override) ? [override, ...ids] : [...ids]);
  const rateFor = (id) => (focused || id === fullId ? fastMs : slowMs);
  const pushWants = () => shared.setWants(new Map(shown().map((id) => [id, rateFor(id)])));

  // Take what the fetcher has for the ids this pane shows. The first problem, one line.
  function sync() {
    if (closed) return;
    const snapshot = shared.snapshot();
    const next = new Map();
    const problems = [];
    for (const id of shown()) {
      const issue = snapshot.issues.get(id);
      if (issue) next.set(id, issue);
      const problem = snapshot.errors.get(id);
      if (problem) problems.push(`${id}: ${problem}`);
    }
    data = next;
    error = (problems.length ? `Linear: ${problems[0]}`.slice(0, 120) : '') || gitError
      || (shared.note ? `Fetcher: private, ${shared.note}`.slice(0, 120) : '');
    emit();
  }

  function probeFocus() {
    const reply = callJson(exec, herdrBin, paneGetArgs(paneId), { timeoutMs: FOCUS_TIMEOUT_MS });
    return reply.ok && reply.result?.pane?.focused === true;
  }

  async function poll() {
    if (closed) return;
    try {
      const next = read(checkout);
      gitError = '';
      if (!same(ids, next)) {
        ids = next;
        override = null;
        selected = ids.includes(selected) ? selected : ids[0] ?? null;
      }
    } catch (cause) {
      gitError = `Git: ${shortError(cause)}`;
    }
    if (paneId && shown().length && now() - lastFocusAt >= focusMs) {
      lastFocusAt = now();
      focused = probeFocus();
    }
    const changed = pushWants();
    sync();
    await shared.step(changed);
    sync();
  }

  function select(delta) {
    if (closed) return false;
    const index = ids.indexOf(selected);
    if (index < 0 || !ids.length) return false;
    const next = ids[Math.max(0, Math.min(ids.length - 1, index + delta))];
    if (next === selected) return false;
    selected = next;
    override = null;
    emit();
    return true;
  }

  async function deliver(identifier) {
    if (closed) return;
    if (selected === identifier && data.has(identifier)) return;
    selected = identifier;
    override = ids.includes(identifier) ? null : identifier;
    const changed = pushWants();
    sync();
    await shared.step(changed);
    sync();
  }

  // The full view's issue stays fast while it is open, focused or not.
  async function setFull(identifier) {
    if (closed) return;
    fullId = identifier;
    const changed = pushWants();
    await shared.step(changed);
  }

  async function refresh() {
    if (closed) return;
    await shared.refreshNow();
    sync();
  }

  return {
    poll, select, deliver, view, setFull, refresh,
    fetcher: shared,
    start() { if (!closed && timer === null) { void poll(); timer = setTimer(() => { void poll(); }, pollMs); } },
    close() {
      closed = true;
      if (timer !== null) clearTimer(timer);
      timer = null;
      shared.close();
    },
  };
}
