import { api, BotApiError } from 'sdk';
import { ACTION_EMOJIS } from './config.js';
import { AppError } from './errors.js';
import { RichText, escapeHtml } from './utils.js';

export class ActionEmojis {
  // Unknown or unfilled categories fall back to `thinking`.
  static resolve(key) {
    const entry = ACTION_EMOJIS[key];
    return entry?.id ? entry : ACTION_EMOJIS.thinking;
  }

  static html(key) {
    const { emoji, id } = ActionEmojis.resolve(key);
    return `<tg-emoji emoji-id="${id}">${emoji}</tg-emoji>`;
  }
}

// The streaming "Thinking..." preview. Re-sends the FULL stage list each time so it reads as a running
// log. Cosmetic only: failures are swallowed. DraftStream.disabled() is a no-op for edits, guests, retries.
export class DraftStream {
  constructor({ chatId, draftId, enabled = true }) {
    Object.assign(this, { chatId, draftId, enabled });
    this.stages = [];
  }

  static disabled() { return new DraftStream({ enabled: false }); }

  async stage(text, emojiKey = 'thinking') {
    if (!this.enabled) return;
    this.stages.push(`${ActionEmojis.html(emojiKey)} ${escapeHtml(text)}`);
    try {
      await api.sendRichMessageDraft({
        chat_id: this.chatId,
        draft_id: this.draftId,
        rich_message: { html: `<tg-thinking>${this.stages.join('<br>')}</tg-thinking>` },
        can_stop: true,
        keep_on_stop: false,
      });
    } catch (err) {
      console.warn('draft failed:', err?.description ?? err?.message);
    }
  }
}

// Everything that sends a finished reply (or a failure notice) back to a chat, plus its logging.
export class Delivery {
  static RETRY_DATA = JSON.stringify({ a: 'retry' });

  static keyboard(next) {
    if (!next?.length) return undefined;
    return { keyboard: next.map((s) => [{ text: s }]), resize_keyboard: true, one_time_keyboard: true };
  }

  static replyParams(msg) {
    const params = { chat_id: msg.chat.id, reply_parameters: { message_id: msg.message_id } };
    if (msg.message_thread_id) params.message_thread_id = msg.message_thread_id;
    return params;
  }

  static plain(msg, text, extra = {}) {
    return api.sendMessage({ ...Delivery.replyParams(msg), text: text.slice(0, 4096), ...extra });
  }

  // If Telegram rejects the model's html (400), degrade to plain text instead of staying silent.
  static async rich(msg, result) {
    const reply_markup = Delivery.keyboard(result.next);
    try {
      return await api.sendRichMessage({ ...Delivery.replyParams(msg), rich_message: { html: result.html }, reply_markup });
    } catch (err) {
      if (!(err instanceof BotApiError) || err.code !== 400) throw err;
      await AppError.handle(err, { phase: 'rich_delivery', html: result.html });
      return Delivery.plain(msg, RichText.stripHtml(result.html), { reply_markup });
    }
  }

  static async deliver(userLog, msg, result) {
    const sent = await Delivery.rich(msg, result);
    await userLog.add('model', {
      chatId: msg.chat.id, messageId: sent?.message_id, threadId: msg.message_thread_id,
      eventType: 'message', text: RichText.stripHtml(result.html), richMessage: result.html, origMsgId: msg.message_id,
    });
    return sent;
  }

  static async retryPrompt(userLog, msg, err) {
    await AppError.handle(err, { chatId: msg.chat.id, messageId: msg.message_id, text: msg.text || '' });
    const sent = await Delivery.plain(msg, 'Sorry, something went wrong putting that together. Tap Retry to try again.', {
      reply_markup: { inline_keyboard: [[{ text: '🔄 Retry', callback_data: Delivery.RETRY_DATA }]] },
    });
    await userLog.add('error', {
      chatId: msg.chat.id, messageId: sent?.message_id, threadId: msg.message_thread_id,
      eventType: 'orchestration_failed', origMsgId: msg.message_id,
    });
    return sent;
  }
}
