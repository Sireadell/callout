// Google Sheet in and out, from the server only (Google sign-in does not work inside the glasses
// web view). Uses a service account: the coordinator shares their sheet with its email address.
// Values go in as plain text, never as formulas.
import { createSign } from 'node:crypto';

const b64u = (x) => Buffer.from(x).toString('base64url');
const SCOPE = 'https://www.googleapis.com/auth/spreadsheets';

// Accepts a full sheet link or a bare id.
export function parseSheetId(s) {
  const m = String(s || '').match(/\/d\/([A-Za-z0-9_-]{20,})/) || String(s || '').trim().match(/^([A-Za-z0-9_-]{20,})$/);
  return m ? m[1] : null;
}

export function makeSheet({ serviceAccount, fetchImpl = fetch, now = () => Date.now() } = {}) {
  let cached = null;

  async function token() {
    if (cached && cached.exp > now() + 60_000) return cached.value;
    const iat = Math.floor(now() / 1000);
    const head = b64u(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const claim = b64u(JSON.stringify({ iss: serviceAccount.client_email, scope: SCOPE, aud: 'https://oauth2.googleapis.com/token', iat, exp: iat + 3600 }));
    const sig = createSign('RSA-SHA256').update(`${head}.${claim}`).sign(serviceAccount.private_key, 'base64url');
    const r = await fetchImpl('https://oauth2.googleapis.com/token', {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${head}.${claim}.${sig}` }),
    });
    if (!r.ok) throw new Error(`google sign-in ${r.status}`);
    const j = await r.json();
    cached = { value: j.access_token, exp: now() + (j.expires_in || 3600) * 1000 };
    return cached.value;
  }

  async function api(path, init = {}) {
    const r = await fetchImpl(`https://sheets.googleapis.com/v4/spreadsheets/${path}`, {
      ...init, headers: { authorization: `Bearer ${await token()}`, 'content-type': 'application/json' },
    });
    if (r.status === 403 || r.status === 404) {
      const why = typeof r.text === 'function' ? await r.text().catch(() => '') : '';
      if (/has not been used|is disabled/i.test(why)) throw new Error('Google Sheets API is switched off for the Callout Google project');
      throw new Error('sheet not shared with the Callout account');
    }
    if (!r.ok) throw new Error(`sheet ${r.status}`);
    return r.json();
  }

  async function ensureTab(id, title) {
    const meta = await api(`${id}?fields=sheets.properties.title`);
    if (meta.sheets?.some((s) => s.properties.title === title)) return;
    await api(`${id}:batchUpdate`, { method: 'POST', body: JSON.stringify({ requests: [{ addSheet: { properties: { title } } }] }) });
  }

  return {
    email: serviceAccount?.client_email,
    // Job sheet in: tab "Volunteers", column A name, column B area. A header row is skipped.
    async readVolunteers(id) {
      const j = await api(`${id}/values/${encodeURIComponent('Volunteers!A:B')}`);
      const rows = (j.values || []).map((r) => [String(r[0] || '').trim(), String(r[1] || '').trim()]).filter(([n, a]) => n && a);
      if (rows[0] && /^name$/i.test(rows[0][0])) rows.shift();
      return rows.slice(0, 40).map(([name, area]) => ({ name, area }));
    },
    // A private copy of the server's state (teams, runs, pairings; no positions), so a host that wipes its
    // disk on restart can pick up where it left off. Stored as text in tab "State", column A, in chunks.
    async writeState(id, state) {
      await ensureTab(id, 'State');
      const text = JSON.stringify(state);
      const rows = []; for (let i = 0; i < text.length; i += 40000) rows.push([text.slice(i, i + 40000)]);
      await api(`${id}/values/${encodeURIComponent('State!A:A')}:clear`, { method: 'POST', body: '{}' });
      await api(`${id}/values/${encodeURIComponent('State!A1')}?valueInputOption=RAW`, { method: 'PUT', body: JSON.stringify({ values: rows.length ? rows : [['']] }) });
      return rows.length;
    },
    async readState(id) {
      let j; try { j = await api(`${id}/values/${encodeURIComponent('State!A:A')}`); } catch { return null; }
      const text = (j.values || []).map((r) => r[0] || '').join('');
      try { return text ? JSON.parse(text) : null; } catch { return null; }
    },
    // Debrief out: one row per volunteer, one row per clue. No positions are written.
    async writeDebrief(id, d, summary = '') {
      await ensureTab(id, 'Debrief'); await ensureTab(id, 'Clues');
      const iso = (t) => new Date(t).toISOString();
      const hm = (t) => (t ? iso(t) : '');
      const people = d.volunteers.map((v) => [d.run, iso(d.startedAt), iso(d.endedAt), v.name, v.area, v.checkins, v.missedNotices, summary, hm(v.firstAt), hm(v.lastAt), v.markedOk || 0, v.signedOut ? 'yes' : 'no']);
      const clues = d.clues.map((c) => [d.run, c.by, c.text, iso(c.at)]);
      const put = (tab, rows) => rows.length && api(`${id}/values/${encodeURIComponent(`${tab}!A:L`)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, { method: 'POST', body: JSON.stringify({ values: rows }) });
      await put('Debrief', people); await put('Clues', clues);
      return { people: people.length, clues: clues.length };
    },
  };
}
