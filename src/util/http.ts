export class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly retryable: boolean,
    readonly retryAfterMs: number | null = null,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export interface FetchTextResult {
  status: number;
  headers: Headers;
  body: string;
  bytes: number;
  finalUrl: string;
}

/**
 * GET a URL with a timeout and a response size cap. Network failures and timeouts
 * are thrown as retryable HttpErrors; non-2xx responses are returned to the caller.
 */
export async function fetchText(
  url: string,
  opts: { headers?: Record<string, string>; timeoutMs: number; maxBytes: number; signal?: AbortSignal },
): Promise<FetchTextResult> {
  const timeout = AbortSignal.timeout(opts.timeoutMs);
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
  let res: Response;
  try {
    res = await fetch(url, { headers: opts.headers, redirect: 'follow', signal });
  } catch (err) {
    throw new HttpError(describeFetchError(err, opts.timeoutMs), null, true);
  }
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > opts.maxBytes) {
    await res.body?.cancel();
    throw new HttpError(`Response too large (${declared} bytes)`, res.status, false);
  }
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    if (res.body) {
      for await (const chunk of res.body as AsyncIterable<Uint8Array>) {
        bytes += chunk.byteLength;
        if (bytes > opts.maxBytes) {
          throw new HttpError(`Response exceeded ${opts.maxBytes} bytes`, res.status, false);
        }
        chunks.push(chunk);
      }
    }
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(describeFetchError(err, opts.timeoutMs), null, true);
  }
  const buf = Buffer.concat(chunks);
  return { status: res.status, headers: res.headers, body: decode(buf, res.headers.get('content-type')), bytes, finalUrl: res.url || url };
}

function decode(buf: Buffer, contentType: string | null): string {
  let charset = /charset=["']?([\w-]+)/i.exec(contentType ?? '')?.[1]?.toLowerCase();
  if (!charset) {
    const head = buf.subarray(0, 1024).toString('latin1');
    charset = /encoding=["']([\w-]+)["']/i.exec(head)?.[1]?.toLowerCase() ?? /<meta[^>]+charset=["']?([\w-]+)/i.exec(head)?.[1]?.toLowerCase();
  }
  try {
    return new TextDecoder(charset ?? 'utf-8').decode(buf);
  } catch {
    return new TextDecoder('utf-8').decode(buf);
  }
}

function describeFetchError(err: unknown, timeoutMs: number): string {
  if (err instanceof Error) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') return `Request timed out after ${timeoutMs} ms`;
    const cause = (err as { cause?: { code?: string; message?: string } }).cause;
    if (cause?.code) return `Network error: ${cause.code}${cause.message ? ` (${cause.message})` : ''}`;
    return `Network error: ${err.message}`;
  }
  return 'Network error';
}

export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}
