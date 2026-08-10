/**
 * Media downloader.
 *
 * Runs from the archive page (extension origin) rather than a content script:
 * since Chrome 85 content-script fetches obey the page's CORS, but extension
 * pages get host-permission-based access. The Referer the CDN wants is added by
 * the declarativeNetRequest rule in rules/dnr.json.
 *
 * Downloads run *while* harvesting, on purpose — TikTok's playAddr URLs are
 * signed and short-lived, so sitting on a full list for 20 minutes before
 * fetching is how you end up with a pile of 403s.
 */

import { LAYOUT, photoName, writeFile } from './fs.js';
import { disk, missingParts, markNoAudio, markSaved, markUnavailable } from './state.js';
import { Guard, Halt, classifyStatus, retryAfterMs } from './throttle.js';

const EXT_BY_TYPE = {
	'image/jpeg': 'jpg',
	'image/jpg': 'jpg',
	'image/webp': 'webp',
	'image/png': 'png',
	'image/heic': 'heic',
	'image/avif': 'avif',
	'video/mp4': 'mp4',
	'audio/mpeg': 'mp3',
	'audio/mp3': 'mp3',
	'audio/mp4': 'm4a',
	'audio/x-m4a': 'm4a',
	'audio/aac': 'aac',
};

function extFor(blob, url, fallback) {
	const byType = EXT_BY_TYPE[(blob.type || '').split(';')[0].toLowerCase()];
	if (byType) return byType;
	const m = String(url).split('?')[0].match(/\.([a-z0-9]{2,5})$/i);
	if (m && m[1].length <= 5) return m[1].toLowerCase() === 'jpeg' ? 'jpg' : m[1].toLowerCase();
	return fallback;
}

/**
 * Magic-byte signatures. Needed because the CDN answers a challenged request
 * with TikTok's captcha page under HTTP 200 — without this check that HTML gets
 * written to disk as a .mp4 and looks like a successful download.
 */
const MAGIC = {
	video: [
		[4, [0x66, 0x74, 0x79, 0x70]], // 'ftyp' at offset 4 (ISO-BMFF / mp4)
		[0, [0x1a, 0x45, 0xdf, 0xa3]], // EBML (webm)
	],
	image: [
		[0, [0xff, 0xd8, 0xff]], // JPEG
		[0, [0x89, 0x50, 0x4e, 0x47]], // PNG
		[0, [0x52, 0x49, 0x46, 0x46]], // RIFF (webp)
		[4, [0x66, 0x74, 0x79, 0x70]], // HEIC/AVIF
		[0, [0x47, 0x49, 0x46, 0x38]], // GIF
	],
	audio: [
		[0, [0x49, 0x44, 0x33]], // 'ID3' — an mp3 carrying a tag
		[4, [0x66, 0x74, 0x79, 0x70]], // 'ftyp' — AAC in an MP4 container (.m4a)
		// A bare MPEG frame: the sync word is eleven set bits, so only the first
		// byte and the top three of the second are fixed. A predicate rather than a
		// row of the table, since the rest of the byte is layer and bitrate.
		(head) => head[0] === 0xff && (head[1] & 0xe0) === 0xe0,
	],
};

async function looksLike(blob, kind) {
	if (!kind || !MAGIC[kind]) return true;
	const head = new Uint8Array(await blob.slice(0, 16).arrayBuffer());
	return MAGIC[kind].some((sig) =>
		typeof sig === 'function' ? sig(head) : sig[1].every((b, i) => head[sig[0] + i] === b)
	);
}

/**
 * Walk the top-level ISO-BMFF boxes and hand back the payload of the first one
 * named `wanted`, or null. Reads only box headers, so the file never has to be
 * pulled into memory whole to find a box near the front.
 */
async function topLevelBox(blob, wanted) {
	for (let at = 0; at + 8 <= blob.size; ) {
		const head = new DataView(await blob.slice(at, at + 16).arrayBuffer());
		if (head.byteLength < 8) return null;
		let size = head.getUint32(0);
		let headerLen = 8;
		const type = String.fromCharCode(head.getUint8(4), head.getUint8(5), head.getUint8(6), head.getUint8(7));
		if (size === 1) {
			// 64-bit size, in a `largesize` field sitting where the payload would be.
			if (head.byteLength < 16) return null;
			size = Number(head.getBigUint64(8));
			headerLen = 16;
		} else if (size === 0) {
			size = blob.size - at; // box runs to end of file
		}
		if (size < headerLen) return null; // malformed: a box can't be shorter than its header
		if (type === wanted) return blob.slice(at + headerLen, at + size);
		at += size;
	}
	return null;
}

