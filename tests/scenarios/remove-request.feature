Feature: Visitors remove their own requests

Scenario: A visitor can remove their own waiting request
  Given the show has songs "Alpha", "Bravo", "Charlie" and "Delta"
  And the setting "jukebox_viewer_cancel" is on
  And the mode is Jukebox
  And the show player plays "Alpha"
  When phone 1 requests "Charlie"
  And phone 2 requests "Delta"
  And phone 1 removes its request for "Charlie"
  Then it is accepted
  And the queue is "Delta"
  And "Delta" plays next as a request

Scenario: A visitor can't remove someone else's request
  Given the show has songs "Alpha", "Bravo", "Charlie" and "Delta"
  And the setting "jukebox_viewer_cancel" is on
  And the mode is Jukebox
  And the show player plays "Alpha"
  When phone 1 requests "Charlie"
  And phone 2 tries to remove phone 1's request for "Charlie"
  Then it is refused with "only remove your own"
  And the queue is "Charlie"

Scenario: A request already sent to the show player can't be removed
  Given the show has songs "Alpha", "Bravo", "Charlie" and "Delta"
  And the setting "jukebox_viewer_cancel" is on
  And the mode is Jukebox
  And the show player plays "Alpha"
  When phone 1 requests "Charlie"
  And the show player takes every waiting request
  And phone 1 removes its request for "Charlie"
  Then it is refused with "already on its way"
  And "Charlie" plays next as a request

Scenario: Requests behind the one sent to the show player can still be removed
  Given the show has songs "Alpha", "Bravo", "Charlie" and "Delta"
  And the setting "jukebox_viewer_cancel" is on
  And the mode is Jukebox
  And the show player plays "Alpha"
  When phone 1 requests "Charlie"
  And phone 2 requests "Delta"
  And the show player takes every waiting request
  And phone 2 removes its request for "Delta"
  Then it is accepted
  And the queue is "Charlie"
  And "Charlie" plays next as a request
  And the queue is empty

Scenario: Removing at the moment the show player takes the request: removed or played, never both
  Given the show has songs "Alpha", "Bravo", "Charlie" and "Delta"
  And the setting "jukebox_viewer_cancel" is on
  And the mode is Jukebox
  And the show player plays "Alpha"
  When phone 1 requests "Charlie"
  And phone 1 removes its request for "Charlie" just as the show player takes it
  Then the request for "Charlie" was either removed or handed to the show player, never both or neither

# A second visitor's copy of a song stays listed (and removable) while the
# first visitor's copy plays: it plays again afterwards.
Scenario: A second request for the song that's playing stays in the queue list
  Given the show has songs "Alpha", "Bravo", "Charlie", "Delta" and "Echo"
  And the setting "jukebox_viewer_cancel" is on
  And the mode is Jukebox
  And the show player plays "Alpha"
  When phone 3 requests "Charlie"
  And phone 1 requests "Delta"
  And phone 2 requests "Delta"
  And "Charlie" plays next as a request
  And "Delta" plays next as a request
  Then the queue is "Delta"
  When phone 2 removes its request for "Delta"
  Then it is accepted
  And the queue is empty

Scenario: A visitor can remove at most 20 requests a minute
  Given the show has songs "Alpha", "Bravo", "Charlie" and "Delta"
  And the setting "jukebox_viewer_cancel" is on
  And the mode is Jukebox
  And the show player plays "Alpha"
  When phone 1 requests and removes "Charlie" 20 times
  Then it is accepted
  When phone 1 requests and removes "Charlie" 1 times
  Then it is refused with "very quickly"
  When phone 2 requests "Delta"
  And phone 2 removes its request for "Delta"
  Then it is accepted

Scenario: Removing is off unless the show turns it on
  Given the show has songs "Alpha", "Bravo", "Charlie" and "Delta"
  And the mode is Jukebox
  And the show player plays "Alpha"
  When phone 1 requests "Charlie"
  And phone 1 removes its request for "Charlie"
  Then it is refused with "turned off"
  And the queue is "Charlie"

Scenario: Requests can't be removed in Listen Only
  Given the show has songs "Alpha", "Bravo", "Charlie" and "Delta"
  And the setting "jukebox_viewer_cancel" is on
  And the mode is Jukebox
  And the show player plays "Alpha"
  When phone 1 requests "Charlie"
  And the show player switches to Listen only
  And phone 1 removes its request for "Charlie"
  Then it is refused with "closed"
  And the queue is "Charlie"

