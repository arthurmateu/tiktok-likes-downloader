# TikTok Likes Archiver

A browser extension that saves your liked TikToks — videos and photo posts, with their songs — into a folder you choose. No download cap, no paid tier, and nothing leaves your machine: it works through your own TikTok login in the browser.

## Install

For Chrome, Chromium, Edge or Brave:

1. Download or clone this repository.
2. Open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked** and pick the repository folder.
3. Pin the extension, click it, and choose **Open archive**.

To update, pull or download the new version and press the reload button on the extension's card in `chrome://extensions`.

### Optional: the local helper

A small Python script (3.10 or newer) that makes the archive nicer to live with: no folder-permission prompt every session, the Library in an ordinary browser tab, and a **Show in folder** button that opens your file manager on any post. From the repository folder, once:

```bash
python3 tools/helper.py install
```

(On Windows the command is usually `python tools\helper.py install`.) The extension picks it up by itself. `uninstall` removes it again.

On Linux the folder dialog needs `zenity`, `kdialog` or Python's `tkinter`. On Windows, run the install from a terminal opened from the Start menu rather than one inside another app.

## Use

1. On the archive page, **Choose folder…** — where the archive goes. With the helper, an archive you chose before is picked up automatically.
2. Enter your TikTok username and press **Sync likes**. A TikTok tab opens in the background; leave it open and carry on browsing.
3. Sync again whenever you like — it only fetches what's new. **Full sync** (the ▾ beside the button) reads your whole list again, which is also how unliked posts get noticed.

Browse what you've saved in the **Library** tab, or open `viewer.html` in the archive folder — it works without the extension, and on any machine you copy the folder to.

## What ends up in the folder

```
videos/<id>.mp4          one file per video
images/<id>.jpg          a photo post — <id>_01.jpg, <id>_02.jpg … for galleries
audio/<id>.mp3           the song a photo post plays over its images
archive.json             every post you've liked, including ones that have since disappeared
viewer.html              the Library, as a page you can open anywhere
```

Delete a file and the next sync downloads it again. Posts that get deleted or made private can't be downloaded any more, but `archive.json` keeps the caption, author and date of any it saw before they went.

## Coming from myfaveTT

Copy [`tools/script.py`](tools/script.py) into your myfaveTT folder and run `python3 script.py`. It moves the media into this layout and builds `archive.json` from myfaveTT's own records, so nothing is downloaded again. `--dry-run` shows what it would do first.

## Firefox

Firefox 128+ works with limits: the archive has to live inside your downloads folder, and the local helper isn't available. Build it with `python3 tools/build.py`, then load `dist/firefox/manifest.json` from `about:debugging` → **This Firefox** → **Load Temporary Add-on…**, and allow it to access TikTok when the archive page asks.

## Good to know

- TikTok sometimes rate-limits or asks for a captcha. The sync slows down or stops and says so; solve the captcha in the TikTok tab and sync again.
- Some photo-post songs aren't offered by TikTok. **Fetch missing songs** retries them from each post's own page.
- Upgrading from a version before the extension had a fixed id: remove the old card in `chrome://extensions` and **Load unpacked** again.

How it all works, and how it's tested: [docs/internals.md](docs/internals.md).
