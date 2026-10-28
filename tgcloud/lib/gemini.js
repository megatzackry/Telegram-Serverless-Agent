import { HttpClient } from './http.js';
import { AppError } from './errors.js';
import { Secrets } from './secrets.js';
import { ApiLogRepo } from './repositories.js';

const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';

// generateContent client (non-streaming): sub-agents, code edits, and every chat that cannot stream.
// 429/503 backoff lives in HttpClient; this class adds auth, telemetry and error shaping.
export class Gemini {
  constructor(model, startedAt = Date.now()) {
    this.model = model;
    this.startedAt = startedAt;
  }

  async post(payload) {
    const apiKey = await Secrets.require('GEMINI_KEY');
    const t0 = Date.now();
    const { data, status } = await new HttpClient(this.startedAt).postJson(
      `${ENDPOINT}/${this.model}:generateContent`, payload, { 'x-goog-api-key': apiKey },
    );
    const entry = { model: this.model, contents: payload.contents, tools: payload.tools, latencyMs: Date.now() - t0 };

    if (!data || data.error) {
      const error = data?.error ?? { code: 'GEMINI_EMPTY', message: `Empty or unparseable response (HTTP ${status})` };
      await ApiLogRepo.add({ ...entry, error });
      throw new AppError(error.code ?? status, error.message || 'Gemini API error', error);
    }

    const usage = data.usageMetadata ?? {};
    await ApiLogRepo.add({
      ...entry,
      output: Gemini.partsOf(data),
      usage: { prompt: usage.promptTokenCount, candidates: usage.candidatesTokenCount, total: usage.totalTokenCount },
    });
    return data;
  }

  // Worth trying again (possibly on another model)? Client errors like 400 or 402 are not.
  static isTransient(err) {
    if (!(err instanceof AppError)) return true;
    const code = Number(err.code);
    if (Number.isFinite(code)) return code === 429 || code >= 500;
    return err.code === 'GEMINI_EMPTY' || /unavailable|exhausted|rate|overload|timeout|internal/i.test(String(err.code));
  }

  static partsOf(response) { return response?.candidates?.[0]?.content?.parts ?? []; }
  static textOf(response) { return Gemini.partsOf(response).map((p) => p.text).filter(Boolean).join(''); }
  static finishReason(response) { return response?.candidates?.[0]?.finishReason ?? null; }
}
