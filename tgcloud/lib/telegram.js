import { api, BotApiError } from 'sdk';
import { ACTION_EMOJIS, DRAFT_PREVIEW_INTERVAL_MS, MAX_DRAFT_FAILURES } from './config.js';
import { AppError } from './errors.js';
import { HtmlBalancer, RichText, escapeHtml } from './utils.js';

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

// The live draft shown while a reply is being produced: a running stage log ("Reading that link"),
// then the answer itself as it streams in. Cosmetic only: failures are swallowed, and previews stop
// after repeated failures. DraftStream.disabled() is a no-op.
export class DraftStream {
  constructor({ chatId, draftId, enabled = true }) {
    Object.assign(this, { chatId, draftId, enabled });
    this.stages = [];
    this.failures = 0;
    this.lastPreviewAt = 0;
  }

  static disabled() { return new DraftStream({ enabled: false }); }

  // sendRichMessageDraft takes the id of a *private* chat only (Bot API rich-message docs), so groups,
  // channels and guest queries get no draft and are answered with one finished message instead.
  static forMessage(msg) {
    if (msg.chat?.type !== 'private') return DraftStream.disabled();
    return new DraftStream({ chatId: msg.chat.id, draftId: msg.message_id });
  }

  // Re-sends the FULL stage list each time so it reads as a running log.
  async stage(text, emojiKey = 'thinking') {
    if (!this.enabled) return;
    this.stages.push(`${ActionEmojis.html(emojiKey)} ${escapeHtml(text)}`);
    await this.push(`<tg-thinking>${this.stages.join('<br>')}</tg-thinking>`);
  }

  // The answer so far (rich html, possibly cut mid-tag). Throttled; the finished message replaces it.
  async preview(html) {
    if (!this.enabled || this.failures >= MAX_DRAFT_FAILURES) return;
    const now = Date.now();
    if (now - this.lastPreviewAt < DRAFT_PREVIEW_INTERVAL_MS) return;
    this.lastPreviewAt = now;
    await this.push(HtmlBalancer.balance(html));
  }

  async push(html) {
    try {
      await api.sendRichMessageDraft({
        chat_id: this.chatId, draft_id: this.draftId, rich_message: { html }, can_stop: true, keep_on_stop: false,
      });
      this.failures = 0;
    } catch (err) {
      this.failures++;
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
