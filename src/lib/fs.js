/**
 * Storage façade.
 *
 * The archive needs four things from a filesystem: list a directory, write a
 * blob, read a file back, and remember where "here" is between sessions.
 * Chromium gives all four through File System Access; Gecko gives none of them
 * and has to be assembled out of the downloads API and a folder the user hands
 * over. Both are behind this one interface, so state.js, downloader.js and
 * viewer.js never learn which browser they're on.
 *
 * The backend is chosen by feature detection, not by user agent.
 */

import * as fsa from './backends/fsa.js';
import * as downloads from './backends/downloads.js';

/**
 * Folder layout inside the archive root. Flat on purpose: two media directories
 * and one metadata file, nothing hidden and nothing nested.
 *
 * This is deliberately *not* myfaveTT's layout any more. Converting an existing
 * myfaveTT (or older ttarchive) folder is `tools/script.py`'s job, run once,
 * rather than a compatibility shape carried forever by the extension.
 */
export const LAYOUT = {
	videos: ['videos'],
	images: ['images'],
	/** The archive root itself — where archive.json lives. */
	root: [],
};

/**
 * Photo posts live directly in images/, one file per image — no directory per
 * post. A single-image post is `<id>.jpg`; a gallery gets a position suffix,
 * `<id>_01.jpg`, `<id>_02.jpg`, … so its parts sort together and stay together
 * when the folder is dragged somewhere else.
 */
export function photoName(id, index, total, ext) {
	const at = total > 1 ? `_${String(index).padStart(2, '0')}` : '';
	return `${id}${at}.${ext}`;
}

// Ids are numeric, so the suffix can be told from the id without guesswork.
const PHOTO_FILE = /^(\d+)(?:_\d+)?\.[a-z0-9]{2,5}$/i;

/** The post a file in images/ belongs to, or null if the name isn't ours. */
export function photoOwner(name) {
	const m = PHOTO_FILE.exec(name);
	return m ? m[1] : null;
}

const backend = fsa.supported() ? fsa : downloads.supported() ? downloads : null;

export function supported() {
	return backend !== null;
}

export function backendId() {
	return backend ? backend.id : null;
}

/**
 * `pick`: 'directory' (any folder) | 'name' (a folder under Downloads) | null
 * `readBack`: true (always) | 'snapshot' (only after a folder scan) | false
 * `liveListing`: whether a listing reflects outside changes without a refresh
 */
export const capabilities = backend
	? backend.capabilities
	: { pick: null, readBack: false, liveListing: false };

function must() {
	if (!backend) throw new Error('No storage backend available in this browser');
	return backend;
}

// ------------------------------------------------------------------ the root

export function rootName() {
	return backend ? backend.rootLabel() : null;
}

/** Must be called from a user gesture. `opts.name` is used by the downloads backend. */
export function pickFolder(opts) {
	return must().pick(opts);
}

/** Returns { state: 'granted' | 'prompt' | 'denied' | 'none', label } without prompting. */
export function restoreFolder() {
	if (!backend) return Promise.resolve({ state: 'none', label: null });
	return backend.restore();
}

/** Must be called from a user gesture. */
export function requestAccess() {
	return must().requestAccess();
}

export function forgetFolder() {
	return must().forget();
}

/**
 * Hand the backend a folder the user picked with `<input webkitdirectory>`.
 * Only the downloads backend needs it — File System Access already has one.
 */
export function canScanFolder() {
	return !!backend && typeof backend.adoptSnapshot === 'function';
}

export function scanFolder(files) {
	return must().adoptSnapshot(files);
}

export function hasReadableFiles() {
	if (!backend) return false;
	if (backend.capabilities.readBack === true) return true;
	return typeof backend.hasSnapshot === 'function' && backend.hasSnapshot();
}

/** Re-read the directory listing. A no-op where listings are already live. */
export async function refresh() {
	if (backend && typeof backend.refresh === 'function') await backend.refresh();
}

// -------------------------------------------------------------------- files

/**
 * Names of every file directly inside a directory. Empty set if it doesn't exist.
 * `opts.onProgress` is called with the running count as the listing is built.
 */
export function listFiles(parts, opts) {
	return must().listFiles(parts, opts);
}

export function listDirs(parts) {
	return must().listDirs(parts);
}

/**
 * Write a blob, creating parent directories as needed.
 * Pass `text: true` for metadata that has to be readable on the next run —
 * the downloads backend mirrors those into IndexedDB, since a download folder
 * is write-only from here.
 */
export function writeFile(parts, name, blob, opts) {
	return must().writeFile(parts, name, blob, opts);
}

export function readTextFile(parts, name) {
	if (!backend) return Promise.resolve(null);
	return backend.readText(parts, name);
}

export function readBlob(parts, name) {
	if (!backend) return Promise.resolve(null);
	return backend.readBlob(parts, name);
}

export function fileSize(parts, name) {
	if (!backend) return Promise.resolve(null);
	return backend.fileSize(parts, name);
}
