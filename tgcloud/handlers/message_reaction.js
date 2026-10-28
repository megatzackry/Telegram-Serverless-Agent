import { guarded } from '../lib/errors.js';
import { UserLog } from '../lib/repositories.js';

// Logged per user; no reply is sent.
export default guarded(async function (reaction) {
  if (!reaction.user) return; // anonymous/channel reactions: nothing to attribute
  await new UserLog(reaction.user.id).add('reaction', {
    chatId: reaction.chat.id, eventType: 'reaction', origMsgId: reaction.message_id,
    meta: { old: reaction.old_reaction, new: reaction.new_reaction },
  });
});
