// Non-secret settings. Secrets live in env.js (CI-generated) or the `secrets` table.

export const MODEL_TIERS = [
  'gemini-3.1-flash-lite',
  'gemini-3.5-flash-lite',
  'gemini-3-flash-preview',
  'gemini-3.5-flash',
  'gemini-3.6-flash',
  'gemini-3.7-flash',
  'gemini-3.8-flash',
];
export const PRIMARY_MODEL = 'gemini-3.5-flash-lite';
export const FALLBACK_MODEL = 'gemini-3.1-flash-lite';
export const SUB_AGENT_DEFAULT_MODEL = 'gemini-3.5-flash';
export const CODE_EDIT_MODEL = 'gemini-3.5-flash';

export const HISTORY_TURN_PAIRS = 6;
export const MAX_ORCHESTRATION_ROUNDS = 8;

// Outbound HTTP (Gemini, Tavily, GitHub). deadlineMs is measured from the start of the invocation.
export const RETRY = { maxAttempts: 4, baseDelayMs: 1500, maxDelayMs: 15000, deadlineMs: 150000 };
// Orchestrator alternating between PRIMARY_MODEL and FALLBACK_MODEL.
export const MODEL_FAILOVER = { maxAttempts: 4, baseDelayMs: 2000, maxDelayMs: 10000, deadlineMs: 150000 };

// Telegram user ids allowed to use github_agent. Empty means nobody.
export const OWNER_IDS = [576324325];
export const isOwner = (userId) => OWNER_IDS.includes(Number(userId));

export const GITHUB = {
  repo: 'https://github.com/megatzackry/Telegram-Serverless-Agent',
  apiBase: 'https://api.github.com',
  readableBranches: ['main', 'test'],
  writableBranches: ['test'], // main only changes through a manual merge
  allowedPathPrefix: 'tgcloud/',
  protectedPaths: ['tgcloud/lib/env.js'],
  maxFileBytes: 200000,
  maxReadChars: 60000,
};

// Animated custom emoji from https://t.me/addemoji/AIActions. null falls back to `thinking`.
export const ACTION_EMOJIS = {
  thinking: { emoji: '🙂', id: '5573473356579078196' },
  reading: { emoji: '🖥', id: '5282843764451195532' },
  writing: { emoji: '📝', id: '5837003105228558796' },
  translating: null,
  calculating: null,
  coding: null,
  searching: { emoji: '🔍', id: '5188217332748527444' },
};
