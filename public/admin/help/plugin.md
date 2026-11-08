# Plugin

This tab shows whether the ShowPilot plugin on your show player (Falcon Player, FPP) is talking to ShowPilot, and gives you the token that pairs the two. For installing the plugin and pairing it step by step, see [Connecting your show player](help:fpp-plugin).

## Plugin Status

| Item | What it tells you |
|---|---|
| **Connection** | **Online** if the plugin has checked in within the last minute, **Offline** if it has been quiet longer, **Never seen** if it has never connected. |
| **Last seen** | How long ago the plugin last checked in. |
| **Plugin version** | The plugin version your show player reported. |
| **Last sync** | When the plugin last sent your playlist, and how many sequences it contained. |

The status refreshes on its own every few seconds. The same online/offline state is shown at the top of every admin page.

> **Tip:** If it says **Offline**, check that the show player is powered on and on the network, and that the plugin is running. If it says **Never seen**, the plugin hasn't been paired yet: start with the token below. More help in [Troubleshooting](help:troubleshooting).

A sync is what fills your [Sequences](help:sequences) list. If **Last sync** is old or shows the wrong number of sequences, see [Connecting your show player](help:fpp-plugin) for how syncing works.

## Show Token (for ShowPilot Plugin)

The token is the key that lets the plugin control your show. To pair:

1. Click **Copy**. If copying doesn't work in your browser, select the token text and copy it by hand.
2. On your show player, open the ShowPilot plugin's settings.
3. Paste it into the plugin's **Show Token** field and save.

Once the plugin connects, **Connection** here changes to **Online**.

> **Careful:** Treat the token like a password. Anyone who has it can control your show. Don't post it in screenshots or forums.

## Audio Cache

When your show player syncs, it uploads each song's audio file to ShowPilot. Phone listeners then stream from ShowPilot instead of from the show player, which is faster and copes with many listeners at once. If a file isn't cached, listeners fall back to streaming through the show player.

- **Cached files** and **Total size** show what's stored.
- **Show file list** lists each cached file with its sequence, file name, size, type and when it was cached. Files no longer linked to any sequence are marked **(orphaned)**. **Delete** removes one file; the next sync uploads it again if the song is still in use.
- **Prune Orphans** removes cached files for sequences that no longer exist or were replaced. Files for your current songs are kept.
- **Clear All** removes every cached file. The next sync uploads everything again, so it takes longer than usual.
- **Refresh** updates the numbers and the list.

> **Tip:** Use **Prune Orphans** to free up disk space after a season changeover. **Clear All** is rarely needed, and the re-upload after it can take a while with a big playlist.

For how phone audio works as a whole, see [Phone audio, start to finish](help:phone-audio). Whether songs are uploaded at all is controlled by **Audio enabled** in [Settings › Audio](help:settings-audio).
