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
