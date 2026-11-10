# Dashboard

The Dashboard is your show at a glance: what's playing, how many people are watching, and the controls you need during a show night. It refreshes itself every few seconds.

ShowPilot has two admin layouts. This page describes the standard one first; the [classic layout](help:dashboard#classic-layout) is covered at the end.

## Notices at the top

Banners appear above the Dashboard only when there's something to act on:

- **An update for the ShowPilot plugin in FPP is available.** Shows the installed and newest plugin versions, with a link to FPP's Plugin Manager. Click **Dismiss** to hide it until the next version comes out. If your plugin is too old to work properly with this ShowPilot, the banner turns red, says why, and can't be dismissed: update the plugin.
- **A new ShowPilot version is available.** Click **What's new & update** (or **What's new**) to open [Settings › Updates](help:settings-updates), or **Dismiss** to hide it until the next one.
- **Unread visitor messages.** Shows how many messages are waiting, and how many are waiting for the message wall. Click **Read them** to open [Messages](help:messages).

## Show control

The strip across the top holds the switches you'll use most.

### Viewer control

Turns audience interaction on or off. While it's **Off**, viewers can still watch your page but can't vote, request or race, and ShowPilot doesn't tell your show player what to play. Turning it **On** brings back the mode you used last (Voting, the first time).

### Mode

Choose **Off**, **Voting**, **Jukebox**, **Race** or **Listen only**. Picking a mode while viewer control is off turns it on. Choosing **Off** is the same as switching viewer control off. What each mode does is explained in [How ShowPilot works](help:how-it-works#viewer-control-and-modes).

> **Tip:** The same switch and mode menu sit in the top bar of every admin page, so you can change them without coming back here.

### Action buttons

The buttons on the right change with the mode. Each one asks you to confirm first.

| Button | Shown in | What it does |
| --- | --- | --- |
| **Reset votes** | Voting, Off | Clears every vote in the current round, so voting starts again from zero. |
| **Purge queue** | Voting, Jukebox, Listen only, Off | Deletes every request that hasn't played yet. Played requests stay in the history. |
| **Reset race** | Race | Clears all taps and starts a new race straight away. |

## Now playing

Shows the song that's playing, with its artist and an **ON AIR** light. When nothing is playing it says **Nothing playing**, **The show is idle.** and **OFF AIR**. If ShowPilot knows the song's length, a progress bar shows time played and time left.

**Up next** shows the song viewers will see as next, with a label saying where it comes from:

- **Vote leader**: the song currently winning the vote,
- **From the queue**: the next jukebox request,
- **Scheduled**: the next song in your show player's own schedule.

## Show numbers

| Number | What it counts |
| --- | --- |
| **Watching now** | People with your viewer page open right now. If anyone is listening through Listen on Phone, it adds how many. |
| **Votes this round** | Votes cast for the next song. In Jukebox and Listen only it becomes **Requests waiting**, the number of requests not yet sent to the show player. In Race it becomes **Taps this race**. |
| **Played by viewers** | Songs played because of votes, requests and PSAs, all time. Songs from your normal schedule don't count. |
| **Sequences** | Songs on your viewer page. |

## Live panel

This panel follows the mode:

- **Viewer control is off**: a reminder that viewers can watch but not take part, with a **Turn on viewer control** button.
- **Live vote** (Voting): the top songs this round with vote bars. The round closes when the current song ends.
- **Request queue** (Jukebox): every request that hasn't played, in the order it will play. Click the **×** next to a request to remove it. Requests marked **sent to the show player** are already handed over and can't be removed here.
- **Tap race** (Race): the race standings, and how this race ends: the leader when the timer runs out or when the song ends, or the first song to reach your tap target. Once a winner is decided it says **Decided: plays next**.
- **Listen only**: a reminder that viewers can watch and listen but not pick songs. If requests were already queued before you switched, it lists them under **Still to play from the queue** instead, because they still play.

## Top sequences

The six songs played most often because of viewers, all time, with play counts. Tick **Hide PSAs** to leave announcements out of the list. ShowPilot remembers your choice. The full numbers are on the [Stats](help:stats) page.

## Viewer QR Code

A scannable code that opens your viewer page, to print on a sign or show on a screen at your display.

- **Copy URL** copies the viewer page address.
- **Download SVG** saves the code as an image that stays sharp at any size.

The code only appears once you've entered a **Public web address** in [Settings › General](help:settings-general#public-web-address). Until then this card tells you to set it.

## Top bar and menu

On every admin page:

- the **Viewer control** switch and **Mode** menu,
- the viewer count (and phones listening),
- **Show**, which opens your viewer page in a new tab,
- the admin color theme menu,
- your name and **Log out** (see [Signing in](help:signing-in)).

The bottom of the menu shows **plugin online** or **plugin offline** for your show player, the **Classic layout** switch, and **Keep menu open**. The **Cockpit (tablet)** link opens a big-button remote; see [Cockpit](help:cockpit).

## Classic layout

Choose **Classic layout** at the bottom of the menu to switch; the classic layout has a **New layout** button to switch back. Its Dashboard has the same information, arranged differently:

- a **Now playing** / **Up next** card,
- number cards: **Active viewers**, **Listening on phones** (with today's total phones and the most at once), **Votes (round)**, **Queue depth**, **Sequences played** and **Total sequences**,
- a **Show Control** card with the **Viewer Control** switch, the **Mode** menu, **Reset Votes**, **Purge Queue**, and **Reset Race** in Race mode,
- **Top Sequences (all time)**, showing the top ten, with **Hide PSAs**,
- the **Viewer QR Code**.

A status strip under the header shows now playing, up next, the queue count and round votes on every page.
