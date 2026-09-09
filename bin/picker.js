#!/usr/bin/env node
import { run } from '../lib/run.js';
import { reportOpenFailure } from '../lib/open.js';

run()
  .then((code) => process.exit(code))
  .catch((err) => {
    process.stderr.write(`${err.message}\n`);
    reportOpenFailure(err);
    process.exit(1);
  });
