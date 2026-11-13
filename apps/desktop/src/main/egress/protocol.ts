const headerBytes = 9;
export const maxEgressFrameBytes = 64 * 1024;
export const egressSubprotocol = 'veyquo.egress.v1';

const kind = {
  open: 1,
  opened: 2,
  data: 3,
  windowUpdate: 4,
  fin: 5,
  reset: 6,
  goaway: 7,
} as const;

export type EgressFrame =
  | { kind: 'open'; streamId: number; hostname: string; port: number }
  | { kind: 'opened'; streamId: number }
  | { kind: 'data'; streamId: number; data: Buffer }
  | { kind: 'window_update'; streamId: number; credit: number }
  | { kind: 'fin'; streamId: number }
  | { kind: 'reset'; streamId: number; code: number }
  | { kind: 'goaway'; streamId: 0; code: number };

function u32(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffff_ffff) {
    throw new Error(`${label} is not uint32`);
  }
  return value;
}

function header(type: number, streamId: number, payload: Buffer): Buffer {
  if (payload.byteLength > maxEgressFrameBytes) throw new Error('egress frame is too large');
  const result = Buffer.allocUnsafe(headerBytes + payload.byteLength);
  result[0] = type;
  result.writeUInt32BE(u32(streamId, 'stream id'), 1);
  result.writeUInt32BE(payload.byteLength, 5);
  payload.copy(result, headerBytes);
  return result;
}

function codePayload(code: number): Buffer {
  if (!Number.isSafeInteger(code) || code < 0 || code > 0xffff) {
    throw new Error('egress code is not uint16');
  }
  const payload = Buffer.allocUnsafe(2);
  payload.writeUInt16BE(code);
  return payload;
}

export function encodeEgressFrame(frame: EgressFrame): Buffer {
  if (frame.kind !== 'goaway' && frame.streamId === 0)
    throw new Error('stream id zero is reserved');
  switch (frame.kind) {
    case 'open': {
      if (!Number.isSafeInteger(frame.port) || frame.port < 1 || frame.port > 0xffff) {
        throw new Error('egress port is not uint16');
      }
      const hostname = Buffer.from(frame.hostname, 'utf8');
      if (hostname.byteLength === 0 || hostname.byteLength > 253) {
        throw new Error('egress hostname has an invalid length');
      }
      const payload = Buffer.allocUnsafe(2 + hostname.byteLength);
      payload.writeUInt16BE(frame.port);
      hostname.copy(payload, 2);
      return header(kind.open, frame.streamId, payload);
    }
    case 'opened':
      return header(kind.opened, frame.streamId, Buffer.alloc(0));
    case 'data':
      return header(kind.data, frame.streamId, frame.data);
    case 'window_update': {
      const payload = Buffer.allocUnsafe(4);
      payload.writeUInt32BE(u32(frame.credit, 'window credit'));
      if (frame.credit === 0) throw new Error('window credit is zero');
      return header(kind.windowUpdate, frame.streamId, payload);
    }
    case 'fin':
      return header(kind.fin, frame.streamId, Buffer.alloc(0));
    case 'reset':
      return header(kind.reset, frame.streamId, codePayload(frame.code));
    case 'goaway':
      return header(kind.goaway, 0, codePayload(frame.code));
    default: {
      const unreachable: never = frame;
      return unreachable;
    }
  }
}

export function decodeEgressFrame(raw: Buffer): EgressFrame {
  if (raw.byteLength < headerBytes || raw.byteLength > headerBytes + maxEgressFrameBytes) {
    throw new Error('egress frame length is invalid');
  }
  const type = raw.readUInt8(0);
  const streamId = raw.readUInt32BE(1);
  const length = raw.readUInt32BE(5);
  if (length !== raw.byteLength - headerBytes)
    throw new Error('egress frame length does not match');
  const payload = raw.subarray(headerBytes);
  if (type !== kind.goaway && streamId === 0) throw new Error('stream id zero is reserved');

  switch (type) {
    case kind.open: {
      if (payload.byteLength < 3 || payload.byteLength > 255)
        throw new Error('OPEN payload is invalid');
      const hostname = payload.subarray(2).toString('utf8');
      if (!Buffer.from(hostname, 'utf8').equals(payload.subarray(2))) {
        throw new Error('OPEN hostname is not UTF-8');
      }
      return { kind: 'open', streamId, port: payload.readUInt16BE(0), hostname };
    }
    case kind.opened:
      if (payload.byteLength !== 0) throw new Error('OPENED payload is not empty');
      return { kind: 'opened', streamId };
    case kind.data:
      if (payload.byteLength === 0) throw new Error('DATA payload is empty');
      return { kind: 'data', streamId, data: Buffer.from(payload) };
    case kind.windowUpdate: {
      if (payload.byteLength !== 4) throw new Error('WINDOW_UPDATE payload is invalid');
      const credit = payload.readUInt32BE();
      if (credit === 0) throw new Error('WINDOW_UPDATE credit is zero');
      return { kind: 'window_update', streamId, credit };
    }
    case kind.fin:
      if (payload.byteLength !== 0) throw new Error('FIN payload is not empty');
      return { kind: 'fin', streamId };
    case kind.reset:
      if (payload.byteLength !== 2) throw new Error('RESET payload is invalid');
      return { kind: 'reset', streamId, code: payload.readUInt16BE() };
    case kind.goaway:
      if (streamId !== 0 || payload.byteLength !== 2) throw new Error('GOAWAY payload is invalid');
      return { kind: 'goaway', streamId: 0, code: payload.readUInt16BE() };
    default:
      throw new Error('egress frame type is unknown');
  }
}
