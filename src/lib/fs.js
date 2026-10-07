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
 * The backend is chosen by feature detection, not by user agent. The local
 * helper is a third way to do the same four things on Chromium, and is used
 * whenever it is installed — see `init`.
 */

import * as fsa from './backends/fsa.js';
import * as downloads from './backends/downloads.js';
import * as helper from './backends/helper.js';

/**
 * Folder layout inside the archive root. Flat on purpose: three media
 * directories and one metadata file, nothing hidden and nothing nested.
 *
 * This is deliberately *not* myfaveTT's layout any more. Converting an existing
 * myfaveTT (or older ttarchive) folder is `tools/script.py`'s job, run once,
 * rather than a compatibility shape carried forever by the extension.
 */
export const LAYOUT = {
	videos: ['videos'],
	images: ['images'],
	/** Songs, and only for photo posts — a video's audio is inside its own mp4. */
	audio: ['audio'],
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

/**
 * The same for audio/, which is one song per post and so has no numbered form.
 * The extension is whatever the CDN served — usually .mp3, sometimes .m4a.
 */
const AUDIO_FILE = /^(\d+)\.[a-z0-9]{2,5}$/i;

export function audioOwner(name) {
	const m = AUDIO_FILE.exec(name);
	return m ? m[1] : null;
}

let backend = fsa.supported() ? fsa : downloads.supported() ? downloads : null;

/**
 * The local helper if it is installed, and what feature detection picked if it
 * isn't: asked once, by the archive page, before anything touches the folder.
 * Anything that never asks — the dev harnesses — keeps the detected backend.
 *
 * Resolves to null, or to why the helper wasn't used when it looked like it
 * should have been: installed but unable to start, or a background too old to
 * know about it. Not being installed is not a problem, and isn't reported.
 */
export async function init() {
	if (!helper.supported()) return null;
	const res = await helper.probe();
	if (res.ok) {
		backend = helper;
		capabilities = helper.capabilities;
		return null;
	}
	return res.error === 'no-helper' ? null : res;
}

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
export let capabilities = backend
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

/** The folder's full path, where the backend knows it. File System Access never does. */
export function rootPath() {
	return backend && typeof backend.rootPath === 'function' ? backend.rootPath() : null;
}

/** The Library at an address a tab can open, where the backend serves one. */
export function libraryURL() {
	return backend && typeof backend.libraryURL === 'function' ? backend.libraryURL() : null;
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
 * `opts.onProgress` is called with the running count as the listing is built,
 * and `opts.onBatch` with the names found since the last call — a backend whose
 * listing takes seconds is usable long before it is finished.
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

/**
 * A URL a media element can stream this file from, or null where the backend
 * has no such thing and the file has to be read into a blob instead. Says
 * nothing about whether the file exists.
 */
export function mediaURL(parts, name) {
	return backend && typeof backend.mediaURL === 'function' ? backend.mediaURL(parts, name) : null;
}

/**
 * Open the system file manager with this file selected. Resolves to `{ ok }`,
 * or `{ ok: false, error }` with `error` one of:
 *   'no-helper'      — Chromium's native helper isn't installed; `setup` is the command that installs it
 *   'not-found'      — the helper looked and the file isn't there; `path` is where it looked
 *   'not-downloaded' — Firefox has no download on record for this file
 * or anything else as plain text.
 */
export function showInFolder(parts, name) {
	if (!backend) return Promise.resolve({ ok: false, error: 'no storage backend' });
	return backend.showInFolder(parts, name);
}
