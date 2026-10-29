import { guarded } from '../lib/errors.js';
import { Conversation } from '../lib/conversation.js';
import { UserLog } from '../lib/repositories.js';
import { Delivery, DraftStream } from '../lib/telegram.js';

const UNSUPPORTED_REPLY = 'I can only read text messages for now. Send me something in words and I will help.';

export default guarded(async function (msg) {
  if (msg.chat?.type !== 'private') return; // groups/supergroups not handled yet
  const startedAt = Date.now();
  const userLog = new UserLog(msg.from.id);

  if (!msg.text) {
    await userLog.logIncoming(msg, 'message', { body: false });
    return Delivery.plain(msg, UNSUPPORTED_REPLY);
  }

  const draft = DraftStream.forMessage(msg);
  await draft.stage('Working on it');
  await userLog.logIncoming(msg, 'message');

  let result;
  try {
    result = await new Conversation(userLog, startedAt).respond(msg, draft);
  } catch (err) {
    return Delivery.retryPrompt(userLog, msg, err);
  }
  return Delivery.deliver(userLog, msg, result);
});
