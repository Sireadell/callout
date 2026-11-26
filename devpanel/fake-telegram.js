// DEV PANEL ONLY. Loaded into a local Callout server with `node --import`.
// It answers every Telegram call on this machine, reports each one to the panel, refuses any other
// outside address, and keeps the server on 127.0.0.1. Nothing is sent to anyone.
import net from 'node:net';

const LOCAL = new Set(['127.0.0.1', 'localhost', '[::1]']);

export function makeFakeFetch({ realFetch, report = () => {} }) {
  let id = 100;
  const answer = (result, ok = true) => ({ ok, status: ok ? 200 : 400, json: async () => (ok ? { ok, result } : { ok, description: result }) });
  return async function fakeFetch(input, init = {}) {
    const url = new URL(typeof input === 'string' ? input : input.url || String(input));
    if (LOCAL.has(url.hostname)) return realFetch(input, init);
    if (url.hostname !== 'api.telegram.org') throw new Error(`dev panel blocks outside address ${url.hostname}`);
    const method = url.pathname.split('/').at(-1);
    let body = {};
    if (typeof init.body === 'string') body = JSON.parse(init.body);
    else if (init.body?.entries) for (const [k, v] of init.body.entries()) body[k] = typeof v === 'string' ? v : `[file, ${v.size} bytes]`;
    if (method === 'getMe') return answer({ id: 1, username: 'devpanel_bot' });
    if (method === 'createForumTopic') return answer('not a forum', false);
    if (method === 'getUpdates') return answer([]);
    if (method === 'getChatMember') return answer({ status: 'member' });
    const result = { message_id: method.startsWith('send') ? ++id : body.message_id };
    report({ method, body, messageId: result.message_id });
    return answer(result);
  };
}

if (process.env.CALLOUT_DEVPANEL === '1') {
  globalThis.fetch = makeFakeFetch({ realFetch: globalThis.fetch, report: (m) => process.send?.(m) });
  const listen = net.Server.prototype.listen;
  net.Server.prototype.listen = function (port, ...rest) {
    return typeof port === 'number' && typeof rest[0] !== 'string' ? listen.call(this, port, '127.0.0.1', ...rest) : listen.call(this, port, ...rest);
  };
}
