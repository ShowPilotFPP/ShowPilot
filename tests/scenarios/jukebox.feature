Feature: Jukebox

Scenario: Requests play in the order they were made
  Given the show has songs "Alpha", "Bravo", "Charlie" and "Delta"
  And the mode is Jukebox
  And the show player plays "Alpha"
  When phone 1 requests "Charlie"
  And phone 2 requests "Bravo"
  Then the queue is "Charlie" and "Bravo"
  And "Charlie" plays next as a request
  And the queue is "Bravo"
  And "Bravo" plays next as a request
  And the queue is empty

Scenario: The show player can clear the queue (the Clear Queue FPP command)
  Given the show has songs "Alpha", "Bravo" and "Charlie"
  And the mode is Jukebox
  And the show player plays "Alpha"
  When phone 1 requests "Charlie"
  And phone 2 requests "Alpha"
  And the show player clears the queue
  Then the queue is empty
  And the show player is not given a song

Scenario: The admin can clear the queue
  Given the show has songs "Alpha", "Bravo" and "Charlie"
  And the mode is Jukebox
  And the show player plays "Alpha"
  When phone 1 requests "Charlie"
  And the admin clears the queue
  Then the queue is empty

Scenario: A song in its cooldown can't be requested again
  Given the show has songs "Alpha", "Bravo", "Charlie" and "Delta"
  And "Charlie" has a cooldown of 30 minutes
  And the mode is Jukebox
  And the show player plays "Alpha"
  When phone 1 requests "Charlie"
  And "Charlie" plays next as a request
  And the song ends
  And phone 2 requests "Charlie"
  Then it is refused

Scenario: The song that's already up next can't be requested
  Given the show has songs "Alpha", "Bravo" and "Charlie"
  And the mode is Jukebox
  And the show player plays "Alpha"
  When phone 1 requests "Bravo"
  Then it is refused with "already up next"
  When phone 2 requests "Alpha"
  Then it is refused with "playing right now"
