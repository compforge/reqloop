const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

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
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`${method} ${url} failed: ${detail}`);
    } finally {
      clearTimeout(timer);
    }
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
