#!/usr/bin/env python3
"""
Reads what is said and what is written in every post of an archive, so the
Library's search can find a post by either.

    pip install -r tools/requirements-index.txt     # once
    python3 tools/index.py "/path/to/archive"

Speech is transcribed with Whisper (faster-whisper) and on-screen text read
with OCR (RapidOCR) off frames every half second of each video and every image of a
photo post. Everything runs on this machine; nothing is uploaded anywhere.

The result is transcripts.json in the archive folder, beside archive.json:

    {"version": 1, "items": {"<id>": {"said": "...", "seen": "...", "ears": 1, "eyes": 2,
                                      "lang": "en", "key": "..."}}}

It is incremental. A post already read is skipped unless its files changed
(`key` records their sizes), newest likes go first, and progress is saved as
it goes, so stopping it with Ctrl+C loses at most a few posts. Run it again
after a sync to read the new likes — or let the helper do that: once
transcripts.json exists, it starts this after every sync.

A post with nothing to read still gets an entry, empty, so it isn't tried again.

Options:
    --model NAME     Whisper model (default: large-v3-turbo on a CUDA GPU, small otherwise)
    --cpu            don't use the GPU even if there is one
    --limit N        stop after N posts
    --redo           read every post again, not just new or changed ones
    --json           progress as JSON lines on stdout, for the helper
"""

import argparse
import json
import os
import re
import signal
import sys
import threading
import time
import unicodedata
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

VERSION = 1
FILE = "transcripts.json"
STATE = "archive.json"

# Saved this often, and at the end: a crash or Ctrl+C costs at most this much.
SAVE_EVERY = 60.0

# Frames read for on-screen text: one every FRAME_EVERY seconds, spread wider
# on a clip long enough to need more than FRAMES_MAX. Edits flash a caption per
# line, often for under a second: reading every second instead loses about a
# fifth of the words, and one every three seconds lost most of them. OCR is
# nearly all the cost, about a tenth of a second a frame on a desktop CPU.
FRAME_EVERY = 0.5
FRAMES_MAX = 240

# Raise when the way text or speech is read improves, so the next run reads
# every post again with it. Posts keep what the other one read.
EYES = 2
EARS = 1

# OCR reads at this height. TikTok's captions are large; full 1080p or 4K
# frames cost several times as much to read for nothing more.
OCR_HEIGHT = 960

# A line read with less confidence than this is more likely noise — a pattern
# on a shirt, a blurred sign — than text anyone meant to be read.
OCR_MIN_SCORE = 0.75

# Whisper writes these over silence and music. They come from the subtitles it
# was trained on, not from the clip.
PHANTOMS = re.compile(
    r"thank(s| you) (so much )?for watching|please subscribe|subscribe to (my|the) channel|"
    r"amara\.org|subtitles by|legendas pela comunidade|obrigad[oa] por assistir|"
    r"sous-titr|untertitel (der|von|im)|продолжение следует|субтитры|ご視聴ありがとうございました|"
    r"字幕|suscr[ií]bete al canal|^\W*(i'll|we'll) see you (in the )?next (time|video)\W*$|다음 영상에서 만나요|"
    r"^\W*(you|bye|thank you|thanks|\.\.\.|♪+|music)\W*$",
    re.IGNORECASE,
)


def say(*args):
    print(*args, file=sys.stderr, flush=True)


# ------------------------------------------------------------------ the folder


def load_json(path: Path) -> dict:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, ValueError):
        return {}


def save_json(path: Path, value: dict) -> None:
    """Whole or not at all: the Library may read it while this is running."""
    part = path.with_name(path.name + ".part")
    part.write_text(json.dumps(value, ensure_ascii=False, indent=1), encoding="utf-8")
    for attempt in range(20):
        try:
            os.replace(part, path)
            return
        except PermissionError:
            # Windows refuses while the helper is sending the old copy.
            time.sleep(0.25)
    os.replace(part, path)


def media_by_id(root: Path) -> dict:
    """Every post's files, from the directory listing — the same source of truth the extension uses."""
    out = {}
    videos = root / "videos"
    if videos.is_dir():
        for f in videos.iterdir():
            if f.suffix.lower() == ".mp4":
                out.setdefault(f.stem, {"video": None, "images": []})["video"] = f
    images = root / "images"
    if images.is_dir():
        for f in sorted(images.iterdir()):
            if f.suffix.lower() not in (".jpg", ".jpeg", ".png", ".webp"):
                continue
            owner = re.sub(r"_\d+$", "", f.stem)
            out.setdefault(owner, {"video": None, "images": []})["images"].append(f)
    return out


