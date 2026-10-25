#!/usr/bin/env node
import { run } from '../lib/run.js';
import { pauseOnFailure } from '../lib/picker.js';
import { reportOpenFailure } from '../lib/open.js';

run()
  .then((code) => process.exit(code))
  .catch(async (err) => {
    process.stderr.write(`${err.message}\n`);
    reportOpenFailure(err);
    await pauseOnFailure();
    process.exit(1);
  });
