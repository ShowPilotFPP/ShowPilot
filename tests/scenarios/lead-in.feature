Feature: Lead-in and lead-out songs

# A playlist's lead-in and lead-out (an intro, an outro) play in the show but
# aren't offered to viewers. The show player sends them as audio-only, so
# phones listening get their audio while viewers can't see, vote for or
# request them.

Scenario: An intro in the lead-in plays on phones but viewers can't pick it
  Given the show has songs "Alpha", "Bravo" and "Charlie"
  And the show has the lead-in song "Intro" with audio
  And the mode is Jukebox
  When the show player plays "Intro"
  Then the phone player is sent the audio of "Intro"
  And "Intro" is not offered to viewers
  And "Alpha" is offered to viewers
  When phone 1 requests "Intro"
  Then it is refused with "not available"
  And the Sequences page marks "Intro" as lead-in or lead-out

Scenario: A song moved into the lead-in leaves the viewer page, and comes back when it returns
  Given the show has songs "Alpha", "Bravo" and "Charlie"
  And the mode is Jukebox
  And the show player plays "Alpha"
  When phone 1 requests "Charlie"
  And the show has the lead-in song "Charlie" with audio
  Then "Charlie" is not offered to viewers
  And the queue is empty
  When the show player plays "Charlie"
  Then the phone player is sent the audio of "Charlie"
  When the show player syncs its playlist again
  Then "Charlie" is not offered to viewers
  Given the show has songs "Alpha", "Bravo" and "Charlie"
  Then "Charlie" is offered to viewers
