Feature: Listen Only mode

Scenario: Listen Only closes requests but the songs already queued still play
  Given the show has songs "Alpha", "Bravo", "Charlie" and "Delta"
  And the mode is Jukebox
  And the show player plays "Alpha"
  When phone 1 requests "Charlie"
  And the show player switches to Listen only
  And phone 2 requests "Delta"
  Then it is refused with "closed for now"
  And "Charlie" plays next as a request
  And the show player is not given a song
  When the show player switches viewer control on
  Then the mode is now Jukebox

Scenario: Votes are closed in Listen Only too, and Off goes back to the right mode later
  Given the show has songs "Alpha", "Bravo" and "Charlie"
  And the mode is Voting
  And the show player plays "Alpha"
  When the admin switches to Listen only
  And phone 1 votes for "Bravo"
  Then it is refused with "closed for now"
  When the admin switches to Off
  And the show player switches viewer control on
  Then the mode is now Voting

Scenario: No PSAs are handed out in Listen Only
  Given the show has songs "Alpha", "Bravo" and "PSA Thanks"
  And "PSA Thanks" is a PSA
  And a PSA plays after every 1 song
  And the mode is Listen only
  When the show player plays "Alpha"
  And the show player plays "Bravo"
  Then no PSA is handed out

Scenario: Phones see Listen Only and can't pick songs
  Given the show has songs "Alpha", "Bravo" and "Charlie"
  And the viewer page uses the test template
  And the mode is Jukebox
  And the show player plays "Alpha"
  When phone 1 opens the viewer page
  And the show player switches to Listen only
  Then phone 1 is in Listen Only
  And phone 1 sees "Charlie"
  When phone 1 taps "Charlie"
  Then phone 1 gets the message "closed for now"
  And the queue is empty
  When the show player switches viewer control on
  Then phone 1 is not in Listen Only
