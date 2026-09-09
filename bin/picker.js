#!/usr/bin/env node
import { run } from '../lib/run.js';
import { reportOpenFailure } from '../lib/open.js';

// herdr tears the pane down the instant this process exits, so an error written on the
// way out flashes past unread — the failure looks like "nothing happened". Hold the pane
// open until a keypress, capped so a forgotten pane still closes itself.
function pause() {
  return new Promise((resolve) => {
    process.stderr.write('press any key to close\n');
    const done = () => {
      clearTimeout(timer);
      process.stdin.pause();
      resolve();
    };
    const timer = setTimeout(done, 30000);
    if (process.stdin.isTTY) process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.once('data', done);
  });
}

run()
  .then((code) => process.exit(code))
  .catch(async (err) => {
    process.stderr.write(`${err.message}\n`);
    reportOpenFailure(err);
    await pause();
    process.exit(1);
  });
