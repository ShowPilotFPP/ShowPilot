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
