# Viewer Page › Translation

Automatically shows your viewer page in each visitor's own language, based on their browser's language setting. Useful if many of your visitors speak another language. Song names and artist names are never translated.

## How it works

When a visitor opens your page, ShowPilot looks at the languages listed in their browser settings, skips English, and translates the page's text into the first other language on the list. Visitors whose browser lists only English get your page as it is.

Each translation is done once per language for each version of a template, then saved. The first visitor in a new language waits a moment while it's translated; everyone after that gets it instantly.

> **Important:** Translation assumes your template is written in English. MyMemory in particular always translates from English.

> **Tip:** The preview in the [Template Editor](help:viewer-editor) is never translated, so you always see your page as you wrote it. To check a translation, open your viewer page in a browser set to another language.

## Enable automatic translation

Turns translation on or off. Off by default. When you turn it on, the backend settings below appear. It saves as soon as you tick or untick it.

## Translation backend

The service that does the translating. Your page's text is sent to it.

| Backend | Good for |
|---|---|
| **MyMemory (free, no setup required)** | The default. Nothing to set up. |
| **LibreTranslate (self-hosted)** | If you run your own LibreTranslate server. |
| **DeepL (higher quality, free tier)** | Better-sounding translations. Needs a free DeepL API key. |

### LibreTranslate settings

- **LibreTranslate API URL**: the address of your LibreTranslate server. If left blank, the public LibreTranslate address is used.
- **API key**: only if your server requires one. Leave it blank otherwise.

### DeepL settings

- **DeepL API key**: your key from DeepL's free developer plan. The free plan allows 500,000 characters a month. Each language is translated once per template version and then saved, which keeps usage down.

> **Careful:** LibreTranslate and DeepL share one key setting. If you switch between them, enter the right key for the new backend.

## 🧪 Test translation

Sends the words "Now playing" to your chosen backend and asks for Spanish. If it works you see **✓ Working** with the result. If not, you see what went wrong, for example a missing DeepL key. Translation must be enabled for the test to run.

## Translation Cache

The table lists every saved translation: the template, the language, its size and when it was made.

- **Clear** on a row deletes that one translation. It's rebuilt the next time a visitor in that language opens the page.
- **Clear All** deletes every saved translation, after you confirm.

You don't normally need to clear anything. Saving changes to a template makes its old translations out of date, and they're rebuilt automatically on the next visit.

> **Tip:** Clear a translation if a backend gave you a poor result and you've since switched to a better one, so visitors get a fresh translation.
