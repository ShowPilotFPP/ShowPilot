# Settings › Updates

Updates ShowPilot from inside the admin. ShowPilot downloads the new version, keeps your data and settings, and restarts itself. It also saves a copy of your data first, so you can roll back if something goes wrong.

## Update status

The box at the top shows:

- **Current version**: what this server is running.
- **Latest version**: the newest version on your update channel, with a link to its **release notes**.
- A badge: **Update available** or **Up to date**.
- **What's new**: the changes between your version and the latest one, newest first. Each change is labelled as a bug fix, feature update or feature request. When you're up to date, it shows what's new in your own version instead.
- **Last checked**: when ShowPilot last looked for updates.

ShowPilot checks by itself shortly after it starts and every few hours after that. When an update is out, the Dashboard also shows a notice.

> **Tip:** Update checks go to GitHub, which answers only 60 checks an hour from one network to anyone not signed in, shared by every device on that network. If that's used up, the page says so and when it resets. ShowPilot checks again by itself after that.

## Update channel

Choose which updates this server gets:

| Channel | What you get |
|---|---|
| **Stable** | Only full releases. Fewer, bigger updates, each with release notes. Recommended for most shows. |
| **Master** | Every fix and feature as soon as it's ready. More frequent updates; you get the newest things first. |

Changing the channel doesn't install anything by itself. On **Master**, the status box shows how many updates you're behind and the button reads **Install … Master update(s)**.

To go back from Master to Stable, select **Stable**. If this server is running a Master update newer than the latest release, a **Go to Stable …** button appears to move you onto the latest release.

## Check for updates

**Check for updates** asks for the latest version right now, instead of waiting for the next automatic check.

## Update now

When an update is available, the button reads **Update to …** (or **Install … Master update(s)** on Master). Press it and confirm. Installing usually takes 30 to 60 seconds, then the server restarts and the page reloads by itself. Viewers on your page reconnect automatically.

Before installing, ShowPilot makes some safety checks:

- There must be at least 200 MB of free disk space.
- Your show database must be healthy.
- No voting round with votes in it, and no pending jukebox requests.

If a check fails, the page lists why. The disk-space and database checks must be fixed first. For the show checks you can press **Update anyway**, but viewers in the middle of voting or waiting in the queue will be disrupted. Updating between shows is best.

> **Tip:** Update when your show is off for the night, not while viewers are voting.

## Roll back to previous version

After an update, **Roll back to …** takes you back to the version you had before. It also puts your data back as it was just before that update.

> **Careful:** Rolling back restores the data copy taken before the update. Any changes you made since updating (settings, sequences, templates) are lost. Only one copy is kept: the one from the most recent update.

The copy doesn't include the cached song audio, which your show player uploads again on its next sync.

## Beta channel

This section appears only when a beta build newer than your version exists, or when you're already running one. Beta builds are unfinished test versions shared to track down specific problems. They may break your viewer page, audio or show control, and they aren't supported.

Don't install a beta unless you've been asked to test one. To install it, tick the box to confirm you understand, then press **Install beta …**. Your data is copied first, as with any update.

While a beta is running, a notice says so. To leave, use **Return to stable …** or **Roll back to …**.

## Update source

Normally updates come from ShowPilot's own GitHub project. If you keep your own copy of ShowPilot on GitHub (a fork), open **Update source**, enter it as `owner/repo` or paste its github.com address, and press **Use this repo**. It must be a public copy of ShowPilot.

While a custom source is set, the page shows a warning, and the server follows that copy's main branch; there's no Stable or Master choice. Press **Back to ShowPilot** to return to normal updates; your saved channel comes back.

> **Warning:** Only use a copy you trust. An update runs its code on your server.

## Running in Docker

In Docker, the in-app updater is switched off; the container gets updates when you pull a new image. The channel is the image tag you run: `:latest` for Stable, `:master` for Master, and `:beta` to test a beta. The Updates page still shows whether a newer version is out.
