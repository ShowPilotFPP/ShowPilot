Feature: Viewer pages

Scenario: A command switches the live viewer page, and open phones follow
  Given the show has songs "Alpha" and "Bravo"
  And the viewer page uses the test template
  And there is also a viewer page "Spooky Night"
  And the mode is Jukebox
  And the show player plays "Alpha"
  When phone 1 opens the viewer page
  Then phone 1 does not see "Spooky Night"
  When the show player sets the viewer page to "spooky night"
  Then the live viewer page is "Spooky Night"
  And phone 1 sees "Spooky Night"

Scenario: Setting a viewer page that doesn't exist is refused and changes nothing
  Given the show has songs "Alpha" and "Bravo"
  And the viewer page uses the test template
  When the show player sets the viewer page to "Easter"
  Then it fails with "HTTP 404"
  And the live viewer page is "Scenario test template"

Scenario: Templates can tell which mode the page is in
  Given the show has songs "Alpha" and "Bravo"
  And the viewer page uses the test template
  And the mode is Jukebox
  When phone 1 opens the viewer page
  Then phone 1's page says the mode is "jukebox"
  When the show player switches to Listen only
  Then phone 1's page says the mode is "listen-only"
  And the viewer page as first sent says the mode is "listen-only"
  When the show player switches to Voting
  Then phone 1's page says the mode is "voting"
  When the show player switches to Off
  Then phone 1's page says the mode is "off"

Scenario: Global CSS styles every viewer page, and templates can override it
  Given the show has songs "Alpha" and "Bravo"
  And the viewer page uses the test template
  And the global CSS is "body { border-top: 5px solid rgb(1, 2, 3); color: rgb(4, 5, 6); }"
  And the mode is Jukebox
  When phone 1 opens the viewer page
  Then on phone 1, the "border-top-color" of "body" is "rgb(1, 2, 3)"
  # The test template sets its own text color, which wins over the global CSS.
  And on phone 1, the "color" of "body" is not "rgb(4, 5, 6)"
  When the global CSS is turned off
  And phone 2 opens the viewer page
  Then on phone 2, the "border-top-color" of "body" is not "rgb(1, 2, 3)"

Scenario: A bad global CSS change can be undone
  Given the show has songs "Alpha" and "Bravo"
  And the viewer page uses the test template
  And the global CSS is "body { border-top: 5px solid rgb(1, 2, 3); }"
  And the global CSS is "body { border-top: 5px solid rgb(9, 9, 9); }"
  When the admin restores the previous global CSS
  And phone 1 opens the viewer page
  Then on phone 1, the "border-top-color" of "body" is "rgb(1, 2, 3)"

Scenario: A template file can be loaded into the editor, and stays a draft until saved
  Given the show has songs "Alpha" and "Bravo"
  And the viewer page uses the test template
  When the admin opens the Viewer Page page
  And the admin loads the file "uploaded-page.html" into the template
  And the admin clicks "Replace"
  Then the draft contains "Uploaded from a file"
  And the admin's code editor shows "Uploaded from a file"
  And the admin sees "Discard Changes"
  When phone 1 opens the viewer page
  Then phone 1 does not see "Uploaded from a file"

Scenario: An unsaved draft from an earlier visit shows in the code editor, with Discard
  Given the viewer page uses the test template
  And the template's draft is the file "uploaded-page.html"
  When the admin opens the Dashboard page
  And the admin goes to the Dashboard and back to the Viewer Page
  And the admin switches the editor to Code
  Then the admin's code editor shows "Uploaded from a file"
  # A draft from an earlier visit shows as unsaved, so Discard is right there.
  And the admin sees "Discard Changes"

Scenario: A broken draft never reaches phones
  Given the show has songs "Alpha" and "Bravo"
  And "Bravo" has the badge "New"
  And the viewer page uses the test template
  And the template's draft is the file "endless-redraw.html"
  And the mode is Jukebox
  When phone 1 opens the viewer page
  Then phone 1's page responds
  And phone 1 sees "Bravo"

Scenario: The same broken script does freeze a page once it's saved (so the test above means something)
  Given the show has songs "Alpha" and "Bravo"
  And "Bravo" has the badge "New"
  And the viewer page uses the test template
  And the live viewer page is the file "endless-redraw.html"
  And the mode is Jukebox
  When phone 1 opens the viewer page
  Then phone 1's page is frozen
