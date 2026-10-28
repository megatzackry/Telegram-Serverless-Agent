import { api } from 'sdk';
import { RichText } from './utils.js';

class BotIdentity {
  static id = null;

  static async get() {
    if (BotIdentity.id === null) BotIdentity.id = (await api.getMe()).id;
    return BotIdentity.id;
  }
}

// Folds the message being replied to into the current turn, since our own log may not contain it
// (an older bot reply, the user's earlier message, or someone else's message).
export class QueryBuilder {
  static describeAuthor(reply, msg, botId) {
    const replyFromId = reply.from?.id;
    if (replyFromId != null && String(replyFromId) === String(botId)) return 'you (the assistant) previously wrote';
    if (replyFromId != null && msg.from?.id != null && String(replyFromId) === String(msg.from.id)) return 'the same user wrote earlier';
    if (reply.from?.is_bot) return `a different bot (${reply.from.first_name || reply.from.username || 'unknown'}) wrote`;
    if (replyFromId != null) return `a different user (${reply.from.first_name || reply.from.username || 'someone else'}) wrote`;
    return `someone else (${reply.sender_chat?.title || 'unknown sender'}) wrote`;
  }

  // Never throws; worst case it falls back to the plain text.
  static async build(msg) {
    const text = msg.text || '';
    try {
      const reply = msg.reply_to_message;
      if (!reply) return text;
      const replyText = reply.text || RichText.fromMessage(reply.rich_message) || reply.caption || null;
      if (!replyText) return text;
      const label = QueryBuilder.describeAuthor(reply, msg, await BotIdentity.get());
      return `[Replying to a message where ${label}]:\n${replyText}\n\n[Current message]:\n${text}`;
    } catch {
      return text;
    }
  }

  // The log already holds the current message (as raw text) as the last 'user' turn. Drop it and push
  // the processed version, otherwise every turn would reach Gemini twice.
  static append(history, query) {
    if (history.length && history[history.length - 1].role === 'user') history.pop();
    history.push({ role: 'user', parts: [{ text: query }] });
    return history;
  }
}
