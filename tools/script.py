#!/usr/bin/env python3
"""
Convert a myfaveTT archive (or an older ttarchive one) to the flat layout.

    <folder>/videos/<id>.mp4
    <folder>/images/<postId>.jpg          a single-image post
    <folder>/images/<postId>_01.jpg       a gallery, numbered in order
    <folder>/audio/<postId>.mp3           a photo post's song, where there is one
    <folder>/archive.json

Photo posts used to get a directory each; they don't any more. An archive
written by an earlier version is migrated in place by the same run, so this is
also the way to flatten `images/<postId>/01.jpg` that's already downloaded.

Drop this file into the archive folder and run it:

    python script.py

It works on the folder it sits in, moves media rather than copying it (instant,
same volume) and never deletes anything. myfaveTT's own `data/.appdata/` and its
covers are left exactly where they are; once you're happy with the result, the
leftover `data/` tree is yours to delete.

    python script.py --dry-run     print the plan, touch nothing
    python script.py --copy        copy instead of moving, keeping myfaveTT working
    python script.py --root PATH   operate on another folder

archive.json records every liked item myfaveTT ever saw, including the ones
TikTok has since deleted. Those files are gone for good, but the metadata is
what survives them.
"""

from __future__ import annotations

import argparse
import base64
import gzip
import json
import os
import re
import shutil
import sys
import time
from pathlib import Path

VERSION = 2

# myfaveTT's databases: data/.appdata/db_<x>.js, each one line of
# `window.<var>_base64 = "<gzip+base64 of JSON>"`.
LEGACY_DBS = {
    "likes": "db_likes.js",
    "videos": "db_videos.js",
    "texts": "db_texts.js",
    "authors": "db_authors.js",
}

B64_IN_JS = re.compile(r'=\s*"([A-Za-z0-9+/=]+)"')

VIDEO_EXTS = {".mp4", ".webm", ".mov"}
IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".webp", ".heic", ".avif", ".gif"}
AUDIO_EXTS = {".mp3", ".m4a", ".aac", ".ogg", ".opus", ".wav"}

# `<postId>.jpg` or `<postId>_01.jpg`. Ids are numeric, so the position suffix
# can be told from the id itself rather than guessed at.
PHOTO_FILE = re.compile(r"^(\d+)(?:_\d+)?$")


def photo_name(post_id: str, index: int, total: int, ext: str) -> str:
    """One image of a photo post, in the flat layout. `index` is 1-based."""
    at = f"_{index:02d}" if total > 1 else ""
    return f"{post_id}{at}{ext}"


def photo_owner(path: Path) -> str | None:
    """The post an images/ file belongs to, or None if the name isn't ours."""
    if path.suffix.lower() not in IMAGE_EXTS:
        return None
    match = PHOTO_FILE.match(path.stem)
    return match.group(1) if match else None


def flatten_post(post: Path, dest: Path):
    """
    (source, destination) for every image in one `images/<postId>/` directory.

    The order on disk is the order of the post — myfaveTT and older versions of
    this project both wrote `01.jpg`, `02.jpg`, … — so position after sorting is
    what the number should carry over, not whatever the old stem happened to be.
    """
    images = sorted(f for f in post.iterdir() if f.is_file() and f.suffix.lower() in IMAGE_EXTS)
    return [
        (src, dest / photo_name(post.name, i, len(images), src.suffix.lower()))
        for i, src in enumerate(images, start=1)
    ]


# --------------------------------------------------------------- reading input


def load_db(appdata: Path, filename: str):
    """Return the parsed JSON of one myfaveTT database, or None."""
    path = appdata / filename
    if not path.is_file():
        return None
    match = B64_IN_JS.search(path.read_text(encoding="utf-8", errors="replace"))
    if not match:
        warn(f"{path.name}: no base64 payload found, skipping")
        return None
    try:
        return json.loads(gzip.decompress(base64.b64decode(match.group(1))))
    except Exception as err:  # noqa: BLE001 — a corrupt DB must not stop the media move
        warn(f"{path.name}: could not decode ({err}), skipping")
        return None


def load_previous_archive(root: Path):
    """Our own metadata from either layout, whichever is present."""
    for candidate in (root / "archive.json", root / "data" / ".ttarchive" / "state.json"):
        if not candidate.is_file():
            continue
        try:
            return json.loads(candidate.read_text(encoding="utf-8"))
        except Exception as err:  # noqa: BLE001
            warn(f"{candidate.name}: unreadable ({err}), ignoring")
    return None


