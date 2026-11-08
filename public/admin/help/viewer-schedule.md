# Viewer Page › Scheduled Switches

Switch the viewer page to another template at a set date and time, once or every year. A switch can also restore a sequence snapshot and change the viewer mode, so one entry can change your whole season: new page, new song list, new mode. Open viewer pages switch live, without a refresh.

> **Tip:** A typical setup: a Halloween template that switches on every year on October 1, and a Christmas template that switches on the fourth Thursday of November (Thanksgiving) at 6 PM.

## Show time zone

The time zone your switch times are in. **Server's zone** (the default) uses the clock of the machine ShowPilot runs on, which may not be your local time. If your browser is in a different zone, a tip next to the box suggests picking it.

Set this once to the zone your show is in, and every switch happens at your local time. Daylight-saving changes are handled for you. Changing the zone recalculates the upcoming switches.

## The list of switches

Each switch shows the template it switches to, its rule (for example "Every year on the fourth Thursday of November at 6:00 PM"), anything else it does, and its status:

- **Next:** when it will run next.
- **Done** (with when it ran): a one-time switch that has already happened.
- **Off**: turned off.

Buttons on each switch:

- **Edit** opens it in the form below.
- **Run now** does everything the switch does, right away, after you confirm. The viewer page changes immediately for everyone watching. Its schedule isn't affected.
- **Delete** removes it after you confirm.

## Add a scheduled switch

Click **Add a scheduled switch** to open the form.

### Switch to

The template to make active. The one that's active now is marked **(active now)**. The switch puts that template's last saved version live, so finish and save it in the [Template Editor](help:viewer-editor) first.

### When

- **Once, on a date**: pick a date.
- **Every year, on a date**: pick a month and a day. A switch set for February 29 runs on February 28 in other years.
- **Every year, on a weekday (e.g. Thanksgiving)**: pick **first**, **second**, **third**, **fourth** or **last**, a weekday, and a month.

Then set the time after **at** (18:00 to start with). Times use the show time zone above.

### Also restore

Optionally restores a sequence snapshot at the same moment, so the song list changes with the page. Choose **No snapshot** to leave your sequences alone. Snapshots are made on the [Sequences](help:sequences) page.

### and set the mode to

Optionally switches the viewer mode: **Voting**, **Jukebox**, **Race**, **Listen only** or **Off**. **(don't change)** leaves the mode as it is. See [How ShowPilot works](help:how-it-works) for what each mode does.

### Enabled

On by default. Untick it to keep the switch but stop it from running.

Click **Save** to add it, or **Cancel** to close the form. If something's wrong, a message appears above the buttons, for example when a one-time date and time has already passed.

## Good to know

- A one-time switch turns itself off after it runs.
- If ShowPilot wasn't running when a switch was due, it runs as soon as ShowPilot is back. If several were missed, only the latest one is applied.
- If you delete a template a switch uses, the switch shows **(deleted template)** and is skipped. Edit it to pick another template.

> **Careful:** A switch that sets the mode changes it for everyone straight away, even in the middle of a show. Pick a time before your show starts.
