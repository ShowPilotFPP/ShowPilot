# Queue

The Queue page shows the jukebox requests waiting to play and the songs that played most recently. Use it during a show to see what's coming, and to take out a request you don't want to play.

The page refreshes itself every few seconds while it's open. Click **Refresh** to update it straight away.

## Pending requests

Every request that hasn't played yet, oldest first, which is the order they play in. Each one shows its cover art, name and artist, and when it was requested (for example *requested 3m ago*). When nothing is waiting, the list says **— Empty —**.

Requests come from viewers in **Jukebox** mode. In other modes this list is usually empty.

### Sent to the show player

ShowPilot passes requests to your show player one at a time. Once the next request has been handed over, it's marked **Sent to the show player** in green: it's waiting in the show player's own queue and plays in turn. The next request is handed over only after this one starts playing, which keeps requests from being skipped.

A request that has been sent can't be removed from here.

### Remove

Click **Remove** next to a request that hasn't been sent yet to take it out of the queue. You're asked to confirm.

> **Tip:** The Dashboard's **Request queue** panel shows the same list, with an **×** to remove a request, so you don't have to leave the Dashboard during a show.

## Clear Queue

Removes every request that hasn't played yet. You're asked to confirm, and it can't be undone. The recently played list is kept.

Use it to start a show night with an empty queue, or after a rush of requests you'd rather not play. The **Purge queue** button on the [Dashboard](help:dashboard) does the same thing.

## Recently played

The last 20 songs, newest first, with how long ago each one played.

- In **Jukebox** mode the heading is **Recently played requests (last 20)** and the list shows only requests.
- In every other mode the heading is **Recently played (last 20)** and the list shows every song played, each labelled with where it came from: **vote winner**, **request**, **PSA** or **show schedule**.

For longer history and totals, see [Stats](help:stats).

## Requests that don't play

ShowPilot tidies the queue on its own so old requests don't pop up later:

- A request that is still waiting **2 hours** after it was made is dropped. This mostly happens when the show player was offline or viewer control was off for a long time.
- A request that was sent to the show player but hasn't started within **5 minutes** is dropped.

If requests keep disappearing this way, check that your show player shows **plugin online** and see [Troubleshooting](help:troubleshooting).

## Switching modes with requests waiting

- **Listen only** stops new requests, but requests already in the queue still play, so nobody loses a song they asked for.
- Turning **viewer control** off stops ShowPilot sending anything to the show player. Waiting requests stay in the list, but can be dropped after 2 hours as above.

The queue size, how many requests one viewer can have waiting, repeats of the same song, and song cooldowns are set in [Settings › Jukebox](help:settings-jukebox). How the queue fits into the rest of ShowPilot is explained in [How ShowPilot works](help:how-it-works#the-queue).
