import { FALLBACK_MODEL, MAX_ORCHESTRATION_ROUNDS, MODEL_FAILOVER, PRIMARY_MODEL } from './config.js';
import { GenerateContentBackend, InteractionsBackend } from './backends.js';
import { AppError } from './errors.js';
import { Gemini } from './gemini.js';
import { buildSystemPrompt } from './prompt.js';
import { Secrets } from './secrets.js';
import { ToolRegistry } from './tools.js';
import { withRetry } from './utils.js';

const FALLBACK_HTML = '<p>Sorry, I could not put together a reply.</p>';

// Decides what a reply needs (tools or not) and returns { html, next }.
// Loop: ask the model -> run any tool calls -> feed results back -> repeat until it answers.
// Where a live draft exists (private chats) the model is streamed through the Interactions API;
// everywhere else, and whenever streaming fails, the same loop runs on generateContent.
export class Orchestrator {
  constructor({ userId, startedAt, draft }) {
    this.userId = userId;
    this.startedAt = startedAt;
    this.draft = draft;
    this.tools = new ToolRegistry({ userId, startedAt });
    this.systemPrompt = buildSystemPrompt({ branch: Secrets.env('BRANCH') ?? 'unknown' });
  }

  makeBackend(streaming) {
    const base = { systemPrompt: this.systemPrompt, startedAt: this.startedAt };
    return streaming
      ? new InteractionsBackend({ ...base, functions: this.tools.functions(), draft: this.draft })
      : new GenerateContentBackend({ ...base, declarations: this.tools.declarations() });
  }

  async run(history) {
    if (!this.draft.enabled) return this.loop(history, this.makeBackend(false));
    try {
      return await this.loop(history, this.makeBackend(true));
    } catch (err) {
      await AppError.handle(new AppError('STREAM_FALLBACK', 'Streaming failed; this turn is re-run on generateContent.', AppError.from(err).message), { userId: this.userId });
      this.tools.rewind(); // tool calls already made are replayed, not repeated
      return this.loop(history, this.makeBackend(false));
    }
  }

  async loop(history, backend) {
    backend.begin(history);
    let model = PRIMARY_MODEL;
    for (let round = 0; round <= MAX_ORCHESTRATION_ROUNDS; round++) {
      const out = await this.generate(backend, model);
      model = out.model; // stay on whichever model last worked
      if (!out.calls.length) return Orchestrator.parseFinal(out.text);
      await backend.addToolResults(await this.runTools(out.calls));
    }
    throw new AppError('MAX_ROUNDS', 'Exceeded max orchestration rounds.');
  }

  // Failures alternate between the primary and fallback model with exponential backoff, until the
  // retry budget or the invocation deadline runs out. Non-transient errors (e.g. 400, 402) fail at once.
  generate(backend, preferred) {
    const models = [preferred, preferred === PRIMARY_MODEL ? FALLBACK_MODEL : PRIMARY_MODEL];
    return withRetry(async (attempt) => {
      const model = models[(attempt - 1) % 2];
      try {
        return { ...(await backend.generate(model)), model };
      } catch (err) {
        await AppError.handle(err, { model, phase: 'orchestrator', streaming: backend.streaming });
        throw err;
      }
    }, { policy: MODEL_FAILOVER, startedAt: this.startedAt, shouldRetry: (err) => (Gemini.isTransient(err) ? 0 : false) });
  }

  // Sequential on purpose: each call's stage line lands on the draft at the moment it starts.
  async runTools(calls) {
    const results = [];
    for (const call of calls) {
      results.push({ id: call.id, name: call.name, result: await this.tools.execute(call, this.draft) });
    }
    return results;
  }

  static parseFinal(text) {
    try {
      const parsed = JSON.parse(text);
      return { html: parsed.html || FALLBACK_HTML, next: parsed.next || [] };
    } catch {
      return { html: text || FALLBACK_HTML, next: [] }; // schema-adherence failure fallback
    }
  }
}
