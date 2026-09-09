// Putting an issue on a terminal and keeping it there.
//
// Shared by the two entrypoints that render: the `[[panes]]` issue pane (bin/issue.js),
// which herdr starts with the identifier in its environment, and the issue host
// (bin/slot-host.js), which the user starts in a pane of their own layout and which then
// renders in-process. Neither of them types anything anywhere.
import { spawn, spawnSync } from 'node:child_process';
import { formatIssue, formatIssueMarkdown } from './render.js';

const RESIZE_DEBOUNCE_MS = 200;
// A renderer is a child process that owns the tty while it runs, so it needs a bound like
// every other child here. glow renders in milliseconds; anything approaching this is hung,
// and a hung renderer would keep stdin paused — which is where `q` is read from, so the
// pane could not even be quit.
const RENDER_TIMEOUT_MS = 5000;
// After SIGTERM, long enough to exit on its own and no longer.
const KILL_GRACE_MS = 500;
// Home, erase screen, erase scrollback: without the last one every re-render would stack
// another copy of the issue in the host's scrollback.
export const CLEAR = '\x1b[H\x1b[2J\x1b[3J';

// glow pads every line out to the render width and fits tables to it, so a rendered
// issue cannot reflow: shrinking the pane wraps that padding into blank lines and breaks
// the table borders. Capturing glow's output to strip the padding is not an option —
// glow drops all styling when its stdout is not a TTY. So re-render instead.
function paneWidth() {
  return Math.max(40, (process.stdout.columns || 80) - 2);
}

// Hold the pane open after rendering, without acting like a prompt: the tty still echoes,
// so typing into a finished pane would print stray characters over the issue, and the
// cursor left sitting below the text reads as an input line. Raw mode stops the echo (and
// with it any interpretation of Ctrl-C, so quit on it explicitly).
//
// Called again after every re-render, so the listeners are wired once: a pair per render
// would trip Node's 11-listener warning onto stderr, straight into the rendered pane.
let wired = false;
export function hold() {
  process.stdout.write('\x1b[?25l');
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.resume();
  if (wired) return;
  wired = true;
  process.on('exit', () => process.stdout.write('\x1b[?25h'));
  if (!process.stdin.isTTY) return;
  process.stdin.on('data', (buf) => {
    // q, Ctrl-C, Ctrl-D. Exiting runs the process's own exit handlers, which is where a
    // host gives its pane, its tokens and its socket back.
    if (buf.includes(0x03) || buf.includes(0x04) || buf.includes(0x71)) process.exit(0);
  });
}

// Whatever renderer is running right now, so it can be killed if this process ends first.
// A child holding the pane's tty must never outlive the pane's own process.
let running = null;
let reaperWired = false;

function kill(child, signal) {
  try { child?.kill(signal); } catch { /* already gone */ }
}

// Render the markdown with glow when it is installed, re-rendering at the new width on
// resize. Returns false when glow cannot be used, so the caller prints the plain panel
// instead.
//
// No pager: the whole rendered issue goes straight into the pane, so scrolling and
// selection stay the host's, exactly as in any other pane. A pager would own the mouse
// (its own tracking, so selection needs shift) or, without --mouse, leave the wheel
// scrolling only the part already paged through.
export function renderWithGlow(markdown, fallback, { timeoutMs = RENDER_TIMEOUT_MS } = {}) {
  if (!process.stdout.isTTY) return false;
  if (spawnSync('sh', ['-c', 'command -v glow'], { timeout: 5000 }).status !== 0) return false;
  if (!reaperWired) {
    reaperWired = true;
    process.on('exit', () => kill(running, 'SIGKILL'));
  }
  let child = null;
  let restart = false;
  let timer = null;
  const render = () => {
    process.stdout.write(CLEAR);
    // glow probes the terminal background (OSC 10/11) to pick its light/dark style and
    // waits for the reply on the tty, so this process must not be reading it at the same
    // time — a resumed stdin here swallows the reply and glow never renders. Which is
    // also why a renderer that never finishes has to be given up on: until it does,
    // nothing is reading the keystroke that would close the pane.
    process.stdin.pause();
    const started = spawn('glow', ['-w', String(paneWidth())], { stdio: ['pipe', 'inherit', 'inherit'] });
    child = started;
    running = started;
    // A long issue may not fit the pipe buffer, so this write can still be pending when a
    // resize kills glow: swallow the EPIPE, or the unhandled error takes the pane down.
    started.stdin.on('error', () => {});
    started.stdin.end(markdown);
    // Declared before `done` closes over it: a spawn error can arrive before the deadline
    // below has been assigned.
    let deadline = null;
    const done = (err) => {
      // A render that has already been given up on can still emit its exit: it is not the
      // current one any more, and it must not render or hold a second time.
      if (child !== started) return;
      clearTimeout(deadline);
      child = null;
      if (running === started) running = null;
      if (restart) { restart = false; return render(); }
      // A glow that starts but fails (bad config, unknown style) leaves a blank pane.
      if (err) process.stdout.write(fallback);
      hold();
    };
    deadline = setTimeout(() => {
      if (child !== started) return;
      restart = false;
      kill(started, 'SIGTERM');
      const hard = setTimeout(() => kill(started, 'SIGKILL'), KILL_GRACE_MS);
      if (typeof hard.unref === 'function') hard.unref();
      // Take the terminal back now rather than when (or if) it dies: print the plain
      // panel and start reading stdin again.
      done(new Error(`glow did not finish within ${timeoutMs}ms`));
    }, timeoutMs);
    if (typeof deadline.unref === 'function') deadline.unref();
    started.on('error', done);
    started.on('exit', (code) => done(code ? new Error(`glow exited ${code}`) : null));
  };
  // Dragging a pane divider fires a burst of these; only the last one is worth a render.
  process.stdout.on('resize', () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (!child) return render();
      restart = true;
      try { child.kill('SIGTERM'); } catch { /* already gone */ }
    }, RESIZE_DEBOUNCE_MS);
  });
  render();
  return true;
}

// Show a fetched issue and keep the pane on it. Markdown through glow where it is
// available, the plain panel otherwise.
export function showIssue(issue, options = {}) {
  const plain = formatIssue(issue);
  if (!renderWithGlow(formatIssueMarkdown(issue), plain, options)) {
    process.stdout.write(plain);
    hold();
  }
}
