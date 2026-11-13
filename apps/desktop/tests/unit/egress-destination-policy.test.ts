import { describe, expect, it } from 'vitest';

import {
  resolvePublicDestination,
  sameAddress,
  type Lookup,
} from '../../src/main/egress/destination-policy.ts';

function answers(...values: { address: string; family: number }[]): Lookup {
  return () => Promise.resolve(values);
}

describe('device egress destination policy', () => {
  it('normalizes a public hostname and pins its numeric address', async () => {
    await expect(
      resolvePublicDestination(
        'Jobs.Example.COM.',
        answers({ address: '93.184.216.34', family: 4 }),
      ),
    ).resolves.toEqual({
      hostname: 'jobs.example.com',
      address: '93.184.216.34',
      family: 4,
    });
  });

  it.each([
    '127.0.0.1',
    '::1',
    'localhost',
    'api.localhost',
    'printer.local',
    'user@example.com',
    'example.com/path',
    'single-label',
  ])('rejects non-public or ambiguous hostname %s', async (hostname) => {
    await expect(
      resolvePublicDestination(hostname, answers({ address: '93.184.216.34', family: 4 })),
    ).rejects.toThrow();
  });

  it.each([
    '0.0.0.0',
    '10.0.0.1',
    '100.64.0.1',
    '127.0.0.1',
    '169.254.169.254',
    '172.16.0.1',
    '192.168.1.1',
    '198.51.100.1',
    '224.0.0.1',
  ])('rejects IPv4 answer %s', async (address) => {
    await expect(
      resolvePublicDestination('example.com', answers({ address, family: 4 })),
    ).rejects.toThrow('public addresses');
  });

  it.each(['::', '::1', '::ffff:127.0.0.1', 'fc00::1', 'fe80::1', 'ff02::1', '2001:db8::1'])(
    'rejects IPv6 answer %s',
    async (address) => {
      await expect(
        resolvePublicDestination('example.com', answers({ address, family: 6 })),
      ).rejects.toThrow('public addresses');
    },
  );

  it('rejects a mixed public and private DNS answer set', async () => {
    await expect(
      resolvePublicDestination(
        'example.com',
        answers({ address: '93.184.216.34', family: 4 }, { address: '192.168.1.20', family: 4 }),
      ),
    ).rejects.toThrow('public addresses');
  });

  it('requires the connected peer to match the pinned address', () => {
    expect(sameAddress('2001:4860:4860::8888', '2001:4860:4860::8888')).toBe(true);
    expect(sameAddress('93.184.216.34', '93.184.216.35')).toBe(false);
    expect(sameAddress('93.184.216.34', undefined)).toBe(false);
  });
});
