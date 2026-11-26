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
    let res;
    try {
      res = await this.fetch(`https://api.telegram.org/bot${this.token}/${method}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      });
    } catch (e) {
      // A dropped connection never reached Telegram. Try once more instead of losing a check-in notice.
      if (!retry) throw e;
      await this.sleep(1000);
      return this.call(method, body, { retry: false });
    }
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
  // A message only one member of a group sees. Telegram does not promise it arrives, so it is only used
  // where losing it does no harm: never for check-in, backup or quiet notices.
  sendOnlyTo(chatId, userId, text) {
    return this._queued(chatId, () => this.call('sendMessage', { chat_id: chatId, text: text.slice(0, 4000), ephemeral_message_parameters: { receiver_user_id: userId } }));
  }
  sendRich(chatId, blocks, extra = {}) {
    return this._queued(chatId, () => this.call('sendRichMessage', { chat_id: chatId, rich_message: { blocks }, ...extra }));
  }
  edit(chatId, messageId, text, extra = {}) {
    return this._queued(chatId, () => this.call('editMessageText', { chat_id: chatId, message_id: messageId, text: text.slice(0, 4000), ...extra }));
  }
  editButtons(chatId, messageId, reply_markup) {
    return this._queued(chatId, () => this.call('editMessageReplyMarkup', { chat_id: chatId, message_id: messageId, reply_markup }));
  }
  // Live location with no end time, so it keeps moving until we stop it. Heading is 1 to 360 degrees.
  sendLiveLocation(chatId, lat, lng, extra = {}) {
    return this._queued(chatId, () => this.call('sendLocation', { chat_id: chatId, latitude: lat, longitude: lng, live_period: 0x7FFFFFFF, ...extra }));
  }
  editLiveLocation(chatId, messageId, lat, lng, heading) {
    const body = { chat_id: chatId, message_id: messageId, latitude: lat, longitude: lng };
    if (heading) body.heading = heading;
    return this._queued(chatId, () => this.call('editMessageLiveLocation', body));
  }
  stopLiveLocation(chatId, messageId) {
    return this.call('stopMessageLiveLocation', { chat_id: chatId, message_id: messageId });
  }
  // A clue as a map pin: the title is what was said, the address line says who.
  sendVenue(chatId, lat, lng, title, address, extra = {}) {
    return this._queued(chatId, () => this.call('sendVenue', { chat_id: chatId, latitude: lat, longitude: lng, title: title.slice(0, 120), address: address.slice(0, 120), ...extra }));
  }
  // Photos go up as a file, so this one is a form, not JSON.
  sendPhoto(chatId, bytes, caption, extra = {}) {
    return this._queued(chatId, async () => {
      const form = new FormData();
      form.set('chat_id', String(chatId));
      form.set('photo', new Blob([bytes], { type: 'image/jpeg' }), 'clue.jpg');
      if (caption) form.set('caption', caption.slice(0, 900));
      for (const [k, v] of Object.entries(extra)) { if (v === undefined || v === null) continue; form.set(k, typeof v === 'object' ? JSON.stringify(v) : String(v)); }
      const res = await this.fetch(`https://api.telegram.org/bot${this.token}/sendPhoto`, { method: 'POST', body: form });
      const data = await res.json().catch(() => ({}));
      if (!data.ok) throw new Error(`telegram sendPhoto: ${data.description || res.status}`);
      return data.result;
    });
  }
  createForumTopic(chatId, name) { return this.call('createForumTopic', { chat_id: chatId, name: name.slice(0, 120) }); }
  closeForumTopic(chatId, threadId) { return this.call('closeForumTopic', { chat_id: chatId, message_thread_id: threadId }); }
  pin(chatId, messageId) {
    return this.call('pinChatMessage', { chat_id: chatId, message_id: messageId, disable_notification: true });
  }
  deleteMessage(chatId, messageId) { return this.call('deleteMessage', { chat_id: chatId, message_id: messageId }); }
  getMe() { return this.call('getMe'); }
  getChatMember(chatId, userId) { return this.call('getChatMember', { chat_id: chatId, user_id: userId }); }
  // Commands shown in the "/" menu, per audience (scope), so volunteers and coordinators see different lists.
  setMyCommands(commands, scope = { type: 'default' }) { return this.call('setMyCommands', { commands, scope }); }
  // Webhook with a secret header: Telegram sends it back on every update and the server checks it.
  setWebhook(url, secret) {
    return this.call('setWebhook', { url, secret_token: secret, allowed_updates: ['message', 'callback_query', 'my_chat_member', 'message_reaction'] });
  }
  // A small reaction on a message (thumbs up, OK hand). Cheaper and quieter than a reply line.
  setReaction(chat, messageId, emoji) { return this.call('setMessageReaction', { chat_id: chat, message_id: messageId, reaction: [{ type: 'emoji', emoji }] }); }
  answerCallback(id, text) { return this.call('answerCallbackQuery', { callback_query_id: id, text }); }
  getUpdates(offset, timeout = 25) {
    return this.call('getUpdates', { offset, timeout, allowed_updates: ['message', 'callback_query', 'my_chat_member', 'message_reaction'] });
  }
}
