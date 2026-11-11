// A stand-in for the desktop app's native-messaging host, for the extension's integration
// tests: Chrome starts it (through the wrapper the test writes into the user-data dir's
// NativeMessagingHosts), and it relays Chrome's native-messaging frames to the test's Unix
// socket, unchanged, both ways. It exits when Chrome closes its stdin. The real host
// (apps/desktop, `--native-host`) adds the IPC handshake; it is tested there.
//
// Run as `node stub-host.ts <socket-path> <origin>`; stdout carries frames only.

import { connect } from 'node:net';

const socketPath = process.argv[2];
if (socketPath === undefined) process.exit(2);

const socket = connect(socketPath);
socket.on('error', () => process.exit(1));
socket.on('close', () => process.exit(0));
socket.on('data', (chunk: Buffer) => process.stdout.write(chunk));
process.stdin.on('data', (chunk: Buffer) => socket.write(chunk));
process.stdin.on('end', () => {
  socket.end();
  process.exit(0);
});
