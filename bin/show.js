#!/usr/bin/env node
import { showIssue } from '../lib/show.js';
import { reportOpenFailure } from '../lib/open.js';

showIssue(process.argv.slice(2)).then((code) => { process.exitCode = code; }).catch((error) => {
  process.stderr.write(`${error.message}\n`);
  reportOpenFailure(error);
  process.exitCode = 1;
});
