# Stats

How many people visited your viewer page, how many listened on their phones, and which songs got played, voted for and requested. Everything on this page follows the same date range.

## Choosing a date range

Pick **From** and **To** dates, or use a shortcut:

| Button | Range |
|---|---|
| **Today** | Today only. |
| **7 days** | Today and the 6 days before. |
| **30 days** | Today and the 29 days before. |
| **This season** | October 1 through January 1, covering Halloween and Christmas. Before October 1, it shows the season that ended last January. |
| **All time** | Clears both dates. |

When the page first opens, both dates are empty, which means all time. Days are counted in your show's time zone.

## Visitor Analytics

Three summary boxes, **Today**, **Range** (the dates you picked) and **All time**, each with:

- **Unique**: different visitors.
- **Visits**: page visits, including repeat visits by the same person.
- **Requests**: song requests. While your show is in Voting mode this reads **Votes** instead.

Below them, charts show **Unique Visitors**, **Total Visits** and **Total Requests** (or **Total Votes**) across the range.

A page load only counts once the viewer page's own script checks in, so bots, link previews and scanners that just fetch the page are left out. If any page loads in the range were left out this way, the note under the charts says how many.

Visitors are recognized with a cookie and a shortened version of their network address. The data stays on your ShowPilot server.

## Phone Listeners

How many phones used **Listen on Phone**. The line at the top shows how many are listening **Now**, how many different phones listened today, and the most at once today. The table shows, per day in your range:

- **Most at once**: the peak number of phones listening at the same time.
- **Phones**: different phones that listened that day.

A phone with its screen locked may drop out of the live count for a while. Listener stats are kept for 90 days. For more on phone audio, see [Phone audio, start to finish](help:phone-audio).

## Song table

One row per sequence, sorted so the songs viewers chose most are at the top.

| Column | What it counts in the range |
|---|---|
| **Plays** | Every time the song played, including your show player's own schedule and PSAs. |
| **From votes** | Plays because it won a vote. |
| **From requests** | Plays because a viewer requested it. |
| **Votes received** | Votes cast for it. |
| **Requests received** | Requests made for it. |
| **Last played** | When it last played. |

> **Tip:** Compare **Requests received** with **From requests**. A popular song that rarely gets to play may have a long cooldown; see [Settings › Jukebox](help:settings-jukebox).

## Exporting

- **Export CSV** downloads the song table for the current range as a spreadsheet file.
- **Export PDF** downloads a report: the song table, and a second page with the visitor summary and the three charts.

## Reset stats

These take effect immediately and can't be undone, so export first if you want a record.

| Button | What it clears |
|---|---|
| **Reset Play History** | All play counts and last-played dates. |
| **Reset Votes** | All votes, current and past, and starts a fresh voting round. |
| **Clear Queue** | Every viewer request ShowPilot has kept, waiting or already played. Because **Requests received** is counted from these, it also sets those counts back to zero. |
| **Reset Everything** | All of the above. |

None of these touch Visitor Analytics or Phone Listeners. To start a new season with clean song stats while keeping a copy of the old one, export first, then reset.

> **Careful:** **Clear Queue** here is stronger than the one on the [Queue](help:queue) tab, which only removes requests that haven't played yet.
