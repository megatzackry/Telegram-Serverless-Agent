// Tools the orchestrator can call. Each tool owns its declaration, its status line, and its execution.
import { MODEL_TIERS, SUB_AGENT_DEFAULT_MODEL, ACTION_EMOJIS } from './config.js';
import { AppError } from './errors.js';
import { Gemini } from './gemini.js';
import { GitHubAgent } from './github.js';
import { HttpClient } from './http.js';
import { Secrets } from './secrets.js';

const EMOJI_KEYS = Object.keys(ACTION_EMOJIS).filter((k) => k !== 'searching');

// Genuine sub-tasks worth handing off before the orchestrator writes its own final reply.
const AGENT_REGISTRY = {
  'URL Inspector': {
    tools: [{ url_context: {} }],
    systemPrompt: 'You inspect the given URL(s) and extract exactly what was asked for. Plain text only, be factual and concise.',
  },
  'Custom Agent': {
    tools: [],
    systemPrompt: 'You are a general-purpose reasoning sub-agent. Complete exactly the task described in the prompt (e.g. digesting a long pasted block of text, translating something, working through a side calculation) and return plain text only.',
  },
};

class Tool {
  constructor(declaration, ctx) {
    this.declaration = declaration;
    this.ctx = ctx; // { userId, startedAt }
  }

  get name() { return this.declaration.name; }
  isAvailable() { return true; }
  describe(args) { return args?.action || 'Working on it'; }
  emojiKey() { return 'thinking'; }
  async run() { throw new AppError('NOT_IMPLEMENTED', `${this.name} has no run()`); }

  // Tool failures go back to the model as plain strings so it can react, never as exceptions.
  async fail(err, payload, prefix) {
    const e = await AppError.handle(err, payload);
    return `${prefix}${e.code}: ${e.message}`;
  }
}

export class WebResearcher extends Tool {
  constructor(ctx) {
    super({
      name: 'web_researcher',
      description: 'Search the web for current, up-to-date information.',
      parameters: {
        type: 'OBJECT',
        properties: {
          query: { type: 'STRING', description: 'The search query to look up.' },
          action: { type: 'STRING', description: 'One short phrase describing the search, e.g. "Looking up the weather".' },
        },
        required: ['query', 'action'],
      },
    }, ctx);
  }

  describe(args) { return args?.action || 'Searching the web'; }
  emojiKey() { return 'searching'; }

  async run({ query }) {
    try {
      const apiKey = await Secrets.require('TAVILY_KEY');
      const { ok, status, data } = await new HttpClient(this.ctx.startedAt).postJson('https://api.tavily.com/search', {
        api_key: apiKey, query, max_results: 3, include_answer: true,
      });
      if (!ok) return `Error: web search failed (HTTP ${status}) ${data?.detail?.error ?? data?.error ?? ''}`.trim();
      const context = (data.results || []).map((r) => `${r.title}: ${r.content}`).join('\n');
      return `Answer: ${data.answer || 'None'}\nContext:\n${context}`;
    } catch (err) {
      return this.fail(err, { query }, 'Error: web search failed - ');
    }
  }
}

export class SubAgent extends Tool {
  constructor(ctx) {
    super({
      name: 'sub_agent',
      description: 'Delegate a sub-task to a specialist agent. Call it more than once in the same turn for independent sub-tasks. Call nothing if you can just answer directly.',
      parameters: {
        type: 'OBJECT',
        properties: {
          name: { type: 'STRING', enum: Object.keys(AGENT_REGISTRY), description: "The sub-agent's name." },
          action: { type: 'STRING', description: 'One short phrase describing what this agent is doing right now, e.g. "Reading that link".' },
          emoji: { type: 'STRING', enum: EMOJI_KEYS, description: 'Whichever category best represents this action -- used to pick a status emoji shown next to it in the live draft.' },
          prompt: { type: 'STRING', description: 'The specific task or question to give this agent, in your own words, with whatever context it needs.' },
          model: { type: 'STRING', enum: MODEL_TIERS, description: 'Select the model capability for this task.' },
          thinking_level: { type: 'STRING', enum: ['low', 'medium', 'high'], description: "Set the reasoning effort. Use 'low' for simple extraction, 'high' for complex logic." },
        },
        required: ['name', 'action', 'emoji', 'prompt', 'model', 'thinking_level'],
      },
    }, ctx);
  }