/**
 * Does this mp4 actually carry sound?
 *
 * TikTok's adaptive `Format: 'dash'` gears are video-only, and the file one
 * returns is a perfectly well-formed mp4 — right magic bytes, right content
 * type, plays fine, silent. The collector no longer picks those, but selection
 * reads fields TikTok owns and can rename, so this is the check that does not
 * depend on getting that right: it looks at what actually arrived.
 *
 * A `moov` holds one `hdlr` per track naming that track's type; an audio track
 * declares `soun`. Unparseable input returns true rather than false — the
 * question is "did we demonstrably get a picture-only file", and "cannot tell"
 * is not a reason to throw away a download.
 */
async function hasAudioTrack(blob) {
	const moov = await topLevelBox(blob, 'moov');
	if (!moov) return true;
	const b = new Uint8Array(await moov.arrayBuffer());
	// 'hdlr' at i puts the box header at i-4, and handler_type 16 bytes into the
	// box: size(4) type(4) version+flags(4) pre_defined(4).
	for (let i = 0; i + 16 <= b.length; i++) {
		if (b[i] === 0x68 && b[i + 1] === 0x64 && b[i + 2] === 0x6c && b[i + 3] === 0x72) {
			if (b[i + 12] === 0x73 && b[i + 13] === 0x6f && b[i + 14] === 0x75 && b[i + 15] === 0x6e) return true;
		}
	}
	return false;
}

const HTML_PREFIXES = ['<!doctype', '<html', '<?xml', '<head'];

/**
 * Distinguishes "TikTok is challenging us" from "this mirror is stale".
 *
 * Worth the extra sniff rather than trusting the Content-Type: the captcha page
 * arrives under HTTP 200, and has been seen served as octet-stream as well as
 * text/html. The two cases need opposite responses — a stale mirror means try
 * the next one, a challenge means stop the run — so guessing is not an option.
 */
async function looksChallenged(blob) {
	if ((blob.type || '').startsWith('text/')) return true;
	const head = new TextDecoder().decode(await blob.slice(0, 64).arrayBuffer()).trim().toLowerCase();
	return HTML_PREFIXES.some((p) => head.startsWith(p));
}

/** Rounds through the mirror list, but only when a throttle caused the retry. */
const MAX_ROUNDS = 4;

/**
 * How many candidates may be rejected by `prefer` before the best one already
 * in hand is accepted instead.
 *
 * Bounded because a `prefer` rejection costs a whole media download, and the
 * one case that can fail every candidate — a post whose audio really is absent
 * everywhere — would otherwise pull the same video down once per mirror. Two is
 * enough to step off a bad gear onto the next one without turning a silent
 * upload into a multi-hundred-megabyte retry loop.
 */
const MAX_PREFER_MISSES = 2;

/**
 * Try each candidate URL in turn; TikTok hands out several mirrors per asset.
 * `expect` is 'video' or 'image' — a response that isn't actually that is
 * treated as a failure so the next mirror gets a turn.
 *
 * A 429 is the one case that does *not* move to the next mirror: they resolve to
 * the same edge fleet, so the next one is another request into a limit we have
 * already hit. It backs off and re-tries the whole list instead.
 *
 * `prefer` is a softer test than `expect`: a payload failing it is *worse*, not
 * wrong. The first one to fail is held on to while the remaining candidates get
 * a turn, and handed back if none of them does better. That distinction is the
 * point — a video whose audio is genuinely missing from every gear must still
 * end up in the archive, so this can move the download to a better candidate
 * but must never be able to fail an item on its own.
 */
