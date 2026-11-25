# Callout: team check-in on Even G2 glasses, run from Telegram

Callout is a check-in tool for field teams like flood wardens, door-knock and welfare-check teams and aid drivers. The G2 lens shows when your next check-in is due and how many of your team have checked in. The coordinator runs everything from the team's Telegram group.

I built it because people doing this work have their hands full. Phones stay in pockets, radios get missed, and a coordinator has no quick way to see who has gone quiet.

> Has everyone on my team checked in, and if not, who and where were they last?

**Measured on real Telegram: a clue sent from the server shows up as a map pin in the team group in about 0.65 seconds** (626, 633, 662 and 687 ms on four clues). That times the server to Telegram leg only, not the glasses to phone leg.

## A flood night with Callout

Six volunteers are checking houses on Elm Street. Each one sees this on the lens:

```
Elm Street
Area A1

Next check-in 08:42

Team 5/6 checked in
```

Ana taps the ring to check in. At a house with someone inside, she taps Clue and says "person inside". A map pin lands in the group with four reply buttons. The coordinator presses "Stay where you are" and that line appears on Ana's lens.

Ben misses his check-in. At 17 minutes the coordinator gets a notice with Ben's last position. At 22 minutes the whole team is told. When Ben checks in, the group sees that too.

At `/end`, the debrief goes to Telegram (and Discord and a Google Sheet if set up), and the server deletes every position. Map pins and notices that show coordinates stay in the group, protected from forwarding, unless the coordinator sends `/end clear`, which also deletes them.

## Check it in one minute

No keys, no account, no network. You need Node 22 or newer.

```powershell
cd callout
npm run proof
npm test
```

| Command | What it shows | Result today |
|---|---|---|
| `npm run proof` | A full run against a fake Telegram chat: pairing, clue pin, reply to the lens, missed check-in notices at 17 and 22 minutes, battery, glasses off, gone quiet, debrief, and that no positions are kept afterwards | 20 of 20 checks pass, 31 messages sent |
| `npm test` | Server tests, with a fake clock so the timers run in milliseconds | 84 of 84 pass |
| `cd glasses; npm install; npm test` | Lens text and head-motion tests | 16 of 16 pass |

## What it uses from the Even Hub SDK

| Part of the SDK | How Callout uses it |
|---|---|
| Startup page and text container | The glance screen: run, area, check-in clock, team count, last reply |
| Text update in place | The clock and notices change without rebuilding the screen |
| Menu | Check in, clue by voice, quick clue, ask team for backup, repeat reply, photo, sign out |
| List container | The four quick clues, one tap each |
| Tap, double tap and swipe events | Tap checks in or says "got it". Double tap opens the exit dialog. Swipe cancels |
| Microphone audio | Voice clue and the spoken "OK", with the wearer's own voice kept and frames marked as someone else dropped |
| Motion sensor | "Still there?" after about five minutes with no head movement |
| Device status | Battery, worn, in case and connection, sent to the coordinator as plain facts |
| App location | Last known position on clues, check-ins and the live location |
| Camera and photo album | A photo on the last clue |
| Local storage | The pairing token and the queue of items waiting for signal |
| Exit dialog | Double tap and Sign out both end with the system exit dialog |

## Track 1, Messaging and News: Telegram is the core

Telegram is where the team lives. The bot sets up the group, hands out pairing codes, posts every clue and notice, and carries the coordinator's replies back to the lens.

### Best Telegram integration: what the bot uses

| What it does | Telegram feature |
|---|---|
| Add-to-group link that asks for exactly the rights it needs | `startgroup` link with `admin=pin_messages+manage_topics` |
| Tells the coordinator which right is missing | `my_chat_member` update |
| Short command list for everyone, full list for admins | `setMyCommands` with `all_chat_administrators` scope |
| Volunteer links their private chat with one tap | `/start CODE` deep link |
| One status board, pinned and edited in place | `sendMessage`, `pinChatMessage`, `editMessageText` |
| Clues arrive as map pins with reply buttons | `sendVenue`, inline keyboard |
| Live location per volunteer, stopped at the debrief | `sendLocation` with live period, `editMessageLiveLocation` |
| One forum topic per run, closed at the end | `createForumTopic`, `closeForumTopic` |
| Photo on a clue | `sendPhoto` as a reply to the clue |
| Check-ins are quiet, missed check-ins buzz | `disable_notification` |
| Anything with a position cannot be forwarded or saved | `protect_content` |
| Coordinator reacts: thumbs up shows "Seen" on the lens, OK hand "OK", heart "Thanks" | `message_reaction` update |
| Bot reacts OK hand to confirm a reply reached the lens | `setMessageReaction` |
| Coordinator dashboard inside Telegram | Mini App (`web_app` button, sign-in data checked on the server) |
| Only the person who set up the team, or a group admin, can run, end or reply. Everyone else can read the board | `getChatMember`, checked on every command and button |
| "Reached them, mark OK" button on missed check-in notices, so a solved problem stops alarming | Inline button, notice edited for the team |
| Volunteer gets a quiet "due soon" message and a loud "check-in time" message in their own private chat, with a Check in button that works even when the phone has paused the glasses app | Private chat, inline button, only that person's chat can press it |
| If the coordinator never pressed Start, notices come back to the group instead of being lost | Send fails, falls back to the group and says so |
| Reply seen on the lens puts an eyes reaction on the coordinator's own message | `setMessageReaction` |
| Ask team for backup from the lens menu: a loud team notice with a map pin, worded as a request | `sendVenue`, loud notification |
| Stays under Telegram's limits | 3.1 seconds between group sends, waits and retries on 429 |
| Webhook or polling | `setWebhook` with a secret header, or `getUpdates` |

