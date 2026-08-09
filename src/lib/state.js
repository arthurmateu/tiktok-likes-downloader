/**
 * Archive state: what's on disk, and what we know about it.
 *
 * Two sources of truth, deliberately:
 *   - the directory listing decides whether a file needs downloading (a DB can
 *     drift, a file either exists or it doesn't)
 *   - archive.json carries metadata for the viewer
 *
 * archive.json holds *every* item ever seen in the likes list, downloadable or
 * not. An item TikTok has since deleted can never be re-fetched, but the record
 * of what it was — id, author, caption, date — costs a few hundred bytes and is
 * the only thing left if a way to retrieve it ever appears.
 *
 * State is plain JSON at the archive root so it stays greppable and repairable
 * by hand. `tools/script.py` writes the same shape.
 */

import { LAYOUT, audioOwner, listFiles, photoOwner, readTextFile, writeFile, refresh } from './fs.js';

const STATE_FILE = 'archive.json';
const STATE_VERSION = 2;

/**
 * Per-item lifecycle:
 *   saved       — the media is on disk
 *   pending     — in your likes list, not downloaded yet
 *   unavailable — download attempted and failed (expired URL, 403, challenge)
 *   gone        — was in your likes list once, isn't any more: deleted,
 *                 privated, or unliked. Unrecoverable; kept for the record.
 */
export const STATUS = { saved: 'saved', pending: 'pending', unavailable: 'unavailable', gone: 'gone' };

export function emptyState() {
	return {
		version: STATE_VERSION,
		updatedAt: 0,
		user: null,
		items: {},
		authors: {},
		likeOrder: [],
		unavailable: [],
		/** When a run last reached the end of the list. 0 means never. */
		fullSyncAt: 0,
	};
}

export const disk = {
	videos: new Set(), // id
	photos: new Map(), // id -> sorted file names, images/ being flat
	audio: new Map(), // id -> file name; photo posts only, and not all of those
};

/**
 * @param {{ onProgress?: (files: number) => void }} opts
 *   `onProgress` receives the running total across the media directories, so a
 *   caller can show a folder this size being read rather than appearing to hang.
 */
export async function scanDisk({ onProgress } = {}) {
	// Backends whose listing isn't live (Gecko's, which reads download history)
	// need telling that now is the time to look again.
	await refresh();

	// Each listing reports its own count from zero; carrying the previous ones'
	// total forward makes the number the caller sees climb once, not three times.
	let base = 0;
	const step = onProgress ? (n) => onProgress(base + n) : undefined;

	const videos = await listFiles(LAYOUT.videos, { onProgress: step });
	base += videos.size;
	const images = await listFiles(LAYOUT.images, { onProgress: step });
	base += images.size;
	const songs = await listFiles(LAYOUT.audio, { onProgress: step });

	disk.videos = new Set([...videos].filter((n) => n.endsWith('.mp4')).map((n) => n.slice(0, -4)));
	disk.photos = new Map();
	for (const name of [...images].sort()) {
		const id = photoOwner(name);
		if (!id) continue;
		const names = disk.photos.get(id);
		if (names) names.push(name);
		else disk.photos.set(id, [name]);
	}
	// The name rather than the id alone: what the CDN served decides the
	// extension, so the viewer can't reconstruct the file name from the post.
	disk.audio = new Map();
	for (const name of songs) {
		const id = audioOwner(name);
		if (id) disk.audio.set(id, name);
	}
	return {
		videos: disk.videos.size,
		photoSets: disk.photos.size,
		/**
		 * Image *files*, not posts — a gallery contributes one per image. Reported
		 * separately because the two are worth several thousand apart on a real
		 * archive, and showing only the file count makes it look far larger than the
		 * number of likes it represents.
		 */
		images: [...disk.photos.values()].reduce((n, names) => n + names.length, 0),
		songs: disk.audio.size,
	};
}

export function hasVideo(id) {
	return disk.videos.has(id);
}
export function hasPhotos(id, expected) {
	const n = disk.photos.get(id)?.length;
	if (n == null) return false;
	return expected ? n >= expected : n > 0;
}
export function hasAudio(id) {
	return disk.audio.has(id);
}

/** What still needs fetching for this record, given what's on disk. */
export function missingParts(rec) {
	if (rec.type !== 'photo') return hasVideo(rec.id) ? [] : ['video'];

	const parts = [];
	if (!hasPhotos(rec.id, (rec.photos || []).length)) parts.push('photos');
	// Only ever asked for when this run actually has a URL to fetch it from. An
	// archive from before songs were collected — or one scanned in off disk — has
	// no way to get one, and would otherwise report every photo post it holds as
	// incomplete for good.
	if ((rec.audio || []).length && !hasAudio(rec.id)) parts.push('audio');
	return parts;
}

