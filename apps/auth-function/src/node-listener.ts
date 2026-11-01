import type { IncomingMessage, ServerResponse } from 'node:http';
import { MAX_BODY_BYTES } from './handler.ts';

/*
 * The fetch handler as a Node request listener, which is what an HTTPS
 * Firebase Function is handed (#663). Firebase has already read the body
 * into `rawBody`; a plain Node server has not, so it is read here, and no
 * further than the handler would accept.
 */

/** A Node request, as Firebase's (Express) hands it: perhaps with its body already read. */
export type FunctionRequest = IncomingMessage & { rawBody?: Buffer };

/** Requests are matched on their path alone; this origin is never contacted. */
const BASE = 'http://function.invalid';

export function nodeListener(
  handle: (request: Request) => Promise<Response>,
): (req: FunctionRequest, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    let response: Response;
    try {
      response = await handle(await toRequest(req));
    } catch {
      // Nothing about the failure leaves the function: its message could hold a token.
      response = new Response(JSON.stringify({ error: 'unavailable' }), {
        status: 500,
        headers: { 'Cache-Control': 'no-store', 'Content-Type': 'application/json' },
      });
    }
    await send(response, res);
  };
}

async function toRequest(req: FunctionRequest): Promise<Request> {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(', ') : value);
  }
  const method = req.method ?? 'GET';
  const body = method === 'GET' || method === 'HEAD' ? null : await bodyOf(req);
  return new Request(new URL(req.url ?? '/', BASE), { method, headers, body });
}

/** The body, cut one byte past the limit so the handler still sees it is too long. */
async function bodyOf(req: FunctionRequest): Promise<Uint8Array<ArrayBuffer>> {
  if (req.rawBody) return new Uint8Array(req.rawBody.subarray(0, MAX_BODY_BYTES + 1));
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    chunks.push(chunk);
    length += chunk.length;
    if (length > MAX_BODY_BYTES) break;
  }
  return new Uint8Array(Buffer.concat(chunks).subarray(0, MAX_BODY_BYTES + 1));
}

async function send(response: Response, res: ServerResponse): Promise<void> {
  res.statusCode = response.status;
  response.headers.forEach((value, name) => {
    if (name !== 'set-cookie') res.setHeader(name, value);
  });
  const cookies = response.headers.getSetCookie();
  if (cookies.length > 0) res.setHeader('Set-Cookie', cookies);
  res.end(Buffer.from(await response.arrayBuffer()));
}
