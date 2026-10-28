import { db } from 'sdk';
import { desc, eq } from 'sdk/db';
import { userLogs, apiLogs, errorLogs } from '../schema.js';

const clip = (value, max = 300) => {
  const s = typeof value === 'string' ? value : JSON.stringify(value ?? '');
  return s.length > max ? `${s.slice(0, max)}...` : s;
};

// Compact one-row summaries: the raw rows (full prompts, tool schemas) are far too big to read.
const SOURCES = {
  user_logs: {
    table: userLogs,
    format: (r) => ({ id: r.id, at: r.createdAt, user: r.userId, role: r.role, event: r.eventType, text: clip(r.text) }),
  },
  api_logs: {
    table: apiLogs,
    format: (r) => ({
      id: r.id, at: r.createdAt, model: r.model, status: r.status, ms: r.latencyMs, tokens: r.totalTokens,
      output: clip((r.responseOutput ?? []).map((p) => p.text ?? (p.functionCall ? `[call ${p.functionCall.name}]` : '')).join(' ')),
      error: r.errorDetails ? clip(r.errorDetails) : undefined,
    }),
  },
  error_logs: {
    table: errorLogs,
    format: (r) => ({ id: r.id, at: r.createdAt, code: r.code, message: clip(r.message), payload: clip(r.payload, 200) }),
  },
};

// Input: { limit?: 5, tables?: ['user_logs', 'api_logs'], userId?: number (filters user_logs) }
export default async function (input) {
  const limit = input.limit ?? 5;
  const names = input.tables ?? ['user_logs', 'api_logs'];
  const out = {};

  for (const name of names) {
    const source = SOURCES[name];
    if (!source) { out[name] = 'unknown table'; continue; }
    let query = db.select().from(source.table);
    if (name === 'user_logs' && input.userId) query = query.where(eq(userLogs.userId, input.userId));
    const rows = await query.orderBy(desc(source.table.id)).limit(limit).all();
    out[name] = rows.map(source.format);
  }
  return out;
}
