import { fetch } from 'sdk';
import { RETRY } from './config.js';
import { withRetry } from './utils.js';

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

  async request(url, init = {}) {
    try {
      return await withRetry(() => this.attempt(url, init), {
        policy: this.policy, startedAt: this.startedAt, shouldRetry: HttpClient.retryHint,
      });
    } catch (err) {
      if (err instanceof RetryableResponse) return err.result;
      throw err;
    }
  }

  postJson(url, body, headers = {}) {
    return this.request(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body),
    });
  }

  async attempt(url, init) {
    const res = await fetch(url, init);
    const raw = await res.text();
    const result = { ok: res.ok, status: res.status, data: HttpClient.parse(raw), raw, retryAfterMs: HttpClient.retryAfterMs(res) };
    if (RETRYABLE_STATUS.has(res.status)) throw new RetryableResponse(result);
    return result;
  }

  // Network failures (thrown by fetch) are retried with no hint.
  static retryHint(err) { return err instanceof RetryableResponse ? err.result.retryAfterMs : 0; }

  static parse(raw) { try { return raw ? JSON.parse(raw) : null; } catch { return null; } }

  static retryAfterMs(res) {
    const seconds = Number(res.headers.get('retry-after'));
    return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 0;
  }
}
