# Boat Speedo — native iOS source

SwiftUI source for the native version of the speedometer. Feature parity with the
web app in [`../speedo/`](../speedo/), plus the one thing a web app cannot do:
**the anchor watch keeps running with the screen off.**

> **This source has never been compiled.** There is no Mac or Xcode in the
> environment it was written in, so treat it as a well-formed starting point
> rather than a finished build. Expect to fix a few things on first compile.

## Files

| File | What it does |
|---|---|
| `BoatSpeedoApp.swift` | App entry, notification permission and presentation |
| `SpeedoModel.swift` | Ties fixes to the trip log and both alarms; smoothing and fallback rules |
| `LocationManager.swift` | CoreLocation wrapper, background updates, magnetometer heading |
| `TripStats.swift` | Distance / max / average with accuracy and jitter filtering, plus unit helpers |
| `AnchorWatch.swift` | Swing circle, drag detection, alarm sound and local notification |
| `SpeedAlarm.swift` | No-wake threshold monitor |
| `SpeedDial.swift` | The gauge |
| `CompassRose.swift` | Rotating compass card |
| `ContentView.swift` | Screen layout |
| `Theme.swift` | Nautical palette, day and night |

## Building it

1. Xcode → **File › New › Project → iOS → App**. Product name `BoatSpeedo`,
   interface **SwiftUI**, language **Swift**. Save it somewhere outside this repo.
2. Delete the generated `ContentView.swift` and `BoatSpeedoApp.swift`, then drag
   every `.swift` file from `BoatSpeedo/` into the project navigator with
   **Copy items if needed** ticked.
3. **Signing & Capabilities** → pick your Apple ID team. Add the
   **Background Modes** capability and tick **Location updates** and
   **Audio, AirPlay, and Picture in Picture**.
4. In **Info**, add these keys:

   | Key | Value |
   |---|---|
   | `NSLocationWhenInUseUsageDescription` | Shows your speed, heading and trip distance on the water. |
   | `NSLocationAlwaysAndWhenInUseUsageDescription` | Lets the anchor watch keep running with the screen off. |
   | `UIBackgroundModes` | `location`, `audio` |

5. Set the deployment target to **iOS 16.0** or later (`interruptionLevel` and
   `persistentSystemOverlays` need it) and run on a real device — the simulator
   has no GPS speed and no magnetometer.

### Keeping it on your phone

With a free Apple ID the app expires after **7 days** and must be re-installed
from Xcode. A paid Apple Developer account ($99/yr) raises that to a year. There
is no way around this for a self-built app.

## Known rough edges

These are deliberate simplifications, not oversights — worth knowing before you
rely on the app at anchor.

- **The alarm uses system sounds** (`AudioServicesPlayAlertSound`), which follow the
  ringer volume and will not wake a heavy sleeper. For a real anchor alarm, bundle a
  loud looping `.caf` and play it through `AVAudioPlayer` with
  `numberOfLoops = -1` on a `.playback` session.
- **`content.sound = .defaultCritical`** only actually bypasses silent mode if Apple
  grants your app the Critical Alerts entitlement, which requires a separate request
  to them. Without it the notification still fires, just politely.
- **No trip persistence.** `TripStats` is `Codable` and ready for it, but nothing
  writes it to disk yet, so a force-quit loses the current run. The web version
  persists to `localStorage`.
- **Battery.** `kCLLocationAccuracyBestForNavigation` plus background updates is
  the heaviest GPS mode iOS has. Keep the phone on a charger for anything longer
  than a few hours.

## Cross-checking against the web version

Both versions use identical constants — EMA weight 0.3, 25 m accuracy limit, 3 m
jitter floor, 0.5 kn under-way threshold, 60 s maximum gap — so on the same track
they should agree. The web version has an automated harness that checks its trip
maths against exact ground truth; if you change a rule in one, change it in both.
