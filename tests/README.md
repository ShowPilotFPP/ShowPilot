# ShowPilot scenario tests

Plain-English tests for ShowPilot. Each scenario is a short story about a
show night ("3 phones vote for Charlie, a PSA plays, Charlie still plays
next"). The test system acts it out against a throwaway ShowPilot, with a
fake show player standing in for FPP (or any show player) and headless phones
and admin pages where needed, then reports what passed and what didn't, with
a screenshot after every step that involves a page.

Nothing here touches a real show: every scenario gets its own copy of
ShowPilot, its own database and its own port, deleted afterwards.

## Running them

```
npm test                  # every scenario
npm test -- listen        # only scenarios whose file or title contains "listen"
npm test -- --steps       # list every sentence you can use
```

Results: `tests/out/report.html` (open in a browser) and
`tests/out/results.json`. On GitHub, every push to `main`, `beta` and
`claude/*` runs them on the self-hosted Mac runner (workflow "Scenario
tests"); the run page shows a summary and the full report is attached as the
**scenario-report** artifact.

## Writing a scenario

Scenarios live in `tests/scenarios/*.feature`, grouped by feature:

```
Feature: Voting

Scenario: A PSA in the middle of a voting round keeps the votes
  Given the show has songs "Alpha", "Bravo", "Charlie" and "PSA Thanks"
  And "PSA Thanks" is a PSA
  And the mode is Voting
  And the show player plays "Alpha"
  When 2 phones vote for "Charlie"
  And the show player plays "PSA Thanks"
  Then "Charlie" has 2 votes
  And "Charlie" plays next as a vote
```

- **Given** sets the scene, **When** is what happens, **Then** is what should
  be true. **And** / **But** continue the previous one. Lines starting with
  `#` are notes.
- Song names, messages and other values go in "double quotes".
- "Then" checks keep trying for a few seconds, because phones and the admin
  update on a short delay, like on a real night.
- **Up next counts.** While "Alpha" plays, the next song in the playlist
  ("Bravo" above) is "up next", and ShowPilot doesn't take votes or requests
  for the song that's already up next. Request or vote for a later song
  unless that's what you're testing.
- If you use a sentence the system doesn't know, it stops before running
  anything and suggests the closest ones it does know.

### Asking for a test instead of writing it

Describe the behaviour in a sentence (to Claude in chat, or in a GitHub issue
labelled `test`), for example: "if someone requests a song that's already in
the queue, they should get a message and it shouldn't be added twice".
Claude turns it into a scenario, adds any new sentence the system needs, runs
it and reports back. The scenario then stays in the suite.

## Every sentence the system knows

```
  the show has songs "A", "B" and "C"
  "A" is a PSA
  a PSA plays after every N songs
  "A" has the artist "Name"
  "A" has the badge "New"
  "A" has a cover
  "A" has a cooldown of N minutes
  the category "Kids" has "A" and "B"
  the viewer page uses the test template (Remote Falcon style)
  there is also a viewer page "Name"   (a copy of the test template with that name in its title)
  the template's draft is the file "name.html"   (from tests/templates)
  the live viewer page is the file "name.html"   (from tests/templates)
  the global CSS is "css"
  the global CSS is turned off | on
  the admin restores the previous global CSS
  phones must be within N miles to vote or request
  the setting "name" is on / off (any admin setting by its database name)
  the mode is Voting | Jukebox | Race | Listen only | Off   (set by the show player, like an FPP command)
  the show player switches to Voting | Jukebox | Race | Listen only | Off | On
  the show player plays "A"
  the song ends   (the show player plays whatever ShowPilot asks for, else the next song)
  the show player clears the queue   (the "Clear Queue" FPP command)
  the show player sets the viewer page to "Name"   (the "Set Viewer Page" command)
  the show player switches the category "Kids" off | on
  phone 1 is at the show | is N miles away [with a rough location]
  phone 1 votes for "A"
  N phones vote for "A"
  phone 1 requests "A"
  N phones are listening   (Listen on Phone open)
  phone 1 opens the viewer page [as an iPhone | in Facebook's browser]
  phone 1 taps "A"
  the admin opens the Dashboard | Sequences | Viewer Page | Queue | Stats page
  the admin ticks "Hide PSAs"
  the admin switches to Voting | Jukebox | Race | Listen only | Off
  the admin clears the queue
  the template's draft has a script that never finishes
  "A" has N votes
  the queue is "A" and "B" | the queue is empty
  "A" plays next | "A" plays next as a vote | request | PSA
  the show player is not given a song   (it follows its own schedule)
  no PSA is handed out
  it is refused with "text"   (the last vote or request)
  it is accepted
  the mode is now Voting | Jukebox | … 
  the admin shows N listening
  the Top Sequences list is "A" and "B" [with PSAs hidden]
  phone 1 sees "text"
  phone 1 does not see "text"
  phone 1 gets the message "text"   (the pop-up after a tap)
  on phone 1, "A" is marked as queued [#N] | is not marked as queued
  on phone 1, "A" shows the badge "New" fully
  phone 1 shows the cover of "A" for Now Playing | Up Next
  phone 1 shows no cover for Up Next | Now Playing
  phone 1 shows "Name" as the Now Playing artist | shows no Now Playing artist
  phone 1 is in Listen Only   (body class + notice)
  phone 1's page says the mode is "listen-only"   (data-showpilot-mode on <html> and <body>)
  the viewer page as first sent says the mode is "listen-only"   (before any script runs)
  on phone 1, the "color" of "selector" is [not] "rgb(1, 2, 3)"
  phone 1's page still responds
  phone 1's page is frozen
  the live viewer page is "Name"
  it fails with "text"   (the last show player command)
  the admin sees "text"
  the admin does not see "text" in Top sequences
  the admin page still responds
  the preview is paused
  the admin's preview froze earlier   (simulates a freeze on the last visit)
  the admin clicks "Button text"
  the admin loads the file "name.html" into the template   (Load from file…, from tests/templates)
  the draft contains "text"
  the admin's code editor shows "text"
  the admin switches the editor to Code
  the admin goes to the Dashboard and back to the Viewer Page   (without reloading)
  the draft is gone
  N seconds pass
```

(Generated by `npm test -- --steps`. New sentences are added in
`tests/lib/steps.js`; each needs a `doc` line, which is what appears here.)

## How it works

- `tests/lib/harness.js` copies the app to a temp folder (packages are
  linked, not copied), starts it on a free port with fixed secrets and a fresh
  database, and signs in the admin with a token.
- `tests/lib/showplayer.js` is the fake show player. It speaks the same plugin
  API as the FPP plugin and other show players: sync the playlist, ask what to
  play next, report what's playing. It never decides whether a song was a
  vote, a request or a PSA; ShowPilot works that out from what it handed out,
  as on a real night.
- `tests/lib/steps.js` is the list of sentences and what each one does.
- `tests/templates/rf-test.html` is a plain Remote Falcon style viewer page
  with every placeholder, used by the browser scenarios. The other files there
  are pages for specific scenarios (an uploaded file, a script that freezes).
- To use a Chromium that's already installed instead of Playwright's own
  download, set `SP_TEST_CHROMIUM=/path/to/chrome` before `npm test`.
- `tests/run.js` reads the scenarios, runs them one by one and writes the
  report (`tests/lib/report.js`).

Not covered: the FPP plugin running inside a real FPP install, and real
phones' audio. Those are covered by testers on real shows.
