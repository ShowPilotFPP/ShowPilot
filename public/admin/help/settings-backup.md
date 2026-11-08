# Settings › Backup & Restore

Saves your whole ShowPilot setup to one file, and loads it back. Use it before big changes, at the end of the season, or to move ShowPilot to a new server.

## Export configuration

Press **Download backup** to save a file named like `showpilot-backup-2025-12-01-1830.json`. It contains:

- your **settings**, including your viewer mode,
- your **sequences**, with their display names, artists, categories, order and visibility,
- your **viewer page templates**,
- your **admin users**, including their passwords (stored scrambled, never as plain text),
- the **secrets** your server uses: the show token your show player connects with, and the key that keeps admins signed in.

Two options add more:

| Option | What it adds |
|---|---|
| **Include cover-art images** | The song artwork stored on this server. Makes the file bigger. Images over 2 MB are left out. |
| **Include play stats** | When each song last played and its play counters. Turn this on when moving servers and you want to keep that history; leave it off for a fresh start. |

Not included: the audio files your show player uploads (it uploads them again on its next sync), and the token for [Public Access](help:settings-public-access).

> **Careful:** A backup file holds your show token and admin passwords. Keep it somewhere private, like you would a password, and don't post it or send it to people you don't trust.

## Restore from backup

Choose a backup file with the file picker. ShowPilot checks it, then shows **Choose what to restore**: when the backup was made and which ShowPilot version made it, and a panel for each part with counts from the backup and from this server.

Nothing changes until you press **Apply restore**. Press **Cancel** to back out.

### Settings, Sequences, Templates, Admin users

Pick what to do with each part:

| Choice | What happens |
|---|---|
| **Replace** | Deletes what this server has for that part and puts in exactly what's in the backup. |
| **Merge** | Adds items from the backup and updates ones with the same name (same sequence name, template name or username). Items only on this server are kept. Not offered for Settings, which is one set of values. |
| **Skip** | Leaves that part alone. |

Settings default to **Replace**; the others default to **Merge**. The counts help you decide: **In both**, **Only in backup** and **Only in destination** (this server).

> **Tip:** If you skip templates and none of the restored ones is active, ShowPilot makes one active so your viewer page still works.

### Secrets (config.js)

**Replace** puts the backup's show token and sign-in key on this server, so your show player keeps working without pasting a new token. The rest of this server's own setup (its port, where the database lives) is left as it is. **Keep current secrets**, the default, leaves them alone.

Replacing secrets signs out every admin and needs a server restart. If ShowPilot runs under a process manager or in Docker, it restarts by itself a moment after the restore. Otherwise the message tells you the command to restart it. After the restart, sign in with the usernames and passwords from the backup.

### Cover-art images

Shown when the backup has artwork. **Restore** writes the images to this server, replacing any with the same file name. **Skip** leaves your current images alone.

> **Careful:** A restore can't be undone. If you're not sure, download a backup of the current server first, so you can go back.

## Moving to a new server

1. On the old server, press **Download backup** with **Include cover-art images** (and **Include play stats** if you want the history).
2. Install ShowPilot on the new server.
3. On a brand-new install, the sign-in page offers to restore from a backup before you sign in for the first time. That restores everything, secrets included, and replaces the starting admin account with your own. Or sign in, go to **Backup & Restore**, and choose what to restore.
4. Point your show player at the new server. If you restored the secrets, the show token stays the same.

A backup from an older ShowPilot loads into a newer one. A backup from a newer ShowPilot than the one you're restoring onto may be refused; update first.
