import { Orchestrator } from './orchestrator.js';
import { QueryBuilder } from './query.js';

// One question -> one { html, next } answer, for a given user.
export class Conversation {
  constructor(userLog, startedAt = Date.now()) {
    this.userLog = userLog;
    this.startedAt = startedAt;
  }

  // withHistory=false answers from the message alone (used for edits: latest edit only).
  async respond(msg, draft, { withHistory = true } = {}) {
    const query = await QueryBuilder.build(msg);
    const past = withHistory ? await this.userLog.conversation() : [];
    const history = QueryBuilder.append(past, query);
    return new Orchestrator({ userId: this.userLog.userId, startedAt: this.startedAt, draft }).run(history);
  }
}