// ------------------------------------------------------------- catching up
//
// The likes list is newest-first, so everything a previous run dealt with sits
// below everything it hasn't. Once a run has walked past a long enough stretch
// of items an earlier one already settled, it is out of the new likes and into
// the part of the list it read last time — and reading the remaining thousands
// of items only asks TikTok the same questions again, which is both slow and
// the thing most likely to get the account rate-limited.
//
// "Settled" is deliberately stricter than "we have a record of it": an item
// whose media never arrived has to keep the run open, or the retry that a
// second sync is for would never reach it.

/**
 * How many settled items in a row end an incremental run. Pages are ~30 items,
 * so this is four of them: long enough that a couple of already-known posts
 * near the top — a re-like, or a page boundary landing awkwardly — can't be
 * mistaken for the end of the new ones.
 */
export const CAUGHT_UP_RUN = 120;

/**
 * Has an earlier run already finished with this item?
 *
 * Call it *before* `upsertItem`: it reads the status the last run left behind,
 * which the merge is about to overwrite.
 */
export function isSettled(state, rec) {
	const prev = state.items[rec.id];
	if (!prev) return false; // never seen it: this is a new like
	// The song a photo post came with is deliberately not part of this. It is a
	// bonus on top of the pictures, and a post whose pictures are all on disk is
	// one an earlier run finished with — counting the song would have sent the
	// first run after songs existed back down the entire list to collect them.
	// They are still fetched for every post a run does reach.
	if (!missingParts(rec).some((part) => part !== 'audio')) return true;
	// Nothing on disk, but we already know why: the media was fetched and
	// refused, or the item had dropped out of the list. Trying again is what a
	// full sync is for; it isn't a reason to hold an incremental run open.
	return prev.status === STATUS.unavailable || prev.status === STATUS.gone;
}

/**
 * Extend a run of settled items by one page's worth of records, in list order.
 * Any item still wanting something resets it to zero — the count has to be
 * consecutive, or a scattering of old items would end a run halfway up the
 * newest likes.
 */
export function settledStreak(state, recs, streak = 0) {
	let n = streak;
	for (const rec of recs) n = isSettled(state, rec) ? n + 1 : 0;
	return n;
}

// ---------------------------------------------------------------- load / save

export async function loadState() {
	const raw = await readTextFile(LAYOUT.root, STATE_FILE);
	let state = emptyState();
	if (raw) {
		try {
			const parsed = JSON.parse(raw);
			if (parsed && parsed.version === STATE_VERSION) state = { ...emptyState(), ...parsed };
		} catch (_) {
			/* corrupt archive.json — fall back to empty; disk scan still finds the media */
		}
	}
	// likeOrder is the record; the per-item rank is derived from it every time, so
	// a file rebuilt by tools/script.py — or edited by hand — can't disagree with
	// itself.
	applyLikeRanks(state);
	return state;
}

let saveTimer = null;
let savePending = null;

export function saveState(state, { immediate = false } = {}) {
	state.updatedAt = Date.now();
	if (immediate) {
		clearTimeout(saveTimer);
		saveTimer = null;
		return flush(state);
	}
	if (saveTimer) return savePending;
	// Coalesced rather than eager: a full archive serializes to a few MB, and a
	// long sync would otherwise rewrite that file hundreds of times. A crash
	// mid-run costs only metadata — the media is already on disk and the next
	// scan finds it.
	savePending = new Promise((resolve) => {
		saveTimer = setTimeout(() => {
			saveTimer = null;
			flush(state).then(resolve, resolve);
		}, 20000);
	});
	return savePending;
}

async function flush(state) {
	// Indented: this file is meant to be opened and read by a person, and by
	// anything that might one day be written to consume it. The extra bytes
	// compress away and are trivial next to the media.
	const blob = new Blob([JSON.stringify(state, null, '\t')], { type: 'application/json' });
	// `text: true` marks this as metadata that has to survive into the next
	// session even on a backend that can't read its own output folder.
	await writeFile(LAYOUT.root, STATE_FILE, blob, { text: true });
}

// ---------------------------------------------------------------- mutations

