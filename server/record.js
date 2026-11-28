// The safety record a coordinator can file: who checked in and when, and the clues. No positions, no trails.
const iso = (ms) => (ms ? new Date(ms).toISOString() : '');
// Every cell is quoted. A cell that starts like a formula gets a leading quote so a spreadsheet shows it as text.
const cell = (v) => {
  let s = String(v ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
};
const row = (cells) => cells.map(cell).join(',');

export function recordCsv(d) {
  const lines = [
    row(['Run', d.run]), row(['Started', iso(d.startedAt)]), row(['Ended', iso(d.endedAt)]), '',
    row(['People']),
    row(['name', 'area', 'check-ins', 'missed notices', 'first check-in', 'last check-in', 'marked OK', 'signed out']),
    ...d.volunteers.map((v) => row([v.name, v.area, v.checkins, v.missedNotices, iso(v.firstAt), iso(v.lastAt), v.markedOk, v.signedOut ? 'yes' : 'no'])),
    '', row(['Clues']), row(['time', 'by', 'text']),
    ...d.clues.map((c) => row([iso(c.at), c.by, c.text])),
  ];
  return `${lines.join('\r\n')}\r\n`;
}

// safety-record-<run name>-<date>.csv, with the name cut down to plain letters and digits.
export function recordFilename(d) {
  const slug = String(d.run || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'run';
  return `safety-record-${slug}-${new Date(d.endedAt).toISOString().slice(0, 10)}.csv`;
}