# ------------------------------------------------------------ planning the move


def plan_media(root: Path):
    """
    Work out every file that has to move, as (source, destination) pairs.

    Sources are myfaveTT's `data/Likes/videos` and this project's older
    `data/Likes/photos`, plus any `images/<postId>/` directory left by a version
    of this extension that nested photo posts. Anything already sitting in the
    new location is left alone, so the script is safe to re-run and safe to
    interrupt.
    """
    moves: list[tuple[Path, Path]] = []
    likes = root / "data" / "Likes"
    images = root / "images"

    videos = likes / "videos"
    if videos.is_dir():
        for src in sorted(videos.iterdir()):
            if src.is_file() and src.suffix.lower() in VIDEO_EXTS:
                moves.append((src, root / "videos" / src.name))

    # A directory per photo post, from either source, becomes flat files here.
    photos = likes / "photos"
    if photos.is_dir():
        for post in sorted(photos.iterdir()):
            if post.is_dir():
                moves += flatten_post(post, images)

    if images.is_dir():
        for post in sorted(images.iterdir()):
            if post.is_dir():
                moves += flatten_post(post, images)

    return [(s, d) for s, d in moves if not d.exists()]


def apply_moves(moves, copy: bool, dry_run: bool):
    done = 0
    for src, dst in moves:
        if dry_run:
            done += 1
            continue
        dst.parent.mkdir(parents=True, exist_ok=True)
        try:
            if copy:
                shutil.copy2(src, dst)
            else:
                # Falls back to copy+unlink across filesystems, which is what
                # shutil.move does anyway; the fast path is a rename.
                shutil.move(str(src), str(dst))
        except OSError as err:
            warn(f"{src.name}: {err}")
            continue
        done += 1
        if done % 250 == 0:
            print(f"  … {done}/{len(moves)}", flush=True)
    return done


def prune_empty(root: Path) -> None:
    """
    Remove source directories the move emptied — and only those. `rmdir` fails
    on a non-empty directory, which is exactly the guard wanted here: nothing
    that still holds a file can be removed by this.
    """
    images = root / "images"
    if images.is_dir():
        for path in sorted(p for p in images.iterdir() if p.is_dir()):
            try:
                path.rmdir()
            except OSError:
                pass

    likes = root / "data" / "Likes"
    if not likes.is_dir():
        return
    for path in sorted((p for p in likes.rglob("*") if p.is_dir()), key=lambda p: -len(p.parts)):
        try:
            path.rmdir()
        except OSError:
            pass
    for path in (likes, root / "data"):
        try:
            path.rmdir()
        except OSError:
            pass


# ---------------------------------------------------------------- archive.json


def scan_disk(root: Path, also: list[Path] | None = None):
    """
    id -> file paths, read from the new layout. The disk is the truth.

    `also` lets a dry run count files it has decided to move but hasn't, so the
    summary it prints is the one the real run would produce.
    """
    videos, images, songs = {}, {}, {}
    found: list[Path] = list(also or [])

    for name in ("videos", "images", "audio"):
        d = root / name
        if d.is_dir():
            found += [f for f in d.iterdir() if f.is_file()]

    for f in found:
        if f.parent.name == "videos" and f.suffix.lower() in VIDEO_EXTS:
            videos[f.stem] = f"videos/{f.name}"
        elif f.parent.name == "images":
            post_id = photo_owner(f)
            if post_id:
                images.setdefault(post_id, []).append(f"images/{f.name}")
        # One song per photo post, so no numbered form and nothing to collect
        # into a list — the stem is the post it belongs to.
        elif f.parent.name == "audio" and f.suffix.lower() in AUDIO_EXTS:
            if f.stem.isdigit():
                songs[f.stem] = f"audio/{f.name}"

    return videos, {k: sorted(v) for k, v in images.items()}, songs


def build_authors(raw: dict | None, previous: dict) -> dict:
    authors = dict(previous)
    for author_id, a in (raw or {}).items():
        unique_ids = a.get("uniqueIds") or []
        nicknames = a.get("nicknames") or []
        authors[str(author_id)] = {
            "id": str(author_id),
            "uniqueId": unique_ids[-1] if unique_ids else "",
            "nickname": nicknames[-1] if nicknames else "",
            "uniqueIds": unique_ids,
            "nicknames": nicknames,
            "followerCount": a.get("followerCount", 0),
            "heartCount": a.get("heartCount", 0),
            "videoCount": a.get("videoCount", 0),
        }
    return authors


