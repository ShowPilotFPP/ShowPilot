# Cockpit (tablet remote)

Cockpit is a big-button show remote for a tablet at your booth or garage. It puts the controls you use during a show on one screen, with large tiles that are easy to tap, and leaves the rest of the admin out of the way.

## Opening Cockpit

Go to **Settings › Cockpit** and press **Open Cockpit**, or open `/admin/cockpit.html` on your ShowPilot address in the tablet's browser. **Customize Cockpit** opens it ready to edit. See [Cockpit settings](help:settings-cockpit).

You sign in with your normal admin account. If you aren't signed in, Cockpit sends you to the sign-in page first. If your account has to change its password, you're taken to the full admin to do that.

> **Tip:** On the tablet, add Cockpit to the home screen. It then opens full screen like an app.

## The header

- **Player online** or **Player offline**: whether your show player's plugin has checked in during the last 30 seconds.
- **watching**: how many people have your viewer page open.
- **Theme**: the color theme for Cockpit.
- **Edit layout**: rearrange the tiles (see below).
- **Full admin**: back to the normal admin pages.

Cockpit refreshes itself every few seconds and updates straight away when something changes, so you don't need to reload it.

## The tiles

Tiles come in a few kinds:

- **On/off switches** show **On** or **Off**. Tap to flip.
- **Choices** show a row of buttons; the lit one is active.
- **Numbers** have **−** and **+** buttons.
- **Buttons that change something big** ask first: tap once and the tile turns to **Tap again to confirm**. If you don't tap again within a few seconds, nothing happens.
- **Status** tiles just show a value.
- **Panels** show live information.

Every change a tile makes is the same change you'd make in the full admin, and it takes effect straight away.

### Show control

| Tile | What it does |
|---|---|
| **Now playing** | The current song, a ring counting down the time left, and what's **Next** (labelled *vote leader*, *from the queue* or *scheduled*). Shows **OFF AIR** when nothing is playing. |
| **Viewer control** | Turns viewer control on or off. Turning it on returns to the last mode you used, or Voting if there isn't one. |
| **Mode** | **Off**, **Voting**, **Jukebox**, **Race** or **Listen only**. See [How ShowPilot works](help:how-it-works). |
| **Live standings** | Vote counts in Voting, tap counts in Race, or the upcoming requests in Jukebox. |
| **Request queue** | Pending requests, each with **Remove** (asks to confirm). See [Queue](help:queue). |
| **Reset votes** | Clears the votes for the current round. |
| **Purge queue** | Empties the request queue. |
| **Reset race** | Resets the current race. |

### Safeguards

Switches for **Location check**, **Location code**, **One vote per round**, **Viewers can change vote**, **Tiebreak rounds**, **One request at a time**, **Block requests for the playing song** and **Block requests for the next song**, plus number tiles for **Queue depth** (1 to 50) and **Requests per viewer** (1 to 20). These are the same settings as [Interaction Safeguards](help:settings-safeguards), [Voting](help:settings-voting) and [Jukebox](help:settings-jukebox).

### Songs & categories

- **Songs**: every song with a switch to show or hide it on the viewer page.
- **Skip cooled-down songs in playlist**: also skips songs on cooldown in your show player's normal playlist.
- One switch per song category you've created, to turn that category on or off on the viewer page.

### Viewer page

- **Viewer page template**: switch which template is live (up to your first four templates).
- **Page effect**: pick a falling effect such as **Snow**, **Leaves** or **Fireworks**, or **None**.
- **Song progress bar** and **Translation**: on/off switches.

### Status

Read-only tiles: **Watching now**, **Votes this round**, **Requests waiting**, **Time left in song** and **Player** (**Online** or **Offline**).

### FPP

The cards from the [FPP Monitor](help:fpp-monitor) page, as tiles. They need the ShowPilot plugin on FPP (0.14.26 or newer).

- **FPP status**: playing or idle, colored green, amber or red, with any problems listed.
- **Now playing on FPP**: the sequence and playlist, and what FPP's scheduler starts next.
- **FPP health**: CPU temperature, CPU, memory and disk bars, and uptime.
- **FPP system**: mode, version, hardware, host name, IP address and plugin version.
- **FPP controls**: start a playlist, run a command preset, **Stop gracefully**, **Stop now** and **Restart FPPD**. Each button asks you to tap again to confirm.
- **MultiSync**: every remote with its status, CPU temperature, CPU, memory and uptime (plugin 0.14.27 or newer). Systems you hid on the FPP Monitor page stay hidden here.
- Single numbers: **FPP CPU temperature**, **FPP CPU**, **FPP memory**, **FPP disk free** and **FPP uptime**.

### Layout

**Spacer** adds empty space to arrange the other tiles. You can add as many as you like. They're only visible while editing.

## Changing the layout

1. Press **Edit layout**. The **Add tiles** list opens beside the tiles.
2. Add a tile by dragging it onto Cockpit or tapping **+ Add**. Tiles already on Cockpit show **Added**.
3. Each tile gets a small strip of buttons:
   - **‹** and **›** move it earlier or later,
   - **S**, **W** or **L** cycles its width (one tile, half width, full width),
   - **↕** sets a spacer's height (1 to 4 rows),
   - **×** removes it.
   With a mouse you can also drag tiles to a new place.
4. Press **Done** (or **Done editing**) when finished.

Changes save automatically. Your layout belongs to your user account, so it follows you to any tablet you sign in on, and other users keep their own. **Reset to default** puts back the standard layout.

If you delete a song category that had a tile, the tile is hidden and shows **No longer available** while you're editing, so you can remove it.
