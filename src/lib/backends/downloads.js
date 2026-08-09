/**
 * Gecko backend: the downloads API, plus a read-only folder snapshot.
 *
 * Firefox has no File System Access API, so there is no handle to write
 * through. What it does have is enough to keep the archive's design intact:
 *
 *   - `downloads.download()` writes anywhere *under* the browser's download
 *     directory and accepts a relative subpath, so the archive's folder layout
 *     survives verbatim.
 *   - `downloads.search()` returns each download's absolute path and an
 *     `exists` flag. That is a real on-disk truth source rather than a database
 *     of our own, which is the property the whole skip-detection rests on.
 *   - `<input type="file" webkitdirectory>` hands back every File in a folder
 *     the user points at, so an existing archive can still be read and the
 *     Library can still play back off disk.
 *
 * Two things are genuinely worse than on Chromium and the UI says so:
 *
 *   - The archive root must be a subfolder of the browser's download folder.
 *     Moving it means moving the download folder (about:preferences).
 *   - Nothing is readable until the user hands us a folder. The listing
 *     therefore starts from download history, which the user can clear. When it
 *     is cleared the next sync re-downloads over the top of the existing files
 *     (conflictAction 'overwrite'), so it costs bandwidth, never data.
 *
 * archive.json is additionally mirrored into IndexedDB, because it has to be
 * readable on the next run and a bare download folder isn't.
 */

import { ext } from '../ext.js';
import { idbGet, idbSet, idbDel } from '../idb.js';

const FOLDER_KEY = 'downloadFolder';
const MIRROR_PREFIX = 'mirror:';

export const DEFAULT_FOLDER = 'TikTok likes';

export const id = 'downloads';

export const capabilities = {
	/** The user names a folder; they don't get to place it. */
	pick: 'name',
	/** Files are readable only for a folder handed over via the scan control. */
	readBack: 'snapshot',
	/** `downloads.search()` has to be re-run to notice outside changes. */
	liveListing: false,
};

/** Folder name under the browser's download directory. */
let folder = null;

/** rel path -> { size }. What we believe is on disk, from download history. */
const index = new Map();

/** rel path -> File. Only for a folder the user handed us this session. */
const snapshot = new Map();
let snapshotName = null;

export function supported() {
	return !!(ext && ext.downloads && typeof ext.downloads.download === 'function');
}

export function rootLabel() {
	if (!folder) return null;
	return snapshotName && snapshotName !== folder ? `${folder} (reading ${snapshotName})` : folder;
}

/**
 * Download folders are the browser's to name. Strip anything it would rewrite
 * behind our back so the path we compute is the path that ends up on disk.
 */