def order(state: dict, media: dict) -> list:
    """Newest like first: what someone is likeliest to look for is what they liked last."""
    seen, out = set(), []
    for pid in state.get("likeOrder") or []:
        if pid in media and pid not in seen:
            seen.add(pid)
            out.append(pid)
    rest = [pid for pid in media if pid not in seen]
    created = lambda pid: (state.get("items", {}).get(pid) or {}).get("createTime") or 0
    out.extend(sorted(rest, key=created, reverse=True))
    return out


def key_of(files: dict) -> str:
    paths = ([files["video"]] if files["video"] else []) + files["images"]
    return f"{VERSION}:" + ",".join(str(p.stat().st_size) for p in paths)


# ------------------------------------------------------------------ text


def fold(text: str) -> str:
    text = unicodedata.normalize("NFKD", text)
    text = "".join(c for c in text if not unicodedata.combining(c))
    return re.sub(r"[^\w]+", " ", text.casefold()).strip()


def tidy_lines(lines) -> str:
    """One line each, in the order first seen, without the repeats a caption makes across frames."""
    kept, seen = [], []
    for line in lines:
        line = " ".join(line.split())
        f = fold(line)
        # Two letters is a piece of a word the camera cut off, or a logo, not
        # something to search for. CJK packs a word into fewer characters, so two
        # of them are kept \u2014 but not one, which OCR reads off any box or bar.
        cjk = re.search(r"[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]", f)
        if len(f) < (2 if cjk else 3):
            continue
        # The same caption read off two frames often differs by a letter, or one
        # read is a piece of another.
        if any(f == s or (len(f) > 3 and (f in s or s in f)) for s in seen):
            if not any(s in f and s != f for s in seen):
                continue
            # A longer read of something already kept replaces it.
            for i, s in enumerate(seen):
                if s in f:
                    seen[i], kept[i] = f, line
                    break
            continue
        seen.append(f)
        kept.append(line)
    return "\n".join(kept)


# ------------------------------------------------------------------ engines


def add_cuda_dlls() -> None:
    """
    On Windows, CTranslate2 needs cuBLAS and cuDNN, which the nvidia-*-cu12
    wheels in requirements-index.txt install as packages rather than anywhere
    Windows looks for a DLL.
    """
    if sys.platform != "win32":
        return
    for base in sys.path:
        nvidia = Path(base) / "nvidia"
        if nvidia.is_dir():
            for lib in nvidia.iterdir():
                b = lib / "bin"
                if b.is_dir():
                    os.add_dll_directory(str(b))
                    os.environ["PATH"] = str(b) + os.pathsep + os.environ.get("PATH", "")


def has_cuda() -> bool:
    try:
        import ctranslate2

        return ctranslate2.get_cuda_device_count() > 0
    except Exception:
        return False


class Ears:
    def __init__(self, model: str | None, cpu: bool):
        add_cuda_dlls()
        from faster_whisper import WhisperModel

        gpu = not cpu and has_cuda()
        self.name = model or ("large-v3-turbo" if gpu else "small")
        self.device = "cuda" if gpu else "cpu"
        try:
            self.model = WhisperModel(self.name, device=self.device, compute_type="float16" if gpu else "int8")
            # A CUDA install with a missing DLL loads fine and fails on first use.
            if gpu:
                import numpy as np

                list(self.model.transcribe(np.zeros(16000, dtype=np.float32))[0])
        except Exception as err:
            if not gpu:
                raise
            say(f"GPU unavailable ({err}); using the CPU")
            self.name, self.device = model or "small", "cpu"
            self.model = WhisperModel(self.name, device="cpu", compute_type="int8")

    def hear(self, path: Path):
        audio = soundtrack(path)
        if audio is None or len(audio) < 16000 // 2:
            return "", ""
        segments, info = self.model.transcribe(
            audio,
            vad_filter=True,
            # Each window on its own: carrying the previous text over is what lets
            # Whisper repeat one line for the rest of a song.
            condition_on_previous_text=False,
            beam_size=5,
        )
        lines = []
        for s in segments:
            text = s.text.strip()
            if not text or s.no_speech_prob > 0.6 or s.avg_logprob < -1.0 or PHANTOMS.search(text):
                continue
            # The same line over and over is a loop, not a chorus worth keeping.
            if lines and fold(lines[-1]) == fold(text):
                continue
            lines.append(text)
        said = " ".join(lines)
        return said, (info.language if said else "")


