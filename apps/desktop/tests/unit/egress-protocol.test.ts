import { describe, expect, it } from 'vitest';

import {
  decodeEgressFrame,
  encodeEgressFrame,
  maxEgressFrameBytes,
  type EgressFrame,
} from '../../src/main/egress/protocol.ts';

describe('device egress binary protocol', () => {
  it.each<EgressFrame>([
    { kind: 'open', streamId: 1, hostname: 'jobs.example.com', port: 443 },
    { kind: 'opened', streamId: 1 },
    { kind: 'data', streamId: 9, data: Buffer.from('tls bytes') },
    { kind: 'window_update', streamId: 9, credit: 262_144 },
    { kind: 'fin', streamId: 9 },
    { kind: 'reset', streamId: 9, code: 2 },
    { kind: 'goaway', streamId: 0, code: 1 },
  ])('round trips $kind', (frame) => {
    expect(decodeEgressFrame(encodeEgressFrame(frame))).toEqual(frame);
  });

  it('refuses oversized payloads and stream id zero', () => {
    expect(() =>
      encodeEgressFrame({
        kind: 'data',
        streamId: 1,
        data: Buffer.alloc(maxEgressFrameBytes + 1),
      }),
    ).toThrow('too large');
    expect(() => encodeEgressFrame({ kind: 'fin', streamId: 0 })).toThrow('reserved');
  });

  it('refuses malformed or non-canonical frame lengths', () => {
    const frame = encodeEgressFrame({ kind: 'data', streamId: 1, data: Buffer.from('x') });
    frame.writeUInt32BE(2, 5);
    expect(() => decodeEgressFrame(frame)).toThrow('does not match');
    expect(() => decodeEgressFrame(Buffer.alloc(8))).toThrow('length');
  });
});
