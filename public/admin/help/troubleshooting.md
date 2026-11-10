# Troubleshooting

Common problems and what to check, quickest fixes first. Each section links to the page with the full details.

## Viewers can't vote or request

Viewers usually see a message saying why. Match it to the list below.

- **Viewer control is off, or in the wrong mode.** Votes only work in **Voting** mode, requests only in **Jukebox** mode, and race taps only in **Race** mode. In **Listen only**, viewers see "Requests and voting are closed for now". Check **Viewer Control** and **Mode** on the [Dashboard](help:dashboard).
- **"Location required…" or "You must be within … miles of the show".** **Require viewers be within radius of show location** is on in [Interaction Safeguards](help:settings-safeguards). The viewer must allow location and be inside the radius.
  - If viewers see "Show location not configured on server", the location check is on but your show's latitude and longitude are empty. Set them, or turn the check off.
  - Browsers only share location on an `https://` page. If your viewer page is plain `http://`, the location check can't work. See [Public Access](help:settings-public-access).
  - Pages opened inside apps such as Facebook or Instagram often can't share location. Viewers should open the page in Safari or Chrome.
- **"Invalid or missing access code."** **Require viewers to enter a code to interact** is on. Make sure the code you post at the show matches the one in Interaction Safeguards.
- **"The queue is full."** The jukebox queue has reached its depth. Raise **Jukebox queue depth** in [Jukebox](help:settings-jukebox) or wait for songs to play.
- **"You already have … in the queue."** The per-viewer request limit is working as intended.
- **"That sequence has been requested the maximum number of times."** **Max copies of the same song in queue** has been reached for that song.
- **"That song is playing right now" or "That song is already up next".** The repeat blockers are on.
- **"That sequence was recently played"** or a cooldown message. The song is resting after it played. See [Sequences](help:sequences).
- **A song is missing from the list.** Check its **Visible**, **Vote** and **Jukebox** switches on [Sequences](help:sequences), whether its category is switched off, and whether it's **Inactive** (no longer in your show player's playlist).
- **One viewer is refused everywhere** with "Your IP has been blocked": their address is in **Blocked IPs** in Interaction Safeguards.

## The show player isn't connected

The admin header says **plugin offline** or **plugin never connected**, and the **Plugin** tab shows **Offline** or **Never seen**. ShowPilot counts the plugin as online while it has checked in during the last minute.

1. Make sure FPP is running and the ShowPilot plugin is installed. FPP must be version 10.0 or newer.
2. Check the plugin's **ShowPilot Server URL**: open that exact address in a browser on FPP's network and you should see ShowPilot.
3. Check the plugin's **Show Token** matches the one on ShowPilot's **Plugin** tab exactly. A wrong token is refused.
4. Look at the plugin's log in FPP under **Status/Control › Logs**, or its **Diagnostics** tab.
5. If the Dashboard shows a red banner saying the plugin needs updating, update it in FPP's **Plugin Manager**.

Full steps: [Connecting your show player](help:fpp-plugin).

## Songs are missing or out of date

- **No songs at all:** the plugin hasn't synced yet. Check its **Remote Playlist** setting, then press **Sync Now** in the plugin. The **Plugin** tab's **Last sync** shows when it last synced and how many songs came across.
- **A song you added in FPP isn't there:** it must be in the playlist the plugin syncs. Add it, then sync.
- **A song you removed still shows in the admin:** it's now **Inactive**. It's hidden from viewers but kept with its details. Use **Delete Inactive** on [Sequences](help:sequences) if you want it gone.
- **A song appears once even though it's in the playlist twice:** that's expected. ShowPilot keeps its first position and notes the duplicate on the Sequences page.
- **Wrong or missing cover art:** use **Fetch Covers** on Sequences, or click a cover to pick another.
- **Your own display names were replaced:** they aren't. Syncing only fills in names, artists and covers that are still empty or unchanged.

## Phone audio is silent

- **No Listen button on the viewer page:** check **Audio enabled** in [Settings › Audio](help:settings-audio). The button is also hidden while viewer control is **Off**; viewers need to reload the page after you turn it back on.
- **The player says "Show is not playing"** or **"No audio for this sequence":** nothing is playing, or the current song has no audio file. Sync the plugin so ShowPilot has the file.
- **"Audio is only available to listeners present at the show":** the distance gate is on and the viewer is outside the **Audio radius**. See [Phone audio, start to finish](help:phone-audio#5-distance-gate).
- **Works on home Wi-Fi but not on cellular:** set the **Public web address** in [Settings › General](help:settings-general#public-web-address), and make sure ShowPilot is reachable from the internet.
- **"Tap to resume audio":** the phone paused audio (a call, the screen locking). Tapping the player resumes it.
- **Check the Audio Cache:** on the **Plugin** tab, **Cached files** should roughly match your songs. If it's empty, check **Audio enabled** and sync the plugin. **Clear All** forces a full re-upload on the next sync.

## Phone audio is out of sync

- **Every phone is off by the same amount:** adjust **Audio sync offset** in [Settings › Audio](help:settings-audio#audio-sync-offset). Positive if phones are ahead of the lights, negative if behind. It applies from the next song.
- **Only some listeners are off:** it's their Bluetooth, headphones or car stereo. Turn on **Let listeners adjust audio timing** so they can fix it on their own phone.
- **FPP isn't sending MultiSync packets:** with FPP in Player mode, open **Status/Control → MultiSync** in FPP, turn on **Send MultiSync Packets**, then restart FPPD. FPP only hands the plugin the exact song position while that's on; without it, phones still play but follow a rougher position. The FPP Monitor and the Dashboard warn when it's off.
- **Sync drifts or is loose for everyone:** check the plugin is online, and the **Daemon port** in Settings › Audio matches the plugin (8090 unless you changed it). ShowPilot must be able to reach your show player on your local network for the live position feed.

Full guide: [Phone audio, start to finish](help:phone-audio).

## You can't sign in

- **"Invalid credentials":** the username or password is wrong, or the account has been disabled. Another admin can re-enable it or set a new password with **Reset PW** on [Users](help:users).
- **"Too many login attempts. Please wait a few minutes and try again.":** after 8 failed attempts in 15 minutes from the same place, sign-in pauses. Wait, then try again carefully.
- **Signed out every time you close the browser:** tick **Remember me on this device (30 days)** when you sign in.
- **Asked to change your password:** this happens the first time you sign in with the default password, or when another admin set your password and asked for it to be changed. Choose your own to continue.

More in [Signing in](help:signing-in).

## The tools can't find your songs

**Audio Normalizer** or **Announcements** says ShowPilot doesn't know your show player's address yet, or doesn't list your FPP songs:

- the plugin must have connected at least once, and
- ShowPilot learns the address only when FPP is on a private home network it can reach.

You can still use **Files from this computer** or upload a song instead. If either tool says **ffmpeg is needed**, follow the install hint it shows, then restart ShowPilot. See [Audio Normalizer](help:tools-normalizer).