export async function fetchFirst(urls, { signal, expect, guard, prefer } = {}) {
	const list = urls.filter(Boolean);
	if (!list.length) throw new Error('no candidate URLs');
	let lastErr = null;
	/** Best-ranked payload that passed `expect` but failed `prefer`. */
	let second = null;
	let misses = 0;

	for (let round = 0; round < MAX_ROUNDS; round++) {
		let throttled = false;

		for (const url of list) {
			if (guard) await guard.pass(signal);
			try {
				const res = await fetch(url, { credentials: 'include', signal, cache: 'no-store' });
				if (!res.ok) {
					lastErr = new Error(`HTTP ${res.status}`);
					const kind = classifyStatus(res.status);
					if (kind) {
						guard?.penalise(kind, retryAfterMs(res.headers));
						throttled = true;
						break;
					}
					continue;
				}
				const blob = await res.blob();
				if (blob.size === 0) {
					lastErr = new Error('empty body');
					continue;
				}
				if (await looksChallenged(blob)) {
					// Every remaining mirror would answer the same way, and so would
					// every other item in the queue.
					const why = 'TikTok served a challenge page instead of media';
					guard?.halt(why);
					throw new Halt(why);
				}
				if (!(await looksLike(blob, expect))) {
					lastErr = new Error(`payload is not ${expect} (${blob.size}B, ${blob.type || 'no type'})`);
					continue;
				}
				// The fetch itself succeeded, whatever `prefer` goes on to say about
				// what came back, so the throttle guard is told either way.
				guard?.ok();
				if (prefer && !(await prefer(blob))) {
					// Candidates arrive best-first, so the first miss is the best miss.
					if (!second) second = { blob, url };
					lastErr = new Error(`payload rejected by preference (${blob.size}B)`);
					if (++misses >= MAX_PREFER_MISSES) return second;
					continue;
				}
				return { blob, url };
			} catch (err) {
				if (err instanceof Halt || err?.name === 'AbortError') throw err;
				lastErr = err;
			}
		}

		// Mirrors genuinely exhausted rather than refused — another round would
		// just repeat the same failures against the same URLs.
		if (!throttled) break;
	}

	// Every candidate was worse than wanted, but one of them was still the media.
	if (second) return second;
	throw lastErr || new Error('no candidate URLs');
}

/**
 * @param {object} rec normalized record from the collector
 * @returns {Promise<{saved: string[], skipped: string[]}>}
 */
async function saveRecord(rec, state, { signal, onFile, guard } = {}) {
	const want = missingParts(rec);
	const saved = [];
	const files = {};

	// Paths recorded in archive.json are archive-relative, so the JSON is useful
	// to anything reading the folder without knowing this code's layout rules.
	if (want.includes('video') && rec.video?.length) {
		const { blob, url } = await fetchFirst(rec.video, {
			signal,
			expect: 'video',
			guard,
			prefer: hasAudioTrack,
		});
		const name = `${rec.id}.mp4`;
		await writeFile(LAYOUT.videos, name, blob);
		disk.videos.add(rec.id);
		files.video = [...LAYOUT.videos, name].join('/');
		saved.push('video');
		onFile?.({ id: rec.id, kind: 'video', bytes: blob.size, url });
	}

	if (want.includes('photos') && rec.photos?.length) {
		const paths = [];
		const names = [];
		for (let i = 0; i < rec.photos.length; i++) {
			const { blob, url } = await fetchFirst(rec.photos[i], { signal, expect: 'image', guard });
			const name = photoName(rec.id, i + 1, rec.photos.length, extFor(blob, url, 'jpg'));
			await writeFile(LAYOUT.images, name, blob);
			names.push(name);
			paths.push([...LAYOUT.images, name].join('/'));
			onFile?.({ id: rec.id, kind: 'photo', index: i + 1, bytes: blob.size, url });
		}
		disk.photos.set(rec.id, names.sort());
		files.photos = paths;
		saved.push('photos');
	}

	// The song over a photo post. Failing to get it is not failing the item: the
	// pictures are the post, and marking one `unavailable` over a track the CDN
	// wouldn't serve would hide it in the library and have every later sync retry
	// the whole thing. A halt or an abort still carry — neither is about this
	// file, and both have to stop the run.
	//
	// What it must not do is fail *quietly*, which is what it used to do. A song
	// that cannot be had is a permanent condition on a real archive — an old
	// post's sound goes away with the upload it came from — so an empty `catch`
	// left the same posts silently retried on every full sync, with nothing on
	// the record to say which ones or why. The reason goes on the item instead.
	//
	// This is only the half where a URL existed and the fetch of it failed. The
	// other half — TikTok naming a song but no link to it — never reaches here,
	// because `missingParts` only asks for audio it has somewhere to fetch from;
	// `noteAbsentSongLink` records that one off the harvested record.
	let noAudio = null;
	if (want.includes('audio') && rec.audio?.length) {
		try {
			const { blob, url } = await fetchFirst(rec.audio, { signal, expect: 'audio', guard });
			const name = `${rec.id}.${extFor(blob, url, 'mp3')}`;
			await writeFile(LAYOUT.audio, name, blob);
			disk.audio.set(rec.id, name);
			files.audio = [...LAYOUT.audio, name].join('/');
			saved.push('audio');
			onFile?.({ id: rec.id, kind: 'audio', bytes: blob.size, url });
		} catch (err) {
			if (err instanceof Halt || err?.name === 'AbortError') throw err;
			noAudio = `the track was refused — ${String((err && err.message) || err)}`;
		}
	}

	if (saved.length) markSaved(state, rec.id, files);
	// After `markSaved`, which clears this on the run where the track does arrive.
	if (noAudio) markNoAudio(state, rec.id, noAudio);
	return { saved, wanted: want, noAudio };
}

