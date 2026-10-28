// Two ways to run one model round, behind the same small interface so the Orchestrator does not care:
//   InteractionsBackend    - streaming (Interactions API), used only where a live draft is possible
//   GenerateContentBackend - plain generateContent, used everywhere else and as the fallback
import { Gemini } from './gemini.js';
import { AppError } from './errors.js';
import { Interactions, SchemaConverter } from './interactions.js';
import { JsonStringField } from './utils.js';

export const FINAL_ANSWER_SCHEMA = {
  type: 'OBJECT',
  properties: {
    html: { type: 'STRING' },
    next: { type: 'ARRAY', items: { type: 'STRING' } },
  },
  required: ['html', 'next'],
};

// Both backends take history as [{ role: 'user' | 'model', parts: [{ text }] }] and return
// { calls: [{ id, name, args }], text } from generate(model).

export class GenerateContentBackend {
  constructor({ systemPrompt, declarations, startedAt }) {
    this.systemPrompt = systemPrompt;
    this.declarations = declarations;
    this.startedAt = startedAt;
    this.streaming = false;
  }

  begin(history) { this.contents = [...history]; }

  async generate(model) {
    const response = await new Gemini(model, this.startedAt).post({
      systemInstruction: { parts: [{ text: this.systemPrompt }] },
      contents: this.contents,
      tools: this.declarations,
      generationConfig: { temperature: 0, responseMimeType: 'application/json', responseSchema: FINAL_ANSWER_SCHEMA },
    });
    const parts = Gemini.partsOf(response);
    const calls = parts.filter((p) => p.functionCall).map((p) => ({ id: p.functionCall.id, name: p.functionCall.name, args: p.functionCall.args ?? {} }));
    if (calls.length) this.contents.push(response.candidates[0].content); // verbatim: preserves the thought signature
    return { calls, text: parts.map((p) => p.text).filter(Boolean).join('') };
  }

  addToolResults(results) {
    this.contents.push({
      role: 'user',
      parts: results.map((r) => ({ functionResponse: { name: r.name, id: r.id, response: { result: r.result } } })),
    });
  }
}

export class InteractionsBackend {
  constructor({ systemPrompt, functions, startedAt, draft }) {
    this.systemPrompt = systemPrompt;
    this.tools = functions.map(SchemaConverter.tool);
    this.startedAt = startedAt;
    this.draft = draft;
    this.streaming = true;
  }

  begin(history) {
    this.input = history.map(InteractionsBackend.toStep);
    this.previousId = null;
  }

  static toStep(turn) {
    const content = turn.parts.filter((p) => p.text).map((p) => ({ type: 'text', text: p.text }));
    return { type: turn.role === 'model' ? 'model_output' : 'user_input', content };
  }

  // Tool rounds continue the stored interaction (previous_interaction_id), so thought signatures
  // stay server-side. Instructions, tools and the output format are re-sent each round.
  request(model) {
    return {
      model,
      input: this.input,
      system_instruction: this.systemPrompt,
      tools: this.tools,
      response_format: { type: 'text', mime_type: 'application/json', schema: SchemaConverter.lower(FINAL_ANSWER_SCHEMA) },
      stream: true,
      store: true,
      ...(this.previousId && { previous_interaction_id: this.previousId }),
    };
  }

  async generate(model) {
    const htmlField = new JsonStringField('html');
    const result = await new Interactions(this.startedAt).stream(this.request(model), {
      onText: (text) => {
        const { value } = htmlField.extract(text);
        return value ? this.draft.preview(value) : undefined;
      },
    });
    if (result.calls.length && !result.id) throw new AppError('NO_INTERACTION_ID', 'Stream carried function calls but no interaction id.');
    this.previousId = result.id;
    return { calls: result.calls, text: result.text };
  }

  addToolResults(results) {
    this.input = results.map((r) => ({ type: 'function_result', call_id: r.id, name: r.name, result: r.result }));
  }
}