The coordinator can answer a clue four ways: press a button, reply to the clue, react to it, or send `/reply Ana <text>`.

Discord works as a second channel: notices through a webhook, and reply buttons when a bot is set up (button presses are signature checked).

## Track 4: the Sheet and AI

| Part | What it does |
|---|---|
| Google Sheet in | Coordinator lists names and areas in a Volunteers tab, then `/import` gives everyone a pairing code |
| Google Sheet out | At `/end`, one row per volunteer goes to a Debrief tab and one row per clue to a Clues tab. No positions are written |
| AI one-line reply | A long coordinator message is shortened to one line for the lens. The full text stays under Repeat reply |
| AI run summary | Three plain sentences posted to the group at `/end` |

The AI only sees counts and clue words. No names, no positions. It runs on the server with Claude or OpenRouter, and only if a key is set. Without a key, long replies are trimmed instead.

## The judging lines

| Judging line | Where you see it |
|---|---|
| Useful at a glance | Run, area, check-in clock, "Team 3/4 checked in", the last reply, low battery and no signal lines |
| Read and write by voice or tap | Check in by ring tap or by saying "OK". Clue by voice (4 seconds, sends itself after 3 seconds, "cancel" or a swipe stops it), from a list of 4 quick clues, or with a photo |
| Technical | Check-ins and clues made with no signal are kept on the phone and sent in order when it returns, each with the time it was made (the server caps that time at 30 minutes and never accepts the future). `/interval 5` to `/interval 60` sets the check-in gap for a run. Timers live on the server, so a paused phone still gets noticed. Voices that are not the wearer's are dropped. Speech to text runs on the server and nothing is stored |
| Display and voice | Plain glyphs only, since the lens drops emoji. Every gesture changes the screen. Double tap on the main screen opens the exit dialog |
| Business and safety | Same wording on lens and bot: team notices only, not an emergency service. Positions deleted when the run ends |

## How each claim is checked

| Claim | How it is shown | Status |
|---|---|---|
| Clue becomes a map pin with four buttons, protected from forwarding | `npm run proof`, `test/bot.test.js` | Tested, seen on real Telegram |
| Missed check-in: coordinator at 17 minutes, whole team at 22 | `npm run proof`, `test/engine.test.js` | Tested, seen on real Telegram with short timers |
| Only the setup person or a group admin can run, end or reply | `test/review.test.js`, `npm run proof` | Tested with a fake Telegram. A plain-member refusal needs a second account |
| Mark OK, private check-in nudges, backup request, eyes reaction | `test/review.test.js`, `npm run proof` | Tested, seen on real Telegram |
| Offline queue keeps its own time (30 minute cap, never the future) | `test/review.test.js`, `glasses/test/view.test.js` | Tested. Not tried on real glasses |
| `/interval`, fuller debrief, `/end clear` | `test/review.test.js` | Tested with a fake Telegram only |
| Positions deleted at the end, none kept | `npm run proof`, `test/engine.test.js` | Tested |
| No emergency, life-saving or health wording anywhere | `npm run proof`, `test/engine.test.js`, `glasses/test/view.test.js` | Tested |
| "Still there?" from head motion | `glasses/test/motion.test.js` | Tested. The simulator sends no motion, so not tried live |
| Voice, Discord buttons, Mini App | `test/stt.test.js`, `test/discord.test.js`, `test/miniapp.test.js` | Tested with fakes only. See "Not yet checked live" |
| Double tap exit, swipe cancel, voice timer, dropping other voices | `glasses/src/main.js` | Built, no automated test. Not tried on real glasses |

## Bugs the live test found

Running on the real app found four bugs that fakes had hidden. All four are fixed and have a test: the status board posted three times when notices arrived together, turning on Topics changed the group's id and the bot lost its team, a photo failed because an empty button field was sent as the text "undefined", and a dropped connection lost the message (about 1 send in 8 on my Wi-Fi), so the server now tries once more.

