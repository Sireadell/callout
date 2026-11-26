# Dev panel (practice panel)

A developer tool, not part of the app. It runs the real glasses app code and the real server on your own computer, and fakes everything around them: the ring, battery, wearing, head motion, signal, position and Telegram. Nothing leaves the computer.

## Run it

Install the glasses packages once:

```powershell
npm ci --prefix glasses
```

The page with buttons, at http://127.0.0.1:8790:

```powershell
node devpanel/panel.js
```

The scripted check (about two minutes):

```powershell
node devpanel/proof.js
```

## What the scripted check covers

| Item | What happens |
|---|---|
| Map pin | A quick clue with a fake position goes out as a map pin with reply buttons |
| Reply | A pressed button shows on the lens, a tap reports it as seen |
| Battery | 10% reaches the coordinator and the lens |
| Glasses off | The coordinator is told |
| No signal | A clue and a check-in are kept, then sent. The clue says how late it was. The quiet notice fires (limit shortened to 20 seconds) |
| Still there? | Five minutes of no movement (the lens clock is moved) brings the question, three unanswered rounds tell the coordinator |
| /end clear | The debrief is posted and delete requests go out for the messages that showed a position |

## What it cannot prove

- Anything about real glasses: their sensors, battery reports, wearing detection, microphone or how text looks on the lens.
- Real signal loss, or whether the phone pauses the app.
- The phone's real location.
- Real Telegram: delivery, map pins on screen, notification sound, or that messages are really deleted.
- Speech to text. The server's built-in developer stub answers every voice round with fixed words.

Say "dev panel" on screen whenever a capture from it is shown.

## One known gap it shows

The "back online" notice is sent only when the 30 second heartbeat is the first call to reach the server after a quiet spell. A sync or a held item arriving first clears the quiet flag without a notice. The check prints this as a NOTE and does not fail on it.
