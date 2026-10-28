import { fetch } from 'sdk';
import { RETRY } from './config.js';
import { ChunkDecoder, withRetry } from './utils.js';

const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

class RetryableResponse extends Error {
  constructor(result) {
    super(`HTTP ${result.status}`);
    this.result = result;
  }
}

// Outbound HTTP with exponential backoff on network errors, 429 and 5xx (honours Retry-After).
// Once retries run out it returns the last response, so callers inspect `ok` / `data.error`.
export class HttpClient {
  constructor(startedAt = Date.now(), policy = RETRY) {
    this.startedAt = startedAt;
    this.policy = policy;
  }

  async request(url, init = {}, { streaming = false } = {}) {
    try {
      return await withRetry(() => this.attempt(url, init, streaming), {
        policy: this.policy, startedAt: this.startedAt, shouldRetry: HttpClient.retryHint,
      });
    } catch (err) {
      if (err instanceof RetryableResponse) return err.result;
      throw err;
    }
  }

  postJson(url, body, headers = {}) {
    return this.request(url, HttpClient.jsonInit(body, headers));
  }

  // POST and read the response body incrementally. Retries only cover getting the stream open;
  // once bytes are flowing a failure is the caller's to handle. onText(text) may be async.
  async postStream(url, body, headers, onText) {
    const result = await this.request(url, HttpClient.jsonInit(body, headers), { streaming: true });
    if (result.response) await HttpClient.pipe(result.response, onText);
    return result;
  }

  async attempt(url, init, streaming) {
    const res = await fetch(url, init);
    if (streaming && res.ok) return { ok: true, status: res.status, response: res };
    const raw = await res.text();
    const result = { ok: res.ok, status: res.status, data: HttpClient.parse(raw), raw, retryAfterMs: HttpClient.retryAfterMs(res) };
    if (RETRYABLE_STATUS.has(res.status)) throw new RetryableResponse(result);
    return result;
  }

  static jsonInit(body, headers = {}) {
    return { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) };
  }

  // Falls back to reading the whole body when it cannot be iterated (no live updates, but still works).
  static async pipe(res, onText) {
    if (res.body && typeof res.body[Symbol.asyncIterator] === 'function') {
      const decoder = new ChunkDecoder();
      for await (const chunk of res.body) await onText(decoder.decode(chunk));
      return;
    }
    await onText(await res.text());
  }

  // Network failures (thrown by fetch) are retried with no hint.
  static retryHint(err) { return err instanceof RetryableResponse ? err.result.retryAfterMs : 0; }

  static parse(raw) { try { return raw ? JSON.parse(raw) : null; } catch { return null; } }

  static retryAfterMs(res) {
    const seconds = Number(res.headers.get('retry-after'));
    return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 0;
  }
}