def build_archive(root: Path, dbs: dict, previous: dict | None, also: list[Path] | None = None):
    """
    Merge three sources into one record per item, in increasing order of trust:
    myfaveTT's databases, our own previous metadata, and the files on disk.
    """
    videos_db = dbs.get("videos") or {}
    texts = dbs.get("texts") or {}
    likes = (dbs.get("likes") or {}).get("likes") or {}
    official = set(str(i) for i in (likes.get("officialList") or []))

    prev_items = (previous or {}).get("items") or {}
    authors = build_authors(dbs.get("authors"), (previous or {}).get("authors") or {})

    on_disk_videos, on_disk_images, on_disk_songs = scan_disk(root, also)

    items: dict[str, dict] = {}

    def ensure(item_id: str) -> dict:
        return items.setdefault(item_id, {"id": item_id, "type": "video", "source": "myfavett"})

    # 1. myfaveTT's video table.
    for item_id, v in videos_db.items():
        item_id = str(item_id)
        author = authors.get(str(v.get("authorId", "")), {})
        item = ensure(item_id)
        item.update(
            {
                "desc": texts.get(item_id) if isinstance(texts.get(item_id), str) else "",
                "createTime": v.get("createTime", 0),
                "author": {
                    "id": str(v.get("authorId", "")),
                    "uniqueId": author.get("uniqueId", ""),
                    "nickname": author.get("nickname", ""),
                },
                "stats": {"diggCount": v.get("diggCount", 0), "playCount": v.get("playCount", 0)},
                "music": {"id": str(v.get("audioId", ""))},
                "sizeText": v.get("size", ""),
            }
        )

    # 2. Ids myfaveTT knew as likes but never had metadata for — still worth a row.
    for item_id in official:
        ensure(item_id)

    # 3. Whatever we recorded ourselves last time wins over the myfaveTT copy:
    #    it came from TikTok's own API rather than myfaveTT's summary of it.
    for item_id, prev in prev_items.items():
        item = ensure(str(item_id))
        item.update({k: v for k, v in prev.items() if k not in ("files", "status", "savedAt")})
        if prev.get("savedAt"):
            item["savedAt"] = prev["savedAt"]

    # 4. The disk decides what is actually here.
    for item_id, path in on_disk_videos.items():
        item = ensure(item_id)
        item["type"] = item.get("type") or "video"
        item["files"] = {"video": path}
    for item_id, paths in on_disk_images.items():
        item = ensure(item_id)
        item["type"] = "photo"
        item["photoCount"] = len(paths)
        item["files"] = {"photos": paths}
    # Merged rather than assigned: the images above are the post, and a song
    # without them is a leftover that shouldn't make the item look downloaded.
    for item_id, path in on_disk_songs.items():
        item = items.get(item_id)
        if item and item.get("files", {}).get("photos"):
            item["files"]["audio"] = path

    for item_id, item in items.items():
        item.setdefault("type", "video")
        item.setdefault("desc", "")
        item.setdefault("createTime", 0)
        item.setdefault("author", {})
        item.setdefault("stats", {})
        item.setdefault("source", "myfavett")
        prev_status = prev_items.get(item_id, {}).get("status")
        if item.get("files"):
            item["status"] = "saved"
        elif prev_status and prev_status != "saved":
            # Our own last run is the better witness: myfaveTT's list can be
            # months old, and an item it never saw is not thereby gone. A stale
            # 'saved' is the one exception — the disk above has just said
            # otherwise, so that one is re-derived below.
            item["status"] = prev_status
        elif official:
            item["status"] = "pending" if item_id in official else "gone"
        else:
            # Without an officialList there is nothing that can say an item has
            # disappeared, so a status already on record is the better answer
            # than re-deriving one from no evidence.
            item["status"] = prev_status or "pending"

    unavailable = sorted(i for i, it in items.items() if it["status"] in ("gone", "unavailable"))

    return {
        "version": VERSION,
        "updatedAt": int(time.time() * 1000),
        "user": (dbs.get("likes") or {}).get("user") or (previous or {}).get("user"),
        "items": dict(sorted(items.items())),
        "authors": authors,
        "likeOrder": (previous or {}).get("likeOrder") or [],
        "unavailable": unavailable,
    }


