Feature: FPP Monitor

Scenario: The heartbeat asks the show player for its status
  Given the show has songs "Alpha", "Bravo" and "Charlie"
  Then the heartbeat asks the show player for FPP status

Scenario: The FPP page shows what FPP reports
  Given the show has songs "Alpha", "Bravo" and "Charlie"
  When the show player reports FPP playing "Alpha.fseq" from "Christmas", the CPU at 55°C, 40% disk free, with the remote "Matrix" online
  Then the FPP page shows "Alpha.fseq"
  And the FPP page shows "Christmas"
  And the FPP page shows "Halloween"
  And the FPP page shows "Matrix"
  And the FPP page shows "Flood On"
  And the FPP health is ok

Scenario: A hot CPU, a full disk and a missing remote are flagged
  Given the show has songs "Alpha", "Bravo" and "Charlie"
  When the show player reports FPP idle, the CPU at 74°C
  Then the FPP health is warn
  And the FPP page shows "CPU is warm"
  When the show player reports FPP idle, the CPU at 83°C
  Then the FPP health is bad
  When the show player reports FPP idle, the CPU at 50°C, 3% disk free
  Then the FPP health is bad
  And the FPP page shows "Disk almost full"
  When the show player reports FPP idle, the CPU at 50°C, 40% disk free, with the remote "Matrix" offline
  Then the FPP health is warn
  And the FPP page shows "not seen recently"

Scenario: Controls reach the show player and report back
  Given the show has songs "Alpha", "Bravo" and "Charlie"
  When the show player reports FPP idle
  And the admin asks FPP to start the playlist "Halloween"
  Then it is accepted
  And the last FPP control is waiting
  When the show player reports FPP idle
  Then the show player is told to startPlaylist "Halloween"
  When the show player reports FPP playing "Spooky.fseq" from "Halloween"
  Then the last FPP control worked
  And the show player is told nothing
  When the admin asks FPP to run the preset "Flood On"
  And the show player reports FPP idle
  Then the show player is told to preset "Flood On"
  When the admin asks FPP to stop now
  And the show player reports FPP idle
  Then the show player is told to stopNow

Scenario: A control needs a name, and unknown controls are refused
  Given the show has songs "Alpha", "Bravo" and "Charlie"
  When the admin asks FPP to start the playlist ""
  Then it is refused with "Pick a playlist"

Scenario: Reports come every second while the FPP page is open
  Given the show has songs "Alpha", "Bravo" and "Charlie"
  When the show player reports FPP idle
  Then the show player is asked to report every 5 seconds
  When the FPP page shows "ShowFPP"
  And the show player reports FPP idle
  Then the show player is asked to report every 1 seconds

Scenario: The FPP Monitor page and the Dashboard strip
  Given the show has songs "Alpha", "Bravo" and "Charlie"
  When the show player reports FPP playing "Alpha.fseq" from "Christmas", the CPU at 55°C, 40% disk free, with the remote "Matrix" online
  And the admin opens the FPP Monitor page
  Then the admin sees "Playing"
  And the admin sees "Alpha.fseq"
  And the admin sees "55°C"
  And the admin sees "Matrix"
  And the admin sees "Restart FPPD"
  When the admin opens the Dashboard page
  Then the admin sees "FPP Monitor"

Scenario: FPP not sending MultiSync packets is flagged while phone audio is on
  Given the show has songs "Alpha", "Bravo" and "Charlie"
  When the show player reports FPP idle, the CPU at 50°C, with MultiSync packets off
  Then the FPP health is warn
  And the FPP page shows "sending MultiSync packets, so phone audio syncs less precisely"
  When the show player reports FPP idle, the CPU at 50°C, with MultiSync packets on
  Then the FPP health is ok
  When phone audio is turned off in Settings
  And the show player reports FPP idle, the CPU at 50°C, with MultiSync packets off
  Then the FPP health is ok
