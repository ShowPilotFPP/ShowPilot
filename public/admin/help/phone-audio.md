# Phone audio, start to finish

**Listen on Phone** lets viewers hear your show through their own phones, in time with the lights, without an FM radio. This guide follows the audio from your show player to a viewer's phone, and explains how to fix timing and the usual problems. Each setting is described in full on [Settings › Audio](help:settings-audio).

## 1. How songs get to ShowPilot

Your audio files live on your show player (FPP). When the plugin syncs, it also uploads each song's audio file to ShowPilot, which keeps its own copy and plays it to phones from there. That's much faster for viewers and lets many people listen at once without slowing your show player.

- The plugin only uploads files ShowPilot doesn't already have, so the first sync takes longest and later ones are quick.
- If you replace a song on FPP (for example after the [Audio Normalizer](help:tools-normalizer)), sync again so phones get the new version.
- The **Plugin** tab's **Audio Cache** card shows how many files ShowPilot holds and their total size. **Show file list** lists them. **Prune Orphans** removes files no current song uses; **Clear All** wipes everything so the next sync uploads it all again.
- If a song isn't in ShowPilot's copy, phones fall back to streaming it through your show player, as long as ShowPilot can reach it on your network.

Phone audio needs **Audio enabled** switched on in [Settings › Audio](help:settings-audio#audio-enabled). With it off, the plugin doesn't upload audio at all.

See [Connecting your show player](help:fpp-plugin) for setting up the plugin and syncing.

## 2. How a viewer starts listening

1. The viewer opens your viewer page and taps the floating **Listen on phone** button. You can change how that button and the player look on [Viewer Page › Listen-on-Phone](help:viewer-phone).
2. If you use the [distance gate](help:settings-audio#audio-distance-gate), the phone asks for their location first.
3. The player opens, shows the song's title, artist and cover, and joins the song at the right point, like tuning into a radio mid-song.

The player can be hidden while the audio keeps playing (a small pill stays on screen), paused, muted, or closed.

The Listen button is hidden when:

- **Audio enabled** is off,
- viewer control is **Off** (the player says **Show is offline**). Viewers need to reload the page after you turn the show back on. In **Listen only** mode, phone audio works while voting and requests are closed.

When nothing is playing, the player shows **Show is not playing** and waits for the next song. A song with no audio file shows **No audio for this sequence**.

## 3. How sync works, in plain words

Every phone downloads the song from ShowPilot and plays it itself. To keep all the phones lined up with the lights:

- An audio helper that the plugin runs on your show player reports exactly where the song is, several times a second.
- ShowPilot passes that position on to every listening phone.
- Each phone compares where it is with where the show is, and gently speeds up or slows down by a tiny amount until they match.

ShowPilot reaches the helper on the **Daemon port** (8090 unless you changed it in the plugin). The next song is downloaded ahead of time, so song changes are quick.

## 4. Fixing timing

There are two different fixes. Use the right one.

### Everyone is off by the same amount: Audio sync offset

If every phone is ahead of or behind the lights, the cause is your setup (speaker delays, how your show player outputs audio). Fix it once for everyone with [Audio sync offset](help:settings-audio#audio-sync-offset):

- phones sound **ahead** of the lights: enter a **positive** value,
- phones sound **behind**: enter a **negative** value.

Change it in steps of 50 to 100 ms and listen to the next song; it applies from the next song.

### Only some listeners are off: listener timing

Bluetooth headphones, Bluetooth speakers and car stereos add their own delay, which the phone can't measure. That's different for every listener, so the fix belongs on their phone.

Turn on [Let listeners adjust audio timing](help:settings-audio#let-listeners-adjust-audio-timing). Listeners then get an **Audio timing** button in the player. It opens a sheet where they can:

- tap **Music is early** or **Music is late** to nudge the sound in small steps,
- drag the slider for fine control,
- pick a preset (**Phone speaker**, **Bluetooth headphones**, **Car Bluetooth**),
- on phones that support it, tap **Detect my delay**, which listens through the microphone for a few seconds and sets the timing for them,
- **Reset** back to zero.

The adjustment is saved on that phone only. You choose how far the slider goes with **Slider range**.

> **Tip:** Turn on **Show a tip in the timing sheet** and add the **Audio Sync Help** block to your viewer page in the Visual Designer to give listeners step-by-step help.

> **Careful:** Don't use the global offset to fix one listener's car stereo. It moves everyone else out of sync.

### Measuring precisely

[Settings › Debug](help:settings-debug) has tools for tuning sync yourself, such as **Microphone sync measurement**, which adds a **Measure sync** button that reports how far your speakers are behind or ahead of a phone and suggests an offset to try. These are visible to every visitor while on, so turn them off when you're done.

## 5. Distance gate

If you play music you don't have streaming rights for, the [Audio distance gate](help:settings-audio#audio-distance-gate) limits listening to people near your show. A viewer who isn't close enough sees **Audio is only available to listeners present at the show**. One who doesn't share their location is asked to allow it and refresh.

The location is checked when they tap the Listen button and again while they listen, so someone who drives away is cut off. If they come back within range, the Listen button reappears and they tap it to carry on.

> **Important:** The gate measures from your show's location in [Interaction Safeguards](help:settings-safeguards). If that location isn't set, the gate lets everyone listen.

## 6. Listener limits

ShowPilot sets no limit on how many phones can listen at once. The header shows how many phones are **listening** right now, and the [Stats](help:stats) page keeps a daily record of the most at once and how many different phones listened. The live count is a close estimate: a phone with its screen locked may stop checking in.

## 7. Listeners away from your home network

People on cellular data can't reach ShowPilot by its local address. Make ShowPilot reachable from the internet and enter that address as the [Public base URL](help:settings-audio#external-audio-access). See [Public Access](help:settings-public-access).

## Common problems

| Problem | What to check |
|---|---|
| No Listen button | **Audio enabled** is on, and viewer control isn't **Off**. Ask viewers to reload the page. |
| **Audio is only available to listeners present at the show** | The distance gate is on and the viewer is outside the **Audio radius**. Check your show location and radius. |
| Viewer at the show is still turned away | Their phone may be sharing only an approximate location (on iPhone, **Precise Location** for Safari Websites is off), or they opened the page inside an app such as Facebook or Instagram, whose built-in browser won't share location. The message on their phone explains what to do; opening the page in Safari or Chrome usually fixes it. |
| Player says **No audio for this sequence** | The song has no audio file in FPP, or hasn't synced yet. Sync the plugin. |
| Silent, or **Tap to resume audio** | The phone paused the audio (a call, the screen locking). Tapping the player resumes it. |
| Plays on Wi-Fi but not on cellular | Set the **Public base URL**. |
| Old version of a song plays | Sync the plugin after replacing files on FPP. |
| A song is missing from the **Audio Cache** | Very large files (over 50 MB) aren't stored by ShowPilot and stream through your show player instead. |
| Everyone out of sync | Adjust **Audio sync offset**. Check the plugin is online. |
| One person out of sync | Their Bluetooth or car audio. Point them to the **Audio timing** button. |

More in [Troubleshooting](help:troubleshooting).
