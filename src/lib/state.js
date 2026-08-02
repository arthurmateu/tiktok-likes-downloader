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

import { LAYOUT, listFiles, photoOwner, readTextFile, writeFile, refresh } from './fs.js';

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
	};
}

export const disk = {
	videos: new Set(), // id
	photos: new Map(), // id -> sorted file names, images/ being flat
};

export async function scanDisk() {
	// Backends whose listing isn't live (Gecko's, which reads download history)
	// need telling that now is the time to look again.
	await refresh();
	disk.videos = new Set(
		[...(await listFiles(LAYOUT.videos))].filter((n) => n.endsWith('.mp4')).map((n) => n.slice(0, -4))
	);
	disk.photos = new Map();
	for (const name of [...(await listFiles(LAYOUT.images))].sort()) {
		const id = photoOwner(name);
		if (!id) continue;
		const names = disk.photos.get(id);
		if (names) names.push(name);
		else disk.photos.set(id, [name]);
	}
	return {
		videos: disk.videos.size,
		photoSets: disk.photos.size,
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

/** What still needs fetching for this record, given what's on disk. */
export function missingParts(rec) {
	if (rec.type === 'photo') {
		return hasPhotos(rec.id, (rec.photos || []).length) ? [] : ['photos'];
	}
	return hasVideo(rec.id) ? [] : ['video'];
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
