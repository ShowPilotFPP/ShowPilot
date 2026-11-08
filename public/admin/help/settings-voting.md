# Settings › Voting

Rules for **Voting** mode, where viewers vote and the song with the most votes plays next. Each "round" runs while one song plays: the leader when your show player is ready for the next song wins. For the bigger picture, see [How ShowPilot works](help:how-it-works).

Song cooldowns (how long before a song can be voted for again) are set under [Settings › Jukebox](help:settings-jukebox#song-cooldown) and apply to voting too.

Every change saves straight away.

## Limit each viewer to one vote per round

Each viewer gets one vote per round. A second vote in the same round is turned away with "You have already voted this round". On by default. ShowPilot recognises a viewer by their phone's browser, so this stops one phone from stuffing the ballot.

Leave this on: the next option only works while it is.

### Let viewers change their vote

With this on, a viewer who taps a different song moves their vote there instead of being turned away. They still have only one vote; the counts never show them voting twice. Tapping the song they already voted for does nothing. Off by default.

It's greyed out while **Limit each viewer to one vote per round** is off.

> **Tip:** Turn this on if people often vote, see another song they like better, and complain they can't switch.

## Auto-reset votes after winner plays

Clears all votes when the next song starts, so every round starts fresh and everyone can vote again. On by default, and recommended.

A PSA starting doesn't end the round: votes carry over, and the winner plays after the PSA.

> **Careful:** With this off, votes keep piling up from song to song and viewers who have voted can't vote again, so the same song can keep winning. You can clear votes by hand with **Reset Votes** on the [Dashboard](help:dashboard).

## Block votes for the song that's currently playing

Viewers can't vote for the song that's on right now; they get "That song is playing right now. Try another." On by default.

## Block votes for the song that's already leading

Viewers can't vote for the song in the lead; they get "That song is already up next. Try another." If nobody has voted yet, the song your show player's schedule plays next counts as the leader. On by default.

It stops everyone piling onto the front-runner and keeps the vote competitive. Turn it off if you'd rather let a crowd favorite win by a landslide.

## Tiebreak

What happens when two or more songs are tied for the most votes.

With the tiebreak off (the default), the tied song that got its first vote earliest wins.

With **Enable tiebreak round on a tie** ticked, a tie at the top starts a tiebreak round instead:

1. Viewers see an urgent banner listing the tied songs, with a countdown.
2. Everyone can cast one tiebreak vote for one of the tied songs, even if they already voted this round.
3. As soon as one song leads on main votes plus tiebreak votes together, it wins and plays next.
4. If time runs out and it's still a tie, all votes for the round are thrown away and your show plays its scheduled next song.

**Tiebreak duration (seconds)** is the longest the tiebreak lasts. You can set 10 to 600 seconds; the default is **60**, and 30 to 90 seconds suits most shows. The tiebreak never runs past the end of the current song, even if the timer is longer.

> **Tip:** Keep the duration shorter than your typical song, or the song ending will usually decide the tiebreak before the timer does.
