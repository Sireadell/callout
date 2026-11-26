// What a spoken phrase asks for. The server only reads it: the lens still does the check-in,
// shows the confirm screen or asks before a backup request.
const norm = (s) => String(s || '').toLowerCase().replace(/[’]/g, "'").replace(/[^a-z0-9' ]+/g, ' ').replace(/\s+/g, ' ').trim();

const REFUSE = /\b(not|no|never|help|hurt)\b|n't\b/;
const NEGATED = /\b(not|no|never)\b|n't\b/;
const OK_KEY = /\b(ok|okay|here|checking in|check in|all good|fine|yes)\b/;
// A check-in is made only of check-in words, so "person here" stays a clue.
const OK_WORDS = new Set(['ok', 'okay', 'o', 'k', 'yes', 'yeah', 'yep', 'fine', 'here', 'all', 'good', 'checking', 'check', 'in', 'i', "i'm", 'im', 'am', "we're", 'we', 'are', 'still', 'thanks', 'thank', 'you']);

export function isOk(text) {
  const t = norm(text);
  const words = t.split(' ');
  if (!t || words.length > 5 || REFUSE.test(t)) return false;
  return OK_KEY.test(t) && words.every((w) => OK_WORDS.has(w));
}

export function intentOf(text, quickClues = []) {
  const t = norm(text);
  if (!t) return { type: 'none' };
  if (t === 'cancel') return { type: 'cancel' };
  const clue = quickClues.find((c) => norm(c) === t);
  if (clue) return { type: 'quick_clue', clue };
  if (/\bback ?up\b/.test(t) && t.split(' ').length <= 6 && !NEGATED.test(t)) return { type: 'backup' };
  if (isOk(t)) return { type: 'checkin' };
  return { type: 'clue' };
}
