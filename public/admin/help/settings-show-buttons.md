# Settings › Show Buttons

Buttons on your viewer page that visitors press to run something on your show while it plays. A button can start an FPP effect on top of the running sequence, run an FPP command preset, or run an FPP script. Use them for props a crowd will love to set off: a fog machine, a flood light, a strobe, a snow machine, an animatronic.

The buttons only appear where your template has the `{SHOW_BUTTONS}` placeholder. In the Visual Designer, add the **Show Buttons** block instead. See [Viewer page templates](help:templates).

Every change saves straight away, and open viewer pages update within a second or two.

## Turning them on

**Show the buttons on the viewer page** turns the whole feature on or off. Off by default.

**Buttons work** decides when visitors can press them:

- **Only while a song is playing** (the default) hides the buttons between songs and when the show is over.
- **Any time (also between shows)** keeps them working while nothing plays, for example to light a prop on a dark display.

The buttons are always hidden while viewer control is **Off** on the [Dashboard](help:dashboard), and while the FPP plugin isn't connected.

**Each visitor waits between presses (seconds)** stops one person from pressing every button over and over. You can set 0 to 600; the default is **10**.

**Heading above the buttons** is the text shown over the row of buttons. Leave it empty for no heading.

**Layout** is **A row that wraps** (buttons side by side, wrapping onto new lines on a phone) or **Two columns**, which suits four or more buttons.

## Buttons

Each button in the list shows how it looks, what it runs and how long it waits after a press. Use the arrows to change the order on the page, **Edit** to change it, and **Delete** to remove it.

**Test** runs the button on your show straight away, ignoring its wait, so you can check your prop works. Buttons must be turned on for the plugin to pick it up.

### Adding a button

Choose **+ Add a button**, then fill in:

| Setting | What it does |
|---|---|
| **Label** | The text on the button, up to 40 characters. |
| **Emoji (optional)** | Shown before the label, such as 💨 or 💡. |
| **Color** | The button's color. Tick **Page default** to use red, or a color your template sets. |
| **What it does** | **FPP effect (.eseq)**, **FPP command preset** or **FPP script**. See below. |
| **Wait after a press (seconds)** | After anyone presses it, the button is greyed out for everyone for this long, with a countdown. 0 to 3600; the default is **30**. |
| **On (shown on the page)** | Untick to hide this one button without deleting it. |

### What a button can run

- **FPP effect (.eseq)**: enter the effect's file name as FPP shows it in **Content Setup › File Manager › Effects**, for example `Flood.eseq`. The effect plays once on its own channels, on top of whatever sequence is playing, then those channels go back to the sequence. Export effects from xLights as an FPP effect (`.eseq`).
- **FPP command preset**: enter the name of a preset from FPP's **Content Setup › Command Presets**. A preset can hold any FPP command, so this is the most flexible choice: an overlay model effect, turning a GPIO output on, or a script with arguments.
- **FPP script**: enter a script's name from FPP's **File Manager › Scripts**, for example `fog_on.sh`.

> **Important:** If the playing sequence also lights the prop's channels, the effect takes them over while it runs, so the prop stops following the music for a moment. Buttons work best with props your sequences leave dark.

> **Tip:** A flood light is a good first test. In FPP, make a preset called "Flood Off" with **Overlay Model State** set to **Disabled** for the light's model. Then make a preset called "Flood On" with two commands: **Overlay Model Fill** on the light's model, and **Trigger Command Preset In Future** running "Flood Off" a few seconds later (FPP counts that wait in milliseconds, so 5000 is 5 seconds). Point the button at "Flood On".

## How a press reaches your show

When a visitor presses a button, ShowPilot checks its wait and the visitor's own wait, then holds the press for the FPP plugin. While buttons are on, the plugin checks for presses about twice a second and runs each one in FPP. A press usually reaches the show within a second. A press the plugin doesn't pick up within 15 seconds is dropped rather than firing late.

Access codes and location checks from [Interaction Safeguards](help:settings-safeguards) apply to the buttons too, as does the blocked IP list.
