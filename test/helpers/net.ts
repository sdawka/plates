// One global fetch stub for a test. Fakes register a route by URL prefix; anything unmatched
// throws, so a test can never reach the real network by accident.
import { vi } from "vitest";

export type Handler = (req: Request) => Response | Promise<Response>;

export interface RecordedRequest {
  url: string;
  method: string;
  headers: Headers;
  body: string;
}

export class Network {
  private routes: { prefix: string; handler: Handler }[] = [];
  readonly unmatched: RecordedRequest[] = [];

  /** Longest prefix wins. */
  route(prefix: string, handler: Handler): void {
    this.routes.push({ prefix, handler });
    this.routes.sort((a, b) => b.prefix.length - a.prefix.length);
  }

  install(): void {
    vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => this.fetch(new Request(input as RequestInfo, init)));
  }

  uninstall(): void {
    vi.unstubAllGlobals();
  }

  async fetch(req: Request): Promise<Response> {
    const url = req.url;
    const hit = this.routes.find((r) => url.startsWith(r.prefix));
    if (!hit) {
      this.unmatched.push({ url, method: req.method, headers: req.headers, body: await req.clone().text() });
      throw new TypeError(`fetch failed: no fake registered for ${req.method} ${url}`);
    }
    return hit.handler(req);
  }
}

export const json = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", ...headers } });
