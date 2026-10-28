import { api } from 'sdk';
import { guarded, AppError } from '../lib/errors.js';
import { Conversation } from '../lib/conversation.js';
import { UserLog } from '../lib/repositories.js';
import { Delivery, DraftStream } from '../lib/telegram.js';
import { RichText } from '../lib/utils.js';

const APOLOGY_HTML = '<p>Sorry, something went wrong. Please try asking again in a moment.</p>';

// Guest Mode must be switched on by hand in @BotFather. No draft streaming here (unconfirmed for guest
// replies) and no Retry button (callback contract unverified), so failures get a plain apology.
export default guarded(async function (msg) {
  if (!msg.text || !msg.guest_query_id) return;
  const startedAt = Date.now();
  const callerId = msg.guest_bot_caller_user?.id ?? msg.from?.id;
  const userLog = new UserLog(callerId);

  await userLog.logIncoming(msg, 'guest_message');

  let result;
  try {
    result = await new Conversation(userLog, startedAt).respond(msg, DraftStream.disabled());
  } catch (err) {
    await AppError.handle(err, { chatId: msg.chat?.id, userId: callerId, text: msg.text });
    await userLog.add('error', { chatId: msg.chat?.id, eventType: 'orchestration_failed', origMsgId: msg.message_id });
    return api.answerGuestQuery({ guest_query_id: msg.guest_query_id, rich_message: { html: APOLOGY_HTML } });
  }

  const sent = await api.answerGuestQuery({
    guest_query_id: msg.guest_query_id, rich_message: { html: result.html }, reply_markup: Delivery.keyboard(result.next),
  });
  await userLog.add('model', {
    chatId: msg.chat?.id, messageId: sent?.message_id, eventType: 'guest_message',
    text: RichText.stripHtml(result.html), richMessage: result.html, origMsgId: msg.message_id,
  });
  return sent;
});
