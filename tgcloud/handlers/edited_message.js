import { api } from 'sdk';
import { guarded } from '../lib/errors.js';
import { Conversation } from '../lib/conversation.js';
import { UserLog } from '../lib/repositories.js';
import { Delivery, DraftStream } from '../lib/telegram.js';
import { RichText } from '../lib/utils.js';

export default guarded(async function (msg) {
  if (!msg.text || msg.chat?.type !== 'private') return;
  const startedAt = Date.now();
  const userLog = new UserLog(msg.from.id);

  const priorReplyId = await userLog.findPriorReplyId(msg.message_id);
  if (!priorReplyId) return; // never answered originally, nothing to fix

  let result;
  try {
    result = await new Conversation(userLog, startedAt).respond(msg, DraftStream.disabled(), { withHistory: false });
  } catch (err) {
    return Delivery.retryPrompt(userLog, msg, err);
  }

  await api.editMessageText({ chat_id: msg.chat.id, message_id: priorReplyId, rich_message: { html: result.html } });
  await userLog.add('model', {
    chatId: msg.chat.id, messageId: priorReplyId, threadId: msg.message_thread_id, eventType: 'edited_message',
    text: RichText.stripHtml(result.html), richMessage: result.html, origMsgId: msg.message_id,
  });
});
