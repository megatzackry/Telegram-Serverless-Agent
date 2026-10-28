import { table, integer, text, json, index, sql } from 'sdk/db';

// Shared so every table stamps rows the same way (unix ms).
const timestamp = (name) =>
  integer(name, { mode: 'timestamp_ms' }).notNull().default(sql`(unixepoch() * 1000)`);

// One row per turn, replacing the per-user spreadsheet tab. No foreign keys on this platform,
// so user_id is a plain column.
export const userLogs = table('user_logs', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  createdAt: timestamp('created_at'),
  userId: integer('user_id').notNull(),
  role: text('role').notNull(), // user | model | error | reaction
  chatId: integer('chat_id'),
  messageId: integer('message_id'),
  threadId: integer('thread_id'),
  eventType: text('event_type'),
  meta: json('meta'),
  replyContext: json('reply_context'),
  entities: json('entities'),
  text: text('text'),
  richMessage: text('rich_message'),
  origMsgId: integer('orig_msg_id'),
}, (t) => ({
  userIdx: index('idx_user_logs_user').on(t.userId, t.id),
  origIdx: index('idx_user_logs_orig').on(t.userId, t.origMsgId),
}));

export const apiLogs = table('api_logs', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  createdAt: timestamp('created_at'),
  latencyMs: integer('latency_ms'),
  model: text('model'),
  contents: json('contents'),
  tools: json('tools'),
  status: text('status'),
  responseOutput: json('response_output'),
  promptTokens: integer('prompt_tokens'),
  candidateTokens: integer('candidate_tokens'),
  totalTokens: integer('total_tokens'),
  errorDetails: json('error_details'),
}, (t) => ({
  createdIdx: index('idx_api_logs_created').on(t.createdAt),
}));

export const errorLogs = table('error_logs', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  createdAt: timestamp('created_at'),
  code: text('code'),
  message: text('message'),
  details: text('details'),
  payload: text('payload'),
});

// Fallback store for values env.js does not provide (GITHUB_TOKEN, GEMINI_KEY, ...).
export const secrets = table('secrets', {
  name: text('name').primaryKey(),
  value: text('value').notNull(),
  updatedAt: timestamp('updated_at'),
});
