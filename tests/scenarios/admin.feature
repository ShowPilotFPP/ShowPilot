Feature: Admin

Scenario: Listening phones are counted, and drop off when they stop
  Given the show has songs "Alpha" and "Bravo"
  And the mode is Jukebox
  And the show player plays "Alpha"
  When 3 phones are listening
  Then the admin shows 3 listening
  When 22 seconds pass
  Then the admin shows 0 listening

Scenario: Top sequences can hide PSAs
  Given the show has songs "Alpha", "Bravo", "Charlie" and "PSA Thanks"
  And "PSA Thanks" is a PSA
  And a PSA plays after every 1 song
  And the setting "block_vote_next_up" is off
  And the mode is Voting
  And the show player plays "Alpha"
  When "PSA Thanks" plays next as a PSA
  And 2 phones vote for "Charlie"
  And "Charlie" plays next as a vote
  Then the top sequences list is "Charlie" with PSAs hidden
  When the admin opens the Dashboard page
  And the admin ticks "Hide PSAs"
  Then the admin does not see "PSA Thanks" in top sequences

Scenario: A template script that never finishes can't lock you out of the admin
  Given the template's draft has a script that never finishes
  When the admin opens the Dashboard page
  Then the admin page responds
  When the admin's preview froze earlier
  And the admin opens the Viewer Page page
  Then the preview is paused
  And the admin page responds
  When the admin clicks "Discard unsaved changes"
  And the admin clicks "Discard"
  Then the draft is gone
  And the preview is loaded

Scenario: Opening the Viewer Page shows the preview (it's only paused after a real freeze)
  Given the viewer page uses the test template
  When the admin opens the Viewer Page page
  And 2 seconds pass
  Then the preview is loaded
  # Reloading the admin straight away isn't mistaken for a freeze either.
  When the admin opens the Viewer Page page
  Then the preview is loaded

Scenario: Tools has the Announcements tool (restored from the old beta)
  When the admin opens the Tools page
  And the admin opens the "Announcements" tab
  Then the admin sees "Install free voices"
  And the admin page responds

Scenario: Settings → Debug has the hidden output delay switch (restored from the old beta)
  When the admin opens the Settings page
  And the admin opens the "Debug" tab
  Then the admin sees "Compensate hidden output delay (experimental)"

Scenario: A category tile on the Cockpit switches the category off and on
  Given the show has songs "Alpha", "Bravo" and "Charlie"
  And the category "Kids" has "Bravo"
  And the admin's cockpit has the tiles "cat:Kids" and "viewerControl"
  When the admin opens the Cockpit
  Then the "Kids" tile on the cockpit says "On"
  When the admin taps the "Kids" tile on the cockpit
  Then the category "Kids" is off
  And the "Kids" tile on the cockpit says "Off"
  When the admin taps the "Kids" tile on the cockpit
  Then the category "Kids" is on
  And the "Kids" tile on the cockpit says "On"

Scenario: Cockpit spacers take up space, any number of them, and only show while editing
  Given the admin's cockpit has the tiles "viewerControl", "spacer1" and "sWatching"
  When the admin opens the Cockpit
  Then the cockpit spacer is 2 rows tall and hidden
  When the admin opens the Cockpit in edit mode
  Then the cockpit spacer is 2 rows tall and visible
  When the admin adds a Spacer on the cockpit
  And the admin adds a Spacer on the cockpit
  Then the saved cockpit has 3 spacers

Scenario: An old FPP plugin gets an update banner on the Dashboard, and the plugin is told
  Given the show has songs "Alpha", "Bravo" and "Charlie"
  And the show player is the FPP plugin version "0.14.18"
  Then the show player is told "0.14.22" is the newest plugin
  When the admin opens the Dashboard page
  Then the admin sees "Your ShowPilot plugin in FPP needs updating."
  And the admin sees "Installed: v0.14.18 · Newest: v0.14.22"
  And the admin sees "play a requested song twice"

Scenario: An FPP plugin that works but isn't the newest gets a dismissible banner
  Given the show has songs "Alpha", "Bravo" and "Charlie"
  And the show player is the FPP plugin version "0.14.21"
  When the admin opens the Dashboard page
  Then the admin sees "An update for the ShowPilot plugin in FPP is available."
  When the admin clicks "Dismiss"
  Then the admin does not see "An update for the ShowPilot plugin in FPP is available."

Scenario: An up-to-date FPP plugin gets no banner
  Given the show has songs "Alpha", "Bravo" and "Charlie"
  And the show player is the FPP plugin version "0.14.22"
  When the admin opens the Dashboard page
  Then the admin does not see "plugin in FPP"

Scenario: A show player that says it has an update gets a banner, and can be dismissed
  Given the show has songs "Alpha", "Bravo" and "Charlie"
  And the show player is version "player-0.13.6" and says "0.13.7" is the newest
  Then the show player is told nothing about updates
  When the admin opens the Dashboard page
  Then the admin sees "An update for your show player is available."
  And the admin sees "Installed: v0.13.6 · Newest: v0.13.7"
  When the admin clicks "Dismiss"
  Then the admin does not see "An update for your show player is available."

Scenario: A show player on its newest version gets no banner
  Given the show has songs "Alpha", "Bravo" and "Charlie"
  And the show player is version "player-0.13.7" and says "0.13.7" is the newest
  When the admin opens the Dashboard page
  Then the admin does not see "An update for your show player"

Scenario: A newer ShowPilot release shows a banner on the Dashboard, and can be dismissed
  Given the show has songs "Alpha", "Bravo" and "Charlie"
  And ShowPilot "9.9.9" is out
  When the admin opens the Dashboard page
  Then the admin sees "ShowPilot v9.9.9 is available."
  When the admin clicks "Dismiss"
  Then the admin does not see "ShowPilot v9.9.9 is available."

Scenario: No ShowPilot banner when the newest release isn't newer
  Given the show has songs "Alpha", "Bravo" and "Charlie"
  And ShowPilot "0.1.0" is out
  When the admin opens the Dashboard page
  Then the admin does not see "is available."

Scenario: The ShowPilot update banner opens the Updates page
  Given the show has songs "Alpha", "Bravo" and "Charlie"
  And ShowPilot "9.9.9" is out
  When the admin opens the Dashboard page
  And the admin clicks "Open Updates"
  Then the admin sees "Pull the latest release of ShowPilot from GitHub"
