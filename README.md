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

Run it again any time. **Sync likes** reads down the list only as far as the point the archive already reaches, so a second sync costs a handful of requests rather than the whole list; the ▾ beside it switches to **Full sync**, which reads to the end. See [Where a sync stops](#where-a-sync-stops). Anything already on disk is skipped either way.

Each completed sync also rewrites `viewer.html` in the folder — the same Library as a file you can double-click, no extension needed. See [viewer.html](#viewerhtml).

## Folder layout

```
<your folder>/
  videos/<videoId>.mp4       one file per video
  images/<postId>.jpg        a single-image post
  images/<postId>_01.jpg     a gallery, one file per image, numbered in order
  audio/<postId>.mp3         the song a photo post plays over its images
  archive.json               every liked item, downloaded or not
  viewer.html                the Library, as a file you can double-click
```

Nothing hidden, nothing nested. Filenames are the TikTok item ID, so writing the same item twice is a no-op, and the **directory listing** — not any database — decides what still needs downloading. Delete a file and the next sync re-fetches it; corrupt `archive.json` and nothing re-downloads.

Only photo posts get an `audio/` file, and only where TikTok gave one: a video's soundtrack is already inside its own mp4, so fetching the track again would be a second request per item for a copy of something the folder has. The Library plays it beside the images. A song that can't be fetched is not a failed item — the pictures are the post — but it is written down rather than passed over in silence: the item gets a `noAudio` saying whether TikTok named no link to the track or the download itself was refused, and a **Full sync** is what tries again.

There are no cover files. A cover is a thumbnail of something you already have, so the Library decodes a frame out of the video instead (a little way in, since TikTok's first frame is usually black) and caches it in memory. Photo posts use their own first image.

### archive.json

Every item that has ever appeared in your likes, whether or not the media could be fetched. Each carries a `status`:

| | |
| --- | --- |
| `saved` | the media is on disk |
| `pending` | in your likes, not downloaded yet |
| `unavailable` | download attempted and failed — expired URL, 403, captcha |
| `gone` | was in your likes once and isn't now: deleted, privated, or unliked |

`gone` is the point of the file. That media is unrecoverable and always was — but the id, author, caption, date and stats are a few hundred bytes each, and they are the only thing that survives the post. A completed sync is what promotes an item to `gone`; a run you stop early never does, because a short list proves nothing, and neither does a run that stopped as soon as it caught up.

`gone` is also the one thing a sync can get *wrong*, so it is guarded. TikTok sometimes ends the list early — `hasMore: false`, no error, nothing to distinguish it from having reached the end — and a run that believes it would write off everything below the cut. What gives it away is where the missing likes are: unliking is scattered through the order, because you unlike a post for what it is, not for when you liked it, while a truncation takes the tail and nothing else. So a completed run that fails to return the deepest 60 likes on record *in one block* is treated as cut short: nothing is marked `gone`, `fullSyncAt` is left alone, and the log says so. See [Where a sync stops](#where-a-sync-stops).

An item may also carry `noAudio`, which is a note rather than a status: the pictures of that photo post are on disk and it is `saved`, but the song over them could not be had, and the value says why. It is cleared the moment a run does come back with the track.

The file also carries `fullSyncAt`, the last time a run did reach the end of the list. It is what lets the next sync stop early — see [Where a sync stops](#where-a-sync-stops) — and `0` on an archive where no run ever has. Beside it, `listLength` records how many likes that run actually read, which is what the next one is compared against and what the log reports back to you.

It's indented JSON at the top level of the folder, so `jq` and a text editor are both fine on it.

### When you liked something

Nothing in TikTok's response says when you liked a post. The only thing that carries that information is the order the likes list comes back in — most recently liked first — so that order is what gets kept, as `likeOrder`: an array of ids, newest like at index 0. Each item's `likeRank` is its index into it, derived from the array on every load so the two can't disagree.

A sync you stop early has only seen the top of the list. Its ids are merged in by anchor rather than appended: an id this run didn't reach keeps its place immediately after whichever id it used to follow, so a partial run corrects the newest likes and leaves the rest of the order alone. An item that has been unliked keeps the position it held, between the two likes it sat between.

An archive last synced before any of this existed has no `likeOrder` at all, and one rebuilt from myfaveTT by `tools/script.py` never gets one — there is nothing in those databases to derive it from. Those items sort last, by post date, which is what the Library did for everything before. One full sync fills it in.

### viewer.html

The archive page lives at a `chrome-extension://` or `moz-extension://` URL, which is not an address anyone wants to keep to hand. So the same Library is written into the folder itself, rewritten after every sync and on demand with **Write viewer.html**. Double-click it and the archive browses itself — search, sort, playback, per-item metadata — with no extension involved. Copy the folder to another machine or a drive and it still opens.

It is one self-contained file because it has to be. A `file://` document gets a unique opaque origin, so it can neither `fetch('archive.json')` nor load a module script from beside itself; the CSS, the JS and a slimmed copy of the metadata are inlined instead. Media is the exception and stays on relative paths — `<img>` and `<video>` load siblings off `file://` without complaint, which is what makes the whole thing work. A 6k-item archive comes out around 3 MB.

It opens in the order you liked things, most recent first — **Recently liked**, with **First liked** for the other end. The two date options sort by when the post was made instead, which is a different question and often a very different order.

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

### Where a sync stops

The list is newest-first, so everything liked since the last sync is above everything already archived. **Sync likes** reads down it until it has passed 120 items in a row that an earlier run had already finished with — four pages — and stops there. A daily sync is then five or six requests instead of two hundred, which is worth more than the time it saves: [every request is attributable to the account](#being-refused), and the cheapest way not to be rate-limited is not to ask.

The content script still reports the whole list it walks; the archive page is what decides it has seen enough, because the decision needs the directory listing and only the archive page has it. "Already finished with" is deliberately stricter than "we have a record of it": an item counts only if its media is on disk, or was fetched and refused (`unavailable`), or had already dropped out of the list (`gone`). Anything still `pending` keeps the run going, so the retry that a second sync exists for cannot be stopped short of the thing it is retrying. The count has to be consecutive, and one unrecognised id resets it — a post you re-liked in among the new ones can't end a run early.

Two things need the end of the list, and they are what **Full sync** is for: noticing what you have unliked, since `gone` is only ever set by a run that reached the end, and retrying failures deeper than an incremental run goes. It is also what the *first* run on any archive does whichever mode is picked — until one run has read the list to the end there is no "already synced up to" to look for, and a folder converted by `tools/script.py` is exactly that case.

### When the end isn't the end

TikTok does not always serve the whole list, and does not say when it hasn't. The reply that ends a run early is the same one that ends it correctly: `hasMore: false`, status 0, no error. On the archive this was found in, a clean **Full sync** stopped 303 likes above where the previous tool had reached, reported success, and wrote off the one item below the cut that had no file on disk to protect it — every other one survived because `markGone` skips anything already downloaded, which is luck rather than design.

So a completed run now has to look plausible before it is believed. The test is *where* the missing likes are rather than how many: unliking is scattered through the order, a truncation takes the deep end and nothing else. A run that fails to return the last 60 likes on record as one unbroken block is treated as cut short — nothing is marked `gone`, `fullSyncAt` and `listLength` keep their old values, and the log says plainly that the list was truncated. Items already `gone` are stepped over rather than counted, or a deletion at the bottom of the list would make every run after it look truncated for good.

The blind spot is the first run: an archive whose *earliest* sync was already truncated has no record of the part it never saw, so nothing can know it is missing. That is what happened here — the wall was there before this tool ever ran, which is why the count is worth reading in the log even when nothing is flagged.

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
| `src/lib/state.js` | Disk scan + `archive.json` load/save/merge, item status, and how far down the list a sync still has to read. |
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

**No watermarks.** `video.playAddr` and `video.downloadAddr` are two different encodes of the same clip. Frames extracted from both show the bouncing "TikTok / @author" watermark burned into `downloadAddr` and a clean image in `playAddr`. The extension selects from `bitrateInfo` (progressive gears only, highest resolution first, bitrate breaking ties) then `playAddr`, and **never** falls back to `downloadAddr` — see the comment in `src/content/collector.js`. Photo-post images carry no watermark at any resolution.

**Progressive gears only — `Format: 'dash'` is video-only.** A `bitrateInfo` gear whose `Format` is `dash` is one representation of the adaptive ladder: picture with no sound track, served from a `media-video-hvc1/` path, its audio held separately in `bitrateAudioInfo` and named by `VideoExtra.audio_file_id`. The file it returns is a complete, playable mp4, so nothing downstream can tell it apart — the archive just gets a silent copy. Selection skips these gears **before** ranking. A missing `Format` is never treated as dash: payloads older than the adaptive ladder don't carry the field and are all progressive. `playAddr` is itself the progressive gear, so the fallback at the end of the list is always muxed.

**Highest resolution, not highest bitrate.** Ranking the `bitrateInfo` gears by bitrate — what this did until 2026-08-02 — picks the h264 540/720 rung over the h265 1080 one whenever HEVC's efficiency puts the latter lower in bits per second. Read off a live feed, 16 of 29 videos had a higher-resolution gear than the bitrate winner. Selection sorts on `PlayAddr.Width × Height` first, bitrate breaking ties.

Resolution-first ranking on its own walked straight into the dash gears, because the dash ladder is where the 1080 rungs usually are — that shipped on 2026-08-02 and cost four silent files before the `Format` check was added. `7669983946771336462` is the worked example: gears are `normal_720_0` (mp4, 720×1280, 28,296,121 B) and `adapt_lowest_1080_1` (dash, 1080×1920, 15,450,455 B), and the silent file in the archive was 15,450,455 bytes to the byte. Reading the first 256 KB of each confirms it — the dash `moov` carries a `vide` handler and no `soun`/`mp4a`, the mp4 one carries both.

**The download is checked for sound, not just for being an mp4.** Gear selection reads fields TikTok owns and can rename, so it can't be the only thing standing between the archive and a silent file — and nothing else noticed: a video-only stream has the right magic bytes, the right content type, and plays. `fetchFirst` now takes a `prefer` predicate, and video downloads pass `hasAudioTrack`, which walks the top-level boxes to `moov` and looks for an `hdlr` declaring `soun`. Unlike `expect`, `prefer` is a preference: a candidate that fails it is held while the rest get a turn and handed back if none does better, so a post whose audio really is missing everywhere still archives rather than failing. Misses are capped at two, because each one costs a whole media download. A file that can't be parsed counts as passing — "cannot tell" is not grounds for discarding a download.

So the 1080 rung is only taken when it exists as a progressive gear. Where it doesn't, the download lands on `normal_720_0` and gives up the resolution rather than the sound; recovering both would mean fetching the dash video and its `bitrateAudioInfo` track and muxing them, which needs a muxer the extension doesn't have. The practical cost of the ranking is that many files land as h265/hvc1 rather than h264 — fine in Chromium and in the Library viewer, but older players and Firefox before 134 may not decode them.

**Photo `urlList` entries are mirrors, not sizes.** Each image's `urlList` holds the same `~tplv-photomode-image.jpeg` asset on two CDN hosts (`p16-…`, `p19-…`), with no resize suffix, so taking the first one that answers cannot silently downgrade an image. Covers are never fetched at all.

Two things this testing established that shape the code:

- **Media URLs are bound to the browser session that obtained them.** A URL harvested in one browser profile returns HTTP 403 in another, even seconds later with identical headers. This is fine for normal use — the extension harvests and downloads in the same profile — but it is why `fetchFirst` sends `credentials: 'include'`, and why a URL you copy out of the log won't work in curl or another browser.
- **A challenged request returns HTTP 200 with TikTok's captcha page.** Before this was caught, a 33 KB HTML page was written to disk as an `.mp4` and counted as a successful download. `fetchFirst` checks magic bytes (`ftyp` for video, JPEG/PNG/WebP/GIF/HEIC for images) and rejects anything that isn't really media. A body that is *not* media but also isn't HTML is a stale mirror, and the next mirror gets a turn; a body that looks like a challenge page stops the whole run instead — see [Being refused](#being-refused).

Not yet verified end-to-end: the Liked-tab harvest in either mode, which needs a logged-in account. Background paging in particular rests on an untested assumption — that TikTok accepts a captured `item_list` URL with the cursor swapped. If it doesn't, the run says so in the log and falls back to scrolling, so the failure mode is the old behaviour rather than a broken sync.

## Known limits

- **Deleted / privated items can't be recovered, and most of them can't even be named.** They never appear in the list responses. Your myfaveTT DB counts 1,995 of them in `numDisappeared` — but that is all it kept: a number. The ids are not in `db_likes.js`, `db_videos.js` or anywhere else in `data/.appdata`, so there is nothing for `tools/script.py` to carry over, and `archive.json` has no record of those 1,995 posts. Only items that were still in the likes list when something read it can ever become `gone`.
- **A photo post's song is sometimes not downloadable.** The pictures are the post and they still archive; the track is a bonus that TikTok does not always serve — licensed music often comes back with no `playUrl` at all, and an old post's sound goes away with the upload it was taken from. Those posts record `noAudio` in `archive.json` saying which of the two it was, and the Library says so under the title instead of showing an empty player. A **Full sync** re-attempts them; **Sync likes** does not, since a post whose pictures are on disk is one an earlier run finished with.
- **Media URLs are signed and expire.** Downloads run concurrently with the list read to stay ahead of it, but on a very large first run some may still time out. They're logged as failures; run **Sync likes** again and only the missing files are retried — for ones deeper in the list than an incremental run reaches, **Full sync**.
- **No `total` from TikTok.** The progress bar is seeded from your previous item count, so it's an estimate until the run ends.
- Bookmarks, Following, and audio extraction are not implemented. The plumbing is there (`collector.js` already recognises the bookmarks tab) if you want them later.

## Development

`syntaxcheck.html` loads every module against a stub `chrome` API to catch parse and top-level errors without installing the extension:

```bash
python -m http.server 8777
```

Then open `http://127.0.0.1:8777/syntaxcheck.html`. Add `?gecko` to make it stub `browser.*` and hide `showDirectoryPicker`, so the Firefox backend is the one that gets selected and evaluated. It is dev-only and not referenced by the extension.

`src/dev/backends.html` unit-tests the Gecko backend against a faked download history and a faked directory pick — path arithmetic, the history/snapshot union, filename sanitising, the `archive.json` mirror. Serve the repo as above and open `http://127.0.0.1:8777/src/dev/backends.html`; it prints pass/fail and needs no browser extension loaded.

`src/dev/paging.html` runs `hook.js` and `collector.js` against a fake `item_list` endpoint — the only way to exercise the list harvest without a logged-in account. It covers what breaks quietly: that background paging replays the captured URL by cursor rather than making the page scroll, that each replay picks up the current `msToken` and is re-signed for its own cursor, that a refused replay falls back to scrolling and still returns the same list, and that a second sync in the same tab reports the whole list again instead of only what changed. Its last two sections cover the opposite case — that a captcha and a 429 *don't* fall back to scrolling, that a rate-limited page is retried at the same cursor with a growing wait rather than skipped, and that the halt reaches the download side. Back-off is measured against the wall clock, so those tests speed `Date.now` up rather than shortening the intervals in the code. Open `http://127.0.0.1:8777/src/dev/paging.html`.

`src/dev/throttle.html` unit-tests `src/lib/throttle.js` and `fetchFirst` against a scripted `fetch`. The behaviour it covers is almost entirely about requests *not* made — that a 429 stops the round instead of walking the remaining mirrors, that four parallel downloads meeting one limit back off once rather than four times, that a challenge page throws before trying anything else and under any content type, that a halted or stopped item is never marked `unavailable`, and that an ordinary 404 still walks the mirror list exactly as it used to. Open `http://127.0.0.1:8777/src/dev/throttle.html`.

`src/dev/thumbs.html` tests the Library against a folder that exists only in memory: an import map swaps `src/dev/fake-fs.js` in for `src/lib/fs.js`, so `state.js` and `viewer.js` run exactly as shipped. It matters most for video thumbnails, which are now decoded frames rather than files — the sample clip inlined in the page is black for its first 0.2 s and colour bars after, so "we took frame 0" fails as a real assertion rather than a flaky one. Open `http://127.0.0.1:8777/src/dev/thumbs.html`.

`src/dev/likeorder.html` covers the like order — the merge in `state.js` and the sort in the Library, against a folder that exists only in memory. The merge is the part worth testing: a run that ends early sees only the top of the list, and folding that prefix into the order already on record has to correct the newest likes without quietly reshuffling everything below them. It also checks the fallback, since an archive that hasn't been synced since this existed has no order at all and has to keep sorting by post date. Open `http://127.0.0.1:8777/src/dev/likeorder.html`.

`src/dev/incremental.html` covers where an incremental sync is allowed to stop — `isSettled` and `settledStreak` in `state.js`, against a seeded in-memory folder. Both mistakes here are silent: too loose and a sync stops above likes it never archived, too strict and every run walks the whole list again, which is the thing this exists to end. So it checks the cases that decide it — a `pending` item holding the run open where an `unavailable` or `gone` one doesn't, a part-downloaded gallery counting as unfinished, one unknown id resetting the count mid-page, and the count surviving being handed a page at a time. Open `http://127.0.0.1:8777/src/dev/incremental.html`.

`src/dev/songs.html` covers what happens when a photo post's song can't be had, which is a failure that goes out of its way to look like nothing. The pictures are the post and they are already on disk, so the item stays `saved`, the run stays green, and the only trace is a post that plays no music — which is how 58 posts in a 794-post archive ended up with no track and no explanation. It stubs `fetch` and runs `downloader.js` and `state.js` as shipped against an in-memory folder, and asserts the record that gets written rather than the download: a refused track is written off on the item without making the post `unavailable` or the run report a failure, a note is cleared the moment the track does turn up, and a payload naming a song with no link in it is caught by `noteAbsentSongLink` — the case the downloader never sees, because `missingParts` asks only for audio it has a URL for, so the queue skips the item outright. Open `http://127.0.0.1:8777/src/dev/songs.html`.

`src/dev/syncmode.html` drives the split **Sync likes ▾** button, which is the one control on the archive page whose state lives in three places at once — the button's label, the tick in the menu, and the flag the click reads — and nothing notices when those disagree. It fetches `archive.html` and mounts the real markup rather than a copy, so an id renamed there fails here instead of quietly testing something that no longer ships, then imports `archive.js` against the same stub `chrome` API `syntaxcheck.html` uses. Open `http://127.0.0.1:8777/src/dev/syncmode.html`.

`src/dev/viewer.html` builds a `viewer.html` from sample state and checks the inlining, which is the part that goes wrong once and silently in someone's folder. A caption is arbitrary text from TikTok, and the fixture's caption carries the three sequences that break a naive generator: `</script>`, which ends the element it sits in; `$&`, which `String.replace` reads out of a *replacement*; and U+2028, a line terminator to a JavaScript parser but not to JSON. The result is rendered into a `blob:` iframe, whose origin is opaque like a `file://` document's. Open `http://127.0.0.1:8777/src/dev/viewer.html`.

`src/dev/selftest.html` answers what a stubbed API can't, by running inside the loaded extension: whether a credentialed fetch from `moz-extension://` carries TikTok's cookies, whether a root-level `archive.json` lands where it was asked to, whether `conflictAction: 'overwrite'` really overwrites instead of uniquifying to `probe(1).txt`, whether `downloads.search` returns paths in the shape `refresh()` parses, and whether the `world: "MAIN"` hook actually installed. Build with `python tools/build.py firefox --dev`, then open the archive page and replace `src/archive/archive.html` in the URL with `src/dev/selftest.html`. It writes only into `<Downloads>/ttarchive-selftest/`, saves and restores the stored folder setting around the run, and has a button to delete everything it wrote.

`src/dev/verify.html` downloads a list of media URLs from the extension's own origin and POSTs the bytes to a local receiver, so the results can be inspected with ffmpeg. It reads its target list from `http://127.0.0.1:8899/targets.json` and needs a CORS-enabled receiver on that port (plain `python -m http.server` will not do — no `Access-Control-Allow-Origin`). To run it, load the extension with a real TikTok tab open in the same profile, then navigate to the page. Also dev-only.
