/**
 * Archive state: what's on disk, and what we know about it.
 *
 * Two sources of truth, deliberately:
 *   - the directory listing decides whether a file needs downloading (a DB can
 *     drift, a file either exists or it doesn't)
 *   - state.json carries metadata for the viewer
 *
 * State is plain JSON so it stays greppable and repairable by hand.
 */

import { LAYOUT, listFiles, listDirs, readTextFile, writeFile, refresh } from './fs.js';
import { importLegacy } from './legacy.js';

const STATE_FILE = 'state.json';
const STATE_VERSION = 1;

export function emptyState() {
	return {
		version: STATE_VERSION,
		updatedAt: 0,
		user: null,
		items: {},
		authors: {},
		likeOrder: [],
		unavailable: [],
		legacy: null,
	};
}

export const disk = {
	videos: new Set(), // id
	covers: new Map(), // id -> actual filename (extension varies)
	photoDirs: new Map(), // id -> file count
};

export async function scanDisk() {
	// Backends whose listing isn't live (Gecko's, which reads download history)
	// need telling that now is the time to look again.
	await refresh();
	disk.videos = new Set(
		[...(await listFiles(LAYOUT.videos))].filter((n) => n.endsWith('.mp4')).map((n) => n.slice(0, -4))
	);
	disk.covers = new Map(
		[...(await listFiles(LAYOUT.covers))]
			.filter((n) => /\.(jpe?g|webp|png|heic|avif)$/i.test(n))
			.map((n) => [n.replace(/\.[^.]+$/, ''), n])
	);
	disk.photoDirs = new Map();
	for (const id of await listDirs(LAYOUT.photos)) {
		disk.photoDirs.set(id, (await listFiles([...LAYOUT.photos, id])).size);
	}
	return {
		videos: disk.videos.size,
		covers: disk.covers.size,
		photoSets: disk.photoDirs.size,
	};
}

export function hasVideo(id) {
	return disk.videos.has(id);
}
export function hasCover(id) {
	return disk.covers.has(id);
}
export function hasPhotos(id, expected) {
	const n = disk.photoDirs.get(id);
	if (n == null) return false;
	return expected ? n >= expected : n > 0;
}

/** What still needs fetching for this record, given what's on disk. */
export function missingParts(rec) {
	const out = [];
	if (rec.type === 'photo') {
		if (!hasPhotos(rec.id, (rec.photos || []).length)) out.push('photos');
	} else if (!hasVideo(rec.id)) {
		out.push('video');
	}
	if (!hasCover(rec.id)) out.push('cover');
	return out;
}

// ---------------------------------------------------------------- load / save

export async function loadState() {
	const raw = await readTextFile(LAYOUT.appdata, STATE_FILE);
	let state = emptyState();
	if (raw) {
		try {
			const parsed = JSON.parse(raw);
			if (parsed && parsed.version === STATE_VERSION) state = { ...emptyState(), ...parsed };
		} catch (_) {
			/* corrupt state.json — fall back to empty; disk scan still finds the media */
		}
	}
	return state;
}

/** Pull metadata out of a sibling myfaveTT archive, once, without touching it. */
export async function mergeLegacy(state) {
	// Retried whenever a previous attempt found nothing: on Gecko the myfaveTT
	// DBs only become readable once the user has scanned the folder, which may
	// well happen after the first load. Six misses cost nothing.
	if (state.legacy && state.legacy.imported && state.legacy.found) {
		return { merged: 0, skipped: true, found: true, counts: state.legacy.counts };
	}
	const legacy = await importLegacy();
	if (!legacy) {
		state.legacy = { imported: true, found: false };
		return { merged: 0, found: false };
	}

	let merged = 0;
	for (const [id, item] of Object.entries(legacy.items)) {
		if (state.items[id]) continue;
		state.items[id] = item;
		merged++;
	}
	for (const [id, a] of Object.entries(legacy.authors)) {
		if (!state.authors[id]) state.authors[id] = a;
	}
	if (!state.user && legacy.user) state.user = legacy.user;

	state.legacy = { imported: true, found: true, counts: legacy.counts, at: Date.now() };
	return { merged, found: true, counts: legacy.counts };
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
	const blob = new Blob([JSON.stringify(state)], { type: 'application/json' });
	// `text: true` marks this as metadata that has to survive into the next
	// session even on a backend that can't read its own output folder.
	await writeFile(LAYOUT.appdata, STATE_FILE, blob, { text: true });
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
	item.files = { ...(item.files || {}), ...files };
}

export function markUnavailable(state, id, reason) {
	if (!state.unavailable.includes(id)) state.unavailable.push(id);
	if (state.items[id]) state.items[id].unavailable = reason || true;
}
