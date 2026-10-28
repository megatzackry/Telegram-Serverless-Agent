// Gemini Interactions API client (streaming). https://ai.google.dev/api/interactions-api
import { AppError } from './errors.js';
import { HttpClient } from './http.js';
import { ApiLogRepo } from './repositories.js';
import { Secrets } from './secrets.js';
import { SseParser } from './utils.js';

const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/interactions';

// Our tool schemas use generateContent-style upper-case types (OBJECT, STRING); Interactions wants JSON Schema.
export class SchemaConverter {
  static lower(node) {
    if (Array.isArray(node)) return node.map(SchemaConverter.lower);
    if (node && typeof node === 'object') {
      return Object.fromEntries(Object.entries(node).map(([k, v]) => [
        k, k === 'type' && typeof v === 'string' ? v.toLowerCase() : SchemaConverter.lower(v),
      ]));
    }
    return node;
  }

  static tool(declaration) {
    return { type: 'function', name: declaration.name, description: declaration.description, parameters: SchemaConverter.lower(declaration.parameters) };
  }
}

// Folds the SSE events of one interaction into text + function calls.
// Events: interaction.created, step.start, step.delta, step.stop, interaction.status_update, interaction.completed, error.
export class InteractionStream {
  constructor() {
    this.id = null;
    this.status = null;
    this.usage = null;
    this.steps = [];
    this.text = '';
  }

  apply(event) {
    switch (event.event_type) {
      case 'interaction.created':
        this.id = event.interaction?.id ?? this.id;
        break;
      case 'interaction.status_update':
        this.status = event.status;
        this.id = this.id ?? event.interaction_id;
        break;
      case 'interaction.completed':
        this.status = event.interaction?.status ?? this.status;
        this.usage = event.interaction?.usage ?? this.usage;
        this.id = this.id ?? event.interaction?.id;
        break;
      case 'step.start':
        this.steps[event.index] = { ...event.step, argText: '' };
        break;
      case 'step.delta':
        this.applyDelta(event.index, event.delta ?? {});
        break;
      case 'error':
        throw new AppError(event.error?.code ?? 'INTERACTION_ERROR', event.error?.message ?? 'Interaction stream error', event.error);
      default:
    }
  }

  applyDelta(index, delta) {
    const step = (this.steps[index] = this.steps[index] ?? { argText: '' });
    if (delta.type === 'text' && step.type !== 'thought') this.text += delta.text ?? '';
    else if (delta.type === 'arguments_delta') step.argText += delta.arguments ?? '';
  }

  get calls() {
    return this.steps
      .filter((s) => s?.type === 'function_call')
      .map((s) => ({ id: s.id, name: s.name, args: InteractionStream.parseArgs(s) }));
  }

  // Arguments arrive as streamed JSON text; some servers put the finished object on the step itself.
  static parseArgs(step) {
    if (step.argText) {
      try { return JSON.parse(step.argText); } catch { /* fall through */ }
    }
    return step.arguments ?? {};
  }

  assertUsable() {
    if (this.status === 'failed') throw new AppError('INTERACTION_FAILED', 'The interaction ended with status "failed".', { id: this.id });
    if (!this.text && !this.calls.length) throw new AppError('GEMINI_EMPTY', 'The stream produced no output.', { id: this.id });
  }

  output() { return { text: this.text.slice(0, 4000), calls: this.calls }; }

  usageSummary() {
    return { prompt: this.usage?.total_input_tokens, candidates: this.usage?.total_output_tokens, total: this.usage?.total_tokens };
  }
}

export class Interactions {
  constructor(startedAt = Date.now()) { this.startedAt = startedAt; }

  // Streams one interaction. onText(textSoFar) fires as output arrives and may be async.
  async stream(body, { onText } = {}) {
    const apiKey = await Secrets.require('GEMINI_KEY');
    const stream = new InteractionStream();
    const parser = new SseParser();
    const t0 = Date.now();
    const entry = { model: `${body.model} [stream]`, contents: body.input, tools: body.tools };

    try {
      const res = await new HttpClient(this.startedAt).postStream(ENDPOINT, body, { 'x-goog-api-key': apiKey }, async (text) => {
        for (const event of parser.feed(text)) stream.apply(event);
        if (onText) await onText(stream.text);
      });
      if (!res.ok) {
        const e = res.data?.error ?? res.data?.[0]?.error ?? { code: res.status, message: `HTTP ${res.status}` };
        throw new AppError(e.code ?? res.status, e.message, e);
      }
      for (const event of parser.flush()) stream.apply(event);
      stream.assertUsable();
    } catch (err) {
      await ApiLogRepo.add({ ...entry, latencyMs: Date.now() - t0, error: { code: err.code ?? 'ERROR', message: err.message } });
      throw err;
    }

    await ApiLogRepo.add({ ...entry, latencyMs: Date.now() - t0, output: stream.output(), usage: stream.usageSummary() });
    return stream;
  }
}
