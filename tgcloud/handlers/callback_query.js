import { api } from 'sdk';
import { guarded, AppError } from '../lib/errors.js';
import { Conversation } from '../lib/conversation.js';
import { UserLog } from '../lib/repositories.js';
import { Delivery, DraftStream } from '../lib/telegram.js';

const answer = (cbq, text) =>
  api.answerCallbackQuery(text ? { callback_query_id: cbq.id, text, show_alert: true } : { callback_query_id: cbq.id });

function parseData(raw) {
  try { return JSON.parse(raw || '{}'); } catch { return {}; }
}

export default guarded(async function (cbq) {
  if (parseData(cbq.data).a !== 'retry') return answer(cbq);

  // The failing message is recovered from the reply chain: the Retry prompt was sent as a reply to the
  // original user message, so Telegram echoes it back as callback_query.message.reply_to_message.
  const original = cbq.message?.reply_to_message;
  if (!original?.text) return answer(cbq, 'Please just resend your message.');

  const startedAt = Date.now();
  const userLog = new UserLog(original.from.id);
  await api.sendChatAction({ chat_id: original.chat.id, action: 'typing' }).catch(() => {});

  let result;
  try {
    result = await new Conversation(userLog, startedAt).respond(original, DraftStream.disabled());
  } catch (err) {
    await AppError.handle(err, { chatId: original.chat.id, messageId: original.message_id, text: original.text });
    await userLog.add('error', { chatId: original.chat.id, eventType: 'orchestration_failed', origMsgId: original.message_id });
    return answer(cbq, 'Still having trouble. Please try again later.');
  }

  await Delivery.deliver(userLog, original, result);
  // Strip the Retry button so it can't be tapped again.
  await api.editMessageReplyMarkup({
    chat_id: cbq.message.chat.id, message_id: cbq.message.message_id, reply_markup: { inline_keyboard: [] },
  }).catch(() => {});
  return answer(cbq);
});