def soundtrack(path: Path):
    """
    The clip's sound as Whisper takes it: 16 kHz mono float samples. Decoded
    here rather than by faster-whisper, whose own decoder follows PyAV's API of
    the day and breaks when that changes.
    """
    import av
    import numpy as np

    with av.open(str(path)) as box:
        stream = next((s for s in box.streams.audio), None)
        if stream is None:
            return None
        resampler = av.AudioResampler(format="s16", layout="mono", rate=16000)
        chunks = []
        try:
            for frame in box.decode(stream):
                for out in resampler.resample(frame):
                    chunks.append(out.to_ndarray().reshape(-1))
            for out in resampler.resample(None):
                chunks.append(out.to_ndarray().reshape(-1))
        except av.error.FFmpegError:
            pass  # a damaged tail: transcribe what decoded
    if not chunks:
        return None
    return np.concatenate(chunks).astype(np.float32) / 32768.0


class Eyes:
    def __init__(self):
        from rapidocr import RapidOCR

        # No angle classifier: TikTok's text is upright, and it costs a sixth of the time.
        params = {"Global.log_level": "critical", "Global.use_cls": False}
        self.engine = RapidOCR(params=params) if _takes_params() else RapidOCR()

    def read(self, img) -> list:
        res = self.engine(img)
        txts = getattr(res, "txts", None) or ()
        scores = getattr(res, "scores", None) or ()
        boxes = getattr(res, "boxes", None)
        out = []
        for i, (t, s) in enumerate(zip(txts, scores)):
            if s >= OCR_MIN_SCORE and t.strip():
                y = float(boxes[i][0][1]) if boxes is not None else i
                out.append((y, t.strip()))
        # Top to bottom, the way a caption is read.
        return [t for _, t in sorted(out)]


def _takes_params() -> bool:
    import inspect
    from rapidocr import RapidOCR

    try:
        return "params" in inspect.signature(RapidOCR.__init__).parameters
    except (TypeError, ValueError):
        return False


