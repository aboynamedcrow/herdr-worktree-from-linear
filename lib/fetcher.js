// One Linear fetcher per Mac.
//
// Every issue host of one user on one Mac shares one directory. The first host takes a
// leader lock and runs the fetch loop. Every host writes an interest file: the ids it
// shows, the rate it wants for each, and a refresh-now stamp. The leader reads the live
// interests, asks Linear for `updatedAt` first, fetches the full issue only for changed
// ids, and writes one cache file. Followers read that file. When the leader exits, or its
// process is gone, a follower takes the lock.
//
// No daemon, no extra process: the loop runs inside whichever host holds the lock, and
// dies with it. No key value reaches a file, a file name, or an error message.
import {
  linkSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync,
  watch as fsWatch, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { loadConfig } from './config.js';
import { fetchIssueBatch, fetchUpdatedAtBatch } from './linear.js';

// Rates. An issue in an open full view, or in a focused pane, is fast. A background
// list is slow. The leader runs one step per tick and probes only the ids that are due.
export const FAST_MS = 60000;
export const SLOW_MS = 300000;
export const TICK_MS = 10000;
// A leader that has not written its heartbeat for this long is treated as gone, even when
// a process with its pid still exists.
export const LEADER_STALE_MS = 90000;
// Each host rewrites its interest file at least this often. The leader ignores an
// interest older than INTEREST_STALE_MS, and removes the file of a dead process.
export const INTEREST_BEAT_MS = 60000;
export const INTEREST_STALE_MS = 300000;
const FETCH_TIMEOUT_MS = 20000;

const LOCK = 'leader.json';
const CACHE = 'issues.json';
const INTEREST = /^host-(\d+)\.json$/;
const ID = /^[A-Za-z][A-Za-z0-9_]{0,15}-[0-9]{1,9}$/;

// One line, no key, no newline: what the pane shows for a failed request.
export const shortError = (error, key = '') => String(error?.message || error || 'request failed')
  .replaceAll(key || '\0', '[redacted]').replace(/[\r\n]+/g, ' ').slice(0, 120);

// Where the shared directory lives. WFL_SHARED_DIR is an explicit override, used by the
// tests and by anyone who needs the hosts of one Mac to meet somewhere else. Otherwise it
// is under XDG_RUNTIME_DIR when that is the user's own directory, else under the
// temporary directory, which macOS already keeps per user.
export function sharedBase(env = process.env) {
  const override = env.WFL_SHARED_DIR;
  if (override && isAbsolute(override)) return override;
  const runtime = env.XDG_RUNTIME_DIR;
  if (runtime && isAbsolute(runtime)) {
    try {
      const stat = lstatSync(runtime);
      if (stat.isDirectory() && stat.uid === process.getuid()) return join(runtime, 'wfl-fetch');
    } catch { /* not usable; fall through */ }
  }
  return join(tmpdir(), 'wfl-fetch');
}

// Create the directory when it is missing, then verify it: a real directory, ours, and
// owner-only. Anything else is refused, and the host fetches on its own instead.
export function openSharedDir(dir) {
  try {
    mkdirSync(dir, { mode: 0o700 });
  } catch (err) {
    if (err.code !== 'EEXIST') return { ok: false, error: `could not create ${dir}: ${err.message}` };
  }
  let stat;
  try {
    stat = lstatSync(dir);
  } catch (err) {
    return { ok: false, error: `could not inspect ${dir}: ${err.message}` };
  }
  if (!stat.isDirectory() || stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0) {
    return { ok: false, error: `${dir} is not an owner-only directory` };
  }
  return { ok: true, dir };
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

// Write the whole file, then rename it into place, so a reader never sees a partial file.
function writeAtomic(path, text, pid) {
  const tmp = `${path}.${pid}.tmp`;
  writeFileSync(tmp, text, { mode: 0o600 });
  renameSync(tmp, path);
}

// Create `path` with `text` only if nothing is there. link() is atomic and fails with
// EEXIST, so two candidates cannot both succeed, and the file is complete when it appears.
function createExclusive(path, text, pid) {
  const tmp = `${path}.${pid}.new`;
  writeFileSync(tmp, text, { mode: 0o600 });
  try {
    linkSync(tmp, path);
    return true;
  } catch {
    return false;
  } finally {
    try { unlinkSync(tmp); } catch { /* already gone */ }
  }
}

export function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

/**
 * The shared fetcher, as one host sees it.
 *
 * `step()` is the only thing that does work, and the host calls it from its own poll
 * loop. As leader, a step reads the interests, fetches what is due, and writes the cache.
 * As follower, a step reads the cache when it changed and checks that the leader is
 * still there. The directory watch only asks for another step; it never fetches itself.
 */
export function createSharedFetcher({
  configDir, checkout, env = process.env,
  dir, base = sharedBase(env), open = openSharedDir,
  pid = process.pid, instance = String(pid),
  now = Date.now, alive = processAlive, watch = fsWatch,
  fetchFn = fetch, load = loadConfig, probe = fetchUpdatedAtBatch, fetchBatch = fetchIssueBatch,
  tickMs = TICK_MS, leaderStaleMs = LEADER_STALE_MS, interestBeatMs = INTEREST_BEAT_MS,
  interestStaleMs = INTEREST_STALE_MS, keepMs = SLOW_MS, fetchTimeoutMs = FETCH_TIMEOUT_MS,
  setAbortTimer = setTimeout, clearAbortTimer = clearTimeout,
  onChange = () => {},
} = {}) {
  let note = '';
  if (dir === undefined) {
    const opened = open(base);
    if (opened.ok) dir = opened.dir;
    else { dir = null; note = opened.error; }
  }
  const lockPath = dir ? join(dir, LOCK) : null;
  const cachePath = dir ? join(dir, CACHE) : null;
  const interestPath = dir ? join(dir, `host-${pid}.json`) : null;

  let role = dir ? 'follower' : 'solo';
  let wants = new Map();
  let refreshAt = 0;
  let interestBody = '';
  let interestWrittenAt = -Infinity;
  // id -> { updatedAt, probedAt, fetchedAt, issue, error }
  let entries = {};
  let cacheSig = '';
  let lastLeadAt = -Infinity;
  const honored = new Map();
  let running = false;
  let pending = false;
  let closed = false;

  const snapshot = () => {
    const issues = new Map();
    const errors = new Map();
    for (const [id, entry] of Object.entries(entries)) {
      if (entry?.issue) issues.set(id, entry.issue);
      if (entry?.error) errors.set(id, entry.error);
    }
    return { issues, errors, role };
  };
  const notify = () => { if (!closed) onChange(snapshot()); };

  // --- interest -------------------------------------------------------------------

  const own = () => ({ pid, checkout, refreshAt, wants: Object.fromEntries(wants) });

  function writeInterest(force = false) {
    if (!dir) return;
    const t = now();
    const payload = { ...own(), instance };
    const body = JSON.stringify(payload);
    if (!force && body === interestBody && t - interestWrittenAt < interestBeatMs) return;
    try {
      writeAtomic(interestPath, JSON.stringify({ ...payload, writtenAt: t }), pid);
      interestBody = body;
      interestWrittenAt = t;
    } catch { /* the next step tries again */ }
  }

  function setWants(next) {
    const same = next.size === wants.size && [...next].every(([id, ms]) => wants.get(id) === ms);
    if (same) return false;
    wants = new Map(next);
    writeInterest(true);
    return true;
  }

  function readInterests(t) {
    const list = [own()];
    if (!dir) return list;
    let names = [];
    try { names = readdirSync(dir); } catch { return list; }
    for (const name of names) {
      const match = INTEREST.exec(name);
      if (!match) continue;
      const filePid = Number(match[1]);
      if (filePid === pid) continue;
      const path = join(dir, name);
      if (!alive(filePid)) {
        try { unlinkSync(path); } catch { /* already gone */ }
        continue;
      }
      const it = readJson(path);
      if (!it || it.pid !== filePid || typeof it.wants !== 'object' || !it.wants) continue;
      if (!(t - Number(it.writtenAt) <= interestStaleMs)) continue;
      list.push({
        pid: filePid,
        checkout: typeof it.checkout === 'string' && isAbsolute(it.checkout) ? it.checkout : checkout,
        refreshAt: Number(it.refreshAt) || 0,
        wants: it.wants,
      });
    }
    return list;
  }

  // --- the lock -------------------------------------------------------------------

  const readLock = () => {
    try { statSync(lockPath); } catch { return null; }
    // Present but unreadable counts as stale, so a corrupt lock cannot hold forever.
    return readJson(lockPath) ?? { pid: 0, instance: '', beat: 0 };
  };
  const mine = (lock) => Boolean(lock) && lock.pid === pid && lock.instance === instance;
  const sameLock = (a, b) => Boolean(a) && Boolean(b) && a.pid === b.pid && a.instance === b.instance && a.beat === b.beat;
  const stale = (lock, t) => !Number.isInteger(lock.pid) || lock.pid <= 0 || !alive(lock.pid)
    || !(t - Number(lock.beat) <= leaderStaleMs);
  const lockText = (t) => JSON.stringify({ pid, instance, beat: t });

  function settleRole() {
    if (!dir) return 'solo';
    const lock = readLock();
    if (role === 'leader') {
      if (mine(lock)) return 'leader';
      cacheSig = '';
      return 'follower';
    }
    const t = now();
    if (lock && !stale(lock, t)) return 'follower';
    if (lock) {
      // Move the stale lock aside, but only the lock we inspected. Another follower may
      // have replaced it with a fresh one between our read and our rename. Re-read first,
      // then check what the rename moved, and put a fresh lock back where it was.
      if (!sameLock(readLock(), lock)) return 'follower';
      const aside = `${lockPath}.${pid}.stale`;
      try { renameSync(lockPath, aside); } catch { return 'follower'; }
      const moved = readJson(aside);
      const fresh = Boolean(moved) && !sameLock(moved, lock);
      if (fresh) {
        try { linkSync(aside, lockPath); } catch { /* a newer lock exists; its owner wins */ }
      }
      try { unlinkSync(aside); } catch { /* already gone */ }
      if (fresh) return 'follower';
    }
    if (!createExclusive(lockPath, lockText(t), pid)) return 'follower';
    lastLeadAt = -Infinity;
    return 'leader';
  }

  function beat(t) {
    try { writeAtomic(lockPath, lockText(t), pid); } catch { /* the next step tries again */ }
  }

  // --- the leader step ------------------------------------------------------------

  function mark(id, patch) {
    const before = entries[id] ?? {};
    const after = { ...before, ...patch };
    entries[id] = after;
    return JSON.stringify([before.issue, before.error, before.updatedAt])
      !== JSON.stringify([after.issue, after.error, after.updatedAt]);
  }

  async function fetchGroup({ config, ids }, t) {
    const key = config.linearApiKey;
    let changed = false;
    const controller = new AbortController();
    const timer = setAbortTimer(() => controller.abort(), fetchTimeoutMs);
    const bounded = (url, options) => fetchFn(url, { ...options, signal: controller.signal });
    try {
      let probed;
      try {
        probed = await probe(config, ids, bounded);
      } catch (cause) {
        const error = shortError(cause, key);
        for (const id of ids) changed = mark(id, { probedAt: t, error }) || changed;
        return changed;
      }
      const due = ids.filter((id) => {
        const entry = entries[id];
        const updatedAt = probed.get(id);
        return updatedAt !== undefined && (!entry?.issue || entry.updatedAt !== updatedAt);
      });
      let full = new Map();
      if (due.length) {
        try {
          full = await fetchBatch(config, due, bounded);
        } catch (cause) {
          const error = shortError(cause, key);
          for (const id of due) changed = mark(id, { probedAt: t, error }) || changed;
          for (const id of ids) {
            if (!due.includes(id)) changed = mark(id, { probedAt: t, error: probed.has(id) ? '' : 'not found' }) || changed;
          }
          return changed;
        }
      }
      for (const id of ids) {
        if (!probed.has(id)) {
          changed = mark(id, { probedAt: t, updatedAt: null, issue: null, error: 'not found' }) || changed;
        } else if (due.includes(id)) {
          const issue = full.get(id);
          changed = (issue
            ? mark(id, { probedAt: t, fetchedAt: t, updatedAt: issue.updatedAt || probed.get(id), issue, error: '' })
            : mark(id, { probedAt: t, error: 'no details' })) || changed;
        } else {
          changed = mark(id, { probedAt: t, error: '' }) || changed;
        }
      }
      return changed;
    } finally {
      clearAbortTimer(timer);
    }
  }

  async function lead() {
    const t = now();
    lastLeadAt = t;
    const interests = readInterests(t);
    const rate = new Map();
    const checkoutFor = new Map();
    const refresh = new Set();
    for (const it of interests) {
      const fresh = it.refreshAt > (honored.get(it.pid) ?? 0);
      for (const [id, everyMs] of Object.entries(it.wants)) {
        const ms = Number(everyMs);
        if (!ID.test(id) || !(ms > 0)) continue;
        if (!rate.has(id) || ms < rate.get(id)) rate.set(id, ms);
        if (!checkoutFor.has(id)) checkoutFor.set(id, it.checkout);
        if (fresh) refresh.add(id);
      }
      if (fresh) honored.set(it.pid, it.refreshAt);
    }
    let changed = false;
    for (const id of Object.keys(entries)) {
      if (!rate.has(id) && !(t - Number(entries[id]?.probedAt ?? 0) <= keepMs)) {
        delete entries[id];
        changed = true;
      }
    }
    const due = [...rate].filter(([id, ms]) => {
      const entry = entries[id];
      return !entry || refresh.has(id) || t - Number(entry.probedAt ?? 0) >= ms;
    }).map(([id]) => id);
    if (due.length) {
      const groups = new Map();
      for (const id of due) {
        try {
          const config = load(configDir, checkoutFor.get(id) ?? checkout, env, id);
          const group = groups.get(config.linearApiKey) || { config, ids: [] };
          group.ids.push(id);
          groups.set(config.linearApiKey, group);
        } catch (cause) {
          changed = mark(id, { probedAt: t, error: shortError(cause) }) || changed;
        }
      }
      const results = await Promise.all([...groups.values()].map((group) => fetchGroup(group, t)));
      changed = results.some(Boolean) || changed;
    }
    if (closed) return;
    if (dir) {
      // The fetch may have taken longer than the lock allows, for example across a laptop
      // sleep. Then another host leads now. Write nothing over its cache or its lock.
      if (!mine(readLock())) {
        role = 'follower';
        cacheSig = '';
        return;
      }
      if (changed) {
        try {
          writeAtomic(cachePath, JSON.stringify({ leader: { pid, instance }, writtenAt: t, issues: entries }), pid);
        } catch { /* followers keep the last file; the next change tries again */ }
      }
      beat(now());
    }
    if (changed) notify();
  }

  // --- the follower step ----------------------------------------------------------

  function readCache() {
    let stat;
    try { stat = statSync(cachePath); } catch { return; }
    const sig = `${stat.ino}:${stat.size}:${stat.mtimeMs}`;
    if (sig === cacheSig) return;
    cacheSig = sig;
    const parsed = readJson(cachePath);
    if (!parsed || typeof parsed.issues !== 'object' || !parsed.issues) return;
    const before = JSON.stringify(entries);
    entries = parsed.issues;
    if (JSON.stringify(entries) !== before) notify();
  }

  // --- the step -------------------------------------------------------------------

  async function step(force = false) {
    if (closed) return;
    if (running) { pending = pending || force; return; }
    running = true;
    try {
      if (dir) {
        writeInterest();
        role = settleRole();
      }
      if (role === 'follower') readCache();
      else if (force || now() - lastLeadAt >= tickMs) await lead();
    } finally {
      running = false;
      if (pending && !closed) {
        pending = false;
        void step(true);
      }
    }
  }

  // The watch asks for a step when another host's file changed. A leader cares about
  // interests, a follower about the lock and the cache. Our own writes, and temporary
  // files, are ignored, or a leader's heartbeat would wake itself forever.
  let watcher = null;
  if (dir) {
    try {
      watcher = watch(dir, (_event, filename) => {
        if (closed) return;
        const name = String(filename ?? '');
        if (!name) { if (role === 'follower') void step(); return; }
        if (name.endsWith('.tmp') || name.endsWith('.new') || name.endsWith('.stale') || name === `host-${pid}.json`) return;
        if (role === 'follower') { if (name === CACHE || name === LOCK) void step(); }
        else if (INTEREST.test(name)) void step(true);
      });
      if (typeof watcher?.unref === 'function') watcher.unref();
    } catch { watcher = null; }
  }

  function close() {
    if (closed) return;
    closed = true;
    try { watcher?.close(); } catch { /* already closed */ }
    if (!dir) return;
    if (role === 'leader' && mine(readLock())) {
      try { unlinkSync(lockPath); } catch { /* already gone */ }
    }
    try { unlinkSync(interestPath); } catch { /* already gone */ }
  }

  return {
    dir,
    note,
    role: () => role,
    snapshot,
    setWants,
    refreshNow() {
      refreshAt = now();
      writeInterest(true);
      return step(true);
    },
    step,
    close,
  };
}
