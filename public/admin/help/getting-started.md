# Getting started

This page takes you from your first sign-in to a live viewer page that people can vote or request songs on. Each step is short and links to the page with the details. For how the pieces fit together, see [How ShowPilot works](help:how-it-works).

> **Tip:** Press **F1** (or the **?** button) on any admin page to open help for that page.

## 1. Sign in

Open the admin in your browser and sign in. A brand-new ShowPilot has one account: username **admin**, password **admin**. Right after you sign in, a **Change Password Required** box asks you to pick a new password before you can carry on.

If someone else set up your ShowPilot for you, sign in with the admin login chosen when the show was created instead.

Moving from another ShowPilot? On a brand-new install the sign-in page also offers to restore a previous backup, so you don't have to set everything up again. See [Signing in](help:signing-in).

## 2. Name your show

Go to **Settings › General** and fill in **Show name**. It becomes the browser tab title on your viewer page (unless your template sets its own) and is used as a friendly name in a few other places.

## 3. Connect your show player

ShowPilot doesn't play anything itself. Your show player (Falcon Player, FPP) runs the show, and the ShowPilot plugin on it talks to ShowPilot.

1. Open **Plugin** and click **Copy** next to the **Show Token**.
2. Install the ShowPilot plugin in FPP and paste the token into its **Show Token** field, along with your ShowPilot address.
3. Back in ShowPilot, the plugin status at the bottom of the menu changes to **plugin online**.

Treat the show token like a password: anyone who has it can control your show. Full steps are in [Connecting your show player](help:fpp-plugin).

## 4. Check your sequences

Once connected, the plugin sends ShowPilot the songs in your FPP playlist, and they appear on the **Sequences** page. Songs that drop out of the playlist later are kept but marked inactive and hidden from viewers.

On the Sequences page you can:

- give each song a friendly **Display Name** and **Artist** (or try **Auto-Fill Song Info**),
- add cover art with **Fetch Covers**,
- choose which songs viewers see and can pick with the **Visible**, **Vote** and **Jukebox** switches,
- mark announcements as **PSA**, so they play between songs and never appear in the list.

You can also add a song by hand under **Add Sequence**, using the name exactly as it appears on your show player. See [Sequences](help:sequences).

## 5. Pick a viewer page template

The viewer page is what your audience sees on their phones. Its look comes from a template.

1. Open **Viewer Page › Template Editor**.
2. Choose a template from the **Templates** list.
3. Click **Set Active**.

Click **Show** in the top bar to open your viewer page in a new tab and check it. You can edit any template or start one with **+ New**. See [Viewer page templates](help:templates) and [Template Editor](help:viewer-editor).

## 6. Choose how viewers take part

ShowPilot has four ways for viewers to interact, called modes:

| Mode | What viewers do |
| --- | --- |
| **Voting** | Vote for the next song; the most votes wins. |
| **Jukebox** | Request songs, which play in order. |
| **Race** | Tap their favorite song as fast as they can; the leader wins. |
| **Listen only** | See what's playing and listen on their phones, but not vote or request. |

Pick one with **Mode** in the top bar or on the [Dashboard](help:dashboard). Fine-tune each mode under [Settings › Voting](help:settings-voting), [Settings › Jukebox](help:settings-jukebox) or [Settings › Race](help:settings-race).

> **Tip:** If your page is reachable from the internet, set up [Interaction Safeguards](help:settings-safeguards) so only people near your show can vote or request.

## 7. Turn viewers on

Flip the **Viewer control** switch in the top bar (or on the Dashboard) to on. Your viewer page now accepts votes, requests or taps, and ShowPilot starts telling your show player what to play next. Turn it off at the end of the night; your show keeps running on its own schedule.

## 8. Tell people where to find you

- The **Viewer QR Code** on the Dashboard gives visitors a code to scan. It appears once you've entered your **Public base URL** in [Settings › Audio](help:settings-audio).
- To let visitors hear the music on their phones, follow [Phone audio, start to finish](help:phone-audio).

If something isn't working, see [Troubleshooting](help:troubleshooting).
