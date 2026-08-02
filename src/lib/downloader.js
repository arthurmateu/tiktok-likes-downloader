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

/**
 * Try each candidate URL in turn; TikTok hands out several mirrors per asset.
 * `expect` is 'video' or 'image' — a response that isn't actually that is
 * treated as a failure so the next mirror gets a turn.
 */
export async function fetchFirst(urls, { signal, expect } = {}) {
	let lastErr = null;
	for (const url of urls) {
		if (!url) continue;
		try {
			const res = await fetch(url, { credentials: 'include', signal, cache: 'no-store' });
			if (!res.ok) {
				lastErr = new Error(`HTTP ${res.status}`);
				continue;
			}
			const blob = await res.blob();
			if (blob.size === 0) {
				lastErr = new Error('empty body');
				continue;
			}
			if ((blob.type || '').startsWith('text/')) {
				lastErr = new Error(`got ${blob.type} — TikTok served a challenge page, not media`);
				continue;
			}
			if (!(await looksLike(blob, expect))) {
				lastErr = new Error(`payload is not ${expect} (${blob.size}B, ${blob.type || 'no type'})`);
				continue;
			}
			return { blob, url };
		} catch (err) {
			lastErr = err;
		}
	}
	throw lastErr || new Error('no candidate URLs');
}

/**
 * @param {object} rec normalized record from the collector
 * @returns {Promise<{saved: string[], skipped: string[]}>}
 */
async function saveRecord(rec, state, { signal, onFile } = {}) {
	const want = missingParts(rec);
	const saved = [];
	const files = {};

	if (want.includes('video') && rec.video?.length) {
		const { blob, url } = await fetchFirst(rec.video, { signal });
		const name = `${rec.id}.mp4`;
		await writeFile(LAYOUT.videos, name, blob);
		disk.videos.add(rec.id);
		files.video = name;
		saved.push('video');
		onFile?.({ id: rec.id, kind: 'video', bytes: blob.size, url });
	}

	if (want.includes('photos') && rec.photos?.length) {
		const names = [];
		for (let i = 0; i < rec.photos.length; i++) {
			const { blob, url } = await fetchFirst(rec.photos[i], { signal });
			const name = `${String(i + 1).padStart(2, '0')}.${extFor(blob, url, 'jpg')}`;
			await writeFile([...LAYOUT.photos, rec.id], name, blob);
			names.push(name);
			onFile?.({ id: rec.id, kind: 'photo', index: i + 1, bytes: blob.size, url });
		}
		disk.photoDirs.set(rec.id, names.length);
		files.photos = names;
		saved.push('photos');
	}

	if (want.includes('cover') && rec.cover?.length) {
		try {
			const { blob, url } = await fetchFirst(rec.cover, { signal });
			// Keeps myfaveTT's <id>.jpg convention whenever the CDN hands us a JPEG,
			// which it does for essentially every cover.
			const name = `${rec.id}.${extFor(blob, url, 'jpg')}`;
			await writeFile(LAYOUT.covers, name, blob);
			disk.covers.set(rec.id, name);
			files.cover = name;
			saved.push('cover');
			onFile?.({ id: rec.id, kind: 'cover', bytes: blob.size, url });
		} catch (_) {
			// A missing thumbnail is not worth failing the item over.
		}
	}

	if (saved.length) markSaved(state, rec.id, files);
	return { saved, wanted: want };
}

/**
 * Bounded-concurrency queue that accepts work while it's already draining.
 */
export class DownloadQueue {
	constructor({ concurrency = 4, state, onProgress, onError } = {}) {
		this.concurrency = concurrency;
		this.state = state;
		this.onProgress = onProgress || (() => {});
		this.onError = onError || (() => {});
		this.queue = [];
		this.active = 0;
		this.controller = new AbortController();
		this.stats = { queued: 0, done: 0, skipped: 0, failed: 0, bytes: 0 };
		this.failed = [];
		this._idleResolvers = [];
		this.paused = false;
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
				onFile: (f) => {
					this.stats.bytes += f.bytes || 0;
				},
			});
			if (res.saved.length) this.stats.done++;
			else this.stats.skipped++;
		} catch (err) {
			this.stats.failed++;
			this.failed.push({ id: rec.id, error: String((err && err.message) || err) });
			markUnavailable(this.state, rec.id, String((err && err.message) || err));
			this.onError(rec, err);
		}
		this.onProgress(this.stats);
	}
}
