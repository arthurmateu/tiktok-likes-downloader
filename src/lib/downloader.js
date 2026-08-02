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

import { LAYOUT, writeFile } from './fs.js';
import { disk, missingParts, markSaved, markUnavailable } from './state.js';
import { Guard, Halt, classifyStatus, retryAfterMs } from './throttle.js';

const EXT_BY_TYPE = {
	'image/jpeg': 'jpg',
	'image/jpg': 'jpg',
	'image/webp': 'webp',
	'image/png': 'png',
	'image/heic': 'heic',
	'image/avif': 'avif',
	'video/mp4': 'mp4',
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
};

async function looksLike(blob, kind) {
	if (!kind || !MAGIC[kind]) return true;
	const head = new Uint8Array(await blob.slice(0, 16).arrayBuffer());
	return MAGIC[kind].some(([off, sig]) => sig.every((b, i) => head[off + i] === b));
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
 * Try each candidate URL in turn; TikTok hands out several mirrors per asset.
 * `expect` is 'video' or 'image' — a response that isn't actually that is
 * treated as a failure so the next mirror gets a turn.
 *
 * A 429 is the one case that does *not* move to the next mirror: they resolve to
 * the same edge fleet, so the next one is another request into a limit we have
 * already hit. It backs off and re-tries the whole list instead.
 */
export async function fetchFirst(urls, { signal, expect, guard } = {}) {
	const list = urls.filter(Boolean);
	if (!list.length) throw new Error('no candidate URLs');
	let lastErr = null;

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
				guard?.ok();
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
		const { blob, url } = await fetchFirst(rec.video, { signal, expect: 'video', guard });
		const name = `${rec.id}.mp4`;
		await writeFile(LAYOUT.videos, name, blob);
		disk.videos.add(rec.id);
		files.video = [...LAYOUT.videos, name].join('/');
		saved.push('video');
		onFile?.({ id: rec.id, kind: 'video', bytes: blob.size, url });
	}

	if (want.includes('photos') && rec.photos?.length) {
		const paths = [];
		for (let i = 0; i < rec.photos.length; i++) {
			const { blob, url } = await fetchFirst(rec.photos[i], { signal, expect: 'image', guard });
			const name = `${String(i + 1).padStart(2, '0')}.${extFor(blob, url, 'jpg')}`;
			await writeFile([...LAYOUT.images, rec.id], name, blob);
			paths.push([...LAYOUT.images, rec.id, name].join('/'));
			onFile?.({ id: rec.id, kind: 'photo', index: i + 1, bytes: blob.size, url });
		}
		disk.photoDirs.set(rec.id, paths.length);
		files.photos = paths;
		saved.push('photos');
	}

	if (saved.length) markSaved(state, rec.id, files);
	return { saved, wanted: want };
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
		this.stats = { queued: 0, done: 0, skipped: 0, failed: 0, bytes: 0 };
		this.failed = [];
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
