# Settings › Public Access

Puts your ShowPilot on the internet so viewers can reach it from their phones on cellular data, with no port forwarding and no router changes. It uses a **Cloudflare Tunnel**: you bring your own free Cloudflare account and a domain in it, and ShowPilot runs the tunnel for you.

The page walks you through it in steps. What you see depends on how far you've got.

## Status and Architecture

The badge at the top right sums up the tunnel:

| Badge | Meaning |
|---|---|
| **Not Installed** | The tunnel program isn't on this server yet. |
| **Needs Token** | Installed, but not connected to your Cloudflare account. |
| **Connecting…** | Running and trying to reach Cloudflare. |
| **Tunnel Online** | Connected. Your show is reachable at the address you set up in Cloudflare. |
| **Stopped** | Set up, but switched off. |

**Status** says the same thing in a sentence. **Architecture** shows the kind of processor your server has. The tunnel works only on Linux servers with a supported processor (64-bit Intel/AMD, 64-bit ARM, or 32-bit ARM such as older Raspberry Pis). On anything else the install button is greyed out and the page says why.

## Step 1: install the tunnel runtime

Press **Install Cloudflare Tunnel**. ShowPilot downloads Cloudflare's tunnel program from its official releases into ShowPilot's own data folder. It takes about 30 seconds on most connections. Nothing else on your server is changed.

## Step 2: connect a Cloudflare tunnel

You need a free Cloudflare account with a domain added to it. Press **Show me how →** on the page for the steps. In short:

1. In your Cloudflare dashboard, go to **Networks → Tunnels** and press **Create a tunnel**. Choose the **Cloudflared** connector and give it any name.
2. On the next screen, copy the **token**: the long string after `--token` in the install command. Don't run the command; you only need the token.
3. Press **Next**. On the **Public Hostname** page, pick a subdomain (for example `show`) and your domain, and set **Service** to `HTTP` with the URL `127.0.0.1:3100`. Use a different port if your ShowPilot runs on one. Save.
4. Back in ShowPilot, paste the token into **Tunnel token** and press **Save Token & Start Tunnel**.

The tunnel starts straight away and the badge should turn to **Tunnel Online** within a few seconds. Your show is then live at the hostname you picked.

> **Careful:** Treat the token like a password. Anyone who has it can connect to your tunnel. ShowPilot stores it only on this server and clears the box once it's saved.

> **Tip:** Cloudflare can also protect the `/admin` part of your address with **Cloudflare Access**, so only you can reach the admin pages. Viewers don't need it. It's free for small numbers of users and well worth setting up.

If you use Listen on Phone, also enter your new address as the **Public base URL** in [Settings › Audio](help:settings-audio#external-audio-access), so listeners off your home network can hear the show.

## Controlling the tunnel

Once a token is saved, these buttons appear:

| Button | What it does |
|---|---|
| **Start Tunnel** / **Stop Tunnel** | Turns the tunnel on or off. While it's off, nobody can reach ShowPilot from the internet; it still works on your own network. |
| **Restart** | Stops and starts the tunnel. Try this first if it seems stuck. |
| **Replace Token** | Shows the token box again so you can paste a different token, for example after making a new tunnel in Cloudflare. Saving it restarts the tunnel with the new token. |
| **View Logs** | Shows the tunnel's recent messages. Use **Refresh** to update them and **Hide** to close them. |
| **Uninstall** | Stops the tunnel, deletes the saved token and removes the tunnel program. Your tunnel in Cloudflare isn't touched, so you can reinstall later and paste the same token. |

The tunnel starts by itself whenever ShowPilot starts, as long as a token is saved. If it drops, ShowPilot keeps trying to reconnect, waiting a little longer between tries (up to a minute).

> **Careful:** **Stop Tunnel** lasts only until ShowPilot next restarts, when the tunnel starts again. To keep it off for good, use **Uninstall**.

## Updating the tunnel program

Below the buttons, ShowPilot shows the installed version of the tunnel program and whether a newer one is out. Press **Update to …** (or **Reinstall latest** when you're already up to date) to get the latest version; your token is kept and a running tunnel is restarted. **Check again** looks for a new version now.

> **Tip:** If you're using this page through the tunnel itself, it loses connection for a few seconds while the tunnel restarts. Leave it open and it comes back.

## When the tunnel won't connect

If the badge stays on **Connecting…**, the logs open by themselves so you can see why. The usual causes:

- The token was copied incompletely or with extra spaces. Copy it again and use **Replace Token**.
- No public hostname is set for the tunnel in Cloudflare, or its service address or port is wrong.
- The server can't reach the internet.

> **Important:** The tunnel token isn't included in backups. After restoring a backup on a new server, install the tunnel again and paste your token. You can always get it again from your Cloudflare dashboard.
