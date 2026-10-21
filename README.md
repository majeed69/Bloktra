<p align="center">
  <img src="assets/icons/icon-128.png" width="96" alt="Bloktra logo">
</p>

<h1 align="center">Bloktra</h1>

<p align="center"><b>Your browser. Your rules.</b></p>

<p align="center">
  A free, open source ad and tracker blocker for Chrome, Edge, Brave and other Chromium browsers.<br>
  Built on Manifest V3. No accounts, no telemetry, no "acceptable ads".
</p>

---

## Why I built this

Most ad blockers either got heavier over the years or quietly started letting some ads through. I wanted something small that I could actually read end to end, that works offline, and that doesn't phone home. Bloktra is that. Every line is in this repo, and nothing leaves your browser.

## What it does

**Blocks ads and trackers at the network level.** EasyList, EasyPrivacy, Peter Lowe's list and Turtlecute d3host are on out of the box. That's roughly 116,000 network filters and 31,000 cosmetic ones. Cookie banners, annoyances and the StevenBlack hosts file are one switch away if you want to go stricter.

**Cleans up what's left.** Empty ad boxes and placeholders get hidden too. Generic hiding rules are only injected when their class or id actually shows up on the page, so it stays light. Procedural rules like `:has-text()`, `:upward()` and `:remove()` work.

**Strips tracking junk from links.** `utm_*`, `fbclid`, `gclid` and about 50 other tracking parameters are removed before the page even loads.

**Shows you what it caught.** There's a count on the toolbar icon, a breakdown per page (ads, trackers, hidden elements and which domains got blocked) and all-time stats with a 30 day chart.

**Lets you stay in control.**

- Pause on any site with one click, or manage a full allowlist
- Hide anything on a page with the element picker (popup, right-click menu, or <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>E</kbd>)
- Write your own rules in Adblock Plus syntax, with live validation
- Subscribe to any filter list by URL, updated daily
- Back up and restore your settings
- Light and dark themes

## Install

Bloktra isn't on the Chrome Web Store yet, so for now you load it by hand. It takes about a minute.

1. Download this repo. Either clone it:
   ```sh
   git clone https://github.com/majeed69/Bloktra.git
   ```
   or click **Code > Download ZIP** on GitHub and unzip it somewhere you won't delete by accident.
2. Open `chrome://extensions` (or `edge://extensions`, `brave://extensions`).
3. Turn on **Developer mode** in the top right.
4. Click **Load unpacked** and pick the `bloktra` folder (the one with `manifest.json` in it).
5. Pin Bloktra to your toolbar so you can see the counter.

You'll need Chrome 121 or newer. To update later, pull the latest changes (or download the ZIP again) and hit the reload icon on the extension card.

## Keyboard shortcuts

| Shortcut | What it does |
| --- | --- |
| <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>S</kbd> | Open the Bloktra popup |
| <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>E</kbd> | Pick an element to hide |

You can change these at `chrome://extensions/shortcuts`.

## Updating the filter lists

The bundled lists are compiled ahead of time into static rulesets. That's how MV3 blockers stay fast and keep working offline. To pull the latest versions yourself:

```sh
npm run build
```

or just `node tools/build.mjs`. You need Node 18 or newer, and there are no dependencies to install. Reload the extension afterwards.

If you already have the raw list files, `node tools/build.mjs --raw path/to/folder` will use those instead of downloading.

## How it works

**Blocking** runs on `declarativeNetRequest`, so Chrome does the matching itself and the extension never sees your traffic. Plain `||domain^` filters get grouped into a handful of rules with big `requestDomains` lists. That's how 116k filters fit into about 13k rules, comfortably under Chrome's guaranteed 30k. Your own filters, the allowlist and custom lists are dynamic rules, and your rules always win over list rules.

**Counting** listens to `webRequest.onErrorOccurred` for `net::ERR_BLOCKED_BY_CLIENT`. A request counts as a *tracker* if its domain is in EasyPrivacy or the URL looks like analytics. Everything else counts as an *ad*. If you run another blocker alongside Bloktra, its blocks get counted too.

**Cosmetic CSS** is injected with `scripting.insertCSS({ origin: "USER" })`, so pages can't override it. Selectors are wrapped in `:is()`, which means one bad selector can't break the rest.

## Project layout

```
manifest.json          MV3 manifest (rule_resources are written by the build)
service-worker.js      rules, counting, cosmetic engine, picker, messaging
content.js             cosmetic filtering and hidden element counting (every frame)
picker.js              element picker, injected on demand
popup.html/.css/.js    toolbar popup
dashboard/             overview, filter lists, my filters, allowlist, settings
assets/                icons, shared styles, theme switcher
lib/filter-parser.js   turns ABP/uBO syntax into declarativeNetRequest + cosmetic data
lib/lists.js           filter list catalog and tracking parameters
rulesets/              compiled static rules (generated)
cosmetic/              compiled element hiding data (generated)
data/                  tracker domains and list metadata (generated)
tools/build.mjs        the list compiler
d3host.adblock         bundled copy of the Turtlecute list
```

## Supported filter syntax

| Works | Skipped for now |
| --- | --- |
| `\|\|domain^`, paths, wildcards, `^`, `\|` anchors, `/regex/` (in your own filters) | `$popup`, `$csp`, `$redirect`, `$rewrite`, `$replace` |
| `$third-party`, `$domain=`, `$to=`, `$denyallow=`, `$method=`, resource types, `$important`, `$match-case`, `$document`, `$all`, `$removeparam=` | scriptlets `##+js()`, snippets `#$#`, HTML filters `##^` |
| `@@` exceptions, `$generichide`, `$elemhide`, `$specifichide`, `$badfilter` | CSS injection `{ ... }`, `:style()`, `:matches-css()`, `:xpath()` |
| `##`, `#@#`, `#?#`, entity domains (`example.*`), `:has()`, `:has-text()`, `:-abp-contains()`, `:upward()`, `:remove()` | |
| hosts files (`0.0.0.0 domain`) and bare domains (in your own filters) | |

## Privacy

Bloktra doesn't collect anything. There's no analytics, no account and no server. Your settings, stats and filters live in your browser's local storage. The only network requests it makes on its own are to download filter list updates, and only for lists you've subscribed to.

## Contributing

Found a site that breaks, or an ad that slips through? Open an issue with the URL and what you saw. Pull requests are welcome too. If it's a bigger change, open an issue first so we can talk it through.

## Credits

Bloktra wouldn't work without the people who maintain these lists:

- [EasyList and EasyPrivacy](https://easylist.to/) (GPLv3 / CC BY-SA 3.0)
- [Peter Lowe's Blocklist](https://pgl.yoyo.org/adservers/)
- [Turtlecute d3host](https://adblock.turtlecute.org/) (CC BY-NC-SA)
- [StevenBlack hosts](https://github.com/StevenBlack/hosts) (MIT)

Each list stays under its own license.

## License

Bloktra's code is released under the [GNU General Public License v3.0](LICENSE).
