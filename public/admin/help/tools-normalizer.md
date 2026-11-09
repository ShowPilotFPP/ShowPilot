# Audio Normalizer

**Tools › Audio Normalizer** makes every song in your show equally loud, so nobody reaches for the volume knob when the playlist moves from a quiet ballad to a loud pop track.

It measures how loud each song actually sounds and turns the whole song up or down by a fixed amount. The mix itself isn't changed. The fixed files keep their names, length and tags, so you can put them straight back on your show player and your sequences keep working.

> **Tip:** This is different from peak normalizers and gain tags (MP3Gain or ReplayGain). Those don't match how loud songs *sound*, and FPP ignores gain tags anyway.

If the page says **ffmpeg is needed for this tool**, ShowPilot can't find the audio program it uses. The message lists what's missing and how to install it for your system. Install it, restart ShowPilot, and open the page again.

## Match songs by

How "equally loud" is judged.

- **How they sound on show speakers (recommended)** measures songs the way outdoor speakers and FM radios play them. Deep bass they can't reproduce is left out, and a typical moment of the song counts rather than a few loud bursts. Songs that get their loudness from big bass hits stop sounding quieter than the rest.
- **Standard loudness (LUFS)** puts every song exactly on the target LUFS, the standard used by streaming services and broadcasters. Bass-heavy songs can still sound quieter than the others on show speakers.

Your choice is remembered for next time. If the speaker option is greyed out, your copy of ffmpeg is missing a filter it needs, and the tool uses LUFS.

## Target loudness

The overall level the show ends up at.

| Choice | When to use it |
|---|---|
| **-14 LUFS — standard (recommended)** | Right for most shows. |
| **-16 LUFS — a little quieter, fewer songs need limiting** | If you'd rather touch fewer songs with the limiter. |
| **-11 LUFS — loud** | Closer to how loud commercial releases are mastered. |
| **Custom…** | Any value from -30 to -5 LUFS. |

Most commercial songs are mastered around -8 to -11 LUFS, so at -14 your show usually gets a little quieter overall. Raise your FPP or transmitter level once afterwards to make up for it.

With show-speaker matching, this is the level a typical song lands on. Bass-heavy songs end up slightly above it and bright ones slightly below, which is what makes them *sound* the same.

## Peak ceiling (dBTP)

No song will peak above this level. The default, **-1.5**, leaves room for MP3 encoding so nothing clips. You can set anything from -9 to 0.

## Let quiet songs reach the target with a gentle limiter

Some quiet songs have a few sharp peaks, so turning them up would push past the ceiling.

- **On** (default): a limiter tames just those peaks, and the song matches the others.
- **Off**: the song is turned up only as far as its peaks allow, and may end up a little quieter.

## Choosing songs

Pick where the songs come from:

- **Songs on FPP** lists the audio files in your show player's music folder. Use the filter box to find songs, tick the ones you want or use **Select all**, and **Refresh** to re-read the folder. This list only appears once your show player has connected to ShowPilot, because that's how ShowPilot learns its address. See [Connecting your show player](help:fpp-plugin).
- **Files from this computer** lets you upload MP3, M4A, AAC, WAV, FLAC or OGG files. Each fixed file comes back in the same format with the same name.

Press **Normalize** to start. A batch can hold up to 300 songs, and each uploaded file can be up to 300 MB.

## Results

Each song gets a row showing its loudness **Before**, the **Change** applied, the loudness **After**, whether its **Length** is the same, and its **Status**:

| Status | Meaning |
|---|---|
| **Fixed** | A new version is ready. |
| **Already right** | The song was within 0.5 of the target and is left untouched. No need to replace it. |
| **Failed** | Something went wrong; the reason is shown under it. |

Notes under a song explain anything unusual, such as a song that couldn't get closer to the target without sounding squashed, or one that was too short to judge on speakers and was matched by LUFS instead. With speaker matching, a song that sounds very different on speakers than its LUFS reading suggests is capped at 4 dB away from standard loudness.

> **Careful:** If a row shows **Length changed — check it against the sequence before using it**, don't send that file until you've checked the sequence still lines up.

### Adjust

Turns one song up or down by hand, on top of the automatic match, between -6 and +6 dB. The song is fixed again from the original. If you'd already sent it, send it again afterwards.

## Getting the fixed files onto your show player

- **Send to FPP** replaces one song in FPP's music folder with the fixed version. **Send all fixed to FPP** does every fixed song at once. Same names, so playlists and sequences keep working.
- **Restore original** puts the original file back after you've sent a fixed one.
- **Download** (per song), **Download fixed files (.zip)** and **Download originals (.zip)** save copies to your computer. To do it by hand, upload the fixed files in FPP's **File Manager › Audio**, replacing the old ones.

> **Careful:** Replacing a song while it's playing can cause a glitch. ShowPilot warns you if the show is playing. Do this with the show stopped.

> **Tip:** Download the originals first if you want your own backup.

Phone listeners hear the new versions after the plugin next syncs. See [Phone audio, start to finish](help:phone-audio).

## Start over and how long files are kept

**Start over** clears the batch so you can begin a new one. If you leave the page and come back in the same browser tab, your batch picks up where it was. Files are kept on the server for 3 hours after you last open the page, then deleted.
