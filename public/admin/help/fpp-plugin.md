# Connecting your show player

ShowPilot doesn't play your show itself. Falcon Player (FPP) does, and a small ShowPilot plugin inside FPP keeps the two talking. This guide covers installing the plugin, pairing it with ShowPilot, syncing your songs and checking that everything is connected.

For what each part of the **Plugin** tab shows, see [Plugin](help:plugin).

> **Tip:** If someone else runs your ShowPilot server for you, set the plugin's **Connection** to **Hosted ShowPilot** and enter the address and show token your host gives you. The plugin then connects out to ShowPilot, so nothing needs opening on your home network.

## What the plugin does

Once paired, the plugin:

- sends ShowPilot the songs in your chosen FPP playlist, so they appear on the **Sequences** page and your viewer page,
- tells ShowPilot what's playing, how far into the song it is, and what's next,
- picks up the songs viewers vote for or request, and plays them,
- uploads your audio files to ShowPilot and runs the audio helper that keeps phones in sync, if you use phone audio.

## Before you start

- FPP **10.0 or newer**. The plugin doesn't support older versions.
- FPP must be able to reach your ShowPilot server's address over the network.
- You need your **Show Token**. In ShowPilot, open the **Plugin** tab and press **Copy** next to **Show Token (for ShowPilot Plugin)**.

> **Careful:** Treat the Show Token like a password. Anyone who has it can control your show.

## 1. Install the plugin in FPP

1. In FPP, go to **Content Setup › Plugin Manager**.
2. Paste the plugin's install address into the plugin URL box. You'll find it in the "Install the FPP plugin" section of ShowPilot's README.
3. Press **Get Plugin Info**, then **Install**.

## 2. Pair it with ShowPilot

Open the plugin's settings in FPP under **Content Setup › ShowPilot** and fill in:

| Plugin setting | What to enter |
|---|---|
| **Server URL** | The address you use to open ShowPilot, without the `/admin` part and without a slash at the end. On your home network that's usually the server's local address and port (ShowPilot uses port 3100 unless you changed it). |
| **Show Token** | The token you copied from ShowPilot's **Plugin** tab. |
| **Remote Playlist** | The FPP playlist holding the songs viewers can pick. |
| **Interrupt schedule** | Turn on if viewer picks should play right away instead of after the current song. |

Save the settings.

## 3. Sync your songs

Press **Sync Now** in the plugin. Within a few seconds your songs appear on ShowPilot's **Sequences** page.

How syncing treats your song list:

- New songs in the playlist are added. Their display names start as the file name with underscores and dashes turned into spaces. You can rename them in ShowPilot and a later sync won't overwrite your names, artists or covers.
- Songs you remove from the playlist become **Inactive**. They keep everything you set up but disappear from the viewer page, voting and the jukebox, and any pending votes or requests for them are cleared. Add them back to the playlist and the next sync makes them active again. Use the **Inactive** filter or **Delete Inactive** on the Sequences page to review or tidy them.
- A song listed more than once in the playlist still counts as one song. ShowPilot keeps its first position and shows a note on the Sequences page.
- ShowPilot looks up cover art for new songs without one, in the background.
- If phone audio is on, the plugin also uploads your audio files. It only sends files ShowPilot doesn't already have, so the first sync takes longest. See [Phone audio, start to finish](help:phone-audio).

> **Tip:** Sync again whenever you change the playlist or replace audio files, for example after using the [Audio Normalizer](help:tools-normalizer).

## 4. Check the connection

ShowPilot shows the connection in several places:

- The admin header reads **plugin online**, **plugin offline** or **plugin never connected**.
- The **Plugin** tab's **Plugin Status** card shows **Connection** (**Online**, **Offline** or **Never seen**), **Last seen**, **Plugin version** and **Last sync** (with how many sequences came across).
- The Cockpit header shows **Player online** or **Player offline**.

The plugin checks in regularly. The admin shows **Online** while ShowPilot has heard from it in the last minute.

If a newer plugin version is available, a banner at the top of the **Dashboard** says so. It turns red when your plugin is too old for this version of ShowPilot; update it from FPP's **Plugin Manager**, then restart FPPD if FPP asks.

## If it won't connect

- **Never seen** or **Offline**: check the **Server URL** in the plugin. Open that exact address in a browser on the same network as FPP; you should see ShowPilot.
- Check the **Show Token** in the plugin matches the one on ShowPilot's **Plugin** tab exactly, with no spaces at either end. A wrong token is refused.
- Check FPP is version 10.0 or newer.
- Look at the plugin's log in FPP under **Status/Control › Logs**, or the plugin's **Diagnostics** tab.
- **Online but no songs**: make sure **Remote Playlist** names the right playlist, then press **Sync Now**. An empty playlist is ignored, so it never wipes your song list.

More fixes are in [Troubleshooting](help:troubleshooting).

## When FPP and ShowPilot are on different networks

The plugin can reach ShowPilot over the internet, but some features need ShowPilot to reach FPP on your local network too. ShowPilot learns FPP's address from the plugin's check-ins, and only accepts a private home-network address. If ShowPilot can't reach FPP:

- songs on FPP don't appear in the [Audio Normalizer](help:tools-normalizer) or [Announcements](help:tools-announcer) (you can still upload files from your computer),
- phone audio still plays from ShowPilot's own copy of each song, but the live position feed that keeps phones tightly in sync isn't available.
