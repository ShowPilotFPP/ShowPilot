# Settings › Audio

Everything about **Listen on Phone**, ShowPilot's built-in way for viewers to hear your show through their phones. For the whole picture, from syncing songs to fixing timing, see [Phone audio, start to finish](help:phone-audio).

> **Tip:** If this page only shows **Phone audio is off for this show**, the server's host has switched phone audio off for your show. Viewers won't see a Listen button. Everything else in ShowPilot works as usual.

## Audio enabled

The master switch for ShowPilot's phone audio. Leave it on to let viewers listen on their phones.

Turn it off if you send audio another way (an FM transmitter, PulseMesh, Icecast) and don't want ShowPilot involved at all. With it off:

- the Listen button disappears from your viewer page,
- ShowPilot stops serving audio,
- your show player stops uploading songs to ShowPilot, which saves disk space and makes syncing faster.

The other settings on this page have no effect while it's off.

## Listen-on-Phone player

### Let listeners adjust audio timing

Adds a small timing button to the phone player. Phones can't measure the delay of Bluetooth speakers or car stereos, so a listener using one can shift the sound earlier or later until it lines up with the lights. Each listener's adjustment is saved on their own phone and applies after the page reloads.

### Slider range

How far listeners can move the timing slider, in milliseconds. Negative values play the audio later (for "the music is early"); positive values play it earlier (for "the music is late"). The default is **−500 to +1000**. You can allow from −2000 up to +3000.

> **Tip:** Car stereos and Bluetooth speakers usually make audio late, so most listeners need the positive side. Keep the range tight enough that the slider is easy to use.

### Show a tip in the timing sheet

Adds a hint in the timing sheet: play the show on a second phone's speaker and adjust until the two sound together. For step-by-step help right on the viewer page, add the **Audio Sync Help** block to your template in the Visual Designer.

## Audio distance gate

Only lets people listen if they're near your show. Recommended if you play licensed or copyrighted music without streaming rights. You can leave it off for original music, or music you have rights to stream.

- **Restrict audio playback to listeners within radius** turns it on.
- **Audio radius (miles)** is how close a listener has to be. It's usually smaller than the radius used for voting and requests.

When a viewer taps the Listen button, their phone does a fresh location check, so an old or faked location doesn't get through. Location is checked again every 15 minutes while they listen, so someone who drives away is cut off.

> **Important:** The gate measures distance from your show's location, which you set in [Interaction Safeguards](help:settings-safeguards). Set that first, or the gate can't work.

## Audio sync offset

Moves the audio for **every** listener, in milliseconds, so you can match it to your speakers and lights. The change applies from the next song.

- Phones sound **ahead** of the lights: use a **positive** value (delays the audio).
- Phones sound **behind** the lights: use a **negative** value.
- The **−/+** button flips the sign.

> **Careful:** This affects everyone. If only one person is off, it's usually their own Bluetooth or car audio, and the listener timing button above is the right fix.

## Audio daemon

The **Daemon port** is where ShowPilot reaches the audio helper the FPP plugin runs on your show player. That helper reports exactly where each song is, many times a second, which is what keeps phones in sync. The default is **8090**. Only change it if you changed the port in the plugin too; the two must match.

## External audio access

Listeners on cellular data, or anywhere off your home network, can't reach your ShowPilot by its local address. Enter the **Public base URL (your domain)**, the full web address where your ShowPilot can be reached from the internet (for example `https://lights.example.com`). Their players then use it automatically, while people on your own network still use the faster direct path.

Leave it blank if your ShowPilot isn't reachable from the internet.
