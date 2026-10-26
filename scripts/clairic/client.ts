// Minimal REST client for Cloudflare's Clairic extraction model (Workers AI, preview). Research only:
// nothing under src/ may import this. Schemas: the request/response JSON Schemas from the model card.
export type ClairicFieldType = "text" | "number" | "date" | "time" | "datetime" | "duration" | "list" | "estimate" | "forecast";

export interface ClairicField {
  type: ClairicFieldType;
  instructions?: string;
  unit?: string;
  integer?: boolean;
  decimals?: number;
  items?: "text" | "number" | "date";
  min?: unknown;
  max?: unknown;
  step?: unknown;
  scale?: "linear" | "log";
  null_threshold?: number;
}

export interface ClairicAnswer {
  type: string;
  value: unknown;
  guess?: unknown;
  p_null?: number;
  confidence?: number;
  span?: number[];
  spans?: number[][];
  mean?: unknown;
  median?: unknown;
  p10?: unknown;
  p90?: unknown;
}

export interface ClairicUsage {
  state_tokens?: number;
  schema_tokens?: number;
  input_tokens: number;
  output_tokens: number;
  passes?: number;
}

export interface ClairicResult {
  answers: Record<string, ClairicAnswer>;
  usage: ClairicUsage;
  truncated: boolean;
  ms: number;
}

export interface ClairicRequest {
  state: string;
  fields: Record<string, ClairicField>;
  reference_date?: string;
}

export interface ClairicConfig {
  accountId: string;
  token: string;
  /** Override for tests; default is the public API. */
  baseUrl?: string;
}

export class ClairicError extends Error {
  constructor(message: string, public status: number, public permanent: boolean) {
    super(message);
  }
}

export const MODEL = "@cf/cloudflare/clairic";
const RETRIES = 3;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** POST one request; retries 429/5xx with backoff; unwraps the Cloudflare `{success, result, errors}` envelope. */
export async function clairic(cfg: ClairicConfig, req: ClairicRequest): Promise<ClairicResult> {
  const url = `${cfg.baseUrl ?? "https://api.cloudflare.com/client/v4"}/accounts/${cfg.accountId}/ai/run/${MODEL}`;
  const body = JSON.stringify({ model: "clairic", ...req });
  const started = Date.now();
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(url, { method: "POST", headers: { authorization: `Bearer ${cfg.token}`, "content-type": "application/json" }, body });
    const text = await res.text();
    if (res.ok) {
      const env = JSON.parse(text) as { success?: boolean; result?: Omit<ClairicResult, "ms">; errors?: { code: number; message: string }[] };
      if (env.success === false || !env.result) throw new ClairicError(`clairic: ${JSON.stringify(env.errors ?? env)}`, res.status, true);
      return { ...env.result, ms: Date.now() - started };
    }
    const transient = res.status === 429 || res.status >= 500;
    if (!transient || attempt >= RETRIES) throw new ClairicError(`clairic ${res.status}: ${text.slice(0, 300)}`, res.status, !transient);
    await sleep(500 * 2 ** attempt);
  }
}
