# Settings › General

Settings that apply to your whole show, whichever viewer page template is active: your show's name, and whether this install is counted.

## Show name

The name of your show, for example *Lights on Maple Street*. You can use up to 200 characters. The default is **My Light Show**.

ShowPilot uses it:

- as the browser tab title on your viewer page, unless your template has its own `<title>` tag (a title in the template always wins),
- as the name under the icon when viewers install your page as an app, unless you set a separate **App name** under [Settings › App](help:settings-app#viewer-app),
- as the heading on ShowPilot's basic built-in viewer page.

Changes save as soon as you leave the box. Viewers see the new name the next time their page loads.

> **Tip:** Keep it short and recognizable. It's what people see in their browser tabs and history when they come back next night.

## Install count

Once a day, ShowPilot sends one anonymous check-in that says "one more install is running". It helps the people who make ShowPilot see how many shows use it and which versions they run.

What is sent is only a random ID made on this install, the product name, the version, and your map choice below. No show name, web address, IP address or settings are sent, and nothing comes back. The line **Exactly what's sent** shows the actual message, word for word.

The first time you open the admin after this feature arrives, a short notice asks whether to **Keep it on** or **Turn it off**. You can change your answer here at any time.

| Setting | What it does |
|---|---|
| **Count this install** | Sends the daily check-in. On by default. Turn it off and nothing is sent. |
| **Put my show on the map** | Optional. Adds your show to the public map of where ShowPilot shows are. Choose **Off** (the default), **Country only**, **State / region** or **Town**. Only available while **Count this install** is on. |

The map doesn't use your show's location setting. ShowPilot still sends no location; the counter makes a rough guess from the connection and keeps only the level you pick. **Town** is rounded to about 10 km, and is often the nearest big town rather than your own.

> **Tip:** If the checkbox is greyed out with a note under it, counting has been switched off for the whole server and can't be turned back on from here. Whoever runs your server can switch it off that way by setting `installCount: false` in `config.js`, or the environment variable `SHOWPILOT_NO_INSTALL_COUNT=1` (or `DO_NOT_TRACK=1`). A demo install never sends a count.
