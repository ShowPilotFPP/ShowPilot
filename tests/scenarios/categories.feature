Feature: Categories

Scenario: Switching a category off from the show player hides its songs
  Given the show has songs "Alpha", "Bravo", "Charlie" and "Delta"
  And the category "Late Night" has "Charlie"
  And the mode is Jukebox
  And the show player plays "Alpha"
  When the show player switches the category "Late Night" off
  And phone 1 requests "Charlie"
  Then it is refused
  When the show player switches the category "late night" on
  And phone 2 requests "Charlie"
  Then it is accepted
