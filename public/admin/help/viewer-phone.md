# Viewer Page › Listen-on-Phone

How the Listen-on-Phone player and its button look on your viewer page. These settings are only about appearance. Whether phone audio is on, the distance gate, sync offset and the listener timing button live in [Settings › Audio](help:settings-audio). For the whole picture, see [Phone audio, start to finish](help:phone-audio).

All settings here save as soon as you change them. They're separate from the admin's own theme: viewers see what you pick here.

## Listen-on-Phone Player Decoration

### Decoration theme

Dresses up the audio player bar with seasonal decorations. Choose **None** (the default) or one of the themes: New Year's, Lunar New Year, Valentine's, Mardi Gras, St. Patrick's, Easter, Independence Day, Halloween, Día de los Muertos, Diwali, Thanksgiving, Hanukkah, Christmas, Kwanzaa, or **Snow (winter generic)**.

Two themes move with the show: **New Year's Live** (the mirror ball reacts to the music) and **Christmas Live** (the string lights react to the music).

> **Tip:** Pair the player theme with a matching [page effect](help:viewer-effects) for a consistent seasonal look.

### Custom player bar color

Only shown, and only used, when **Decoration theme** is **None**. Handy when you have a themed viewer page and want the player to match it.

- **Solid color**: pick a color, or type one (for example `#1a1a2e`).
- **Gradient**: pick a **Top** and **Bottom** color and a **Direction** (top to bottom, bottom to top, left to right, right to left, or one of two diagonals).

The **Preview** shows how the bar will look. **Reset to default** goes back to the standard dark player.

### Enable animations (twinkle, fall, drift)

Lets the decorations move. On by default. Turn it off if you want the decorations to stay still.

### Larger two-row player on phones

On phones, the player uses two rows: the full song title and artist on top, with bigger, spread-out controls below. It's easier to tap but covers a little more of the page. Tablets and computers keep the single row. Off by default. Takes effect when viewers reload the page.

## Audio Sync Help

**Show the audio sync help panel** shows or hides the help for listeners whose audio doesn't line up with the lights. That's the **Audio Sync Help** block (add it to your page in the Template Editor's Blocks or Sections tab), plus any part of a hand-built template marked with `data-showpilot-sync-help`. On by default. The help only appears when Listen on Phone is on and **Let listeners adjust audio timing** is on in [Settings › Audio](help:settings-audio#let-listeners-adjust-audio-timing). Takes effect when viewers reload the page.

## Listen-on-Phone Launcher Button

The floating button viewers tap to open the audio player. Changes take effect when viewers reload the page, except the colors, which reach open pages within a few seconds.

### Icon

Pick **Default (headphones emoji)**, one of the built-in icons (headphones, Christmas tree, pumpkin, ghost, snowflake, music notes, heart, shamrock, star), or **Custom image…**.

With **Custom image…**, an **Upload icon** box appears. Choose a PNG, JPG, SVG or WebP under 250 KB. It's saved straight away and shown below. **Clear custom icon** removes it. Square images work best.

### Show round button background

- **On** (the default): the classic round button with the icon inside.
- **Off**: just the icon. Your image becomes the button, so pick one that clearly looks tappable. A transparent PNG works best.

### Button color and Icon color

The defaults are red and white. **Use default** next to each puts it back.

- **Icon color** only changes the built-in icons. Emoji and uploaded images keep their own colors.
- With the round background off, only the icon color is used.

> **Tip:** Template authors can also set `--sp-launcher-bg` and `--sp-launcher-fg` in their CSS. Colors you choose here win over the template's.

### Size

**Small (40 px)**, **Medium (52 px)** (the default) or **Large (72 px)**. The preview under it shows how viewers will see the button.

> **Tip:** Want a Listen button inside your page text as well? Put `{LISTEN_BUTTON}` in your template. See [Viewer page templates](help:templates).
