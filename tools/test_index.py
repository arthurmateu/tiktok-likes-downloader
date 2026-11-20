#!/usr/bin/env python3
"""
Tests for the parts of tools/index.py that decide what gets read and what gets
kept — none of which needs Whisper or OCR installed.

    python tools/test_index.py
"""

import json
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import index  # noqa: E402


class Text(unittest.TestCase):
    def test_a_caption_read_off_several_frames_is_kept_once(self):
        lines = ["Had to teach my son a", "lesson", "Had to teach my son a", "lesson for spamming", "202.50"]
        self.assertEqual(index.tidy_lines(lines), "Had to teach my son a\nlesson for spamming\n202.50")

    def test_a_caption_split_differently_is_still_one(self):
        self.assertEqual(index.tidy_lines(["QUELLEVA3", "QUE LLEVA 3", "AÑO YA", "AÑOYA"]), "QUELLEVA3\nAÑO YA")

    def test_fragments_and_noise_go(self):
        self.assertEqual(index.tidy_lines(["ck", "th", "ok", "rock star"]), "rock star")

    def test_two_cjk_characters_are_a_word_and_one_is_noise(self):
        self.assertEqual(index.tidy_lines(["口", "日", "東京"]), "東京")

    def test_whispers_phantoms_are_known(self):
        for line in ["Thanks for watching!", "Thank you.", "Subtitles by the Amara.org community", "♪♪", "you",
                     "¡Suscríbete al canal!", "We'll see you next time.", "다음 영상에서 만나요."]:
            self.assertTrue(index.PHANTOMS.search(line), line)
        for line in ["Thank you for the food, mom", "you don't seem that happy"]:
            self.assertFalse(index.PHANTOMS.search(line), line)

    def test_a_watermark_is_kept_once_and_captions_under_it_stay(self):
        def read(text, x, y, h=0.02):
            return index.Read(text, 0.9, x, y, h)
        marks = ["Soyeah"] * 6 + ["Soyear", "Juycah", "Soy sh", "veah"]
        captions = ["first line", "second words", "third bit", "fourth one", "fifth thing",
                    "sixth part", "seventh go", "eighth row", "ninth try", "tenth end"]
        frames = [[read(c, 0.5, 0.75), read(m, 0.8, 0.92)] for c, m in zip(captions, marks)]
        kept = [r.text for frame in index.fixtures(frames) for r in frame]
        self.assertEqual(kept, [captions[0], "Soyeah"] + captions[1:])

    def test_huge_words_in_one_spot_are_not_a_watermark(self):
        words = ["PLEASE", "STOP", "ESCAPE", "REFUSE", "MUSIC", "PLAY"]
        frames = [[index.Read(w, 0.9, 0.5, 0.5, 0.4)] for w in words]
        self.assertEqual([r.text for f in index.fixtures(frames) for r in f], words)

    def test_lines_that_only_name_the_author_go(self):
        names = ["soyeah1", "soyeah"]
        for line in ["@soyeah1", "TikTok", "TikTok @soyeah1", "Soyear", "𝐒𝐨𝐲𝐞𝐚𝐡"]:
            self.assertTrue(index.names_only(line, names), line)
        for line in ["so yeah I went", "MUSIC", "Soyeah's new song is out"]:
            self.assertFalse(index.names_only(line, names), line)

    def test_fold(self):
        self.assertEqual(index.fold("Café, NAÏVE!"), "cafe naive")


class Folder(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix="ttarchive-index-"))
        (self.root / "videos").mkdir()
        (self.root / "images").mkdir()
        for name, size in [("videos/1.mp4", 10), ("videos/2.mp4", 20), ("images/3_01.jpg", 5),
                           ("images/3_02.jpg", 6), ("images/4.jpg", 7), ("images/notes.txt", 1)]:
            (self.root / name).write_bytes(b"x" * size)
        state = {
            "likeOrder": ["3", "9", "1"],
            "items": {"2": {"createTime": 200}, "4": {"createTime": 100}},
        }
        (self.root / "archive.json").write_text(json.dumps(state))
        self.state = state

    def tearDown(self):
        shutil.rmtree(self.root, ignore_errors=True)

    def test_media_comes_from_the_listing(self):
        media = index.media_by_id(self.root)
        self.assertEqual(sorted(media), ["1", "2", "3", "4"])
        self.assertEqual([p.name for p in media["3"]["images"]], ["3_01.jpg", "3_02.jpg"])
        self.assertIsNone(media["3"]["video"])

    def test_newest_likes_first_then_by_post_date(self):
        media = index.media_by_id(self.root)
        self.assertEqual(index.order(self.state, media), ["3", "1", "2", "4"])

    def test_a_changed_file_is_read_again(self):
        media = index.media_by_id(self.root)
        before = index.key_of(media["3"])
        (self.root / "images" / "3_02.jpg").write_bytes(b"y" * 60)
        self.assertNotEqual(before, index.key_of(media["3"]))

    def test_nothing_to_do_needs_nothing_installed(self):
        media = index.media_by_id(self.root)
        items = {pid: {"said": "", "seen": "", "key": index.key_of(media[pid]), "ears": index.EARS, "eyes": index.EYES}
                 for pid in media}
        (self.root / index.FILE).write_text(json.dumps({"version": index.VERSION, "items": items}))
        self.assertEqual(index.main([str(self.root)]), 0)

    def test_a_better_way_of_reading_text_rereads_only_the_text(self):
        media = index.media_by_id(self.root)
        items = {pid: {"said": f"spoken {pid}", "seen": "old", "lang": "en", "key": index.key_of(media[pid]),
                       "ears": index.EARS, "eyes": index.EYES - 1} for pid in media}
        (self.root / index.FILE).write_text(json.dumps({"version": index.VERSION, "items": items}))

        class NoEars:
            def __init__(self, *_):
                raise AssertionError("speech was read again")

        saved = index.Ears, index.Eyes, index.read_post
        index.Ears, index.Eyes, index.read_post = NoEars, object, lambda *_: "new"
        try:
            self.assertEqual(index.main([str(self.root)]), 0)
        finally:
            index.Ears, index.Eyes, index.read_post = saved
        after = json.loads((self.root / index.FILE).read_text())["items"]
        self.assertEqual(after["1"], {"said": "spoken 1", "seen": "new", "lang": "en", "key": items["1"]["key"],
                                      "ears": index.EARS, "eyes": index.EYES})

    def test_refuses_a_folder_that_is_not_an_archive(self):
        (self.root / "archive.json").unlink()
        self.assertEqual(index.main([str(self.root)]), 2)


if __name__ == "__main__":
    unittest.main(verbosity=2)
