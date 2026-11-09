# Settings › Debug

Tools for finding out what went wrong: ShowPilot's own log, and switches that help you measure and fix Listen on Phone timing. You won't need this page day to day.

## Server log

A running record of what ShowPilot has been doing: what the show player was told to play, what it reported playing, requests, votes and errors. The latest lines load when you open this page.

- **Show latest** reloads the newest lines (up to the last 400).
- Type a word in the box (for example `queue`, `playing` or `error`) and press **Show latest** or Enter to see only lines containing it. Capitals don't matter.
- **Download log** saves the whole log as a text file, with a short summary at the top (ShowPilot version, viewer mode, show player details).

Times in the log are UTC, not your local time.

> **Tip:** When you report a problem, download the log soon after it happens and attach it. Say roughly when it happened, so the right lines can be found.

> **Careful:** The show token and passwords are hidden in the log, but viewers' IP addresses can appear in it. Share it only with people helping you.

## Listen on Phone diagnostics

The switches below help you troubleshoot audio sync. They're all off by default.

> **Important:** These switches affect your live viewer page, and most of them show extra readouts or buttons to **every** visitor. Turn them on while you're testing and off again when you're done.

### Show sync debug overlay on viewer page

Pins a live readout to the top of the viewer page: drift, player position, clock offset and calibration. It's the same as adding `?debug=1` to the end of your viewer page address, except that this switch shows it to everyone.

> **Tip:** To check timing on your own phone without showing the overlay to viewers, leave this off and add `?debug=1` to the address on your phone.

### Compensate hidden output delay (experimental)

Some phones, often Android, say their audio has no delay but quietly hold it back a little, so the music lags the lights like an echo. The overlay's `outDelay` line shows the delay ShowPilot measured. With this on, the player corrects for it too. It takes effect when the viewer page is reloaded.

### Microphone sync measurement

Adds a **Measure sync** button to the viewer page while someone is listening. Stand near your show speakers with the phone playing the show and press it. The phone records a few seconds with its own sound on and a few with it muted, then tells you how many milliseconds the speakers are behind or ahead of the phone, and which [Audio sync offset](help:settings-audio#audio-sync-offset) to try.

Browsers only allow the microphone on a secure page, so open your viewer page by its normal `https://` address.

### Sync probe: compare relayed timing with the show player directly

For measuring audio sync in detail. The phone player also connects straight to the audio helper on your show player, and reports how far ShowPilot's relayed position is from the show player's own, in the debug overlay and the browser console.

Browsers block this on an `https://` page. Open the viewer page by this server's local `http://` address, on the same network as your show player.

### Show audio stats in player bar

Shows the drift and calibration readout in the small status line inside the Listen on Phone player bar. Handy for tuning sync phone by phone.

For the bigger picture on keeping phones in time with the lights, see [Phone audio, start to finish](help:phone-audio).
