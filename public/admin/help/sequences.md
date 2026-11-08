# Sequences

Your song list. Here you choose what viewers see for each sequence (name, artist, cover art, category, badge), what they can vote for or request, and how long a song rests after it plays. The list itself comes from your show player: see [Connecting your show player](help:fpp-plugin).

## Where the list comes from

There is no sync button on this page. Each time the FPP plugin syncs, ShowPilot updates the list from your show player's playlist:

- New sequences are added, visible and switched on for voting and the jukebox.
- Your own display names, artists and cover art are kept. A sync only fills in a name, artist or cover that is still blank (or still the raw file name).
- A sequence that is no longer in the playlist becomes **Inactive**: it keeps all its details but is hidden from viewers, and its pending requests and votes are cleared. It becomes active again, details intact, when the playlist lists it again.

The count next to the title shows how many are active and inactive.

> **Tip:** If a yellow note says a song is listed more than once in your playlist, ShowPilot still shows it once, and requests and vote winners play the first copy. Remove the extra copy on your show player if that's not what you want.

## The table

| Column | What it does |
|---|---|
| **Status** | Green dot: in your show player's playlist. Red: inactive. |
| **Art** | Click to add or change the cover (see below). |
| **Display Name** | The title viewers see. Click and type to edit; it saves when you click away. |
| **Sequence Name** | The name on your show player. Read-only. |
| **Playlist #** | Position in the playlist from the last sync. Hidden by default. If the wrong song plays, check this matches your playlist and sync again. |
| **Artist** | Click and type to edit. |
| **Category** | Groups the song on the viewer page. Pick **+ New category…** to create one on the spot. The funnel button next to it filters the list to that category. |
| **Badge** | A short label such as New or Fan Favorite. Pick **Custom…** for your own text (up to 24 characters). Badges only show if you turn them on (see Categories below). |
| **Visible** | Listed on the viewer page. |
| **Vote** | Can be voted for in Voting mode. |
| **Jukebox** | Can be requested in Jukebox mode. |
| **PSA** | Played as an announcement between songs and never listed for viewers. |
| **Cooldown** | How long after this song plays before viewers can pick it again (minutes, or songs, depending on [Settings › Jukebox](help:settings-jukebox)). Leave it empty to use the category's or the show's cooldown; the faded number shows what applies. **0** means it never cools down. |

Drag the **⋮⋮** handle to change the order songs appear in here and on the viewer page. This never changes what your show player plays: picks are always matched to the playlist by name.

### Row buttons

- **Play** previews the song's audio in your browser (not on the show speakers). Click again to stop. Hover to see whether it's playing from ShowPilot's audio cache or through the show player.
- **Search** looks the song up online and lets you pick the right match. Clicking a result sets the display name, artist and cover in one go. If the first results are wrong, add or remove the artist and search again.
- **Languages** (only for songs with an audio file) lets you upload an alternate-language audio track. Phone listeners then get a language choice. The file must be exactly as long as the original, or it won't stay in sync.
- **Delete** removes the sequence from ShowPilot. The file on your show player isn't touched, so if the song is still in the playlist it comes back, with default details, at the next sync.

### Cover art

Clicking the art opens a cover picker. It searches automatically using the title and artist; click a cover to use it. You can also **Use URL** to download an image from a web address, **Choose image…** to upload one (JPEG, PNG, GIF or WebP, up to 10 MB, square works best), or **Remove** the cover.

## Search, filters and view options

- **Search sequences…** matches display name, sequence name, artist and category.
- **All**, **Active**, **Inactive** and **Hidden** (Visible switched off) filter the list, with counts.
- A row of category pills appears once songs have categories. Categories that are off, or outside their schedule right now, are marked; hover a pill to see why.
- **Compact rows** fits more songs on screen. **Icon switches** shows Visible, Vote, Jukebox and PSA as small icons (lit = on).
- **Columns ▾** shows, hides and reorders columns and the row buttons. **Reset columns** goes back to the default. Hidden columns keep their values.

These view choices are remembered in your browser.

## Changing many songs at once

Tick the boxes on the left (the header box selects every row the current filter shows). A toolbar appears with **Show**, **Hide**, **Set category…**, **Set badge…**, **Cooldown…**, **Re-scrape titles**, **Delete selected** and **Clear** (deselect).

## Buttons at the top

| Button | What it does |
|---|---|
| **Fetch Covers** | Looks up covers for every song that has none. Runs in the background, about a second per song. |
| **Auto-Fill Song Info** | Looks up a clean title and artist for every song from its file name. |
| **Sort A→Z** | Orders the list alphabetically by display name. Only the display order changes. |
| **Import CSV** | Updates songs from a ShowPilot or Remote Falcon sequence CSV. |
| **Export CSV ▾** | **ShowPilot (all fields)** is a full copy of the list including switches and cooldowns. **Remote Falcon format** has the six columns Remote Falcon uses. |
| **Delete Inactive** | Deletes inactive songs, plus any switched off everywhere (not visible, votable, jukebox or PSA). |
| **Delete All** | Deletes every sequence, with its play history, votes and queue. You must type DELETE ALL to confirm. Sync again afterwards to start fresh. |

> **Careful:** **Auto-Fill Song Info** and **Re-scrape titles** overwrite display names and artists you typed yourself. For one song, use the row's **Search** button instead.

**Importing:** rows are matched to your songs by sequence name. ShowPilot first tells you how many match. Blank cells in the file never overwrite anything. If the file has songs you don't have yet, you can choose to add them as Inactive; they become active, with the imported details, once your playlist includes them.

Below the table, **Add Sequence** adds a song by hand. The sequence name must match the name on your show player exactly.

## Categories

Categories group songs under headings on the viewer page. Each category row has:

- an on/off switch: off hides all its songs from viewers and blocks votes and requests for them (your show player's own schedule is not affected),
- a **Cooldown** for its songs (empty = the show's cooldown; a song's own cooldown wins),
- **Add schedule** / **Schedule**: show the category only on chosen days and times, in the show's time zone. Outside the schedule it behaves as if switched off. A time range can run past midnight,
- **Rename** and **Delete** (its songs become uncategorized, not deleted),
- a drag handle to set the order of headings on the viewer page.

Songs with no category are always shown. Display options:

- **Show category headings on the viewer page**. With headings off, categories still control visibility but the list keeps its normal order.
- **Heading for uncategorized sequences** is the heading those songs get.
- **Show badges on the viewer page**, **Badge position**, **Badge color** and **Text color** control how badges look; the preview updates as you change them.
- **Dim songs that are already in the request queue** helps viewers spot what's already coming up.

## Sequence Snapshots

A snapshot saves your whole list (display names, artists, order, visibility and so on) so you can bring it back later, for example a Halloween setup you restore next year. Enter a name and optional description, then **Save Snapshot**.

**Restore** updates your songs to the snapshot's values, adds back songs that no longer exist, and hides songs that aren't in it. Play history, votes and the queue are kept. **Rename** and **Delete** only affect the snapshot, never your current list.

> **Tip:** Save a snapshot before big changes like **Auto-Fill Song Info** or an import. For a backup of everything, see [Backup & Restore](help:settings-backup).
