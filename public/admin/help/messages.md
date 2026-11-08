# Messages

Visitors can send you a short message from your viewer page: a thank-you, a song suggestion, a shout-out. Messages are private, only you see them here, unless you turn on the **Message wall** to show some of them on the page.

Messages are off until you turn them on, and the message box only appears where your template has the `{MESSAGE_BOX}` placeholder. See [Viewer page templates](help:templates).

## Visitor messages

The list of messages you've received, newest first. Unread messages have a colored edge and say **new**. Each one shows when it arrived, the name the visitor typed (or **No name**), and **words hidden** if the word filter masked something.

Each message has:

- **Mark read** / **Mark unread**.
- **Delete** (asks first).
- **Show on wall** / **Take off wall**, only on messages whose sender ticked the box to have it shown. A pill says **Wants to be on the wall** or **On the wall**.

At the top:

| Control | What it does |
|---|---|
| **Show** list | **All messages**, **Unread only**, **Waiting for the wall** (asked to be shown, not approved yet) or **On the wall**. |
| **Refresh** | Reloads the list. |
| **Mark all read** | Marks every message read. |
| **Export CSV** | Downloads your messages as a spreadsheet file. |
| **Delete read** | Deletes every message you've already read. This can't be undone. |

The list loads 100 at a time; **Show more** loads the next 100.

> **Tip:** You don't have to keep this tab open. The **Messages** tab shows an unread count, and the Dashboard shows a banner when new messages arrive.

## Settings

### Accept messages from visitors

The master switch. Off by default. While messages are off or closed (see **When** below), the message box is hidden from the viewer page.

### Look of the box

- **Accent color** is the box's highlight color. **Use default** goes back to the standard one.
- **Box style**: **Dark card (for dark pages)** or **Light card (for light pages)**. Pick the one that matches your template.
- **Dark page** / **Light page** only change the background behind the preview, so you can see how the box sits on either.

The preview shows how visitors will see the box; you can type in it to try it. The box keeps its own card on any template. Template authors can restyle it with CSS; the settings card lists the class and variables to use.

### When

- **Only while the show is on** (default): the box is open while viewer control isn't off and a song is playing or played recently.
- **Any time**: always open.

**Close the box this many minutes after the last song** covers the gaps between songs when you use **Only while the show is on**. The default is **15**; you can set 1 to 120.

### Limits

| Setting | Default | What it does |
|---|---|---|
| **Longest message (characters)** | 280 | From 20 to 1000. |
| **Minutes between messages (per visitor)** | 2 | How long one visitor must wait before sending another. 0 = no wait. |
| **Most messages per visitor per night** | 5 | 0 = no limit. A "night" is the last 12 hours. |

ShowPilot also has its own built-in limits against floods of messages, so one person can't fill your inbox.

If you've turned on the access code or the "viewer must be at the show" location check in [Interaction Safeguards](help:settings-safeguards), visitors have to pass it to send a message too.

### Hide bad words

**Hide bad words** is on by default. Matching words are replaced with `***` rather than rejected, so the visitor can't test what gets through.

The list below is the words to hide, one per line. End a word with `*` to also catch longer words that start with it (for example `fudge*` also catches "fudges"). Common disguises are caught automatically: numbers or symbols for letters, stretched or spaced-out letters, and accented or fancy letters. So list each word once, spelled normally.

Click **Save word list** after editing. **Reset to the built-in list** replaces your list with ShowPilot's default one.

## Message wall

Shows visitors' messages on your viewer page. Add `{MESSAGE_WALL}` to your template where they should appear. The wall hides itself while it's empty.

While the wall is on, the message box gets a **Show my message on this page** checkbox. Only messages sent with that box ticked can ever appear on the wall; everything else stays private.

- **Show messages on the viewer page** turns the wall on.
- **Before a message shows**: **I approve each one first (recommended)**, or **Show it automatically**. Automatic still masks words from your list, and you can take any message off the wall from the list above.
- **Layout**: **Cards**, **Chat bubbles** or **Scrolling ticker**. The preview above shows the wall in the layout you pick, with sample messages.
- **How many to show**: the newest 1 to 30 messages. The default is 8.

> **Careful:** With **Show it automatically**, anything a visitor writes appears on your page right away, apart from words on your list. For a family audience, approving each one first is safer.
