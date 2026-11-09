# FPP Monitor

A live view of your show's main FPP, right in ShowPilot: what's playing, what's next, how healthy the Pi is, and the MultiSync remotes it sees. You can also start a playlist, stop the show, run a command preset or restart FPPD from here.

ShowPilot doesn't connect to FPP itself. Your show player sends its status to ShowPilot, so this page works wherever ShowPilot runs, including away from your show's network. On FPP that needs the ShowPilot plugin (**ShowPilot Blackbox**) 0.14.26 or newer. The page fills in a few seconds after the plugin checks in.

If your show player isn't FPP and reports its own short name, the page uses that name instead of "FPP" (in the menu, the Dashboard strip and the controls).

While the page is open it updates about every second. When it's closed, your show player reports every few seconds, which keeps the Dashboard strip current.

## At the top

A colored dot and the state: **Playing**, **Idle**, **Paused**, **Stopping** or **Test mode**, with FPP's host name and when the last report arrived.

- **Green** means everything looks fine.
- **Amber** means something to keep an eye on: a warm CPU (70°C or more), a disk getting full (15% free or less), a MultiSync remote FPP hasn't seen for two minutes, or a warning FPP itself shows.
- **Red** means act now: a hot CPU (80°C or more), a disk almost full (5% free or less), or no report from your show player for over a minute (**Not checking in**).

Each problem is listed under the state. **Open FPP** opens FPP's own pages in a new tab. It only works when your device is on the same network as FPP.

## Now playing

The sequence playing, its playlist and position in it, and a progress bar with time played and time left. Below that: what FPP's scheduler starts next and when, and whether the scheduler is on.

## Health

- **CPU temperature**, colored green, amber or red as above.
- **CPU**, **Memory** and **Disk used** bars, with the free space in GB.
- **Uptime**.
- Every other sensor FPP reports (for example a cape's voltage or a second temperature) as small chips.

## System

FPP's mode (player or remote), version, hardware, OS, host name, IP address, the plugin version, and when the last report came in.

## Controls

| Control | What it does |
|---|---|
| **Start playlist** | Starts the playlist you pick, once, replacing what's playing. The list comes from FPP. |
| **Run preset** | Runs one of FPP's command presets (Content Setup › Command Presets). |
| **Stop gracefully** | Lets the current song finish, then stops. |
| **Stop now** | Stops the show immediately. Asks first. |
| **Restart FPPD** | Restarts FPP's player. The show stops for a few seconds. Asks first. |

Controls only work while your show player is checking in. Each one runs within a second or two. **Recent controls** lists them with who pressed each and whether it worked. A control your show player doesn't pick up within 30 seconds is dropped, so nothing runs long after you pressed it.

> **Note:** There's no volume control, reboot or shutdown here on purpose. Volume is best set once at FPP or your transmitter, and a mis-tap on reboot in the middle of a show is a bad night.

## MultiSync

Every other system FPP sees on its network (remotes, other players, controllers that answer MultiSync), with its address, mode, version and when FPP last heard from it. A green dot means it was seen in the last two minutes.

## Dashboard strip

Once your show player reports, the [Dashboard](help:dashboard) shows a one-line strip: FPP's state, the song, and the CPU temperature, colored like the dot above. Click it to open this page.
