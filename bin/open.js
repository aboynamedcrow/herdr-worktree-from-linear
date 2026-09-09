#!/usr/bin/env node
import { openPicker, reportOpenFailure } from '../lib/open.js';

try {
  const result = openPicker();
  if (result.stdout) process.stdout.write(result.stdout);
  process.exitCode = 0;
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  reportOpenFailure(error);
  process.exitCode = 1;
}
