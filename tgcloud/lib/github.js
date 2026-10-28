// Self-update machinery, split by responsibility:
//   GitHubPolicy - what the bot is allowed to touch
//   GitHubClient - transport (GitHub contents / trees API)
//   GitHubAgent  - the read / modify / commit workflow the orchestrator calls
import { CODE_EDIT_MODEL, GITHUB } from './config.js';
import { AppError } from './errors.js';
import { Gemini } from './gemini.js';
import { HttpClient } from './http.js';
import { Secrets } from './secrets.js';
import { Base64, LineDiff, stripCodeFence } from './utils.js';

export class GitHubPolicy {
  static assertReadable(branch) {
    if (!GITHUB.readableBranches.includes(branch)) {
      throw new AppError('FORBIDDEN', `Branch "${branch}" is not readable. Allowed: ${GITHUB.readableBranches.join(', ')}.`);
    }
  }

  static assertWritable(branch) {
    if (!GITHUB.writableBranches.includes(branch)) {
      throw new AppError('FORBIDDEN', `Branch "${branch}" is read-only for the bot. Writable: ${GITHUB.writableBranches.join(', ')}. Ask the user to merge test into main.`);
    }
  }

  // Only .js modules under tgcloud/, never the secrets file. Returns the cleaned path.
  static assertPath(path) {
    const clean = String(path ?? '').replace(/^\/+/, '');
    const protectedHit = GITHUB.protectedPaths.some((p) => p.toLowerCase() === clean.toLowerCase());
    if (clean.includes('..') || !clean.startsWith(GITHUB.allowedPathPrefix) || !clean.endsWith('.js') || protectedHit) {
      throw new AppError('FORBIDDEN', `Path "${path}" is not allowed. Only .js files under ${GITHUB.allowedPathPrefix} (except protected files) can be accessed.`);
    }
    return clean;
  }
}

export class GitHubClient {
  constructor(token, startedAt) {
    this.token = token;
    this.http = new HttpClient(startedAt);
  }

  static async create(startedAt) {
    return new GitHubClient(await Secrets.require('GITHUB_TOKEN'), startedAt);
  }

  async call(path, { method = 'GET', body } = {}) {
    const init = {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'notaicatbot',
        'Content-Type': 'application/json',
      },
    };
    if (body) init.body = JSON.stringify(body);
    const res = await this.http.request(`${GITHUB.apiBase}/repos/${GITHUB.repo}${path}`, init);
    if (!res.ok) throw new AppError(`GITHUB_${res.status}`, res.data?.message ?? 'GitHub request failed', res.data);
    return res.data;
  }

  static encodePath(path) { return path.split('/').map(encodeURIComponent).join('/'); }

  async listPaths(branch) {
    const tree = await this.call(`/git/trees/${encodeURIComponent(branch)}?recursive=1`);
    return tree.tree
      .filter((e) => e.type === 'blob' && e.path.startsWith(GITHUB.allowedPathPrefix) && e.path.endsWith('.js'))
      .map((e) => e.path);
  }

  async getFile(branch, path) {
    const d = await this.call(`/contents/${GitHubClient.encodePath(path)}?ref=${encodeURIComponent(branch)}`);
    if (d.type !== 'file' || d.encoding !== 'base64') throw new AppError('GITHUB_NOT_A_FILE', `${path} is not a readable file.`, { size: d.size });
    return { path, sha: d.sha, content: Base64.decodeUtf8(d.content) };
  }

  async putFile({ branch, path, content, sha, message }) {
    const d = await this.call(`/contents/${GitHubClient.encodePath(path)}`, {
      method: 'PUT', body: { message, content: Base64.encodeUtf8(content), sha, branch },
    });
    return { sha: d.commit.sha, url: d.commit.html_url };
  }
}

const EDITOR_SYSTEM_PROMPT = `You edit ONE JavaScript module of a Telegram Serverless bot.
Rules:
- Apply exactly the requested change and leave everything else untouched.
- Return the COMPLETE updated file and nothing else: no commentary, no markdown fences.
- Relative imports must keep the .js extension. No npm packages, no Node built-ins, no filesystem access.
- Never add code that reads, logs, or sends secrets (GITHUB_TOKEN, GEMINI_KEY, TAVILY_KEY) anywhere.`;

export class GitHubAgent {
  constructor({ userId, startedAt }) {
    this.userId = userId;
    this.startedAt = startedAt;
  }

  async run({ operation, branch, path, instruction }) {
    GitHubPolicy.assertReadable(branch);
    const client = await GitHubClient.create(this.startedAt);
    switch (operation) {
      case 'list_files': return (await client.listPaths(branch)).join('\n');
      case 'read_file': return this.readFile(client, branch, path);
      case 'modify_file': return this.modifyFile(client, branch, path, instruction);
      default: throw new AppError('BAD_OPERATION', `Unknown operation "${operation}".`);
    }
  }

  async readFile(client, branch, path) {
    const file = await client.getFile(branch, GitHubPolicy.assertPath(path));
    const clipped = file.content.length > GITHUB.maxReadChars;
    return clipped ? `${file.content.slice(0, GITHUB.maxReadChars)}\n[truncated]` : file.content;
  }

  async modifyFile(client, branch, path, instruction) {
    GitHubPolicy.assertWritable(branch);
    if (!instruction) throw new AppError('BAD_OPERATION', 'modify_file needs an instruction.');
    const clean = GitHubPolicy.assertPath(path);

    const original = await client.getFile(branch, clean);
    const updated = await this.rewrite(clean, original.content, instruction);
    const diff = LineDiff.summarize(original.content, updated);

    const commit = await client.putFile({
      branch, path: clean, content: updated, sha: original.sha, message: `bot: ${instruction.replace(/\s+/g, ' ').slice(0, 72)}`,
    });
    return `Committed ${commit.sha.slice(0, 7)} to ${branch} (${clean}, +${diff.added}/-${diff.removed} lines): ${commit.url}. CI will syntax-check and redeploy the ${branch} bot shortly.`;
  }

  // Asks Gemini for the full updated file, then refuses output that looks truncated or unchanged.
  async rewrite(path, original, instruction) {
    const response = await new Gemini(CODE_EDIT_MODEL, this.startedAt).post({
      systemInstruction: { parts: [{ text: EDITOR_SYSTEM_PROMPT }] },
      contents: [{ role: 'user', parts: [{ text: `File: ${path}\n\nInstruction: ${instruction}\n\nCurrent contents:\n${original}` }] }],
      generationConfig: { temperature: 0, thinkingConfig: { thinkingLevel: 'medium' } },
    });
    if (Gemini.finishReason(response) !== 'STOP') throw new AppError('EDIT_INCOMPLETE', `Model stopped early (${Gemini.finishReason(response)}); nothing committed.`);

    const updated = stripCodeFence(Gemini.textOf(response)).trimEnd() + '\n';
    if (updated.trim() === original.trim()) throw new AppError('EDIT_NOOP', 'The edit produced no change; nothing committed.');
    if (updated.length < original.length * 0.5) throw new AppError('EDIT_SUSPICIOUS', 'The rewritten file is less than half the original size; nothing committed.');
    if (updated.length > GITHUB.maxFileBytes) throw new AppError('EDIT_TOO_LARGE', 'The rewritten file is too large; nothing committed.');
    return updated;
  }
}
