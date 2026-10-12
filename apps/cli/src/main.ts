#!/usr/bin/env node
import { buildProgram, reportError } from './commands.js';

try {
  await buildProgram().parseAsync(process.argv);
} catch (e) {
  reportError(e);
}
