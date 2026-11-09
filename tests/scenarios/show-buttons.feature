Feature: Show buttons

Scenario: A button press reaches the show player and starts a wait for everyone
  Given the show has songs "Alpha", "Bravo" and "Charlie"
  And the show player is the FPP plugin version "0.14.30"
  And the show has a button "Fog" that runs the effect "Fog.eseq" with a wait of 30 seconds
  And show buttons are on
  And the mode is Jukebox
  And the show player plays "Alpha"
  When phone 1 presses the "Fog" button
  Then it is accepted
  When the show player checks for button presses
  Then the show player runs "Effect Start" with "Fog.eseq"
  When phone 2 presses the "Fog" button
  Then it is refused with "just pressed"
  When the show player checks for button presses
  Then the show player is given no button presses

Scenario: Buttons are off until the owner turns them on
  Given the show has songs "Alpha", "Bravo" and "Charlie"
  And the show player is the FPP plugin version "0.14.30"
  And the show has a button "Fog" that runs the effect "Fog.eseq"
  And the mode is Jukebox
  And the show player plays "Alpha"
  Then the heartbeat tells the show player not to check for button presses
  When phone 1 presses the "Fog" button
  Then it is refused with "off"
  When show buttons are on
  Then the heartbeat tells the show player to check for button presses

Scenario: By default buttons only work while a song is playing
  Given the show has songs "Alpha", "Bravo" and "Charlie"
  And the show player is the FPP plugin version "0.14.30"
  And the show has a button "Fog" that runs the effect "Fog.eseq"
  And show buttons are on
  And the mode is Jukebox
  When phone 1 presses the "Fog" button
  Then it is refused with "off"
  When show buttons are on any time
  And phone 1 presses the "Fog" button
  Then it is accepted

Scenario: Buttons don't work while viewer control is off
  Given the show has songs "Alpha", "Bravo" and "Charlie"
  And the show player is the FPP plugin version "0.14.30"
  And the show has a button "Fog" that runs the effect "Fog.eseq"
  And show buttons are on any time
  And the mode is Off
  When phone 1 presses the "Fog" button
  Then it is refused with "off"

Scenario: Each visitor waits a few seconds between presses
  Given the show has songs "Alpha", "Bravo" and "Charlie"
  And the show player is the FPP plugin version "0.14.30"
  And the show has a button "Fog" that runs the effect "Fog.eseq" with a wait of 0 seconds
  And the show has a button "Strobe" that runs the script "strobe.sh" with a wait of 0 seconds
  And show buttons are on any time
  And the mode is Jukebox
  When phone 1 presses the "Fog" button
  Then it is accepted
  When phone 1 presses the "Strobe" button
  Then it is refused with "few seconds"
  When phone 2 presses the "Strobe" button
  Then it is accepted
  When the show player checks for button presses
  Then the show player is given 2 button presses
  And the show player runs "Run Script" with "strobe.sh"

Scenario: The admin's Test button runs a command preset straight away
  Given the show has songs "Alpha", "Bravo" and "Charlie"
  And the show player is the FPP plugin version "0.14.30"
  And the show has a button "Flood" that runs the command preset "Flood On"
  And show buttons are on
  When the admin tests the "Flood" button
  And the show player checks for button presses
  Then the show player runs "Trigger Command Preset" with "Flood On"

Scenario: Phones see the buttons, and the wait after someone presses one
  Given the show has songs "Alpha", "Bravo" and "Charlie"
  And the live viewer page is the file "show-buttons.html"
  And the show player is the FPP plugin version "0.14.30"
  And the show has a button "Fog" that runs the effect "Fog.eseq" with a wait of 30 seconds
  And show buttons are on
  And the mode is Jukebox
  And the show player plays "Alpha"
  When phone 1 opens the viewer page
  And phone 2 opens the viewer page
  Then on phone 2, the "Fog" button can be pressed
  When phone 1 taps the "Fog" button
  Then on phone 2, the "Fog" button is greyed out
  And on phone 1, the "Fog" button is greyed out
  When the show player checks for button presses
  Then the show player runs "Effect Start" with "Fog.eseq"
  When show buttons are off
  Then on phone 2, the "Fog" button is not shown
