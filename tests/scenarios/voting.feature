Feature: Voting

# Songs in these scenarios avoid "Bravo": while "Alpha" plays, "Bravo" is up
# next in the playlist, and ShowPilot doesn't take votes for the song that's
# already up next.

Scenario: The song with the most votes plays next
  Given the show has songs "Alpha", "Bravo", "Charlie" and "Delta"
  And the setting "block_vote_next_up" is off
  And the mode is Voting
  And the show player plays "Alpha"
  When 3 phones vote for "Charlie"
  And 2 phones vote for "Delta"
  Then "Charlie" has 3 votes
  And "Charlie" plays next as a vote
  And "Charlie" has 0 votes

Scenario: Votes for the song that's already leading are blocked (setting on by default)
  Given the show has songs "Alpha", "Bravo", "Charlie" and "Delta"
  And the mode is Voting
  And the show player plays "Alpha"
  # Before anyone votes, the song next in the playlist counts as "up next".
  When phone 3 votes for "Bravo"
  Then it is refused with "already up next"
  # Once a song leads, it's the one that's up next.
  When phone 1 votes for "Charlie"
  Then it is accepted
  When phone 2 votes for "Charlie"
  Then it is refused with "already up next"
  When phone 3 votes for "Delta"
  Then it is accepted

Scenario: A phone can only vote once per round
  Given the show has songs "Alpha", "Bravo", "Charlie" and "Delta"
  And the mode is Voting
  And the show player plays "Alpha"
  When phone 1 votes for "Charlie"
  Then it is accepted
  When phone 1 votes for "Delta"
  Then it is refused
  And "Charlie" has 1 vote
  And "Delta" has 0 votes

Scenario: A PSA in the middle of a voting round keeps the votes
  Given the show has songs "Alpha", "Bravo", "Charlie" and "PSA Thanks"
  And "PSA Thanks" is a PSA
  And the setting "block_vote_next_up" is off
  And the mode is Voting
  And the show player plays "Alpha"
  When 2 phones vote for "Charlie"
  And the show player plays "PSA Thanks"
  Then "Charlie" has 2 votes
  And "Charlie" plays next as a vote
