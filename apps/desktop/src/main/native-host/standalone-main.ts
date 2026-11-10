// Entry point of the standalone native-messaging host (`standalone.ts`). It exits once
// everything written to stdout has been handed on: a pipe's writes are asynchronous on Windows.

import { runStandaloneHost } from './standalone.ts';

void runStandaloneHost({
  argv: process.argv.slice(2),
  platform: process.platform,
  stdin: process.stdin,
  stdout: process.stdout,
}).then(
  (code) => {
    process.stdout.write('', () => process.exit(code));
  },
  () => {
    process.exit(1);
  },
);
