// Thin Telegram Bot API client. Plain fetch, no library.
// Keeps to Telegram's limits: about 20 messages a minute per group (we leave
// a gap between sends to one chat) and waits out 429 "retry_after" replies.
const sleepReal = (ms) => new Promise((r) => setTimeout(r, ms));

export class Telegram {
  constructor(token, { fetchImpl = fetch, minGapMs = 1100, sleep = sleepReal } = {}) {
    this.token = token;
    this.fetch = fetchImpl;
    this.minGapMs = minGapMs;
    this.sleep = sleep;
    this.chains = new Map(); // chatId -> promise of the last send
  }

  async call(method, body = {}, { retry = true } = {}) {
    const res = await this.fetch(`https://api.telegram.org/bot${this.token}/${method}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (data.ok) return data.result;
    const wait = data.parameters?.retry_after;
    if (res.status === 429 && wait && retry) {
      await this.sleep((wait + 1) * 1000);
      return this.call(method, body, { retry: false });
    }
    throw new Error(`telegram ${method}: ${data.description || res.status}`);
  }

  // Sends to one chat are queued one after another, with a gap.
  _queued(chatId, fn) {
    const prev = this.chains.get(chatId) || Promise.resolve();
    const next = prev.catch(() => {}).then(async () => {
      const out = await fn();
      // Groups (negative ids) are capped at 20 messages a minute, so leave 3.1 s between sends.
      await this.sleep(chatId < 0 ? Math.max(this.minGapMs, 3100) : this.minGapMs);
      return out;
    });
    this.chains.set(chatId, next);
    return next;
  }

  send(chatId, text, extra = {}) {
    return this._queued(chatId, () => this.call('sendMessage', { chat_id: chatId, text: text.slice(0, 4000), ...extra }));
  }
  edit(chatId, messageId, text, extra = {}) {
    return this._queued(chatId, () => this.call('editMessageText', { chat_id: chatId, message_id: messageId, text: text.slice(0, 4000), ...extra }));
  }
  pin(chatId, messageId) {
    return this.call('pinChatMessage', { chat_id: chatId, message_id: messageId, disable_notification: true });
  }
  answerCallback(id, text) { return this.call('answerCallbackQuery', { callback_query_id: id, text }); }
  getUpdates(offset, timeout = 25) {
    return this.call('getUpdates', { offset, timeout, allowed_updates: ['message', 'callback_query', 'my_chat_member'] });
  }
}