/** Merge a freshly harvested record over whatever we already had. */
export function upsertItem(state, rec) {
	const prev = state.items[rec.id] || {};
	state.items[rec.id] = {
		...prev,
		id: rec.id,
		type: rec.type,
		desc: rec.desc || prev.desc || '',
		createTime: rec.createTime || prev.createTime || 0,
		author: rec.author?.id ? rec.author : prev.author || {},
		stats: rec.stats || prev.stats || {},
		music: rec.music || prev.music || {},
		duration: rec.duration || prev.duration || 0,
		width: rec.width || prev.width || 0,
		height: rec.height || prev.height || 0,
		photoCount: rec.type === 'photo' ? (rec.photos || []).length : 0,
		// Seeing it in the list again undoes a previous 'gone': the item is back,
		// whatever happened in between.
		status: prev.status === STATUS.saved ? STATUS.saved : STATUS.pending,
		source: prev.source === 'myfavett' ? 'myfavett' : 'ttarchive',
	};
	if (rec.author?.id) {
		const a = state.authors[rec.author.id] || { id: rec.author.id, uniqueIds: [], nicknames: [] };
		if (rec.author.uniqueId && !a.uniqueIds.includes(rec.author.uniqueId))
			a.uniqueIds.push(rec.author.uniqueId);
		if (rec.author.nickname && !a.nicknames.includes(rec.author.nickname))
			a.nicknames.push(rec.author.nickname);
		a.uniqueId = rec.author.uniqueId || a.uniqueId;
		a.nickname = rec.author.nickname || a.nickname;
		state.authors[rec.author.id] = a;
	}
	return state.items[rec.id];
}

// ------------------------------------------------------------- like order
//
// TikTok's favorites list carries no "liked at" timestamp — nothing in the
// payload says when you liked something. What it does say is where an item sits
// in the list, and that list is in like order, most recent first. So the order
// itself is the only record of when, and `likeOrder` holds it: index 0 is the
// most recently liked item. `likeRank` on each item is its index into that
// array, cached so the viewers can sort without a lookup table.

/** Re-derive every item's `likeRank` from `state.likeOrder`. */
export function applyLikeRanks(state) {
	for (const item of Object.values(state.items || {})) delete item.likeRank;
	(state.likeOrder || []).forEach((id, at) => {
		const item = state.items[id];
		if (item) item.likeRank = at;
	});
}

/**
 * Fold the ids this run saw, in the order TikTok returned them, into the order
 * we already had.
 *
 * A run that stopped early only saw the top of the list, and ids it never
 * reached — or that have since been unliked — still deserve a position rather
 * than being dropped to the end. So placement is by anchor: an id missing from
 * this run stays immediately after whichever id it used to follow. A complete
 * run therefore rewrites the whole order and leaves `gone` items sitting
 * between the neighbours they were liked between; a partial run corrects the
 * top and leaves the tail as it was.
 */
export function recordLikeOrder(state, seenOrder) {
	const seen = new Set(seenOrder);
	/** Ids that dropped out before the first surviving one: they were the newest. */
	const head = [];
	/** surviving id -> the ids that used to follow it */
	const after = new Map();
	let anchor = null;

	for (const id of state.likeOrder || []) {
		if (seen.has(id)) {
			anchor = id;
			continue;
		}
		if (anchor === null) head.push(id);
		else if (after.has(anchor)) after.get(anchor).push(id);
		else after.set(anchor, [id]);
	}

	const order = [];
	const placed = new Set();
	const push = (id) => {
		// An id with no item behind it is a stale entry, not a position.
		if (placed.has(id) || !state.items[id]) return;
		placed.add(id);
		order.push(id);
	};
	for (const id of head) push(id);
	for (const id of seenOrder) {
		push(id);
		for (const trailing of after.get(id) || []) push(trailing);
	}

	state.likeOrder = order;
	applyLikeRanks(state);
	return order.length;
}

export function markSaved(state, id, files) {
	const item = state.items[id];
	if (!item) return;
	item.savedAt = Date.now();
	item.status = STATUS.saved;
	delete item.unavailable;
	item.files = { ...(item.files || {}), ...files };
	const at = state.unavailable.indexOf(id);
	if (at !== -1) state.unavailable.splice(at, 1);
}

export function markUnavailable(state, id, reason) {
	if (!state.unavailable.includes(id)) state.unavailable.push(id);
	const item = state.items[id];
	if (!item) return;
	item.unavailable = reason || true;
	if (item.status !== STATUS.saved) item.status = STATUS.unavailable;
}

/**
 * Called after a *complete* harvest: anything we knew about that TikTok no
 * longer returns has been deleted, privated or unliked. The media is
 * unrecoverable either way — this only records that it happened, so a future
 * reader of archive.json can tell "never downloaded" from "no longer exists".
 *
 * Never called on a stopped or errored run, where a short list means nothing.
 */
export function markGone(state, seenIds) {
	let gone = 0;
	for (const item of Object.values(state.items)) {
		if (seenIds.has(item.id)) continue;
		if (item.status === STATUS.saved || disk.videos.has(item.id) || disk.photos.has(item.id)) continue;
		if (item.status === STATUS.gone) continue;
		item.status = STATUS.gone;
		item.goneAt = Date.now();
		gone++;
	}
	return gone;
}
