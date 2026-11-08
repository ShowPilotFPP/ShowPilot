# Viewer Page › Global CSS

One stylesheet that loads on every viewer page, whichever template is active, and in the Template Editor's preview too. Use it to keep a season's colors and fonts in one place across several templates, or for a small fix you want everywhere without editing each template.

## How it fits with your templates

Global CSS loads *before* the template's own styles. So when both set the same thing, the template wins. If a rule here seems to do nothing, the template is probably setting the same property itself. Make your rule more specific, or change it in the template.

A good use is setting CSS variables once, then using them in your templates:

```
:root { --show-accent: #ff7a00; }
body { font-family: 'Creepster', cursive; }
```

ShowPilot's own parts (the Listen button, the progress bar, the message box, the winner announcement) have CSS variables you can set here too. They're listed under **CSS variables** on the [template reference](/admin/template-reference.html) page.

## Use the global CSS on viewer pages

The on/off switch, on by default. It saves the moment you tick or untick it, so it doubles as a quick off switch: untick it and pages go back to their own styles at once. Your CSS is kept while it's off.

## The CSS box and Save

Type or paste your CSS in the big box, then click **Save**. Open viewer pages pick it up the next time they load, and the preview in the Template Editor refreshes. The limit is 512 KB, far more than you'll need.

**📄 Load from file…** puts a .css file from your computer into the box (up to 512 KB). It isn't live until you click **Save**.

## ↶ Restore previous

Goes back to what was saved before your last **Save**, after you confirm. Clicking it again swaps back, so a restore can be undone. It's greyed out when there's no earlier version to go back to.

> **Tip:** If a change breaks your pages, untick **Use the global CSS on viewer pages** first to get viewers back to normal right away, then fix the CSS or use **↶ Restore previous**.

## Good to know

- Global CSS is saved in ShowPilot's database, so it survives updates and is included in [backups](help:settings-backup).
- It applies to every template. For styles that belong to one template only, put them in that template instead (see the [Template Editor](help:viewer-editor)).
- Only CSS goes here, not HTML or scripts.
