# Viewer Page › Template Editor

This is where you build and edit the page your viewers see. You can keep several templates (say, one for Halloween and one for Christmas), but only one is live at a time. For how templates and placeholders work in general, see [Viewer page templates](help:templates).

## Templates list

The list on the left shows every template. Click one to open it. Badges show its state:

| Badge | Means |
|---|---|
| **ACTIVE** | The template viewers see right now. |
| **BUILT-IN** | Comes with ShowPilot. You can edit it, but you can't delete it. |
| 🔒 | Locked against edits (see [Lock](help:viewer-editor#lock)). |

The buttons above the list work on the selected template:

- **+ New** asks for a name and creates a simple starter page with the song list, queue and the basic pop-up messages.
- **Duplicate** makes a copy called "(copy)". The copy keeps the same editing mode, settings and blocks. Duplicate a template before big changes so you can always go back.
- **Set Active** makes the selected template the live viewer page. Open viewer pages switch to it straight away, without a refresh.
- **Delete** removes the template after you confirm. You can't delete the active template, a built-in one or a locked one.

> **Tip:** **Set Active** puts the template's last *saved* version live, not unsaved changes. Click **Save Changes** first.

> **Tip:** To change templates automatically on a date (for example, Halloween to Christmas on November 1), use [Scheduled Switches](help:viewer-schedule).

## Name, lock and favicon

- The name box at the top renames the template. The new name is saved when you click **Save Changes**.
- The **SAVED** / **UNSAVED** badge tells you whether you have changes that aren't live yet.
- **Custom favicon for viewer page** (click to open) sets the small icon shown in the browser tab. **Upload** a square image under 150 KB, or paste an address in **Or URL**. **Remove** clears it. It's saved with **Save Changes**. Browsers hold on to favicons, so viewers may need a hard refresh to see a new one.

### Lock

**🔓 Lock** protects a finished template. While it's locked, a banner says so and you can't edit, save, rename or delete it. You can still look at it, preview it and make it active. Click **Unlock** to edit again.

## The four ways to edit

The tabs above the editor give you different ways to work. Which ones you see depends on how the template was made.

### ⚙️ Settings

A simple form that builds a complete page for you: **Show name (big title)**, **Subtitle**, **Intro text**, **FM frequency**, two lines of **Show Hours**, four colors (**Background top**, **Background bottom**, **Primary / accent**, **Text**), an optional **Background image URL**, and **Social Links**. Good for getting a page up quickly without designing anything.

### 🧱 Blocks

The Visual Designer. Pick blocks from **+ Add Block** on the left (Hero, Now Playing, Song List, Queue, Countdown, FAQ, Sponsors, Image and many more) and they appear in **Page Layout**. Drag a block by its header, or use ▲ and ▼, to reorder. Click a block's header to open its settings. × removes it.

Blocks marked **✓ On page** are already there. Some blocks only make sense once per page, and ShowPilot asks before adding a second one. The page's background and text colors come from the **Settings** tab.

> **Careful:** Settings and Blocks each build a whole page. The page shows whichever of the two you changed last, so stick to one of them for a given template.

### ⌨️ Code

The full HTML of the page, in a code editor. Use it to paste in a template you got from someone else, or to hand-build a page with placeholders like `{NOW_PLAYING}` and `{PLAYLISTS}`. The full list is on the **📖 Template reference** page (the link is at the right of the tabs, or open the [template reference](/admin/template-reference.html) from here).

**📄 Load from file…** replaces this template's code with an .html file from your computer (up to 2 MB). It becomes an unsaved change: check the preview, then save or discard it.

> **Important:** Once you edit a page in **Code**, it counts as hand-built. The **Settings** and **Blocks** tabs are hidden for it, because using them would replace your page. The **Sections** tab appears instead. To build with Settings or Blocks again, click **+ New**.

### 🧩 Sections (beta)

For hand-built pages only. It lists the parts of your page from top to bottom, so you can make changes without touching code:

- ↑ and ↓ move a part; 👁 hides it from visitors (it stays in the page so you can show it again); ⧉ duplicates it; 🗑 removes it.
- ✎ (or clicking the name) opens the part's text in plain boxes you can type in. **Edit HTML of this section** is there for anything else.
- **＋ Add block here** inserts a ready-made block from the Blocks library between two parts.
- **↶ Undo** steps back through your changes.
- **Show scripts & pop-ups** also lists the page's scripts, styles and pop-up messages, which are kept in place.

Tags on each part show when it appears, such as **Voting only**, **Jukebox only** or **Show off only**, and **Live info** for parts filled in by the show.

> **Tip:** Words in curly brackets, like `{NOW_PLAYING}`, are filled in with live show info. Leave them as they are.

## Live Preview, Save Changes and Discard Changes

Every edit is kept as an unsaved draft and shown in **Live Preview** on the right, using your real songs and settings. Viewers don't see any of it until you click **Save Changes**. **Discard Changes** throws the draft away and goes back to the last saved version. Drafts are kept on the server, so a draft you started in another browser shows up here as unsaved too.

The ↻ button reloads the preview. **Open viewer page →** opens the live page in a new tab.

> **Careful:** The preview runs your template's own scripts. If a script gets stuck, the preview can freeze this page. Next time you open it, ShowPilot shows **Preview paused** instead, with **Discard unsaved changes** and **Load preview anyway**. Your live viewer page isn't affected by an unsaved draft.

## Keeping a copy of a template

There's no separate export button. To keep a copy, open **Code**, select all and paste it into a file on your computer. To bring it back, use **📄 Load from file…** on a new or duplicated template. Templates are also included in your [backups](help:settings-backup).
