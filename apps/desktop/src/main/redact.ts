// Scrubs text before it reaches a log line or a crash record (desktop plan §7, global
// constraints: ids only). Every logger and the crash handler pass messages through here.
// Crash upload stays off; this keeps the local records clean too.

const maxLength = 200;

// A URL up to the first character that cannot be in one; its query and fragment go.
const urlPattern = /\b(?:https?|wss?|file):\/\/[^\s"'<>`]+/giu;
const emailPattern = /[\w.%+-]+@[\w-]+(?:\.[\w-]+)+/gu;
// Long runs of token characters: JWTs, base64 keys, signatures, cookies.
const tokenPattern = /[A-Za-z0-9_\-+/=.]{32,}/gu;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/** Only the scheme and host survive: a path can name a person, a job or a token. */
function originOnly(url: string): string {
  const match = /^([a-z]+:\/\/[^/?#]*)(.*)$/iu.exec(url);
  if (match === null) return '[url]';
  const [, origin = '', rest = ''] = match;
  return rest === '' || rest === '/' ? `${origin}${rest}` : `${origin}/[path]`;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

export function redact(text: string, options: { home?: string } = {}): string {
  let out = text;
  if (options.home !== undefined && options.home.length > 1) {
    out = out.replace(new RegExp(escapeRegExp(options.home), 'gu'), '~');
  }
  // URLs first: their paths are kept, so the token rule must not see their queries.
  const urls: string[] = [];
  out = out.replace(urlPattern, (url) => {
    urls.push(originOnly(url));
    return `\uE000${String(urls.length - 1)}\uE001`;
  });
  out = out.replace(emailPattern, '[email]');
  out = out.replace(tokenPattern, (run) => (uuidPattern.test(run) ? run : '[redacted]'));
  out = out.replace(/\uE000(\d+)\uE001/gu, (_, index: string) => urls[Number(index)] ?? '');
  return out.length > maxLength ? `${out.slice(0, maxLength)}…` : out;
}

/** The parts of a thrown value that may be logged: its class name and redacted message. */
export function redactError(
  error: unknown,
  options: { home?: string } = {},
): { name: string; message: string } {
  if (error instanceof Error) {
    return { name: error.name, message: redact(error.message, options) };
  }
  return { name: 'unknown', message: '' };
}
