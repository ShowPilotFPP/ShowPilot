Feature: Location check

Scenario: An iPhone that blocks location is told which setting to change
  Given the show has songs "Alpha" and "Bravo"
  And phones must be within 1 mile to vote or request
  And the viewer page uses the test template
  And the mode is Jukebox
  When phone 1 opens the viewer page as an iPhone
  And phone 1 taps "Alpha"
  Then phone 1 gets the message "Safari Websites"
  And the queue is empty

Scenario: Facebook's built-in browser is told to open the page in Safari
  Given the show has songs "Alpha" and "Bravo"
  And phones must be within 1 mile to vote or request
  And the viewer page uses the test template
  And the mode is Jukebox
  When phone 1 opens the viewer page in Facebook's browser
  And phone 1 taps "Alpha"
  Then phone 1 gets the message "built-in browser"

Scenario: A rough location that looks too far away suggests Precise Location
  Given the show has songs "Alpha" and "Bravo"
  And phones must be within 1 mile to vote or request
  And the viewer page uses the test template
  And the mode is Jukebox
  And phone 1 is 3 miles away with a rough location
  When phone 1 opens the viewer page as an iPhone
  And phone 1 taps "Alpha"
  Then phone 1 gets the message "Precise Location"

Scenario: A phone at the show can request, one far away can't
  Given the show has songs "Alpha" and "Bravo"
  And phones must be within 1 mile to vote or request
  And the viewer page uses the test template
  And the mode is Jukebox
  And phone 1 is at the show
  And phone 2 is 5 miles away
  When phone 1 opens the viewer page
  And phone 1 taps "Alpha"
  Then phone 1 gets the message "Added to the queue"
  And the queue is "Alpha"
  When phone 2 requests "Bravo"
  Then it is refused with "mile"

Scenario: A phone signed in to the admin can request from far away, other phones still can't
  Given the show has songs "Alpha", "Bravo" and "Charlie"
  And phones must be within 1 mile to vote or request
  And the mode is Jukebox
  And phone 1 is 5 miles away
  And the setting "admin_skip_location" is on
  And phone 1 is signed in to the admin
  And phone 2 is 5 miles away
  When phone 1 requests "Bravo"
  Then it is accepted
  When phone 2 requests "Charlie"
  Then it is refused with "mile"

Scenario: A phone signed in to the admin isn't asked for its location
  Given the show has songs "Alpha" and "Bravo"
  And phones must be within 1 mile to vote or request
  And the viewer page uses the test template
  And the mode is Jukebox
  And the setting "admin_skip_location" is on
  And phone 1 is signed in to the admin
  When phone 1 opens the viewer page as an iPhone
  And phone 1 taps "Alpha"
  Then phone 1 gets the message "Added to the queue"
  And the queue is "Alpha"

Scenario: The access code still applies to a phone signed in to the admin
  Given the show has songs "Alpha" and "Bravo"
  And phones must be within 1 mile to vote or request
  And the setting "location_code_enabled" is on
  And the setting "location_code" is "4321"
  And the mode is Jukebox
  And the setting "admin_skip_location" is on
  And phone 1 is signed in to the admin
  When phone 1 requests "Bravo"
  Then it is refused with "access code"

Scenario: A phone signed in to the admin can listen from far away, other phones still can't
  Given the show has songs "Alpha" and "Bravo"
  And phones must be within 1 mile to vote or request
  And the setting "audio_gate_enabled" is on
  And the mode is Jukebox
  And the setting "admin_skip_location" is on
  And phone 1 is signed in to the admin
  And phone 2 is 5 miles away
  And phone 3 is at the show
  Then phone 1 can listen
  And phone 2 can't listen
  And phone 3 can listen

Scenario: With "Signed-in admins skip location checks" off, an admin is checked like everyone else
  Given the show has songs "Alpha", "Bravo" and "Charlie"
  And phones must be within 1 mile to vote or request
  And the setting "audio_gate_enabled" is on
  And the mode is Jukebox
  And phone 1 is 5 miles away
  And phone 1 is signed in to the admin
  When phone 1 requests "Bravo"
  Then it is refused with "mile"
  And phone 1 can't listen
