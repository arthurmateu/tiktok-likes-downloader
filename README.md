# TikTok Likes Archiver

A browser extension that archives your liked TikToks — **videos and photo posts** — into any folder you choose. No download cap, no paid tier.

Built as a replacement for [myfaveTT](https://myfavett.com/), but not as a clone of its folder layout: media filenames are still the TikTok item ID, so nothing is ever downloaded twice, while the folder itself is flat and readable. An existing myfaveTT archive is converted once by [`tools/script.py`](tools/script.py) rather than lived with forever — see [Converting an existing archive](#converting-an-existing-archive).

## Install

Chromium and Gecko need different manifests, so they can't share one folder. Build both:

```bash
python tools/build.py
```

**Edge, or Chrome 111+** — open `edge://extensions` (or `chrome://extensions`), turn on **Developer mode**, **Load unpacked** → `dist/chrome`. The repo root also loads directly if you'd rather skip the build.

**Firefox 128+** — open `about:debugging#/runtime/this-firefox` → **Load Temporary Add-on…** → `dist/firefox/manifest.json`. Then open the extension's entry in `about:addons` → **Permissions** and allow it to access tiktok.com and the CDNs, or use the **Grant access to TikTok** button the archive page shows; Firefox treats manifest host permissions as optional and every download 403s until they're granted.

Either way: pin the extension, click it, **Open archive**.

## Use

1. On the archive page, click **Choose folder…** and pick your archive folder. Chromium asks for read/write permission once per browser session. On Firefox the button instead asks for a *name*, and the archive lands in that subfolder of your browser's download folder — see [Firefox](#firefox) for why.
2. If it's an existing myfaveTT folder, convert it first — see below. The page says so if it spots one.
3. Enter your TikTok username and press **Sync likes**.
4. A TikTok tab opens on your profile in the background and pages through the **Liked** tab from there. Leave it open, but you don't have to look at it — carry on browsing. It may come to the front for a second or two to open the Liked tab, then hands the foreground back.
5. Downloads run while the list is still being read. Watch the counters and log.

If TikTok rejects the paged requests, the log says so and the run falls back to scrolling the tab — that older path does need the tab visible, and it says so too.

Run it again any time. Anything already on disk is skipped.

Each completed sync also rewrites `viewer.html` in the folder — the same Library as a file you can double-click, no extension needed. See [viewer.html](#viewerhtml).

## Folder layout

```
<your folder>/
  videos/<videoId>.mp4       one file per video
  images/<postId>.jpg        a single-image post
  images/<postId>_01.jpg     a gallery, one file per image, numbered in order
  archive.json               every liked item, downloaded or not
  viewer.html                the Library, as a file you can double-click
```

Nothing hidden, nothing nested. Filenames are the TikTok item ID, so writing the same item twice is a no-op, and the **directory listing** — not any database — decides what still needs downloading. Delete a file and the next sync re-fetches it; corrupt `archive.json` and nothing re-downloads.

There are no cover files. A cover is a thumbnail of something you already have, so the Library decodes a frame out of the video instead (a little way in, since TikTok's first frame is usually black) and caches it in memory. Photo posts use their own first image.

### archive.json

Every item that has ever appeared in your likes, whether or not the media could be fetched. Each carries a `status`:

| | |
| --- | --- |
| `saved` | the media is on disk |
| `pending` | in your likes, not downloaded yet |
| `unavailable` | download attempted and failed — expired URL, 403, captcha |
| `gone` | was in your likes once and isn't now: deleted, privated, or unliked |

`gone` is the point of the file. That media is unrecoverable and always was — but the id, author, caption, date and stats are a few hundred bytes each, and they are the only thing that survives the post. A completed sync is what promotes an item to `gone`; a run you stop early never does, because a short list proves nothing.

It's indented JSON at the top level of the folder, so `jq` and a text editor are both fine on it.

### viewer.html

The archive page lives at a `chrome-extension://` or `moz-extension://` URL, which is not an address anyone wants to keep to hand. So the same Library is written into the folder itself, rewritten after every sync and on demand with **Write viewer.html**. Double-click it and the archive browses itself — search, sort, playback, per-item metadata — with no extension involved. Copy the folder to another machine or a drive and it still opens.

It is one self-contained file because it has to be. A `file://` document gets a unique opaque origin, so it can neither `fetch('archive.json')` nor load a module script from beside itself; the CSS, the JS and a slimmed copy of the metadata are inlined instead. Media is the exception and stays on relative paths — `<img>` and `<video>` load siblings off `file://` without complaint, which is what makes the whole thing work. A 6k-item archive comes out around 3 MB.

Opening an item gives you a feed rather than a single clip. The wheel, ↑ ↓ (or `j`/`k`, PageUp/PageDown) and the two round buttons step through whatever the search and sort currently list, skipping anything not on disk; space plays and pauses, `m` mutes for the rest of the session, Esc closes and leaves the grid scrolled to where you got to. A photo post shows one image at a time the way TikTok's own slideshow does — ← → or the dots page through it, and `g` opens the whole post out at once. The same feed is in the extension's own Library tab; the two are kept in step by hand.

Two consequences worth knowing:

- **Thumbnails are `<video>` elements seeked to 0.5 s**, not decoded frames. The archive page uses `canvas.toBlob`, which throws here: a `file://` video taints the canvas.
- **It is a snapshot.** The metadata is as current as the last sync. The media is always current, since that is read off the folder.

On Chromium it can also talk back to the extension, which makes it a front-end rather than an export. Turn on **Allow access to file URLs** on the extension's card in `chrome://extensions` and the page reads live metadata instead of its snapshot, and can start a sync itself. That permission covers every local file you open, so the content script bails unless the document carries a `<meta name="ttarchive-viewer">` whose token matches one the extension issued and keeps to itself — another local page can't drive the archiver by copying the tag.

Firefox does not run extensions on `file://` pages at all, and rejects `file:///*` match patterns outright, so there is no counterpart in `manifest.firefox.json`. There the page stays a snapshot, says so in a banner, and offers the archive page's URL to copy.

## Converting an existing archive

[`tools/script.py`](tools/script.py) turns a myfaveTT folder — or an older version of this one, which used `data/Likes/` — into the layout above. Copy it into the folder and run it:

```bash
python script.py
```

It moves media rather than copying it, so it's instant even at hundreds of GB, and it writes `archive.json` from myfaveTT's own gzipped databases: every id they recorded, including the ones TikTok had already deleted. Nothing is downloaded and nothing is deleted — myfaveTT's `data/.appdata/` and its cover thumbnails are left where they are, and the script prints their size so you can decide about them yourself.

| | |
| --- | --- |
| `--dry-run` | print the plan and touch nothing |
| `--copy` | copy instead of moving, so the myfaveTT archive keeps working |
| `--root PATH` | operate on a folder other than the script's own |

Safe to re-run: it only moves files whose destination doesn't already exist, and rebuilds `archive.json` from whatever it finds.

## Firefox

Gecko has no File System Access API, so there is no handle to write through and none of the above works as written. It does have three things that, together, cover it:

- `downloads.download()` writes anywhere **inside** the browser's download folder and accepts a relative subpath — so the layout above survives verbatim. (The flat layout helps here: there is no longer a leading-dot directory for Firefox's filename sanitiser to object to.)
- `downloads.search()` returns each download's absolute path plus an `exists` flag. That keeps the load-bearing property intact: what needs downloading is still decided by what is on disk, not by a database we maintain.
- `<input type="file" webkitdirectory>` hands back every `File` in a folder the user points at, which is how an existing archive gets read at all.

`src/lib/fs.js` is now a façade over two backends and picks one by feature detection. Nothing above it — `state.js`, `downloader.js`, `viewer.js` — knows which browser it's on.

Four things are honestly worse than on Chromium, and the archive page says so where it matters:

| | Chromium | Firefox |
| --- | --- | --- |
| Where the archive can live | any folder | only under the download folder; move it in `about:preferences` |
| What "already downloaded" means | a live directory listing | download history, plus any folder you've scanned |
| Reading files back (Library playback, thumbnails, `archive.json`) | always | only after **Scan an existing folder…** |
| `viewer.html` in the folder | can read live state and start a sync | a snapshot; the extension can't attach to a local file |

That last row is a platform limit with no workaround, not a gap in the port. Gecko has never run extensions on `file://` URLs — `externally_connectable` doesn't cover the scheme either, and content-initiated navigation to `moz-extension:` is blocked — so a page in your archive folder has no way to reach the extension. It still browses the archive perfectly well; it just can't sync, and it explains that rather than failing quietly.

Clearing your download history costs bandwidth, never data: the next sync re-downloads over the top of files that are already there (`conflictAction: 'overwrite'`), and identical filenames mean the result is the same archive. `archive.json` is additionally mirrored into IndexedDB, because a download folder is write-only from inside the extension and the metadata has to survive to the next run.

Every file also appears in Firefox's download panel. There's no API to suppress that.

**Not verified end-to-end.** Firefox's port is written and unit-tested (`src/dev/backends.html`) but hasn't been run against a live TikTok session. The specific thing to watch is cookies: the README's finding that media URLs are bound to the session that obtained them depends on `credentials: 'include'` actually sending TikTok's cookies, and Firefox partitions cookies more aggressively than Chromium does. If downloads 403 on Firefox while the same account works on Edge, that's the first thing to check.

## How the list is obtained

TikTok's `/api/favorite/item_list/` requires `X-Bogus` / `_signature` / `msToken`, computed by an obfuscated bundle that rotates regularly. Reimplementing that signer means breaking every few weeks.

Instead, `src/content/hook.js` runs in the page's MAIN world and wraps `fetch` and `XMLHttpRequest`. TikTok's own code makes its own correctly-signed request; we read the response and keep the URL that produced it.

From there a sync pages the list one of two ways:

**Background paging (default).** `hook.js` replays that captured URL with the next `cursor` and a fresh `msToken`, using the page's own `fetch` so cookies, `Origin` and `Referer` are whatever TikTok expects. Nothing is scrolled, so the tab can sit in the background and you keep your browser. If the bundle still exposes its signer (`window.byted_acrawler`) the replay is re-signed; if it doesn't, the plain replay is tried anyway and the response decides.

**Scrolling (fallback).** The original path: scroll the page and let TikTok's own code request the next page. Slower, and it needs the tab visible — a hidden tab's rendering is suspended, so the scroll never triggers anything. Used automatically whenever paging is refused, since that's a signing change and this path has nothing to break.

Both feed the same normalizer, so nothing downstream knows which one ran. A run that falls back partway just re-walks the list from the top; already-downloaded items are skipped on disk.

One detail worth knowing if you touch this: Chrome clamps a hidden tab's timers to 1/s, and to 1/min once it has been hidden a while, which would throttle the paging loop to a crawl. The delay between pages is therefore taken from the service worker's clock (`{type: 'sleep'}` in `src/background.js`), which isn't clamped, raced against the local timer in case the worker has been shut down.

## Being refused

Every request a sync makes carries your own logged-in session and TikTok's own signing. That is what makes the archive possible, and it is also why being rate-limited here is attributable to the **account** and not just the IP. The rule the code follows, in `src/lib/throttle.js`, is that a refusal has to make the extension quieter — never louder.

It did the opposite before this existed. `fetchFirst` treated any non-2xx as "this mirror is stale, try the next one", and TikTok hands out four to six mirrors per asset; they resolve to the same edge fleet, so one 429 became five more immediate requests into a limit already hit, times four parallel downloads. The list pager, separately, had a flat 400 ms between pages and no notion of a refusal at all.

Two outcomes now, deliberately different:

| | | |
| --- | --- | --- |
| **Pause** | 429, 502/503/504 | Everything parks — downloads *and* the pager — for 20 s, doubling per consecutive refusal to a 10-minute ceiling, jittered. A `Retry-After` wins whenever it asks for longer. Twenty clean requests walk the back-off down again. Four parallel downloads meeting one limit count as one event, not four. |
| **Halt** | a captcha or challenge page | No interval fixes this; it needs a human in the tab. The run stops, says so, and asks you to clear the check and press Sync again. |

The halt case is the one worth being careful about. A challenge and a *signing* failure both look like "the replay didn't work", but they want opposite responses: a signing failure should fall back to scrolling, because scrolling has nothing to do with signing, whereas falling back to scrolling during a challenge would go on making the same requests from the same session while TikTok is objecting. `hook.js` therefore reports a status code and a `challenged` flag rather than one opaque error string, and only the former reroutes.

Nothing a halt touches is marked `unavailable`. That status is a claim about the media — that it was fetched and could not be had — and a stopped run has no business making it; a run that resumed tomorrow would skip everything the halt caught. Parked items are simply left `pending` and picked up by the next sync.

The two halves keep each other informed. Downloads run on the archive page and the list is paged in the content script, so a refusal met by one is news the other cannot otherwise get; it travels over the background relay and each side adopts the longer pause. A challenge met while downloading stops the pager, and vice versa.

The paging delay is now 800–2500 ms, randomised. The old fixed 400 ms was its own tell — nothing human requests a page on a metronome three hundred times — and this is both slower and irregular. There is also a 1200-page ceiling on a single run as a backstop, far past any real likes list.

`src/dev/throttle.html` and the last two sections of `src/dev/paging.html` are where this is checked.

## Architecture

| File | Role |
| --- | --- |
| `src/content/hook.js` | MAIN world. Wraps `fetch`/XHR, forwards `item_list` responses over `postMessage`, and replays the captured request by cursor on demand. |
| `src/content/collector.js` | ISOLATED world. Pages the list (background paging, else auto-scroll), normalizes items, relays to the service worker. |
| `src/background.js` | Relay between content scripts and the archive page; manages the TikTok tab, lends the foreground when a step needs it, and serves the collector's unthrottled clock. Service worker on Chromium, event page on Gecko, so it stays import-free. |
| `src/archive/archive.js` | Owns the storage backend, the sync run, and all disk I/O. |
| `src/archive/viewer.js` | Offline library browser — search, sort, thumbnails, playback from disk. |
| `src/archive/standalone.js` | Generates the folder's own `viewer.html`, inlining `src/viewer/`. |
| `src/viewer/` | Template, CSS and runtime for that generated page. Never loaded as files by the extension — only read and inlined. |
| `src/content/viewer-bridge.js` | Chromium only. Relays a generated `viewer.html`'s requests to the background. |
| `src/lib/fs.js` | Storage façade: folder layout, backend selection by feature detection. |
| `src/lib/backends/fsa.js` | Chromium backend — File System Access, write retries. |
| `src/lib/backends/downloads.js` | Gecko backend — downloads API, history-derived listing, folder snapshot. |
| `src/lib/ext.js` | `browser ?? chrome`, so every call site can `await`. |
| `src/lib/state.js` | Disk scan + `archive.json` load/save/merge, item status. |
| `src/lib/downloader.js` | Bounded-concurrency fetch/write queue, media URL selection. |
| `src/lib/throttle.js` | Back-off and halt state — what happens when TikTok refuses. Shared by the queue and, restated inline, by the collector. |
| `tools/script.py` | One-off converter from a myfaveTT (or older ttarchive) folder. |

All fetching happens on the extension page rather than in a content script: since Chrome 85 content-script requests obey the page's CORS policy, while extension pages get host-permission-based access.

## Verified behaviour

Checked on 2026-08-02 by loading this extension into Edge with `--load-extension` and downloading from the extension's own origin — the same conditions a real sync runs under. All of it is Chromium; see [Firefox](#firefox) for what has and hasn't been checked there.

| Case | Result |
| --- | --- |
| Video — `tiktok.com/@soupy_cos/video/7669190146864074006` | 1,219,617 bytes, exactly the `video.size` TikTok declares; h264 576×1024, 7.34 s, 220 frames |
| Single photo post — `@abc.es/photo/7668973530595314966` | 1 image, 1080×1350 JPEG, 171 KB |
| Gallery photo post — `@mcslobby/photo/7666435596851711254` | all 9 images, in order, up to 1440×2148, 74–196 KB each |

**No watermarks.** `video.playAddr` and `video.downloadAddr` are two different encodes of the same clip. Frames extracted from both show the bouncing "TikTok / @author" watermark burned into `downloadAddr` and a clean image in `playAddr`. The extension selects from `bitrateInfo` (highest resolution first, bitrate breaking ties) then `playAddr`, and **never** falls back to `downloadAddr` — see the comment in `src/content/collector.js`. Photo-post images carry no watermark at any resolution.

**Highest resolution, not highest bitrate.** Ranking the `bitrateInfo` gears by bitrate — what this did until 2026-08-02 — picks the h264 540/720 rung over the h265 1080 one whenever HEVC's efficiency puts the latter lower in bits per second. Read off a live feed, 16 of 29 videos had a higher-resolution gear than the bitrate winner, and TikTok's own `MVMAF` scores rate the swap far worse: for `7665751835969326368`, `normal_540_0` (576×1024, 802 kbps) scores 81.98 VMAF against the original where `adapt_lowest_1080_1` (1080×1920, 676 kbps) scores 94.29. Selection now sorts on `PlayAddr.Width × Height` first. The practical cost is that most files land as h265/hvc1 rather than h264 — fine in Chromium and in the Library viewer, but older players and Firefox before 134 may not decode them.

**Photo `urlList` entries are mirrors, not sizes.** Each image's `urlList` holds the same `~tplv-photomode-image.jpeg` asset on two CDN hosts (`p16-…`, `p19-…`), with no resize suffix, so taking the first one that answers cannot silently downgrade an image. Covers are never fetched at all.

Two things this testing established that shape the code:

- **Media URLs are bound to the browser session that obtained them.** A URL harvested in one browser profile returns HTTP 403 in another, even seconds later with identical headers. This is fine for normal use — the extension harvests and downloads in the same profile — but it is why `fetchFirst` sends `credentials: 'include'`, and why a URL you copy out of the log won't work in curl or another browser.
- **A challenged request returns HTTP 200 with TikTok's captcha page.** Before this was caught, a 33 KB HTML page was written to disk as an `.mp4` and counted as a successful download. `fetchFirst` checks magic bytes (`ftyp` for video, JPEG/PNG/WebP/GIF/HEIC for images) and rejects anything that isn't really media. A body that is *not* media but also isn't HTML is a stale mirror, and the next mirror gets a turn; a body that looks like a challenge page stops the whole run instead — see [Being refused](#being-refused).

Not yet verified end-to-end: the Liked-tab harvest in either mode, which needs a logged-in account. Background paging in particular rests on an untested assumption — that TikTok accepts a captured `item_list` URL with the cursor swapped. If it doesn't, the run says so in the log and falls back to scrolling, so the failure mode is the old behaviour rather than a broken sync.

## Known limits

- **Deleted / privated items can't be recovered.** They never appear in the list responses. Your myfaveTT DB records 1,995 of these already; `tools/script.py` carries all of them into `archive.json` as `gone`, which is as much as can be done for them.
- **Media URLs are signed and expire.** Downloads run concurrently with the list read to stay ahead of it, but on a very large first run some may still time out. They're logged as failures; run **Sync likes** again and only the missing files are retried.
- **No `total` from TikTok.** The progress bar is seeded from your previous item count, so it's an estimate until the run ends.
- Bookmarks, Following, and audio extraction are not implemented. The plumbing is there (`collector.js` already recognises the bookmarks tab) if you want them later.

## Development

`_syntaxcheck.html` loads every module against a stub `chrome` API to catch parse and top-level errors without installing the extension:

```bash
python -m http.server 8777
```

Then open `http://127.0.0.1:8777/_syntaxcheck.html`. Add `?gecko` to make it stub `browser.*` and hide `showDirectoryPicker`, so the Firefox backend is the one that gets selected and evaluated. It is dev-only and not referenced by the extension.

`src/dev/backends.html` unit-tests the Gecko backend against a faked download history and a faked directory pick — path arithmetic, the history/snapshot union, filename sanitising, the `archive.json` mirror. Serve the repo as above and open `http://127.0.0.1:8777/src/dev/backends.html`; it prints pass/fail and needs no browser extension loaded.

`src/dev/paging.html` runs `hook.js` and `collector.js` against a fake `item_list` endpoint — the only way to exercise the list harvest without a logged-in account. It covers what breaks quietly: that background paging replays the captured URL by cursor rather than making the page scroll, that each replay picks up the current `msToken` and is re-signed for its own cursor, that a refused replay falls back to scrolling and still returns the same list, and that a second sync in the same tab reports the whole list again instead of only what changed. Its last two sections cover the opposite case — that a captcha and a 429 *don't* fall back to scrolling, that a rate-limited page is retried at the same cursor with a growing wait rather than skipped, and that the halt reaches the download side. Back-off is measured against the wall clock, so those tests speed `Date.now` up rather than shortening the intervals in the code. Open `http://127.0.0.1:8777/src/dev/paging.html`.

`src/dev/throttle.html` unit-tests `src/lib/throttle.js` and `fetchFirst` against a scripted `fetch`. The behaviour it covers is almost entirely about requests *not* made — that a 429 stops the round instead of walking the remaining mirrors, that four parallel downloads meeting one limit back off once rather than four times, that a challenge page throws before trying anything else and under any content type, that a halted or stopped item is never marked `unavailable`, and that an ordinary 404 still walks the mirror list exactly as it used to. Open `http://127.0.0.1:8777/src/dev/throttle.html`.

`src/dev/thumbs.html` tests the Library against a folder that exists only in memory: an import map swaps `src/dev/fake-fs.js` in for `src/lib/fs.js`, so `state.js` and `viewer.js` run exactly as shipped. It matters most for video thumbnails, which are now decoded frames rather than files — the sample clip inlined in the page is black for its first 0.2 s and colour bars after, so "we took frame 0" fails as a real assertion rather than a flaky one. Open `http://127.0.0.1:8777/src/dev/thumbs.html`.

`src/dev/viewer.html` builds a `viewer.html` from sample state and checks the inlining, which is the part that goes wrong once and silently in someone's folder. A caption is arbitrary text from TikTok, and the fixture's caption carries the three sequences that break a naive generator: `</script>`, which ends the element it sits in; `$&`, which `String.replace` reads out of a *replacement*; and U+2028, a line terminator to a JavaScript parser but not to JSON. The result is rendered into a `blob:` iframe, whose origin is opaque like a `file://` document's. Open `http://127.0.0.1:8777/src/dev/viewer.html`.

`src/dev/selftest.html` answers what a stubbed API can't, by running inside the loaded extension: whether a credentialed fetch from `moz-extension://` carries TikTok's cookies, whether a root-level `archive.json` lands where it was asked to, whether `conflictAction: 'overwrite'` really overwrites instead of uniquifying to `probe(1).txt`, whether `downloads.search` returns paths in the shape `refresh()` parses, and whether the `world: "MAIN"` hook actually installed. Build with `python tools/build.py firefox --dev`, then open the archive page and replace `src/archive/archive.html` in the URL with `src/dev/selftest.html`. It writes only into `<Downloads>/ttarchive-selftest/`, saves and restores the stored folder setting around the run, and has a button to delete everything it wrote.

`src/dev/verify.html` downloads a list of media URLs from the extension's own origin and POSTs the bytes to a local receiver, so the results can be inspected with ffmpeg. It reads its target list from `http://127.0.0.1:8899/targets.json` and needs a CORS-enabled receiver on that port (plain `python -m http.server` will not do — no `Access-Control-Allow-Origin`). To run it, load the extension with a real TikTok tab open in the same profile, then navigate to the page. Also dev-only.
