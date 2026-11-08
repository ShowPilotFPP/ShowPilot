# How ShowPilot works

ShowPilot sits between your audience and your show player. Viewers use a web page on their phones; ShowPilot collects their votes and requests and tells your show player (Falcon Player, through the ShowPilot plugin) what to play next. This page explains the moving parts.

## The three pieces

- **Your show player** (FPP) runs the lights and music, following its own playlist and schedule, just as it would without ShowPilot.
- **The ShowPilot plugin** runs on the show player. It keeps ShowPilot informed and asks it what viewers want.
- **ShowPilot** hosts the viewer page and this admin, keeps the votes and the request queue, and decides what plays next.

## How the show player and ShowPilot talk

The plugin checks in with ShowPilot regularly and proves who it is with your **Show Token** from the [Plugin](help:plugin) page.

The plugin:

- **Sends your playlist.** When it syncs, the songs in your FPP playlist appear on the [Sequences](help:sequences) page. Songs no longer in the playlist become inactive: kept with all their details, but hidden from viewers.
- **Reports what's playing**, what's scheduled next, and the exact position in the song, about twice a second while music plays. That's what drives **Now playing**, **Up next** and phone audio sync.
- **Asks what to play next.** ShowPilot answers with the vote winner, the next request, the race winner or a PSA, depending on the mode. The plugin hands that song to FPP; afterwards FPP returns to its own schedule.

The admin shows **plugin online** while ShowPilot has heard from the plugin within the last minute, and **plugin offline** otherwise. Setup is covered in [Connecting your show player](help:fpp-plugin).

## Viewer control and modes

**Viewer control** is the master switch. While it's off, ShowPilot only watches: it shows what's playing but never tells the show player what to do, and viewers can watch but not vote or request. Turning it back on returns to the mode you used last.

| Mode | What viewers do | What gets played |
| --- | --- | --- |
| **Voting** | Each viewer gets one vote per round. | The song with the most votes plays next. A new round starts when that song begins. |
| **Jukebox** | Viewers request songs. | Requests play in the order they arrived. |
| **Race** | Viewers tap a song as fast as they can. | The leader wins when the race ends and plays next, or straight away if you allow interrupting. |
| **Listen only** | Viewers see what's playing and can listen on their phones. | Nothing new is added. Requests already in the queue still play. |

When nobody votes or requests, your show simply follows its own schedule.

### Voting ties

If two songs are tied for the lead, ShowPilot can run a short tiebreak where viewers vote again between just those songs. If there is still no winner when time runs out, the votes are cleared and the show plays its scheduled song. See [Settings › Voting](help:settings-voting).

### Race

A race ends on a timer, when the current song ends, or when a song reaches a set number of taps, depending on your settings. See [Settings › Race](help:settings-race).

## The queue

In Jukebox mode, every request goes into the queue. ShowPilot hands requests to the show player **one at a time**: the next one is only handed over once the previous one has started playing, so nothing is skipped or lost. A request that has been handed over shows as **Sent to the show player**.

To keep the queue tidy:

- a request that was never handed over is dropped after 2 hours,
- a handed-over request that never starts is dropped after 5 minutes.

You can watch and edit the queue on the [Queue](help:queue) page or the [Dashboard](help:dashboard).

## PSAs and cooldowns

- **PSAs** are announcement sequences. ShowPilot slips one in between songs after a set number of viewer interactions or songs. This only happens while viewers can take part: not when viewer control is off or in Listen only. PSAs are never listed for viewers.
- **Cooldowns** stop a song from being picked again too soon after it plays. A viewer who tries is told the song was recently played and to pick another.

## What viewers see

Viewers open your ShowPilot address (or scan your QR code) and get the active template from [Viewer Page › Template Editor](help:viewer-editor). The page updates live and shows:

- what's playing and what's up next,
- the song list, with voting, request or race buttons depending on the mode,
- the request queue or vote counts, if your template includes them,
- a **Listen** button for phone audio, if it's turned on (see [Phone audio, start to finish](help:phone-audio)).

Location checks, access codes and other limits on who can take part are set in [Interaction Safeguards](help:settings-safeguards).
