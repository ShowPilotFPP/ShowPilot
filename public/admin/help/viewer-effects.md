# Viewer Page › Page Effects

Extra touches on top of whichever template is active: a seasonal animation across the whole page, and a bar showing how far into the song the show is. Each setting saves as soon as you change it.

## Page-wide effects

An ambient effect that drifts, falls or twinkles across the entire viewer page. It works with any template, so you don't have to edit your page to add snow in December.

### Effect

Choose **None** (the default), **❄️ Snow**, **🍂 Leaves**, **🎆 Fireworks**, **💗 Hearts**, **✨ Twinkling stars**, **🦇 Bats**, **🎉 Confetti**, **🌸 Petals**, **🔥 Embers**, **🫧 Bubbles** or **🌧️ Rain**.

Open viewer pages pick up a change within a few seconds, without a refresh.

> **Tip:** Visitors who have turned on their phone's or computer's reduce-motion accessibility setting see no effect at all. That's on purpose.

### Intensity

How much of the effect there is: **Subtle**, **Medium** (the default) or **Heavy**. Start with Subtle or Medium and check the page on a phone: a heavy effect can get in the way of reading the song list on a small screen.

### Color tint

Each effect has its own sensible color (snow is white, leaves are orange, hearts are pink, and so on). To change it, use the color picker or type any CSS color (for example `#ff7a00` or `gold`) in the box next to it. **Use default** clears your choice and goes back to the effect's own color.

## Song progress bar

A slim bar showing how far into the current song the show is, and how much time is left. It hides between songs, and for sequences with no known length. Changes reach open viewer pages within a few seconds.

### Show song progress bar on the viewer page

Turns the bar on for every template. Off by default.

> **Tip:** If you build your own template, you can instead place the bar exactly where you want it with the `{NOW_PLAYING_PROGRESS}` placeholder. See [Viewer page templates](help:templates).

### Position

- **On the player (bottom of the screen when it's closed)**, the default: the bar sits on the top edge of the Listen-on-Phone player. When the player is closed, it moves to the bottom edge of the screen.
- **Top of the screen**: the bar sits along the top edge of the page.

### Bar color

By default the bar matches the Listen-on-Phone player's theme (see [Listen-on-Phone](help:viewer-phone)). Pick a color to override it, or click **Match player theme** to go back to the default.

### Show time left next to the bar

Adds the time remaining (for example 2:41) beside the bar. On by default. Turn it off for a cleaner look.
