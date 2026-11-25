# Settings › ShowPilot App

Everything for the ShowPilot phone app is on this page. The page is marked **Coming soon** because the app isn't in the app stores yet; the settings work now, so your show is ready when it is.

## List my show

Tick **List my show in the ShowPilot app** and your show is listed straight away; the line under the switch says **Listed** when the app's directory has it. There's nothing else to press: whenever your show name, town, address, location or Public web address changes, ShowPilot updates the listing by itself. While listed it also tells the directory once a minute whether a song is playing, so the app can show your show as live.

Untick it and your show is removed from the app at once. If the directory can't be reached right then, ShowPilot keeps trying every minute until it's gone, and the line says so.

Listing needs two things, and the page tells you if either is missing:

- a show location: enter your **Show address** on this page, or set it in [Interaction Safeguards](help:settings-safeguards#gps-proximity-check), and
- a **Public web address** that starts with `https://` in [Settings › General](help:settings-general#public-web-address). Phones on cellular reach your show through it, so a home network address won't work.

## What people see

| Item | Where it comes from |
|---|---|
| **Name** | Your show name from [Settings › General](help:settings-general). |
| **Town** | Optional. Shown under your name. Leave it blank and the app shows no town. |
| **Show address** | Optional. Shown on your listing with a **Navigate** button that opens the phone's maps app. |

## Show address

Type your address and press **Save address**. ShowPilot looks it up on the map and also sets your show location from it, the same location the GPS check and the audio distance limit use. If the map can't find the address it's still saved for the Navigate button, but your show location stays as it was.

- **With an address**, the app shows it with a **Navigate** button, and your pin in the app's Directory of Shows is exact. Your address is public then, so there's nothing to hide.
- **Without an address**, there's no Navigate button, and your location is rounded to about a mile everywhere it's public: the app's list, the Directory of Shows and your viewer page.

## Where your show appears

- **Shows near you**, the app's main list, shows your show to phones within about a mile of it. That distance is the same for every show.
- **Directory of Shows** puts shows on a map with a list, and people pick how far to search, in miles or kilometres depending on where they are.

**What gets sent** shows exactly what ShowPilot sends to the directory.

> **Tip:** Without an address and with the audio distance limit on, the phone audio player checks with your server about every 30 seconds instead of comparing positions on the phone, because the page doesn't carry your exact location.