def frames(path: Path):
    """Frames through the clip, scaled down, as RGB arrays; see FRAME_EVERY."""
    import av

    with av.open(str(path)) as box:
        stream = next((s for s in box.streams.video), None)
        if stream is None:
            return
        stream.thread_type = "AUTO"
        duration = float(box.duration or 0) / av.time_base if box.duration else 0.0
        step = max(FRAME_EVERY, duration / FRAMES_MAX)
        fps = float(stream.average_rate or 30)
        due = 0.0
        try:
            for i, frame in enumerate(box.decode(stream)):
                t = frame.time if frame.time is not None else i / fps
                if t < due:
                    continue
                due = t + step
                h = frame.height
                if h > OCR_HEIGHT:
                    frame = frame.reformat(width=round(frame.width * OCR_HEIGHT / h) // 2 * 2, height=OCR_HEIGHT)
                yield frame.to_ndarray(format="rgb24")
        except av.error.FFmpegError:
            return  # a damaged tail: read what decoded


def again(fn, *args):
    """
    Once more after a moment if the file couldn't be opened: on Windows a virus
    scan, or the Library playing the same file, can hold it for a second.
    """
    try:
        return fn(*args)
    except OSError:
        time.sleep(2)
        return fn(*args)


def read_post(eyes: Eyes, files: dict) -> str:
    lines = []
    if files["video"]:
        for img in frames(files["video"]):
            lines.extend(eyes.read(img))
    for f in files["images"]:
        lines.extend(eyes.read(str(f)))
    return tidy_lines(lines)


# ------------------------------------------------------------------ the run


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description="Read speech and on-screen text into transcripts.json.")
    p.add_argument("folder", type=Path, help="the archive folder, the one holding archive.json")
    p.add_argument("--model")
    p.add_argument("--cpu", action="store_true")
    p.add_argument("--limit", type=int, default=0)
    p.add_argument("--redo", action="store_true")
    p.add_argument("--json", action="store_true")
    args = p.parse_args(argv)

    root = args.folder.expanduser().resolve()
    if not (root / STATE).is_file():
        say(f"{root} has no {STATE}: point this at the archive folder.")
        return 2

    def report(**fields):
        if args.json:
            print(json.dumps(fields), flush=True)

    out_path = root / FILE
    data = load_json(out_path)
    if data.get("version") != VERSION:
        data = {"version": VERSION, "items": {}}
    done = data["items"]

    state = load_json(root / STATE)
    media = media_by_id(root)
    todo = []
    for pid in order(state, media):
        try:
            k = key_of(media[pid])
        except OSError:
            continue
        had = done.get(pid) or {}
        if args.redo or had.get("key") != k:
            todo.append((pid, k, True, True))
        else:
            # Same files, read by an older way of reading one side or both.
            ears_old = had.get("ears", 1) < EARS
            eyes_old = had.get("eyes", 1) < EYES
            if ears_old or eyes_old:
                todo.append((pid, k, ears_old, eyes_old))
    if args.limit:
        todo = todo[: args.limit]
    report(event="start", total=len(todo), indexed=len(done))
    if not todo:
        say("Every post is already read.")
        report(event="done", read=0, total=0)
        return 0

    try:
        ears = Ears(args.model, args.cpu) if any(hear for _, _, hear, _ in todo) else None
        eyes = Eyes()
    except ImportError as err:
        say(f"Missing {err.name}: pip install -r {Path(__file__).with_name('requirements-index.txt')}")
        report(event="error", error="missing-packages")
        return 3
    speech = f"speech with Whisper {ears.name} on the {ears.device.upper()}, " if ears else ""
    say(f"Reading {len(todo)} posts: {speech}text with RapidOCR.")

    stop = threading.Event()
    signal.signal(signal.SIGINT, lambda *_: stop.set())
    if hasattr(signal, "SIGTERM"):
        signal.signal(signal.SIGTERM, lambda *_: stop.set())

    # Speech runs on the GPU and text on the CPU, so each post's text is read
    # while its speech is transcribed.
    pool = ThreadPoolExecutor(max_workers=1)
    started = last_save = time.monotonic()
    count = failed = 0
    try:
        for pid, k, hear, look in todo:
            if stop.is_set():
                break
            files = media[pid]
            had = done.get(pid) or {}
            seen_job = pool.submit(again, read_post, eyes, files) if look else None
            said, lang, ok = had.get("said", ""), had.get("lang", ""), True
            if hear:
                said, lang = "", ""
            if hear and files["video"]:
                try:
                    said, lang = again(ears.hear, files["video"])
                except Exception as err:
                    say(f"{pid}: could not transcribe ({err})")
                    ok = False
            try:
                seen = seen_job.result() if seen_job else had.get("seen", "")
            except Exception as err:
                say(f"{pid}: could not read text ({err})")
                ok = False
            if not ok:
                # Left out rather than saved empty, so the next run tries it again.
                failed += 1
                continue
            entry = {"said": said, "seen": seen, "key": k, "ears": EARS, "eyes": EYES}
            if lang:
                entry["lang"] = lang
            done[pid] = entry
            count += 1

            rate = count / max(1e-6, time.monotonic() - started)
            left = (len(todo) - count) / rate if rate else 0
            say(f"[{count}/{len(todo)}] {pid}  {len(said):>5} said  {len(seen):>4} seen  ~{left / 60:.0f} min left")
            report(event="progress", read=count, total=len(todo))
            if time.monotonic() - last_save > SAVE_EVERY:
                data["updatedAt"] = int(time.time() * 1000)
                save_json(out_path, data)
                last_save = time.monotonic()
    finally:
        pool.shutdown(wait=True)
        data["updatedAt"] = int(time.time() * 1000)
        save_json(out_path, data)
    report(event="done", read=count, failed=failed, total=len(todo), stopped=stop.is_set())
    say(f"Read {count} posts in {(time.monotonic() - started) / 60:.1f} min. Saved to {out_path}.")
    if failed:
        say(f"{failed} could not be read and will be tried again next time.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