/**
 * Bounded-concurrency queue that accepts work while it's already draining.
 */
export class DownloadQueue {
	constructor({ concurrency = 4, state, onProgress, onError, onThrottle, onHalt } = {}) {
		this.concurrency = concurrency;
		this.state = state;
		this.onProgress = onProgress || (() => {});
		this.onError = onError || (() => {});
		this.onHalt = onHalt || (() => {});
		// The collector holds a Guard of its own; `onThrottle` is how the two are
		// kept in step, so a limit met here also stops the list being paged.
		this.guard = new Guard({ onNotice: onThrottle || (() => {}) });
		this.queue = [];
		this.active = 0;
		this.controller = new AbortController();
		this.stats = { queued: 0, done: 0, skipped: 0, failed: 0, bytes: 0, noAudio: 0 };
		this.failed = [];
		/** Photo posts whose song could not be had: `{ id, reason }`. */
		this.noAudio = [];
		this._idleResolvers = [];
		this.paused = false;
		this._halted = false;
	}

	add(rec) {
		if (!missingParts(rec).length) {
			this.stats.skipped++;
			this.onProgress(this.stats);
			return false;
		}
		this.queue.push(rec);
		this.stats.queued++;
		this._pump();
		return true;
	}

	addMany(recs) {
		let n = 0;
		for (const r of recs) if (this.add(r)) n++;
		return n;
	}

	pause() {
		this.paused = true;
	}

	resume() {
		this.paused = false;
		this._pump();
	}

	stop() {
		this.queue.length = 0;
		this.controller.abort();
		this.controller = new AbortController();
	}

	get pending() {
		return this.queue.length + this.active;
	}

	/** Resolves when the queue has fully drained. */
	idle() {
		if (this.pending === 0) return Promise.resolve();
		return new Promise((r) => this._idleResolvers.push(r));
	}

	_pump() {
		while (!this.paused && this.active < this.concurrency && this.queue.length) {
			const rec = this.queue.shift();
			this.active++;
			this._run(rec).finally(() => {
				this.active--;
				if (this.pending === 0) {
					const rs = this._idleResolvers.splice(0);
					for (const r of rs) r();
				}
				this._pump();
			});
		}
	}

	async _run(rec) {
		try {
			const res = await saveRecord(rec, this.state, {
				signal: this.controller.signal,
				guard: this.guard,
				onFile: (f) => {
					this.stats.bytes += f.bytes || 0;
				},
			});
			if (res.noAudio) {
				this.stats.noAudio++;
				this.noAudio.push({ id: rec.id, reason: res.noAudio });
			}
			if (res.saved.length) this.stats.done++;
			else this.stats.skipped++;
		} catch (err) {
			// Neither a halt nor a stop says anything about this item, so neither
			// may mark it `unavailable` — that status is a claim about the media,
			// and a run that resumes tomorrow would skip everything it touched.
			if (err instanceof Halt) {
				this.queue.unshift(rec);
				this.pause();
				if (!this._halted) {
					this._halted = true;
					this.onHalt(err.message);
				}
				return;
			}
			if (err?.name === 'AbortError') return;

			this.stats.failed++;
			this.failed.push({ id: rec.id, error: String((err && err.message) || err) });
			markUnavailable(this.state, rec.id, String((err && err.message) || err));
			this.onError(rec, err);
		}
		this.onProgress(this.stats);
	}
}
