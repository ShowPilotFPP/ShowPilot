# Settings › Race

Settings for **Race** mode. In a race, viewers tap their favorite song as many times as they like, and the song with the most taps when the race ends plays next. Each song gets a live bar, so everyone can watch the race unfold.

To start a race, choose **Race** in the **Mode** dropdown on the [Dashboard](help:dashboard). A new race starts on its own every time a new song begins, with all taps set back to zero.

Every change saves straight away and applies from the next race.

## Race duration

How long each race lasts.

- **Race timer (seconds)** is the length of the race. Viewers see a shrinking bar and a countdown, and the bar turns red in the last 10 seconds. You can set 10 to 600 seconds; the default is **60**. When time runs out, the song with the most taps wins. If nobody tapped, there's no winner and your show carries on with its schedule.
- **End race when the current song ends (ignore timer)** drops the timer. The race stays open for the rest of the current song, and viewers see "Race ends with this song" instead of a countdown. When it's ticked, the timer setting is hidden. Off by default.

> **Tip:** A short race (30 to 90 seconds) creates excitement. Make sure it ends well before a typical song does, so the winner is ready in time.

## Win condition

**First to reach this many taps wins immediately** ends the race the moment any song reaches this many taps, even with time left. You can set 0 to 9999. The default is **0**, which turns it off: the race always runs until the timer, or the song, ends.

Pick a number your crowd can reach. Too high and it never triggers; too low and the first enthusiastic tapper wins on their own.

## Winner playback

**Interrupt current song and play winner immediately** cuts off the song that's playing and starts the winner straight away. Off by default: the winner plays after the current song finishes, like in Voting mode.

Once a winner is decided, taps are turned away until the next song starts and a new race begins.

> **Careful:** Interrupting cuts songs off part-way, which can feel abrupt to people watching. It works best with short races and an audience that's mainly there to play.

## Viewer instructions

The text shown to viewers above the tap buttons during a race. It saves as you type. Plain text only; HTML isn't allowed.

Leave it blank to use the default: "Tap your favorite song as many times as you want — most taps wins!"

## Instruction font size

**Font size (CSS value)** sets the size of the instruction text. Use any CSS size, for example `0.9em`, `14px` or `1rem`. The default is **0.9em**. Leave it blank to go back to the default.

## Race styling

**Use template CSS for race UI (skip ShowPilot's built-in race styles)** stops ShowPilot adding its own look for the race rows, bars and buttons, so your template's CSS controls them entirely. Off by default: ShowPilot adds sensible styles that work with any template.

Only turn this on if your template already styles the race. The parts you'll need to style include `.race-row`, `.race-song-name`, `.race-tap-count`, `.race-bar-track`, `.race-bar-fill`, `.race-tap-btn` and `.race-instructions`. See [Viewer page templates](help:templates).

> **Careful:** With this on and no race styles in your template, the race shows as plain, unstyled text and buttons.
