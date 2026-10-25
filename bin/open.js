#!/usr/bin/env node
import { openPicker, reportOpenFailure } from '../lib/open.js';

try {
  const flags = process.argv.slice(2);
  const result = openPicker(process.env, undefined, { start: flags.includes('--start'), show: flags.includes('--show') });
  if (result.stdout) process.stdout.write(result.stdout);
  process.exitCode = 0;
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  reportOpenFailure(error);
  process.exitCode = 1;
}