function sanitizeFolder(name) {
	const clean = String(name || '')
		.replace(/[\\/:*?"<>|]/g, '_')
		.replace(/[\u0000-\u001f]/g, '')
		.replace(/^[.\s]+/, '')
		.replace(/[.\s]+$/, '')
		.trim();
	return clean || DEFAULT_FOLDER;
}

export async function restore() {
	folder = (await idbGet(FOLDER_KEY)) || null;
	if (!folder) return { state: 'none', label: null };
	await refresh();
	return { state: 'granted', label: rootLabel() };
}

/** @param {{ name?: string }} opts */
export async function pick({ name } = {}) {
	folder = sanitizeFolder(name);
	await idbSet(FOLDER_KEY, folder);
	await refresh();
	return { label: rootLabel() };
}

/** Nothing to re-grant: the downloads permission is granted at install time. */
export async function requestAccess() {
	return folder ? 'granted' : 'none';
}

export async function forget() {
	folder = null;
	snapshot.clear();
	snapshotName = null;
	index.clear();
	await idbDel(FOLDER_KEY);
}

function requireFolder() {
	if (!folder) throw new Error('No archive folder set');
	return folder;
}

// ------------------------------------------------------------------ listing

/**
 * Rebuild the on-disk index from download history.
 *
 * `exists === false` means the browser has checked and the file is gone — a
 * deleted file therefore comes back on the next sync, same as on Chromium.
 * Records with `exists` undefined are trusted: Firefox only fills it in lazily.
 */
export async function refresh() {
	index.clear();
	if (!folder) return;

	let rows = [];
	try {
		// An explicit ceiling rather than the conventional `limit: 0`: Chromium
		// reads 0 as "no limit", Gecko documents the default as 100, and a
		// truncated history would silently look like missing files.
		rows = await ext.downloads.search({ limit: 1e6 });
	} catch (_) {
		return;
	}

	const marker = `/${folder}/`;
	for (const row of rows) {
		if (row.state !== 'complete' || row.exists === false) continue;
		const path = String(row.filename || '').replace(/\\/g, '/');
		const at = path.lastIndexOf(marker);
		if (at === -1) continue;
		const rel = path.slice(at + marker.length);
		if (!rel || rel.startsWith('/')) continue;
		index.set(rel, { size: row.fileSize > 0 ? row.fileSize : row.totalBytes || 0 });
	}
}

/**
 * Take a directory the user picked with `<input webkitdirectory>`. The first
 * path segment is the folder they chose, so everything after it is already
 * archive-relative.
 *
 * @param {FileList|File[]} files
 */
export function adoptSnapshot(files) {
	snapshot.clear();
	snapshotName = null;
	for (const file of files) {
		const rel = String(file.webkitRelativePath || file.name).replace(/\\/g, '/');
		const cut = rel.indexOf('/');
		if (cut < 1) continue;
		if (snapshotName === null) snapshotName = rel.slice(0, cut);
		snapshot.set(rel.slice(cut + 1), file);
	}
	return { name: snapshotName, files: snapshot.size };
}

export function hasSnapshot() {
	return snapshot.size > 0;
}

function prefixOf(parts) {
	return parts.length ? `${parts.join('/')}/` : '';
}

function* knownPaths() {
	yield* index.keys();
	yield* snapshot.keys();
}

/**
 * `onProgress` is reported once, at the end. There is no incremental work to
 * report: the listing is a walk over an in-memory index that `refresh()` has
 * already built, and it returns in microseconds.
 */
export async function listFiles(parts, { onProgress } = {}) {
	const prefix = prefixOf(parts);
	const names = new Set();
	for (const path of knownPaths()) {
		if (!path.startsWith(prefix)) continue;
		const rest = path.slice(prefix.length);
		if (rest && !rest.includes('/')) names.add(rest);
	}
	onProgress?.(names.size);
	return names;
}

export async function listDirs(parts) {
	const prefix = prefixOf(parts);
	const names = new Set();
	for (const path of knownPaths()) {
		if (!path.startsWith(prefix)) continue;
		const cut = path.slice(prefix.length).indexOf('/');
		if (cut > 0) names.add(path.slice(prefix.length, prefix.length + cut));
	}
	return names;
}

// ------------------------------------------------------------------ writing

/**
 * Resolve once the browser has finished writing the file.
 *
 * The listener can miss a download that finished between the call and the
 * subscription, so the current state is checked once as well.
 */
function settle(downloadId, timeout = 180000) {
	return new Promise((resolve, reject) => {
		let settled = false;
		const finish = (err) => {
			if (settled) return;
			settled = true;
			ext.downloads.onChanged.removeListener(onChanged);
			clearTimeout(timer);
			if (err) reject(err);
			else resolve();
		};
		const fromState = (state, error) => {
			if (state === 'complete') finish();
			else if (state === 'interrupted') finish(new Error(`download failed (${error || 'unknown'})`));
		};
		const onChanged = (delta) => {
			if (delta.id !== downloadId || !delta.state) return;
			fromState(delta.state.current, delta.error && delta.error.current);
		};

		ext.downloads.onChanged.addListener(onChanged);
		const timer = setTimeout(() => finish(new Error('download timed out')), timeout);
		ext.downloads.search({ id: downloadId }).then(
			(rows) => {
				const row = rows && rows[0];
				if (row) fromState(row.state, row.error);
			},
			() => {}
		);
	});
}

/**
 * @param {string[]} parts
 * @param {string} name
 * @param {Blob} blob
 * @param {{ retries?: number, text?: boolean }} opts
 *   `text` marks metadata that also has to survive into the next session, which
 *   a write-only download folder can't do on its own.
 */
export async function writeFile(parts, name, blob, { retries = 2, text = false } = {}) {
	requireFolder();
	const rel = [...parts, name].join('/');

	if (text) await idbSet(MIRROR_PREFIX + rel, await blob.text());

	let lastErr;
	for (let attempt = 0; attempt <= retries; attempt++) {
		const url = URL.createObjectURL(blob);
		try {
			const downloadId = await ext.downloads.download({
				url,
				filename: `${folder}/${rel}`,
				conflictAction: 'overwrite',
				saveAs: false,
			});
			await settle(downloadId);
			index.set(rel, { size: blob.size });
			return true;
		} catch (err) {
			lastErr = err;
			await new Promise((r) => setTimeout(r, 250 * (attempt + 1)));
		} finally {
			// Revoking while the download is still reading the blob interrupts it,
			// and the write is asynchronous even after `settle` resolves.
			setTimeout(() => URL.revokeObjectURL(url), 30000);
		}
	}

	// Mirrored metadata is already safe in IndexedDB. Firefox rewrites some
	// filenames (a leading-dot directory, for one) and that must not take down a
	// sync whose media is landing fine.
	if (text) return false;
	throw lastErr;
}

// ------------------------------------------------------------------ reading

export async function readBlob(parts, name) {
	return snapshot.get([...parts, name].join('/')) || null;
}

export async function readText(parts, name) {
	const rel = [...parts, name].join('/');
	const file = snapshot.get(rel);
	if (file) return file.text();
	const mirrored = await idbGet(MIRROR_PREFIX + rel);
	return typeof mirrored === 'string' ? mirrored : null;
}

export async function fileSize(parts, name) {
	const file = snapshot.get([...parts, name].join('/'));
	if (file) return file.size;
	const entry = index.get([...parts, name].join('/'));
	return entry ? entry.size : null;
}
