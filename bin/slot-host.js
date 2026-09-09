#!/usr/bin/env node
// The issue host, in the foreground of a pane you already have.
//
//   node <plugin>/bin/slot-host.js --pane "$HERDR_PANE_ID" --config-dir <dir> [--cwd <checkout>]
//
// Start it yourself in the pane your config names (issueTabLabel / issuePaneLabel), or
// have your layout start it there. While it runs, picking a Linear issue shows that issue
// here. `q` (or Ctrl-C) quits and gives the pane back to your shell.
//
// It is only ever started explicitly. Nothing in this plugin launches it, because
// launching it would mean typing into somebody's shell — the exact thing this design
// exists to avoid.
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { formatIssue } from '../lib/render.js';
import { hold, showIssue, CLEAR } from '../lib/viewer.js';
import { publishHost, resolveHostContext, startHost, unpublishHost } from '../lib/host.js';

const USAGE = 'usage: node bin/slot-host.js --pane PANE_ID --config-dir DIR [--cwd CHECKOUT]';

function ready(checkout) {
  return [
    CLEAR,
    'Linear issue host\n\n',
    `Ready in ${checkout}.\n`,
    'Pick a Linear issue (Worktree from Linear) and it will appear here.\n\n',
    'q or Ctrl-C returns this pane to your shell.\n',
  ].join('');
}

// Give the pane, its tokens and the socket back however this ends: q, Ctrl-C, the pane
// closing, or a failed fetch. Injectable so main() can be called without taking over the
// caller's process — the entrypoint installs the real ones.
function installHandlers(cleanup) {
  process.on('exit', cleanup);
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => process.exit(0));
}

export async function main({
  argv = process.argv.slice(2),
  env = process.env,
  cwd = process.cwd(),
  install = installHandlers,
} = {}) {
  const context = resolveHostContext(argv, env, cwd);
  if (!context.ok) {
    process.stderr.write(`${context.error}\n${USAGE}\n`);
    return 2;
  }
  const herdrBin = env.HERDR_BIN_PATH || 'herdr';

  const started = await startHost({
    paneId: context.paneId,
    configDir: context.configDir,
    checkout: context.checkout,
    // Rendering happens in this process, from an issue this process fetched. A request
    // asked for an identifier; it did not supply anything to run.
    onShow: (issue) => showIssue(issue),
    // A failed fetch is the host's failure, not the worktree's: say why, give the pane
    // back to the shell that started this, and exit non-zero like any other command.
    onFail: (identifier, reason) => {
      process.stdout.write(CLEAR);
      process.stdout.write(formatIssue({ identifier, error: reason }));
      process.exit(1);
    },
  });
  if (!started.ok) {
    process.stderr.write(`${started.error}\n`);
    return 1;
  }
  const { host } = started;
  // Both halves are bounded and neither can throw.
  install(() => {
    unpublishHost(host, { herdrBin });
    host.close();
  });

  // Publishing is how the picker finds this host at all, so a host that cannot publish is
  // not a usable host: say so and return the shell rather than sit here undiscoverable —
  // and stop listening on the way out, rather than leaving a socket nobody can find.
  const published = publishHost(host, { herdrBin });
  if (!published.ok) {
    process.stderr.write(`issue host could not publish itself on ${host.paneId}: ${published.error}\n`);
    host.close();
    return 1;
  }

  process.stdout.write(ready(host.checkout));
  hold();
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  main().then((code) => { if (code !== 0) process.exit(code); });
}
