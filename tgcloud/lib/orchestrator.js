import { FALLBACK_MODEL, MAX_ORCHESTRATION_ROUNDS, MODEL_FAILOVER, PRIMARY_MODEL, isOwner } from './config.js';
import { AppError } from './errors.js';
import { Gemini } from './gemini.js';
import { buildSystemPrompt } from './prompt.js';
import { Secrets } from './secrets.js';
import { ToolRegistry } from './tools.js';
import { withRetry } from './utils.js';

const FALLBACK_HTML = '<p>Sorry, I could not put together a reply.</p>';

const FINAL_ANSWER_SCHEMA = {
  type: 'OBJECT',
  properties: {
    html: { type: 'STRING' },
    next: { type: 'ARRAY', items: { type: 'STRING' } },
  },
  required: ['html', 'next'],
};

// Decides what a reply needs (tools or not) and returns { html, next }.
// Loop shape: ask the model -> run any tool calls -> feed results back -> repeat until it answers.
export class Orchestrator {
  constructor({ userId, startedAt, draft }) {
    this.startedAt = startedAt;
    this.draft = draft;
    this.tools = new ToolRegistry({ userId, startedAt });
    this.systemPrompt = buildSystemPrompt({ isOwner: isOwner(userId), branch: Secrets.env('BRANCH') ?? 'unknown' });
  }

  async run(history) {
    let model = PRIMARY_MODEL;
    for (let round = 0; round <= MAX_ORCHESTRATION_ROUNDS; round++) {
      const generated = await this.generate(history, model);
      model = generated.model; // stay on whichever model last worked
      const parts = Gemini.partsOf(generated.response);
      const calls = parts.filter((p) => p.functionCall).map((p) => p.functionCall);
      if (!calls.length) return Orchestrator.parseFinal(parts);

      history.push(generated.response.candidates[0].content); // verbatim: preserves the thought signature
      history.push({ role: 'user', parts: await this.runTools(calls) });
    }
    throw new AppError('MAX_ROUNDS', 'Exceeded max orchestration rounds.');
  }

  // Failures alternate between the primary and fallback model with exponential backoff, until the
  // retry budget or the invocation deadline runs out. Non-transient errors (e.g. 400) fail at once.
  generate(history, preferred) {
    const models = [preferred, preferred === PRIMARY_MODEL ? FALLBACK_MODEL : PRIMARY_MODEL];
    return withRetry(async (attempt) => {
      const model = models[(attempt - 1) % 2];
      try {
        const response = await new Gemini(model, this.startedAt).post(this.request(history));
        return { response, model };
      } catch (err) {
        await AppError.handle(err, { model, phase: 'orchestrator' });
        throw err;
      }
    }, { policy: MODEL_FAILOVER, startedAt: this.startedAt, shouldRetry: (err) => (Gemini.isTransient(err) ? 0 : false) });
  }

  request(history) {
    return {
      systemInstruction: { parts: [{ text: this.systemPrompt }] },
      contents: history,
      tools: this.tools.declarations(),
      generationConfig: { temperature: 0, responseMimeType: 'application/json', responseSchema: FINAL_ANSWER_SCHEMA },
    };
  }

  // Sequential on purpose: each call's stage line lands on the draft at the moment it starts.
  async runTools(calls) {
    const parts = [];
    for (const call of calls) {
      const result = await this.tools.execute(call, this.draft);
      parts.push({ functionResponse: { name: call.name, id: call.id, response: { result } } });
    }
    return parts;
  }

  static parseFinal(parts) {
    const text = parts.map((p) => p.text).filter(Boolean).join('');
    try {
      const parsed = JSON.parse(text);
      return { html: parsed.html || FALLBACK_HTML, next: parsed.next || [] };
    } catch {
      return { html: text || FALLBACK_HTML, next: [] }; // schema-adherence failure fallback
    }
  }
}
