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

# GitHub #37. From the logs: the plugin's once-a-minute mode check asked for
# the full state while three requests were waiting, ShowPilot handed it
# Abracadabra, and the plugin threw the answer away. FPP never had the song.
Scenario: The plugin's mode check can't use up a request (the skipped first request)
  Given the show has songs "Regular", "Filler", "Abracadabra", "Bodies", "Houdini" and "Toxic"
  And the mode is Jukebox
  And the show player plays "Regular"
  When phone 1 requests "Abracadabra"
  And phone 2 requests "Bodies"
  And phone 3 requests "Houdini"
  And the show player checks the mode
  And the show player takes every waiting request
  Then the show player's own queue is "Abracadabra"
  And "Abracadabra" plays next as a request
  And "Bodies" plays next as a request
  And "Houdini" plays next as a request
  And the queue is empty

Scenario: A mode check with peek hands nothing out
  Given the show has songs "Regular", "Filler" and "Abracadabra"
  And the mode is Jukebox
  And the show player plays "Regular"
  When phone 1 requests "Abracadabra"
  And the show player checks the mode with peek
  Then nothing has been handed to the show player
  And "Abracadabra" plays next as a request

Scenario: A handed-over request that's one song late still plays
  Given the show has songs "Regular", "Filler", "Abracadabra", "Bodies" and "Toxic"
  And the mode is Jukebox
  And the show player plays "Regular"
  When phone 1 requests "Abracadabra"
  And phone 2 requests "Bodies"
  And the show player takes every waiting request
  And the show player plays "Filler"
  Then the server log says "it gets one more song to start"
  And the queue is "Abracadabra" and "Bodies"
  And "Abracadabra" plays next as a request
  And "Bodies" plays next as a request

Scenario: A request the show player never starts is dropped so it can't block the queue
  Given the show has songs "Regular", "Filler", "Abracadabra", "Bodies" and "Toxic"
  And the mode is Jukebox
  And the show player plays "Regular"
  When phone 1 requests "Abracadabra"
  And phone 2 requests "Bodies"
  And the show player takes every waiting request
  And the show player plays "Filler"
  And the show player plays "Toxic"
  Then the server log says "dropping it from the queue"
  And the queue is "Bodies"

Scenario: A sequence on repeat restarts its progress bar each time
  Given the show has songs "Show Starts Soon" and "Regular"
  And the mode is Jukebox
  And the show player plays "Show Starts Soon"
  And "Show Starts Soon" has been playing for 200 seconds
  When the show player reports "Show Starts Soon" at 2 seconds
  Then the song shows 2 seconds played
  When the show player reports "Show Starts Soon" at 3.5 seconds
  Then the song shows 3 seconds played

Scenario: The admin lists requests already handed to the show player, and none says Playing now
  Given the show has songs "Regular", "Filler", "Abracadabra", "Bodies" and "Houdini"
  And the mode is Jukebox
  And the show player plays "Regular"
  When phone 1 requests "Abracadabra"
  And phone 2 requests "Bodies"
  And the show player takes every waiting request
  And the admin opens the Dashboard page
  Then the admin sees "Abracadabra"
  And the admin sees "Bodies"
  And the admin sees "2 waiting"
  When the admin opens the Queue page
  Then the admin sees "Sent to the show player"
  And the admin does not see "Playing now"

Scenario: Requests handed to the show player still count toward the queue limit
  Given the show has songs "Regular", "Filler", "Abracadabra", "Bodies" and "Houdini"
  And the setting "jukebox_queue_depth" is "2"
  And the mode is Jukebox
  And the show player plays "Regular"
  When phone 1 requests "Abracadabra"
  And phone 2 requests "Bodies"
  And the show player takes every waiting request
  And phone 3 requests "Houdini"
  Then it is refused with "The queue is full"

Scenario: The server log can be downloaded and shows what the show player was told
  Given the show has songs "Regular", "Filler" and "Abracadabra"
  And the mode is Jukebox
  And the show player plays "Regular"
  When phone 1 requests "Abracadabra"
  And "Abracadabra" plays next as a request
  Then the server log says "to the show player (requested"
  And the downloaded server log has "started playing"
