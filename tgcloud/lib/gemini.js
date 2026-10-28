import { HttpClient } from './http.js';
import { AppError } from './errors.js';
import { Secrets } from './secrets.js';
import { ApiLogRepo } from './repositories.js';

const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';

// Gemini REST client. 429/503 backoff lives in HttpClient; this class adds auth, telemetry and error shaping.
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
    const latencyMs = Date.now() - t0;

    if (!data || data.error) {
      const error = data?.error ?? { code: 'GEMINI_EMPTY', message: `Empty or unparseable response (HTTP ${status})` };
      await ApiLogRepo.add({ model: this.model, payload, error, latencyMs });
      throw new AppError(error.code ?? status, error.message || 'Gemini API error', error);
    }

    await ApiLogRepo.add({ model: this.model, payload, response: data, latencyMs });
    return data;
  }

  // Worth trying again (possibly on another model)? Client errors like 400 are not.
  static isTransient(err) {
    if (!(err instanceof AppError)) return true;
    const code = Number(err.code);
    return err.code === 'GEMINI_EMPTY' || code === 429 || code >= 500;
  }

  static partsOf(response) { return response?.candidates?.[0]?.content?.parts ?? []; }
  static textOf(response) { return Gemini.partsOf(response).map((p) => p.text).filter(Boolean).join(''); }
  static finishReason(response) { return response?.candidates?.[0]?.finishReason ?? null; }
}
