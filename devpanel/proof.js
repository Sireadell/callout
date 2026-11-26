// DEV PANEL proof: the real glasses app code talks to a real local server over HTTP, with fake glasses
// input and a fake Telegram. Run it with: node devpanel/proof.js [--save report.txt]
// It takes about two minutes, because the app's own timers run at their real speed.
import fs from 'node:fs';
import { startRig, until, GROUP } from './rig.js';

const out = [];
const log = (line = '') => { out.push(line); console.log(line); };
let failed = 0;
const check = (label, ok) => { log(`${ok ? 'PASS' : 'FAIL'}  ${label}`); if (!ok) failed++; };
const lensShot = (lens, label) => log(`\n  [lens: ${label}]\n${[lens.text, ...(lens.list || []).map((x) => `- ${x}`)].filter(Boolean).join('\n').replace(/^/gm, '  | ')}\n`);

log('DEV PANEL PROOF. Fake glasses input and fake Telegram. Not real glasses, not real Telegram.\n');
const rig = await startRig({ onServerLine: () => {} });
const { lens, sent, textOf, find } = rig;
const seen = async (re, from = 0, ms = 30_000) => {
  const m = await until(() => find(re, from), { ms });
  if (m) log(`  [chat ${m.body.chat_id === GROUP ? 'group' : m.body.chat_id}] ${textOf(m).replace(/\n/g, ' / ')}`);
  return m;
};
const lensSays = (re, ms = 15_000) => until(() => re.test(lens.text) && lens.text, { ms, step: 100 });

try {
  check('the glasses app pairs with a code sent by the bot', Boolean(await lensSays(/Elm Street/)));
  lensShot(lens, 'paired');

  log('--- S22: map pin from a fake position ---');
  lens.position = { lat: 51.50722, lng: -0.1275 };
  let from = sent.length;
  lens.chooseMenu(/quick clue/i);
  await until(() => lens.list);
  lensShot(lens, 'quick clue list');
  const picked = lens.list[2];
  await lens.chooseList(2);
  const pin = await until(() => sent.slice(from).find((m) => m.method === 'sendVenue'));
  if (pin) log(`  [chat group] map pin "${pin.body.title}" at ${pin.body.latitude}, ${pin.body.longitude}`);
  check('a quick clue arrives as a map pin at the fake position', pin?.body.title === picked && pin.body.latitude === 51.50722);
  check('the pin has reply buttons', (pin?.body.reply_markup?.inline_keyboard?.flat().length || 0) >= 4);

  log('\n--- Coordinator reply to the lens ---');
  const button = pin?.body.reply_markup.inline_keyboard.flat()[0];
  if (button) await rig.press(pin.messageId, button.callback_data);
  check('a pressed reply button shows on the lens', Boolean(button && await lensSays(new RegExp(button.text))));
  lensShot(lens, 'reply');
  lens.tap(); // got it
  check('a tap on the reply tells the coordinator it was seen', Boolean(await seen(/Ana saw:/, from)));

  log('\n--- S21: battery ---');
  from = sent.length;
  lens.setDevice({ batteryLevel: 10 });
  check('battery at 10%: the coordinator is told', Boolean(await seen(/battery low \(10%\)/, from)));
  check('battery at 10%: the lens shows it', Boolean(await lensSays(/battery 10%/i, 20_000)));
  lensShot(lens, 'low battery');
  lens.setDevice({ batteryLevel: 80 });

  log('--- S21: glasses taken off ---');
  from = sent.length;
  lens.setDevice({ isWearing: false });
  check('glasses taken off: the coordinator is told', Boolean(await seen(/taken the glasses off/, from)));
  lens.setDevice({ isWearing: true });

  log('\n--- S21: no signal, then signal returns ---');
  await lensSays(/Next check-in/);
  from = sent.length;
  lens.signal = false;
  lens.clockOffsetMs = -3 * 60_000; // the clue is made "3 minutes ago"
  lens.chooseMenu(/quick clue/i);
  await until(() => lens.list);
  const held = lens.list[0];
  await lens.chooseList(0);
  check('with no signal the clue is kept on the phone', Boolean(await lensSays(/saved\. Sends when signal returns/i)));
  await lens.chooseMenu(/^check in/i);
  check('with no signal the check-in is kept too', Boolean(await lensSays(/2 waiting/)));
  lens.clockOffsetMs = 0;
  await new Promise((r) => setTimeout(r, 1200)); // let the lens redraw
  lensShot(lens, 'two items waiting');
  check('nothing reached the chat while there was no signal', !find(new RegExp(held), from));
  check('after the quiet limit (shortened to 20 s) the coordinator is told the app has gone quiet', Boolean(await seen(/gone quiet/, from, 45_000)));
  lens.signal = true;
  const late = await until(() => sent.slice(from).find((m) => m.method === 'sendVenue' && m.body.title === held));
  if (late) log(`  [chat group] map pin "${late.body.title}" (${late.body.address})`);
  check('signal back: the kept clue is sent and marked as sent late', /sent \d+ min late/.test(late?.body.address || ''));
  check('signal back: the queue empties', Boolean(await until(() => !/\d waiting/.test(lens.text), { ms: 15_000 })));
  // Reported, not counted: the server only says "back online" when a 30 second heartbeat is the first
  // call to arrive. A sync or a held item that arrives first clears the quiet flag without a notice.
  const online = await seen(/back online/, from, 3000);
  log(online ? 'PASS  signal back: the coordinator is told they are online again' : 'NOTE  signal back: no "back online" notice was sent this time (see devpanel/README.md)');

  log('\n--- S21: "Still there?" with no answer ---');
  await new Promise((r) => setTimeout(r, 4000));
  from = sent.length;
  lens.noMovementFor(5);
  check('after five minutes with no head movement the lens asks "Still there?"', Boolean(await lensSays(/Still there\?/)));
  lensShot(lens, 'Still there?');
  const still = await seen(/no head movement was seen/, from, 45_000);
  check('three unanswered rounds: the coordinator is told only that no movement was seen', Boolean(still));
  lens.resetClock();

  log('\n--- S22: /end clear (fake Telegram) ---');
  from = sent.length;
  await rig.say('/end clear');
  const debrief = await seen(/finished after/, from, 45_000);
  check('/end clear posts the debrief', Boolean(debrief));
  check('the check-in kept while there was no signal is counted in the debrief', /Ana \(Area A1\): 1 check-ins/.test(debrief ? textOf(debrief) : ''));
  const deleted = await until(() => sent.slice(from).some((m) => m.method === 'deleteMessage' && m.messageId === pin?.messageId), { ms: 45_000 });
  check('/end clear asks Telegram to delete the messages that showed a position', Boolean(deleted));
  log(`  ${sent.slice(from).filter((m) => m.method === 'deleteMessage').length} delete requests`);
  check('the lens shows the run is finished', Boolean(await lensSays(/Run finished/, 20_000)));
  lensShot(lens, 'finished');
} catch (e) {
  check(`the proof stopped early: ${e.message}`, false);
}

log(failed ? `\n${failed} check(s) failed` : '\nAll dev panel checks passed.');
log('Not proven by this: real glasses or their sensors, the phone\'s real location and signal, how the lens draws the text, and real Telegram.');
const save = process.argv.indexOf('--save');
if (save > 0 && process.argv[save + 1]) fs.writeFileSync(process.argv[save + 1], `${out.join('\n')}\n`);
rig.stop();
process.exit(failed ? 1 : 0);