# ---------------------------------------------------------------------- output


def warn(msg: str) -> None:
    print(f"  ! {msg}", file=sys.stderr)


def dir_size(path: Path) -> tuple[int, int]:
    files = total = 0
    if path.is_dir():
        for dirpath, _, names in os.walk(path):
            for n in names:
                try:
                    total += (Path(dirpath) / n).stat().st_size
                    files += 1
                except OSError:
                    pass
    return files, total


def human(n: int) -> str:
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if n < 1024 or unit == "TB":
            return f"{n:.0f} {unit}" if unit == "B" else f"{n:.1f} {unit}"
        n /= 1024
    return f"{n} B"


def main() -> int:
    ap = argparse.ArgumentParser(description="Convert a myfaveTT archive to the flat layout.")
    ap.add_argument("--root", type=Path, default=Path(__file__).resolve().parent,
                    help="archive folder (default: the folder this script is in)")
    ap.add_argument("--copy", action="store_true", help="copy files instead of moving them")
    ap.add_argument("--dry-run", action="store_true", help="show what would happen, change nothing")
    args = ap.parse_args()

    root: Path = args.root.resolve()
    if not root.is_dir():
        print(f"No such folder: {root}", file=sys.stderr)
        return 1

    print(f"Archive folder: {root}")
    if args.dry_run:
        print("Dry run — nothing will be written.\n")

    appdata = root / "data" / ".appdata"
    dbs = {key: load_db(appdata, name) for key, name in LEGACY_DBS.items()} if appdata.is_dir() else {}
    previous = load_previous_archive(root)

    moves = plan_media(root)

    if not any(dbs.values()) and previous is None and not (root / "data").is_dir() and not moves:
        print("Nothing to convert here: no data/ folder, no myfaveTT databases, no archive.json.")
        print("Is this the right folder? Pass --root PATH if not.")
        return 1

    if any(dbs.values()):
        likes = (dbs.get("likes") or {}).get("likes") or {}
        print(
            f"Found a myfaveTT archive: {likes.get('total', 0)} likes recorded, "
            f"{len(likes.get('downloaded') or [])} downloaded, "
            f"{likes.get('numDisappeared', 0)} already gone from TikTok."
        )
    if previous:
        print(f"Found existing metadata for {len(previous.get('items') or {})} items.")

    verb = "Copying" if args.copy else "Moving"
    if moves:
        print(f"{verb} {len(moves)} media file(s) into videos/ and images/ …")
        moved = apply_moves(moves, copy=args.copy, dry_run=args.dry_run)
        print(f"  {moved} file(s) {'to be ' if args.dry_run else ''}{'copied' if args.copy else 'moved'}.")
        if not args.copy and not args.dry_run:
            prune_empty(root)
    else:
        print("No media left to move — already in the flat layout.")

    archive = build_archive(root, dbs, previous, also=[dst for _, dst in moves] if args.dry_run else None)
    by_status: dict[str, int] = {}
    for item in archive["items"].values():
        by_status[item["status"]] = by_status.get(item["status"], 0) + 1

    out = root / "archive.json"
    if args.dry_run:
        print(f"\nWould write {out} — {len(archive['items'])} items.")
    else:
        # Written via a temporary file so an interrupted run can't leave a
        # half-written archive.json behind in place of a good one.
        tmp = out.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(archive, indent="\t", ensure_ascii=False), encoding="utf-8")
        tmp.replace(out)
        print(f"\nWrote {out} — {len(archive['items'])} items.")

    for status in ("saved", "pending", "gone"):
        if by_status.get(status):
            label = {
                "saved": "on disk",
                "pending": "in your likes, not downloaded",
                "gone": "no longer on TikTok — metadata only",
            }[status]
            print(f"  {by_status[status]:>6}  {label}")

    leftovers = []
    for path, why in (
        (root / "data" / "Likes" / "covers", "myfaveTT cover thumbnails, no longer used"),
        (root / "data" / ".appdata", "myfaveTT's databases, now folded into archive.json"),
    ):
        files, size = dir_size(path)
        if files:
            leftovers.append(f"  {path.relative_to(root)} — {files} files, {human(size)} ({why})")
    if leftovers:
        print("\nLeft in place, safe to delete once you've checked the result:")
        print("\n".join(leftovers))

    return 0


if __name__ == "__main__":
    sys.exit(main())
