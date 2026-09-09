#!/usr/bin/env node
// The `[[panes]]` issue entrypoint: herdr opens a pane and runs this with the identifier
// in its environment (`--env HERDR_WFP_ISSUE`). One issue, rendered, held until the pane
// is closed.
//
// This is not how the picker delivers an issue into your own layout — that is
// bin/slot-host.js, a host you start yourself in the pane you chose. This entrypoint owns
// a pane herdr made for it, so there is no shell behind it to hand back: it holds.
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../lib/config.js';
import { fetchIssue } from '../lib/linear.js';
import { formatIssue } from '../lib/render.js';
import { hold, showIssue } from '../lib/viewer.js';

// Flags win where both are present; the environment form is what herdr's pane command
// uses. Identity flags do not exist here on purpose — this pane publishes nothing and
// owns no slot, so there is nothing for it to claim.
export function parseViewerArgs(argv = [], env = {}) {
  const flag = (name) => {
    const i = argv.indexOf(name);
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null;
  };
  return {
    identifier: (flag('--issue') || env.HERDR_WFP_ISSUE || '').trim().toUpperCase(),
    configDir: flag('--config-dir') || env.HERDR_PLUGIN_CONFIG_DIR || undefined,
    // loadConfig treats this as the repository root for path-based key selection. An
    // explicit value keeps that decision off whatever cwd the pane happened to start in.
    cwd: flag('--cwd') || undefined,
  };
}

async function main() {
  const args = parseViewerArgs(process.argv.slice(2), process.env);
  const { identifier } = args;
  let issue;
  try {
    const config = loadConfig(args.configDir, args.cwd, process.env, identifier);
    issue = await fetchIssue(config, identifier);
  } catch (err) {
    // A failed fetch is rendered, not thrown: the pane must say why rather than vanish.
    issue = { identifier, error: err.message };
  }
  if (issue.error) {
    process.stdout.write(formatIssue(issue));
    hold();
    return;
  }
  showIssue(issue);
}

// Only when herdr runs this as the pane command — importing it (see test/issue.test.js)
// must not fetch from Linear or take over the tty.
if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) main();