## What I've seen work on real Telegram

I ran a full run on the live Telegram app with my own bot and group:

`/start` help and the admin link, the rights message in all three states, `/team`, `/run` with the consent line, `/add` with a pairing code, the private `/start CODE` link, a forum topic per run and closing it at the end, the pinned status board, a clue as a map pin with four buttons, a photo on a clue, protected content (Telegram showed "copying and forwarding is not allowed"), live location, a button press showing on the lens, a thumbs up showing "Seen" on the lens, a typed reply with the OK hand back, the missed check-in notice with buttons, the whole-team notice, the "gone quiet" notice, and `/end` with the board marked finished and live location stopped.

For the notices I shortened the timers so I didn't have to wait 17 minutes.

## Not yet checked live

| Part | Where it stands |
|---|---|
| Voice clue and spoken OK | Built. The speech to text step has run on real audio twice (a recorded clip, then a computer-spoken 4.8 second clip that came back word for word in 5.9 seconds, with the transcript deleted afterwards). Not tried with real glasses audio, since the simulator mic gives almost nothing |
| Google Sheet | Ran for real with a service account: the Volunteers tab was read (3 names and areas) and a debrief row and a clue row were written, with no positions. Not yet run through the `/sheet`, `/import` and `/end` commands in Telegram |
| Discord | The webhook notice reached a real Discord channel (1 second, one test message). Reply buttons need a Discord bot and are tested with fakes only |
| AI reply and summary | Ran for real through OpenRouter (Claude Haiku): a long reply came back as "Go to main road, wait by red car. Boat team arrives in 10 min" in 2.1 seconds, and a run summary in 2.6 seconds. If the Anthropic key has no credit, the server falls back to OpenRouter. Not yet run through a real `/end` in Telegram |
| Mini App dashboard | Built. Needs a public https address before Telegram will open it |
| Voice from someone else | Dropping frames the app marks as another speaker has not been tried with real audio |
| `/end clear` | Tested with a fake Telegram only |
| Real G2 glasses | Everything above ran in the simulator only. Camera, album and the "Still there?" prompt from head motion are untested, since the simulator sends no photos or motion |
| Newest Telegram parts | The coordinator-only check, Mark OK button, private check-in nudges, backup request and eyes reaction are tested with a fake Telegram. The nudges, Mark OK, backup pin and reactions have now run on real Telegram. The plain-member refusal is covered by tests only (it needs a second account) |
| Not built | A voice note copy of each spoken clue, and Telegram's new ephemeral messages |

## What this is not

- Not a life-saving tool, not an emergency service, and no replacement for radios or calling 999 or 911.
- No route finding and no medical anything. A "Still there?" prompt asks a question. It never says anything about someone's health.
- Positions only go to your own team's group, and never to the AI.
- "Ask team for backup" is a message to your own team. It does not call anyone and it does not promise that help is coming.
- Nothing listens in the background. The mic opens on a tap, or for three short rounds when a check-in is overdue or the app asks "Still there?".
- No camera on the glasses. Photos come from the phone.

## Privacy and consent

Everyone in a run's group agrees that their position is shared with the group while the run is active. Positions are deleted when the run ends.

Voice is turned into text on the server, and the transcript is deleted at the speech provider as soon as the words come back. Photos are passed straight to the group. The server keeps neither. Pairing codes work once and expire after 15 minutes.

## Run it with your own bot

1. Get a bot token from @BotFather in Telegram.
2. Copy the settings file and put the token in it:
   ```powershell
   cd callout
   Copy-Item .env.example .env
   notepad .env
   ```
3. Start the server. The log says "Telegram: polling".
   ```powershell
   npm start
   ```
4. Send `/start` to your bot and use the link it gives you to add it to a group as admin. It answers "All set".
5. In the group, send `/team Test`, then `/run Elm Street`, then `/add Ana | Area A1`. A pairing code appears.
6. In a second window, start the glasses app:
   ```powershell
   cd callout\glasses
   npm install
   npm run dev
   ```
7. Open the page in the Even Hub simulator and enter the code. Add `?dev=1` to the address for a panel that fakes battery, glasses off and signal, which the simulator doesn't send.
8. Tap to check in, pick a quick clue, and watch the pin land in the group.
9. Send `/end` for the debrief.

Every other key in `.env` is optional. Each one switches on one part (voice, Sheet, Discord, AI, webhook, Mini App) and Callout runs fine without it.

## What existed before

This repo was started on November 24 for this hackathon. The approach to Telegram alerts and to server-side speech to text comes from two earlier projects of mine (a token tracker's Telegram alerts and a voice record book that used AssemblyAI).

---

Has everyone on my team checked in, and if not, who and where were they last? That's the question Callout answers, on the lens and in the group chat.
