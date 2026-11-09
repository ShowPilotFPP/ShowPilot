# Announcements

**Tools › Announcements** makes spoken announcements without you having to record yourself. Use it for a clip of its own ("Tune your radio to…", donation asks, "the show starts soon") to drop into a playlist, or for a voice-over on a song's intro with the music turned down underneath.

Songs keep their exact length, so their sequences stay in sync. This tool is marked **Beta**.

> **Tip:** This tool needs ffmpeg, the same as the [Audio Normalizer](help:tools-normalizer). If the page says ffmpeg is needed, follow the install hint on the Audio Normalizer page.

## 1. The voice

Pick where the voice comes from.

### Free voices (on this server)

Natural-sounding voices that run on your ShowPilot server, with no account and no internet needed once installed. The first time, choose a size and press **Install free voices**:

- **Best quality (about 350 MB download)** sounds a little smoother.
- **Standard (about 130 MB download)** is smaller and quicker.

Both have the same voices. Then pick a **Voice** (★ marks the best ones for announcements; try "Santa" for Christmas) and a **Speed** between 0.7× and 1.3×. **Remove free voices** deletes the engine and voices from the server.

If this option isn't shown, the server's host doesn't allow it. Use one of the others.

### OpenAI and ElevenLabs

Paid voice services. Each needs your own **API key**: paste it and press **Save key**. The key is stored only on this server, is never shown again and isn't included in backups. **Remove** deletes it.

- **OpenAI**: choose a **Model** and **Voice**, and a **Speed**. With the model that follows style instructions, **How it should sound** lets you describe the delivery, for example "Excited holiday radio DJ, warm and upbeat". A whole season of announcements typically costs a few cents.
- **ElevenLabs**: choose a **Model**, then press **Load my voices** and pick a **Voice**. Voices you add in your ElevenLabs Voice Library show up after you reload them. The free plan covers a handful of announcements.

### My own recording

Upload a recording from a friend, a voice actor or another app (MP3, M4A, AAC, WAV, FLAC or OGG). It's level-matched automatically.

### Script

Type what the voice should say in **Script** (up to 2,000 characters), then press **Generate voice**. **Start from:** fills in a ready-made script (**Tune in**, **Headlights**, **Donations**, **Starting soon**, **Thanks**). Replace anything in [brackets] with your own details. **Recent scripts…** brings back one you used before.

> **Tip:** If a word comes out wrong, spell it the way it sounds, for example "eighty-eight point one".

When it's done you'll see **Voice ready** with a player so you can listen. Not happy? Change the script or voice and press **Generate again**.

## 2. Use it

### Save as its own clip

Makes a standalone MP3.

| Setting | What it does |
|---|---|
| **File name** | The name the clip is saved under. It always ends in .mp3. |
| **Silence before (s)** | Quiet time before the voice starts (0 to 10 seconds). |
| **Silence after (s)** | Quiet time after it ends (0 to 30 seconds). |
| **Loudness (LUFS)** | How loud the clip is. Use the same level as your normalized songs (-14 by default) so it isn't louder or quieter than the music. |

Press **Make clip**, listen, then **Download** it or press **Send to FPP** to save it in FPP's music folder. A file with the same name there is replaced. Add the clip to a playlist in FPP as a media-only entry; it doesn't need a sequence.

### Talk over a song's intro

Mixes the voice over the start of a song, turning the music down while the voice speaks and back up after.

1. Pick a song from FPP's music folder and press **Load**, or upload one.
2. Set **Voice starts at (s)**: how far into the song the voice begins.
3. Set **Turn the music down by (dB)**. 12 is a good start; use more if the song is busy.
4. Set **Voice level (dB, relative to the song)** if the voice needs to be louder or softer than the song (-10 to +10).
5. Press **Preview** to hear just the part around the voice, then **Make the full song**.

The result shows whether it's the same length as the original. If it says the length differs, don't use it with the sequence.

When you're happy:

- **Replace the song on FPP** swaps the original for this version. The name and length stay the same, so its sequence keeps working. **Put the original back** undoes it.
- **Save as new file** saves it under a new name (the original gets " (intro)" added by default) and keeps the original. Point the sequence at the new file in xLights or FPP to use it.
- **Download** saves a copy to your computer.

> **Careful:** Replacing a file while the show is playing can cause a glitch. ShowPilot warns you if the show is playing.

If you replace a song that phone listeners hear, they get the new version after the plugin next syncs. See [Phone audio, start to finish](help:phone-audio).

## How long things are kept

Generated voices, loaded songs and finished files are kept on the server for 3 hours after you last use them, then deleted. Download anything you want to keep. Your recent scripts and voice choices are remembered.
