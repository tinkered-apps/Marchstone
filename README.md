# Marchstone

A marchstone is the stone that says where one holding ends and the next begins.
This is that stone, if it could shout.

Mark an area by tapping it on a map or walking round it on foot. Your phone then
tells you whether you are **inside** it, **outside** it, or **on its edge**, by
colour, sound and vibration. It answers "am I in this shape?" for any shape on the
ground: fencing, spraying, surveying, foraging permissions, event boundaries,
marking what to cut.

Live at <https://marchstone.tinkered.app>. It runs in the phone's browser, needs no
account, and once loaded works with no signal.

## Install

Open the address on the phone, then **Add to Home screen** from Chrome's ⋮ menu or
Safari's Share sheet. GPS only works on an `https://` page, so a copy you email
yourself gets no location permission.

On Android, use Chrome; [When the position wanders](#when-the-position-wanders)
says why.

## Set an area

**Draw** on the satellite map, tapping each corner. Drag one to move it, tap it to
delete it, Undo backs out. Three corners minimum.

**Walk** it if the line is easier to stand on than to see. **WALK** turns the
position feed on and puts a **CORNER** key under your thumb: stand on the corner,
tap it, walk to the next one. The key carries the number it is about to drop, and
the readout at the top gains **GPS** and **LAST FIX**, the two figures that say
whether the corner under your feet is worth having.

The two mix freely. Tapping the map still drops a corner while you walk, so a
perimeter that is half fence you can stand on and half the far side of a river
takes half of each. The line closes itself; there is no need to walk back to the
first corner.

A walked corner is only as good as the fix that made it. Each one is confirmed
with the ± it was dropped at, and if the worst of them was looser than 10 m the app
says so once before it saves, with the number, and leaves the decision to you.
Dragging a corner afterwards drops its figure rather than shrinking it.

**Import** `.kml`, `.gpx` or `.geojson` from Google Earth, a handheld GPS or farm
software. A file holding several areas lets you pick one.

Every boundary is checked on the way in. Nonsense is refused with the reason: too
few corners, coordinates that are not numbers, latitude past the pole (almost
always a file written longitude-first). Odd but workable shapes are flagged and
left to you, because a walked perimeter doubling back near the gate is an ordinary
GPX track, and refusing it would break the import that matters most.

## Track

The bottom of the screen becomes the answer.

| state | screen | alert |
|---|---|---|
| **INSIDE** | green | silent |
| **UNSURE** | no colour | one low tick every 7 s |
| **BORDER** | amber | two beeps, double buzz, every 1.8 s |
| **OUTSIDE** | red | three fast beeps, long buzz, every 1.1 s |

Alerts repeat, so missing one costs you nothing.

A ±40 m fix standing 12 m inside the line does not know you are inside, so the app
stops saying so: the green goes, the number stays, and a quiet tick reminds you it
cannot see well enough to promise. The same fix 12 m *outside* stays red with its
full alarm. Bad GPS takes away the reassurance, never the warning.

Under the number sits the boundary seen edge on: **EDGE** is the line, **YOU**
slides as you walk, the hatched band is your border width. Tap it for the same
thing in words, or tap the **GPS / BORDER / LAST FIX** strip for live diagnostics.
Watch LAST FIX. A confident number measured three fields ago is the worst thing
this app can show you, so past ten seconds it says so on screen.

The map follows you until you drag it. A **FOLLOW** key then appears above
**MARK**, and nothing else turns following back on.

## Marks

**MARK** drops a numbered point where you are standing, and the point carries the
accuracy of the fix it came from wherever it appears. ±40 m is not the same object
as ±4 m.

Tap a disc on the map, or the tally at the top, to label, move, recentre on or
delete it. Deleting the last mark hands its number back. Deleting one from the
middle leaves the gap, since by then #7 already exists out there in paint. The mark
you last dropped or opened gets its own key above **MARK**, and its disc turns ink
on the map.

Marks taken in the same spot are drawn as a pile: the top disc carries the count
of the ones behind it. Tap the pile and it spreads out, each disc tethered to a dot
at the point it actually holds. A disc is never drawn more than 6 m from its point,
so a pile too crowded for the zoom lists itself instead.

**Move it on the map** fixes a mark a bad fix put metres from what you are standing
at. Drag it or tap where it belongs; a strip at the top shows how far you have
taken it. A moved mark stops claiming a ±, because the error is now the imagery's
and your eye's. It reads `placed by hand · 12 m from its fix` on screen and in every
file, and **Put it back where the fix had it** restores the position and the ±
together.

**Save these marks to a file** writes GPX waypoints, KML or GeoJSON points, then
offers to clear them. Open the file before you clear anything: from inside the
app, a download the browser refused looks the same as one it saved. An area's
GeoJSON export and **Back up every area** carry its marks too. Its KML export is
the boundary alone.

## When the position wanders

Android hands browsers *approximate* location unless you grant the precise kind:

> Settings → Apps → *your browser* → Permissions → Location → **Precise**

Switch on the phone's location accuracy service too, then stand in the open for a
minute while a cold receiver finds satellites.

Chrome on Android reads a position that Play Services blends from GPS, wifi, cell
and motion sensors. Firefox fixes arrive further apart, sit looser, and on some
devices come back stale whatever you grant it, and no Firefox setting closes the
gap. This comes from watching both browsers in the field; a page cannot see how a
browser works inside. To move from Firefox to Chrome, export each area as GeoJSON
from its **⋯** menu, import it in Chrome, and run **Save map** again there.

**Position quality** in Settings throws out readings too vague to be satellites,
the ones that drop you a street away. If nothing better arrives in fifteen
seconds you get the poor reading anyway, labelled. When the browser's position
watch goes quiet, the app asks outright every 1.2 s and rebuilds the watch if both
fall silent.

Under canopy, expect ±10 m or worse whatever you do. Widen the border to match.

## Settings

The theme button at the top right cycles through Auto, Day, and Night. Auto
follows the phone. Day is easier to read in direct sun. The EN / PL switch beside it
sets the language, English or Polish; the privacy page follows it.

| setting | default | what it does |
|---|---|---|
| Border width | 5 m | How far either side of the line counts as *on the border*. Under 4 m flickers; 10 m warns earlier and holds you in amber longer. |
| Position quality | 30 m | Accuracy at which a reading is thrown out as a guess from masts. |
| Keep screen on | on | Holds a wake lock while tracking. |
| Start muted | off | Colour only. |

The footer shows the version the phone is running. Quote it when something looks
like a bug that was already fixed. A new version takes over the next time the app
is closed completely and opened again.

**Save map**, on the drawing screen, stores satellite imagery for zoom 14 to 18 of
the current view, up to 1,200 tiles. The maths needs no signal; the picture does.
Only the satellite layer can be saved, because OpenStreetMap's usage policy rules
out downloading tiles ahead of time. The imagery is licensed to Esri and its
suppliers, so save the ground you are working and no more.

## Your data

Areas, marks, positions and settings stay in this browser on this phone. There is
no account, no analytics and no upload. The privacy page, linked from the footer
and from Settings, lists everything the app keeps on the phone and how to remove it.

Two things reach a server:

- **The page itself**, from Cloudflare, the way any web page does. Static files
  only, with request logs off.
- **Map tiles**, from Esri (satellite) or OpenStreetMap (street map), for the
  squares of ground in view. That tells the provider which patch of the world
  someone is looking at, often roughly where they are standing. Save the map
  before you go, or work a saved area with no signal, and this stops. The map is
  built the first time you open one, except on a wide screen, where the areas
  list has a map beside it from the start.

The [privacy page](public/privacy.html) (`/privacy` on the live site, linked from
the footer) says who is responsible, what each provider receives, how long the
host keeps its records and how to use your rights.

## Backups and restore

Browsers clear their storage when short of space, and clearing site data takes it
along, so browser storage is not a safe place for the only copy of anything. The
app asks for **persistent** storage and reports in Settings whether it was
granted. It reads back every save and offers you a file the moment one does not
stick.

**Back up every area** writes every area with its marks into one GeoJSON file.
**Restore from a backup** reads that file into any browser on any device. Restoring
adds; it never replaces.

The site itself holds no data, so restoring it means redeploying the code. How to
do that is in [AGENTS.md](AGENTS.md), with the commands and conventions for working
on it.

## Limits

- **Only as good as the GPS.** A ±4 m fix cannot answer a 1 m question, and the
  app drops to UNSURE rather than show a confident colour.
- **A mark is only as good as its fix.** ±30 m records ±30 m. Nothing improves a
  mark after the fact or averages fixes into a better-looking one.
- **So is a walked corner.** The shape draws the same crisp line whether its
  corners came from ±3 m or ±30 m. The app names the worst of them when you save
  and keeps no record afterwards, so a boundary you reopen to edit no longer knows
  what made it.
- **iPhones cannot vibrate from a web page.** Colour and sound only. The readout
  strip reports what sound, vibration and screen-awake have actually done, not
  what the browser claims to support.
- **It stops when the screen goes off.** A hidden page gets no positions and
  cannot beep. The wake lock beats the screen timeout; the power button still
  wins. Running dark takes a native app.
- **Areas are simple outlines.** No holes, no multi-part parcels. An imported
  polygon with a hole comes in as its outer edge, flagged, and the hole counts as
  inside.

## Credits

- Author: Kuba (kuba@tinkered.app)
- Map: [Leaflet](https://leafletjs.com), BSD 2-Clause licence, in
  [public/vendor/LICENSE-leaflet.txt](public/vendor/LICENSE-leaflet.txt)
- Fonts: Barlow and Barlow Condensed, SIL Open Font License 1.1, in
  [public/vendor/fonts/OFL.txt](public/vendor/fonts/OFL.txt)
- Imagery: Esri World Imagery (Esri, Maxar, Earthstar Geographics and the GIS User
  Community) and © OpenStreetMap contributors, credited on the map as their terms
  require
