import { AsyncLocalStorage } from "node:async_hooks";

/** One HTTP round trip. An SDK call that retries produces several of these. */
export interface Attempt {
  startedAt: number;
  durationMs: number;
  status: number | null;
  requestBytes: number | null;
  responseBytes: number | null;
  requestId: string | null;
  error: string | null;
}

export interface CallTrace {
  attempts: Attempt[];
}

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

const traces = new AsyncLocalStorage<CallTrace>();
const encoder = new TextEncoder();

function byteLength(body: RequestInit["body"]): number | null {
  if (body == null) return 0;
  if (typeof body === "string") return encoder.encode(body).byteLength;
  if (body instanceof ArrayBuffer) return body.byteLength;
  if (ArrayBuffer.isView(body)) return body.byteLength;
  return null;
}

/**
 * Wraps fetch so every attempt made inside `traceCall` is timed and sized. Both SDKs accept a custom
 * fetch, so application code cannot forget to record a call, and retries are counted per attempt.
 */
export function instrumentedFetch(base: FetchLike = globalThis.fetch): FetchLike {
  return async (input, init) => {
    const trace = traces.getStore();
    if (!trace) return base(input, init);

    const attempt: Attempt = {
      startedAt: Date.now(),
      durationMs: 0,
      status: null,
      requestBytes: byteLength(init?.body),
      responseBytes: null,
      requestId: null,
      error: null,
    };
    trace.attempts.push(attempt);
    const started = performance.now();
    try {
      const response = await base(input, init);
      attempt.status = response.status;
      attempt.requestId = response.headers.get("x-typesafe-request-id") ?? response.headers.get("request-id");
      // Reading a clone measures the decoded body and makes the duration cover the full download.
      attempt.responseBytes = (await response.clone().arrayBuffer()).byteLength;
      return response;
    } catch (error) {
      attempt.error = error instanceof Error ? error.message : String(error);
      throw error;
    } finally {
      attempt.durationMs = performance.now() - started;
    }
  };
}

export type Settled<T> = { ok: true; value: T } | { ok: false; error: unknown };

/** Runs `fn` and returns the HTTP attempts it made, whether it resolved or threw. */
export async function traceCall<T>(fn: () => Promise<T>): Promise<{ trace: CallTrace; wallMs: number; outcome: Settled<T> }> {
  const trace: CallTrace = { attempts: [] };
  const started = performance.now();
  const outcome = await traces.run(trace, async (): Promise<Settled<T>> => {
    try {
      return { ok: true, value: await fn() };
    } catch (error) {
      return { ok: false, error };
    }
  });
  return { trace, wallMs: performance.now() - started, outcome };
}
