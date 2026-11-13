import { lookup as systemLookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import { domainToASCII } from 'node:url';

export interface ResolvedDestination {
  hostname: string;
  address: string;
  family: 4 | 6;
}

export type Lookup = (
  hostname: string,
  options: { all: true; verbatim: true },
) => Promise<{ address: string; family: number }[]>;

const blockedV4 = new BlockList();
const blockedV6 = new BlockList();

for (const [network, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  blockedV4.addSubnet(network, prefix, 'ipv4');
}

for (const [network, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['::ffff:0:0', 96],
  ['64:ff9b:1::', 48],
  ['100::', 64],
  ['2001:10::', 28],
  ['2001:db8::', 32],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
] as const) {
  blockedV6.addSubnet(network, prefix, 'ipv6');
}

function normalizeHostname(raw: string): string {
  let hasControl = false;
  for (let index = 0; index < raw.length; index += 1) {
    const code = raw.charCodeAt(index);
    if (code <= 0x20 || code === 0x7f) {
      hasControl = true;
      break;
    }
  }
  if (raw.length === 0 || raw.length > 253 || hasControl || /[/@\\[\]]/u.test(raw)) {
    throw new Error('destination hostname is invalid');
  }
  if (isIP(raw) !== 0) throw new Error('IP-literal destinations are not allowed');
  const hostname = domainToASCII(raw.replace(/\.$/u, '')).toLowerCase();
  if (
    hostname.length === 0 ||
    hostname.length > 253 ||
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local')
  ) {
    throw new Error('destination hostname is not public');
  }
  const labels = hostname.split('.');
  if (
    labels.length < 2 ||
    labels.some(
      (label) =>
        label.length === 0 ||
        label.length > 63 ||
        label.startsWith('-') ||
        label.endsWith('-') ||
        !/^[a-z0-9-]+$/u.test(label),
    )
  ) {
    throw new Error('destination hostname is invalid');
  }
  return hostname;
}

function publicAddress(address: string, family: number): address is string {
  if (family === 4) return isIP(address) === 4 && !blockedV4.check(address, 'ipv4');
  if (family === 6) return isIP(address) === 6 && !blockedV6.check(address, 'ipv6');
  return false;
}

/** Resolve a hostname once and pin the connection to one validated numeric address.
 * If any answer is non-public the entire set is rejected, preventing mixed-answer rebinding. */
export async function resolvePublicDestination(
  rawHostname: string,
  lookup: Lookup = systemLookup,
): Promise<ResolvedDestination> {
  const hostname = normalizeHostname(rawHostname);
  const answers = await lookup(hostname, { all: true, verbatim: true });
  if (
    answers.length === 0 ||
    answers.some((answer) => !publicAddress(answer.address, answer.family))
  ) {
    throw new Error('destination did not resolve only to public addresses');
  }
  const selected = answers[0];
  if (selected === undefined || (selected.family !== 4 && selected.family !== 6)) {
    throw new Error('destination address family is unsupported');
  }
  return { hostname, address: selected.address, family: selected.family };
}

export function sameAddress(expected: string, actual: string | undefined): boolean {
  if (actual === undefined) return false;
  return expected.toLowerCase() === actual.toLowerCase();
}
