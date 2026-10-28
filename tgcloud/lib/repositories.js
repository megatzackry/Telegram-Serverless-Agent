// Database access, one class per table. Replaces the spreadsheet-backed Sheet/User classes.
import { db } from 'sdk';
import { eq, desc, inArray, ne } from 'sdk/db';
import { userLogs, apiLogs, errorLogs, secrets } from '../schema.js';
import { HISTORY_TURN_PAIRS } from './config.js';
import { toJson } from './utils.js';

// One person's own transcript: log a turn, rebuild Gemini-shaped history, find a prior reply id.
export class UserLog {
  constructor(userId) { this.userId = userId; }

  add(role, e = {}) {
    return db.insert(userLogs).values({
      userId: this.userId,
      role,
      chatId: e.chatId ?? null,
      messageId: e.messageId ?? null,
      threadId: e.threadId ?? null,
      eventType: e.eventType ?? null,
      meta: e.meta ?? null,
      replyContext: e.replyContext ?? null,
      entities: e.entities ?? null,
      text: e.text ?? '',
      richMessage: e.richMessage ?? null,
      origMsgId: e.origMsgId ?? null,
    }).run();
  }

  // Shared by message / guest_message handlers. body=false for messages we only acknowledge.
  logIncoming(msg, eventType, { body = true } = {}) {
    return this.add('user', {
      chatId: msg.chat?.id, messageId: msg.message_id, threadId: msg.message_thread_id, eventType, meta: msg.from,
      ...(body && {
        replyContext: msg.reply_to_message || msg.external_reply || msg.quote || null,
        entities: msg.entities,
        text: msg.text,
      }),
    });
  }

  // Oldest-first user/model turns, capped at maxPairs pairs.
  async conversation(maxPairs = HISTORY_TURN_PAIRS) {
    const rows = await db.select({ role: userLogs.role, text: userLogs.text }).from(userLogs)
      .where(eq(userLogs.userId, this.userId), inArray(userLogs.role, ['user', 'model']), ne(userLogs.text, ''))
      .orderBy(desc(userLogs.id))
      .limit(maxPairs * 2)
      .all();
    return rows.reverse().map((r) => ({ role: r.role, parts: [{ text: r.text }] }));
  }

  // Given the ORIGINAL incoming message id, the bot's own latest reply id (for in-place edits).
  async findPriorReplyId(origMsgId) {
    const row = await db.select({ messageId: userLogs.messageId }).from(userLogs)
      .where(eq(userLogs.userId, this.userId), eq(userLogs.role, 'model'), eq(userLogs.origMsgId, origMsgId))
      .orderBy(desc(userLogs.id))
      .limit(1)
      .get();
    return row?.messageId ?? null;
  }
}

// Model call telemetry (generateContent and Interactions alike). Never throws: logging must not break a reply.
// usage is { prompt, candidates, total } token counts.
export class ApiLogRepo {
  static async add({ model, contents, tools, output, usage, error, latencyMs }) {
    try {
      await db.insert(apiLogs).values({
        latencyMs,
        model,
        contents: contents ?? [],
        tools: tools ?? [],
        status: error ? `ERROR ${error.code ?? ''}`.trim() : 'SUCCESS',
        responseOutput: output ?? null,
        promptTokens: usage?.prompt ?? null,
        candidateTokens: usage?.candidates ?? null,
        totalTokens: usage?.total ?? null,
        errorDetails: error ?? null,
      }).run();
    } catch (e) {
      console.error('api_logs write failed', e);
    }
  }
}

export class ErrorLogRepo {
  static add({ code, message, details, payload }) {
    return db.insert(errorLogs).values({
      code: String(code ?? 'UNKNOWN'), message: message ?? '', details: toJson(details), payload: toJson(payload),
    }).run();
  }
}

export class SecretRepo {
  static async get(name) {
    const row = await db.select().from(secrets).where(eq(secrets.name, name)).get();
    return row?.value ?? null;
  }

  static set(name, value) {
    return db.insert(secrets).values({ name, value })
      .onConflictDoUpdate({ target: secrets.name, set: { value } }).run();
  }
}
