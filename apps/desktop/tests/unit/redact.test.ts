import { describe, expect, it } from 'vitest';

import { redact, redactError } from '../../src/main/redact.ts';

const longText = 'word '.repeat(60);

describe('redact', () => {
  it.each([
    {
      case: 'drops a URL query string and fragment',
      input: 'POST https://api.veyquo.com/v1/devices/pairings?code=ABCD2345#x answered 500',
      output: 'POST https://api.veyquo.com/[path] answered 500',
    },
    {
      case: 'drops a WebSocket query string',
      input: 'connect wss://api.veyquo.com/v1/devices/connect?token=abc failed',
      output: 'connect wss://api.veyquo.com/[path] failed',
    },
    {
      case: 'keeps only the origin of a URL: paths can name people or jobs',
      input: 'GET https://jobs.example.com/ana-lopez/applications/42 failed',
      output: 'GET https://jobs.example.com/[path] failed',
    },
    {
      case: 'keeps a bare origin as it is',
      input: 'GET http://localhost:8400/ and http://127.0.0.1:9',
      output: 'GET http://localhost:8400/ and http://127.0.0.1:9',
    },
    {
      case: 'replaces an email address',
      input: 'no account for ana.lopez+jobs@example.co.uk here',
      output: 'no account for [email] here',
    },
    {
      case: 'replaces a token-like string',
      input: 'Bearer eyJhbGciOiJFZERTQSJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJlc2ln rejected',
      output: 'Bearer [redacted] rejected',
    },
    {
      case: 'keeps a UUID, which is an id',
      input: 'device 6f1c2b8e-0d5a-4c33-9d0e-2a1b3c4d5e6f went offline',
      output: 'device 6f1c2b8e-0d5a-4c33-9d0e-2a1b3c4d5e6f went offline',
    },
    {
      case: 'cuts anything over 200 characters',
      input: longText,
      output: `${longText.slice(0, 200)}…`,
    },
    { case: 'leaves an empty message empty', input: '', output: '' },
  ])('$case', ({ input, output }) => {
    expect(redact(input)).toBe(output);
  });

  it('replaces the home directory, which carries the user name', () => {
    expect(redact('EACCES /home/ana/.config/Veyquo/journal.jsonl', { home: '/home/ana' })).toBe(
      'EACCES ~/.config/Veyquo/journal.jsonl',
    );
  });

  it('reads any thrown value as a redacted name and message', () => {
    const error = new TypeError('fetch https://api.example.com/x?secret=1 failed for a@b.io');
    expect(redactError(error)).toEqual({
      name: 'TypeError',
      message: 'fetch https://api.example.com/[path] failed for [email]',
    });
    expect(redactError('a string')).toEqual({ name: 'unknown', message: '' });
  });
});