  describe(args) { return args?.action || 'Thinking...'; }
  emojiKey(args) { return args?.emoji || 'thinking'; }

  async run(args) {
    const agent = AGENT_REGISTRY[args.name];
    if (!agent) return `Unknown agent "${args.name}". Pick one of the listed agents, or answer directly instead.`;

    const model = args.model || SUB_AGENT_DEFAULT_MODEL;
    const payload = {
      systemInstruction: { parts: [{ text: agent.systemPrompt }] },
      contents: [{ role: 'user', parts: [{ text: args.prompt }] }],
      generationConfig: { thinkingConfig: { thinkingLevel: args.thinking_level || 'low' } },
    };
    if (agent.tools.length) payload.tools = agent.tools;

    try {
      const response = await new Gemini(model, this.ctx.startedAt).post(payload);
      return Gemini.textOf(response) || 'The agent returned no output.';
    } catch (err) {
      return this.fail(err, { model, agent: args.name }, `Agent "${args.name}" failed on model ${model} (`).then((s) => `${s}). Try a different model or agent, or answer without this information.`);
    }
  }
}

export class GithubAgentTool extends Tool {
  constructor(ctx) {
    super({
      name: 'github_agent',
      description: "Read or change this bot's own source code in its GitHub repository. Writes are only allowed on the test branch. Use list_files to discover paths, read_file to inspect one, modify_file to apply a described change and commit it.",
      parameters: {
        type: 'OBJECT',
        properties: {
          operation: { type: 'STRING', enum: ['list_files', 'read_file', 'modify_file'] },
          branch: { type: 'STRING', enum: ['main', 'test'], description: 'Branch to read from or commit to.' },
          path: { type: 'STRING', description: 'Repo path such as tgcloud/lib/prompt.js. Required for read_file and modify_file.' },
          instruction: { type: 'STRING', description: 'For modify_file: a precise description of the change to make to this one file.' },
          action: { type: 'STRING', description: 'One short phrase describing what is happening, e.g. "Editing the formatting prompt".' },
        },
        required: ['operation', 'branch', 'action'],
      },
    }, ctx);
  }

  describe(args) { return args?.action || 'Working on the repository'; }
  emojiKey(args) { return args?.operation === 'modify_file' ? 'coding' : 'reading'; }

  async run(args) {
    try {
      return await new GitHubAgent(this.ctx).run(args);
    } catch (err) {
      return this.fail(err, args, 'Error: ');
    }
  }
}

export class ToolRegistry {
  constructor(ctx) {
    this.tools = [new WebResearcher(ctx), new SubAgent(ctx), new GithubAgentTool(ctx)].filter((t) => t.isAvailable());
    this.record = []; // results of this run, in call order
    this.queue = [];  // results to replay after rewind()
  }

  functions() { return this.tools.map((t) => t.declaration); }
  declarations() { return [{ functionDeclarations: this.functions() }]; }

  // Called when the orchestrator restarts a turn on another backend: calls that match what already
  // ran are answered from the record instead of being executed (and committed, searched...) twice.
  rewind() {
    this.queue = this.record;
    this.record = [];
  }

  // Announces the call on the live draft, then runs it. Always resolves to a result string.
  async execute(call, draft) {
    const tool = this.tools.find((t) => t.name === call.name);
    if (!tool) return `Unknown tool "${call.name}". Pick one of the listed tools, or answer directly instead.`;
    const args = call.args ?? {};
    const key = `${call.name}:${JSON.stringify(args)}`;

    const replayed = this.queue[0]?.key === key ? this.queue.shift() : null;
    if (!replayed) {
      this.queue = [];
      await draft.stage(tool.describe(args), tool.emojiKey(args));
    }
    const result = replayed ? replayed.result : await tool.run(args);
    this.record.push({ key, result });
    return result;
  }
}
