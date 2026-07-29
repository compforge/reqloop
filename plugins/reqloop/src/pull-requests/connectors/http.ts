import { ForgeRateLimitError } from "../protocol.ts";

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const DEFAULT_RATE_LIMIT_BACKOFF_MS = 60_000;

export type Fetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface JsonHttpClientOptions {
  readonly fetch?: Fetch;
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
}

export class JsonHttpClient {
  readonly #fetch: Fetch;
  readonly #timeoutMs: number;
  readonly #maxResponseBytes: number;
  #blockedUntil = 0;

  constructor(options: JsonHttpClientOptions = {}) {
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#maxResponseBytes =
      options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  }

  async request(
    method: string,
    url: string,
    init: Omit<RequestInit, "method" | "signal"> = {},
  ): Promise<{ readonly data: unknown; readonly headers: Headers }> {
    const now = Date.now();
    if (this.#blockedUntil > now) {
      throw new ForgeRateLimitError(
        `Forge requests paused after rate limiting`,
        this.#blockedUntil - now,
      );
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
    try {
      const response = await this.#fetch(url, {
        ...init,
        method,
        signal: controller.signal,
      });
      const body = await this.#readBody(response);
      if (!response.ok) {
        if (rateLimited(response, body)) {
          throw this.rateLimit(
            `returned ${response.status}: ${body.slice(0, 500)}`,
            retryAfterMs(response.headers),
          );
        }
        throw new Error(
          `returned ${response.status}: ${body.slice(0, 500)}`,
        );
      }

      try {
        return {
          data: body ? JSON.parse(body) as unknown : undefined,
          headers: response.headers,
        };
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(`returned invalid JSON: ${detail}`);
      }
    } catch (error) {
      if (error instanceof ForgeRateLimitError) throw error;
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`${method} ${url} failed: ${detail}`);
    } finally {
      clearTimeout(timer);
    }
  }

  rateLimit(
    detail: string,
    delayMs = DEFAULT_RATE_LIMIT_BACKOFF_MS,
  ): ForgeRateLimitError {
    const boundedDelay = Math.max(1, delayMs);
    this.#blockedUntil = Math.max(
      this.#blockedUntil,
      Date.now() + boundedDelay,
    );
    return new ForgeRateLimitError(detail, boundedDelay);
  }

  async #readBody(response: Response): Promise<string> {
    const contentLength = Number(response.headers.get("content-length"));
    if (
      Number.isFinite(contentLength) &&
      contentLength > this.#maxResponseBytes
    ) {
      throw new Error(
        `exceeded ${this.#maxResponseBytes} response bytes`,
      );
    }
    if (!response.body) return "";

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let size = 0;
    let text = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > this.#maxResponseBytes) {
        await reader.cancel();
        throw new Error(
          `exceeded ${this.#maxResponseBytes} response bytes`,
        );
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  }
}

function rateLimited(response: Response, body: string): boolean {
  return response.status === 429 ||
    (
      response.status === 403 &&
      (
        response.headers.get("x-ratelimit-remaining") === "0" ||
        /rate.?limit/i.test(body)
      )
    );
}

function retryAfterMs(headers: Headers): number {
  const retryAfter = headers.get("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
    const date = Date.parse(retryAfter);
    if (Number.isFinite(date)) return Math.max(1, date - Date.now());
  }
  const reset = Number(headers.get("x-ratelimit-reset"));
  if (Number.isFinite(reset) && reset > 0) {
    return Math.max(1, reset * 1_000 - Date.now());
  }
  return DEFAULT_RATE_LIMIT_BACKOFF_MS;
}

export function record(name: string, value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

export function records(name: string, value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) {
    throw new Error(`${name} must be an array`);
  }
  return value.map((item, index) => record(`${name}[${index}]`, item));
}

export function nonEmptyString(name: string, value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value;
}

export function positiveLimit(limit: number | undefined): number {
  if (limit === undefined) return 30;
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new Error("PullRequest list limit must be a positive integer");
  }
  return Math.min(limit, 100);
}

export function reviewActivityKey(
  provider: "github" | "gitlab",
  tokens: readonly string[],
): string {
  return createHash("sha256")
    .update(JSON.stringify([provider, [...tokens].sort()]))
    .digest("hex");
}
import { createHash } from "node:crypto";
