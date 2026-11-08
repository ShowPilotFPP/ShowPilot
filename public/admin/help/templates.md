# Viewer page templates

Your viewer page, the page people open on their phones at your show, is built from a template. This guide explains how templates work, how ShowPilot fills them with live show info, and where to find every placeholder. To actually edit one, use **Viewer Page › Template Editor** (see [Template Editor](help:viewer-editor)).

## What a template is

A template is one complete web page. You can keep as many as you like, for example one per season, but only the **active** one is shown to viewers. You switch between them with **Set Active** in the Template Editor, or automatically on a date with [Scheduled Switches](help:viewer-schedule).

Every template is edited as a draft. Your changes show in the editor's **Live Preview** right away, but viewers only see them after you click **Save Changes**.

Some things apply to every template, so you set them once instead of in each page:

- seasonal animations and the song progress bar, on [Page Effects](help:viewer-effects),
- the look of the Listen-on-Phone player and button, on [Listen-on-Phone](help:viewer-phone),
- shared styles, on [Global CSS](help:viewer-globalcss),
- automatic translation, on [Translation](help:viewer-translation).

## Three ways to build one

- **Settings**: fill in a short form (show name, hours, colors, social links) and ShowPilot builds the whole page. The quickest start.
- **Blocks**: stack ready-made blocks such as Hero, Now Playing, Song List, Queue, Countdown and FAQ, then reorder them and change each one's settings. No code needed.
- **Code**: write or paste the page's HTML yourself, with placeholders where the live show info goes. This is how you use a template someone else made, including Remote Falcon templates, which work as they are.

A page you've edited in Code is "hand-built". For those, the **Sections** tab lets you move, hide and reword the parts of the page, and add ready-made blocks, without touching the code.

## Placeholders

A placeholder is a name in curly braces that ShowPilot replaces with live show info when the page loads. It keeps it up to date while visitors are on the page, with no refresh needed. Names are case-sensitive.

Some of the most used:

| Placeholder | Shows |
|---|---|
| `{NOW_PLAYING}` | The song playing now. |
| `{NOW_PLAYING_ARTIST}`, `{NOW_PLAYING_IMAGE}` | Its artist and cover art. |
| `{NOW_PLAYING_TIMER}` | Time left in the song. |
| `{NOW_PLAYING_PROGRESS}` | A progress bar with the time left. |
| `{NEXT_PLAYLIST}` | The song up next. |
| `{PLAYLISTS}` | The song list, with vote or request buttons depending on the mode. |
| `{JUKEBOX_QUEUE}` | The songs waiting to play. |
| `{LISTEN_BUTTON}` | A small Listen-on-Phone button inside your text. |
| `{SHOW_BUTTONS}` | Buttons visitors press to run an effect on your show. See [Show Buttons](help:settings-show-buttons). |

### Show / hide sections

Some placeholders go *inside an opening tag* and make that part of the page appear only when it applies, switching live when you change modes:

```
<div {jukebox-dynamic-container}>
  <h2>Pick a song:</h2>
  {PLAYLISTS}
</div>
<div {after-hours-message}>The show starts at 6 PM!</div>
```

There are ones for Voting, Jukebox, Race, the access code, visitor messages, show buttons and "show is off".

### Pop-up messages

Add hidden elements with special IDs, such as `requestSuccessful` and `requestFailed`, and ShowPilot shows them for a few seconds when a request or vote succeeds or fails.

### The full list

Every placeholder, show/hide section, pop-up message ID, song-list class, CSS variable and script call is on the [Template reference](/admin/template-reference.html) page. It also opens from the **📖 Template reference** link in the Template Editor, and has a search box.

## Tips

- **Duplicate before big changes.** Work on the copy, preview it, then **Set Active** when you're happy.
- **Lock finished templates.** The **Lock** button stops accidental edits, which is handy for a template you bought or spent hours on.
- **Preview with real data.** The preview uses your real songs and settings, so badges, cooldowns and the current mode look the way they will live. It shows the parts for the mode the show is in right now.
- **Placeholders work inside comments too.** ShowPilot replaces them everywhere, even in HTML comments. To mention one in a comment, leave off the braces.
- **Leave the braces alone in Sections.** When editing text in the Sections tab, words in curly brackets are live info; leave them exactly as they are.
- **Use Global CSS for shared looks.** Colors and fonts you want on every template belong in [Global CSS](help:viewer-globalcss), not copied into each page.
- **Check it on a phone.** Most visitors use one. Open the viewer page on your own phone after saving.
