Feature: Race

# Songs in these scenarios avoid "Bravo": it's next in the playlist after
# "Alpha", so a schedule fill would also pick it.

Scenario: A race that ends with the song plays the leader right after it
  Given the show has songs "Alpha", "Bravo", "Charlie" and "Delta"
  And "Alpha" is 200 seconds long
  And the setting "race_end_on_sequence_end" is on
  And the mode is Race
  And the show player plays "Alpha"
  When 3 phones tap "Charlie" in the race
  And 1 phone taps "Delta" in the race
  # Mid-song, nobody has won yet: the race is still open.
  Then the show player is not given a song
  When "Alpha" has been playing for 197 seconds
  Then "Charlie" plays next as a race winner
  And the race winner waits for the song to end

Scenario: A race timer of 0 also ends with the song
  Given the show has songs "Alpha", "Bravo", "Charlie" and "Delta"
  And "Alpha" is 200 seconds long
  And the setting "race_duration_seconds" is "0"
  And the mode is Race
  And the show player plays "Alpha"
  When 2 phones tap "Delta" in the race
  And "Alpha" has been playing for 198 seconds
  Then "Delta" plays next as a race winner

Scenario: The live position decides when the song is ending
  Given the show has songs "Alpha", "Bravo", "Charlie" and "Delta"
  And "Alpha" is 200 seconds long
  And the setting "race_end_on_sequence_end" is on
  And the mode is Race
  And the show player plays "Alpha"
  When 2 phones tap "Charlie" in the race
  And the show player reports "Alpha" at 120 seconds
  Then the show player is not given a song
  When the show player reports "Alpha" at 197 seconds
  Then "Charlie" plays next as a race winner

Scenario: With no taps, a race that ends with the song follows the schedule
  Given the show has songs "Alpha", "Bravo", "Charlie" and "Delta"
  And "Alpha" is 200 seconds long
  And the setting "race_end_on_sequence_end" is on
  And the mode is Race
  And the show player plays "Alpha"
  When "Alpha" has been playing for 198 seconds
  Then "Bravo" plays next

Scenario: The first song to reach the tap target wins
  Given the show has songs "Alpha", "Bravo", "Charlie" and "Delta"
  And the setting "race_target_taps" is "3"
  And the mode is Race
  And the show player plays "Alpha"
  When 2 phones tap "Charlie" in the race
  Then the show player is not given a song
  When 1 phone taps "Charlie" in the race
  Then "Charlie" plays next as a race winner

Scenario: The next song starts a fresh race
  Given the show has songs "Alpha", "Bravo", "Charlie" and "Delta"
  And "Alpha" is 200 seconds long
  And "Charlie" is 200 seconds long
  And the setting "race_end_on_sequence_end" is on
  And the mode is Race
  And the show player plays "Alpha"
  When 2 phones tap "Charlie" in the race
  And "Alpha" has been playing for 198 seconds
  Then "Charlie" plays next as a race winner
  When 1 phone taps "Delta" in the race
  And "Charlie" has been playing for 198 seconds
  Then "Delta" plays next as a race winner
