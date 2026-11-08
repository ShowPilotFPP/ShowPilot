# Settings › Jukebox

Rules for song requests in **Jukebox** mode: how big the queue can get, how much one viewer can ask for, and how soon a song can be picked again. The **Song cooldown** settings at the bottom also apply in **Voting** mode. For how requests reach your show player, see [How ShowPilot works](help:how-it-works).

Every change saves straight away and applies to the next request.

## Jukebox queue depth (max requests in queue)

The most requests that can wait in the queue at once, counted across all viewers. When the queue is full, viewers who try to add a song see "The queue is full. Try again later." You can set 0 to 100. The default is **0**, which means no limit.

A request counts until it starts playing, including requests already handed to your show player and waiting there.

> **Tip:** A long queue means a long wait, and people rarely stay an hour for their song. Divide how long you expect visitors to stay by your average song length for a sensible number. If your template shows the limit, use the `{QUEUE_DEPTH}` placeholder so the text always matches this setting.

## Max copies of the same song in queue

How many times one song can be waiting in the queue at once, across all viewers. Once it's reached, more requests for that song are turned away with "That sequence has been requested the maximum number of times. Try another." You can set 0 to 20; 0 means no limit. The default is **3**.

Set it to 1 if you'd rather never play the same song twice in a row from requests.

## Limit each viewer to … pending request(s) at a time

When ticked, each viewer can only have this many requests waiting at once. Their slot opens again once one of their requests plays. A viewer who tries for more is told how many they already have waiting and asked to wait. It's on by default, with a limit of **1**. You can allow 1 to 20.

This stops one person from filling the queue with their favorites. ShowPilot recognises a viewer by their phone's browser, so the same person on a second phone counts as a second viewer. For stronger protection, see [Interaction Safeguards](help:settings-safeguards).

## Block requests for the song that's currently playing

Viewers can't request the song that's on right now; they get "That song is playing right now. Try another." On by default.

## Block requests for the song that's already up next

Viewers can't request the song that's next to play: the first song in the request queue or, if the queue is empty, the next song in your show player's schedule. They get "That song is already up next. Try another." On by default. It keeps the front of the queue from filling up with duplicates.

## Hide song from the request list after it plays

When ticked, the song that's playing drops off the viewers' list, and can't be requested or voted for, until the next song starts. Off by default.

This only keeps a song away for one song. For a longer break, use **Song cooldown** below.

## Song cooldown

After a song plays, viewers can't request it, or vote for it, until its cooldown is over. It works in both Jukebox and Voting modes.

**Wait … before a song can be picked again** sets the cooldown for your whole show. Enter a number from 0 to 1440 and choose how to count it:

- **more songs** counts every song that starts after it, whatever its length. "3 more songs" means three other songs have to start first.
- **minutes** counts clock time from when the song started.

The default is **0**, no cooldown. Viewers who try to pick a cooling-down song are told when it's available again, for example "You can pick it again after 3 more songs".

When a song with a cooldown starts playing, any other requests for it still waiting in ShowPilot's queue are removed, so it doesn't play again straight away.

Categories and individual songs can have their own cooldown on the [Sequences](help:sequences) page. A song's own cooldown wins, then its category's, then this show-wide one. Leave a song's or category's cooldown empty to use this one; set it to 0 for a song that never cools down.

> **Careful:** Switching between **more songs** and **minutes** doesn't convert numbers already set for categories or songs. "10" becomes 10 songs instead of 10 minutes, so check them on the Sequences page after switching.

### Keep cooling-down songs on the page, greyed out, instead of hiding them

By default, a cooling-down song disappears from the viewer page until it's available again. Tick this to keep it on the page, greyed out, with a note such as "Available again after 3 more songs". Tapping it tells the viewer when it can be picked. Off by default.

If you design your own template, a cooling-down song has the class `showpilot-cooldown`, the attributes `data-cooldown` (for example "after 3 more songs") and `data-cooldown-left`, and a `.sequence-cooldown` note you can style. If your page has a `<div id="songCooldown">`, ShowPilot shows the tap message there. See [Viewer page templates](help:templates).

### Also skip cooled-down songs in the show player's normal playlist rotation

Cooldowns normally only affect what viewers can pick; your show player's own playlist still plays everything. Tick this and your show player also skips a song in its playlist while it's cooling down, then brings it back when the cooldown ends. Off by default. On FPP, this needs version 0.13.40 or newer of the ShowPilot plugin.

> **Tip:** Turn this on if a viewer pick and your playlist keep landing on the same song close together.
