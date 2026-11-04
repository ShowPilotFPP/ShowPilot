Feature: Viewer page

Scenario: Songs already in the queue are marked on every phone
  Given the show has songs "Alpha", "Bravo", "Charlie", "Delta" and "Echo"
  And the viewer page uses the test template
  And the mode is Jukebox
  And the show player plays "Alpha"
  When phone 1 opens the viewer page
  And phone 2 requests "Charlie"
  Then on phone 1, "Charlie" is marked as queued #1
  When phone 1 taps "Delta"
  Then on phone 1, "Delta" is marked as queued #2
  And on phone 1, "Echo" is not marked as queued
  When the song ends
  Then on phone 1, "Charlie" is not marked as queued
  And on phone 1, "Delta" is marked as queued #1

Scenario: Badges show in full in the corner of each song
  Given the show has songs "Alpha", "Bravo" and "Charlie"
  And "Alpha" has the badge "Fan Favorite"
  And "Bravo" has the badge "New"
  And "Alpha" has a cover
  And the viewer page uses the test template
  And the mode is Jukebox
  When phone 1 opens the viewer page
  Then on phone 1, "Alpha" shows the badge "Fan Favorite" fully
  And on phone 1, "Bravo" shows the badge "New" fully

Scenario: Now Playing shows the artist and covers for the playing and next song
  Given the show has songs "Alpha", "Bravo", "Charlie" and "Delta"
  And "Alpha" has the artist "Sir Mix"
  And "Alpha" has a cover
  And "Charlie" has the artist "Eartha"
  And "Charlie" has a cover
  And the viewer page uses the test template
  And the mode is Jukebox
  And the show player plays "Alpha"
  When phone 1 requests "Charlie"
  And phone 2 opens the viewer page
  Then phone 2 shows "Sir Mix" as the Now Playing artist
  And phone 2 shows "Eartha" as the Up Next artist
  And phone 2 shows the cover of "Alpha" for Now Playing
  And phone 2 shows the cover of "Charlie" for Up Next
  When "Charlie" plays next as a request
  Then phone 2 shows the cover of "Charlie" for Now Playing
  And phone 2 shows no cover for Up Next
  And phone 2 shows "Eartha" as the Now Playing artist
  And phone 2 shows no Up Next artist
  And the phone player is sent the cover of "Charlie" with no audio

Scenario: The Now Playing and Up Next blocks show each song's artist
  Given the show has songs "Alpha", "Bravo" and "Charlie"
  And "Alpha" has the artist "Sir Mix"
  And "Bravo" has the artist "Eartha"
  And the viewer page is built from the Now Playing and Up Next blocks
  And the mode is Voting
  And the show player plays "Alpha"
  When phone 1 opens the viewer page
  Then phone 1 shows "Sir Mix" as the Now Playing artist
  And phone 1 shows "Eartha" as the Up Next artist

Scenario: The Settings designer's page shows each song's artist
  Given the show has songs "Alpha", "Bravo" and "Charlie"
  And "Alpha" has the artist "Sir Mix"
  And "Bravo" has the artist "Eartha"
  And the viewer page is built with the Settings designer
  And the mode is Voting
  And the show player plays "Alpha"
  When phone 1 opens the viewer page
  Then phone 1 shows "Sir Mix" as the Now Playing artist
  And phone 1 shows "Eartha" as the Up Next artist

Scenario: The built-in Default page shows each song's artist
  Given the show has songs "Alpha", "Bravo" and "Charlie"
  And "Alpha" has the artist "Sir Mix"
  And "Bravo" has the artist "Eartha"
  And the mode is Voting
  And the show player plays "Alpha"
  When phone 1 opens the viewer page
  Then phone 1 shows "Sir Mix" as the Now Playing artist
  And phone 1 shows "Eartha" as the Up Next artist
  When the show player plays "Bravo"
  Then phone 1 shows "Eartha" as the Now Playing artist

Scenario: Listen on Phone shows the song and its cover when the song has no audio
  Given the show has songs "Halloween Lights", "Alpha" and "Bravo"
  And "Alpha" has the artist "Sir Mix"
  And "Alpha" has a cover
  And the setting "audio_gate_enabled" is off
  And the mode is Jukebox
  And the show player plays "Alpha"
  When phone 1 opens the viewer page
  And phone 1 opens Listen on Phone
  Then phone 1's player shows "Alpha" with the cover of "Alpha"
  When the show player plays "Halloween Lights"
  Then phone 1's player shows "Halloween Lights" with the no-cover picture

Scenario: The phone player's decoration shows even when the song has no audio
  Given the show has songs "Halloween Lights" and "Alpha"
  And the setting "audio_gate_enabled" is off
  And the setting "player_decoration" is "christmas"
  And the mode is Jukebox
  And the show player plays "Halloween Lights"
  When phone 1 opens the viewer page
  And phone 1 opens Listen on Phone
  Then phone 1's player has the "christmas" decoration

Scenario: The Live player decorations are available and draw without errors
  Given the show has songs "Halloween Lights" and "Alpha"
  And the setting "audio_gate_enabled" is off
  And the setting "player_decoration" is "christmas-live"
  And the mode is Jukebox
  And the show player plays "Halloween Lights"
  When phone 1 opens the viewer page
  And phone 1 opens Listen on Phone
  Then phone 1's player has the "christmas-live" decoration
  When the setting "player_decoration" is "newyear-live"
  And 6 seconds pass
  Then phone 1's player has the "newyear-live" decoration

Scenario: Audio timing has Detect my delay (restored from the old beta)
  Given the show has songs "Halloween Lights" and "Alpha"
  And the setting "audio_gate_enabled" is off
  And the mode is Jukebox
  And the show player plays "Halloween Lights"
  When phone 1 opens the viewer page
  And phone 1 opens Listen on Phone
  And phone 1 opens Audio timing
  Then phone 1 sees "Detect my delay"