Scenario: Removing a request opens the visitor's slot again
  Given the show has songs "Alpha", "Bravo", "Charlie" and "Delta"
  And the setting "jukebox_viewer_cancel" is on
  And the mode is Jukebox
  And the show player plays "Alpha"
  When phone 1 requests "Charlie"
  And phone 1 requests "Delta"
  Then it is refused with "You already have"
  When phone 1 removes its request for "Charlie"
  And phone 1 requests "Delta"
  Then it is accepted
  And the queue is "Delta"

Scenario: A removed request no longer counts toward the next PSA
  Given the show has songs "Alpha", "Bravo", "Charlie", "Delta" and "PSA Thanks"
  And "PSA Thanks" is a PSA
  And the setting "play_psa_enabled" is on
  And the setting "psa_frequency" is "10"
  And the setting "jukebox_viewer_cancel" is on
  And the mode is Jukebox
  And the show player plays "Alpha"
  When phone 1 requests "Charlie"
  Then the PSA count is 1
  When phone 1 removes its request for "Charlie"
  Then the PSA count is 0

Scenario: A request made before the last PSA doesn't take a count from after it
  Given the show has songs "Alpha", "Bravo", "Charlie", "Delta" and "PSA Thanks"
  And "PSA Thanks" is a PSA
  And the setting "play_psa_enabled" is on
  And the setting "psa_frequency" is "10"
  And the setting "jukebox_viewer_cancel" is on
  And the mode is Jukebox
  And the show player plays "Alpha"
  When phone 1 requests "Charlie"
  And the show player plays "PSA Thanks"
  And phone 2 requests "Delta"
  Then the PSA count is 1
  When phone 1 removes its request for "Charlie"
  Then the PSA count is 1

# In interrupt mode a request saves the playing song as the place the show
# goes back to. With the only request removed, nothing interrupts the show,
# so Up Next must go back to the schedule rather than show the playing song.
Scenario: Up Next goes back to the schedule when the only request is removed
  Given the show has songs "Alpha", "Bravo", "Charlie" and "Delta"
  And the setting "interrupt_schedule" is on
  And the setting "jukebox_viewer_cancel" is on
  And the mode is Jukebox
  And the show player plays "Alpha"
  When phone 1 requests "Charlie"
  Then Up Next is "Charlie"
  When phone 1 removes its request for "Charlie"
  Then Up Next is "Bravo"

Scenario: Phones show a Remove button only on their own waiting requests
  Given the show has songs "Alpha", "Bravo", "Charlie" and "Delta"
  And the viewer page uses the test template
  And the setting "jukebox_viewer_cancel" is on
  And the mode is Jukebox
  And the show player plays "Alpha"
  When phone 1 requests "Charlie"
  And phone 2 requests "Delta"
  And phone 1 opens the viewer page
  And phone 2 opens the viewer page
  Then on phone 1, the request for "Charlie" has a Remove button
  And on phone 1, the request for "Delta" has no Remove button
  And on phone 2, the request for "Charlie" has no Remove button
  And on phone 2, the request for "Delta" has a Remove button
  When phone 1 taps Remove on "Charlie"
  Then phone 1 gets the message "Your request was removed"
  And the queue is "Delta"
  And on phone 2, "Charlie" is not marked as queued
  And on phone 1, the request for "Delta" has no Remove button

Scenario: The Remove button goes when the request is sent or the setting is turned off
  Given the show has songs "Alpha", "Bravo", "Charlie" and "Delta"
  And the viewer page uses the test template
  And the setting "jukebox_viewer_cancel" is on
  And the mode is Jukebox
  And the show player plays "Alpha"
  When phone 1 requests "Charlie"
  And phone 1 requests "Delta"
  Then it is refused
  When the setting "viewer_request_limit" is "2"
  And phone 1 requests "Delta"
  And phone 1 opens the viewer page
  Then on phone 1, the request for "Charlie" has a Remove button
  And on phone 1, the request for "Delta" has a Remove button
  When the show player takes every waiting request
  Then on phone 1, the request for "Charlie" has no Remove button
  And on phone 1, the request for "Delta" has a Remove button
  When the setting "jukebox_viewer_cancel" is off
  Then on phone 1, the request for "Delta" has no Remove button

Scenario: The built-in Default page has the Remove button too
  Given the show has songs "Alpha", "Bravo", "Charlie" and "Delta"
  And the viewer page is the built-in Default template
  And the setting "jukebox_viewer_cancel" is on
  And the mode is Jukebox
  And the show player plays "Alpha"
  When phone 1 requests "Charlie"
  And phone 1 opens the viewer page
  Then on phone 1, the request for "Charlie" has a Remove button
  When phone 1 taps Remove on "Charlie"
  Then phone 1 sees "Your request was removed."
  And the queue is empty
