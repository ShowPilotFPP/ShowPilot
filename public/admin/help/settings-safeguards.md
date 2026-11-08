# Settings › Interaction Safeguards

Controls who can vote, request songs and tap in races, and adds public service announcements (PSAs) to your show. These settings also set your show's location, which the audio distance gate in [Settings › Audio](help:settings-audio#audio-distance-gate) uses.

The checks on this page apply when a viewer votes, makes a jukebox request, taps in a race or sends you a message. Viewers can still open your page and see what's playing.

## PSA injection

PSAs are short sequences you play between songs: tip-jar reminders, your FM frequency, safety messages, sponsor thanks. Turn on **Inject PSAs into the show** and ShowPilot slips one in every so often.

First, mark one or more sequences as a PSA on the [Sequences](help:sequences) page. Each time a PSA is due, ShowPilot picks the PSA that has gone the longest without playing, so several PSAs take turns.

### When to fire

Choose how ShowPilot counts toward the next PSA:

| Option | How it counts | Best for |
|---|---|---|
| **After every N viewer interactions (votes / requests)** | Each vote or jukebox request adds one. After N of them, the next viewer-driven play is replaced with a PSA. | Shows where most songs are picked by viewers. |
| **After every N sequences played** | Each song your show player starts adds one. PSAs themselves don't count. | Shows that mostly run their own playlist and want regular reminders whether or not anyone is voting. |

> **Careful:** In interactions mode, if nobody is voting or requesting, PSAs never play. If you want them on a schedule, use sequences mode.

### Frequency

The N in the option above: how many interactions, or how many songs, between PSAs. The default is **5**, and you can set 1 to 100. A viewer changing their vote doesn't count as a new interaction.

> **Tip:** PSAs never play while the viewer mode is **Off** or **Listen only**. The count keeps going in the background, so PSAs pick up again when you switch back.

## GPS proximity check

Turn on **Require viewers be within radius of show location** so only people near your display can vote, request or tap. When a viewer tries, their phone asks for permission to share its location; if they're too far away, or refuse, they get a message instead.

- **Show latitude** and **Show longitude** are your display's position.
- **Radius (miles)** is how close viewers must be. The default is **0.5**; you can set 0.1 to 50.

You don't have to type the coordinates yourself:

- Type your address in the box and press **Find Coordinates**. ShowPilot looks it up and fills in both fields.
- Or, standing at your display with a phone or laptop, press **Detect My Current Location** and allow the browser to use your location.

The **Location preview** map shows the point and the radius, so you can check the circle covers your street and viewing area.

> **Important:** If the check is on but no show location is set, every vote and request is refused. Set the coordinates before you turn it on.

> **Tip:** Phone location indoors or in a car can be off by a few hundred feet. A radius a little bigger than your viewing area avoids turning away people who are really there.

The same coordinates are used by the audio distance gate on [Settings › Audio](help:settings-audio#audio-distance-gate), even if this check is off.

## Location code

Another way to make sure viewers are really at your show: put a code on a sign in your yard, and viewers must enter it before they can vote or request.

- Turn on **Require viewers to enter a code to interact**.
- Type the code in **Access code**, for example `1234`.

Your viewer page needs a place to type the code. Add these to your template:

- `{LOCATION_CODE}` shows the code input box. It shows nothing while the code is off.
- `{location-code-dynamic-container}` goes inside an element's opening tag, so that element (for example, a heading that says "Enter the code from the sign") only shows while the code is on.

See [Viewer page templates](help:templates) for how placeholders work.

> **Careful:** If the code is turned on but **Access code** is empty, nobody is asked for a code and everything is let through.

> **Tip:** Change the code now and then, so people who saw it once can't keep using it from home.

## IP blocking

**Blocked IPs** stops specific internet addresses from voting, requesting, tapping in races or sending messages. Blocked viewers can still open your page. Separate addresses with commas.

ShowPilot compares each viewer's address with the list exactly, so enter every address you want to block in full.

> **Careful:** Many phones on the same mobile network, or everyone on a shared Wi-Fi, can share one address. Blocking it can block innocent viewers too.

## View-source deterrent

Turn on **Enable view-source deterrent on viewer page** to discourage visitors from copying your viewer page, for example a template you bought from a creator. With it on:

- the usual keyboard shortcuts for viewing source and developer tools do nothing,
- right-clicking the page is disabled,
- anyone who views the page source sees a friendly "nothing to see here" note instead of your template.

Viewers see and use your page as normal. The Template Editor's preview isn't affected.

> **Important:** This only stops casual snooping. Someone determined can still open the browser's developer tools from its menu and see the page. Don't rely on it to protect a license.
