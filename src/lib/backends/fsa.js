/**
 * Chromium backend: File System Access.
 *
 * Everything is relative to a single root directory handle that the user picks
 * (and can re-pick at any time, like myfaveTT does). The handle is persisted in
 * IndexedDB so a reload doesn't force another picker, but Chromium still
 * requires a user gesture to re-grant read/write on a new session.
 *
 * This is the backend the archive was designed around: writes land wherever the
 * user says, and reads come straight back off the same handle, so the directory
 * listing can be the single source of truth about what still needs downloading.
 */

import { idbGet, idbSet, idbDel } from '../idb.js';

const HANDLE_KEY = 'rootHandle';

export const id = 'fsa';

export const capabilities = {
	/** The user chooses a real directory, anywhere. */
	pick: 'directory',
	/** Files written can be read straight back — the viewer plays from disk. */
	readBack: true,
	/** Listings come from the filesystem itself and are always current. */
	liveListing: true,
};

let root = null;

export function supported() {
	return typeof globalThis.showDirectoryPicker === 'function';
}

export function rootLabel() {
	return root ? root.name : null;
}

/** Must be called from a user gesture. */
export async function pick() {
	const handle = await globalThis.showDirectoryPicker({
		id: 'ttarchive-root',
		mode: 'readwrite',
		startIn: 'videos',
	});
	root = handle;
	await idbSet(HANDLE_KEY, handle);
	return { label: handle.name };
}

/** Returns 'granted' | 'prompt' | 'denied' | 'none' without prompting. */
export async function restore() {
	const handle = await idbGet(HANDLE_KEY);
	if (!handle) return { state: 'none', label: null };
	const state = await handle.queryPermission({ mode: 'readwrite' });
	if (state === 'granted') root = handle;
	return { state, label: handle.name };
}

/** Must be called from a user gesture. */
export async function requestAccess() {
	const handle = await idbGet(HANDLE_KEY);
	if (!handle) return 'none';
	const state = await handle.requestPermission({ mode: 'readwrite' });
	if (state === 'granted') root = handle;
	return state;
}

export async function forget() {
	root = null;
	await idbDel(HANDLE_KEY);
}

function requireRoot() {
	if (!root) throw new Error('No archive folder selected');
	return root;
}

/** @param {string[]} parts */
async function getDir(parts, { create = false } = {}) {
	let dir = requireRoot();
	for (const part of parts) {
		dir = await dir.getDirectoryHandle(part, { create });
	}
	return dir;
}

async function tryGetDir(parts) {
	try {
		return await getDir(parts, { create: false });
	} catch (_) {
		return null;
	}
}

/**
 * How many entries to read between progress reports. Each entry is a handle
 * built across an IPC to the browser process, so a folder with thousands of
 * files takes seconds — long enough that the caller has to be able to say so.
 */
const REPORT_EVERY = 250;

/**
 * Names of every file directly inside a directory. Empty set if it doesn't exist.
 *
 * `onProgress` is handed the running file count. It comes with a yield to the
 * event loop, because reporting into a DOM that never gets a chance to paint is
 * the same as not reporting at all: entries within one of Chromium's fetched
 * batches resolve as microtasks, which a repaint can't get between.
 */
export async function listFiles(parts, { onProgress } = {}) {
	const names = new Set();
	const dir = await tryGetDir(parts);
	if (!dir) return names;
	let since = 0;
	for await (const [name, handle] of dir.entries()) {
		if (handle.kind === 'file') names.add(name);
		if (onProgress && ++since >= REPORT_EVERY) {
			since = 0;
			onProgress(names.size);
			await new Promise((r) => setTimeout(r, 0));
		}
	}
	onProgress?.(names.size);
	return names;
}

export async function listDirs(parts) {
	const names = new Set();
	const dir = await tryGetDir(parts);
	if (!dir) return names;
	for await (const [name, handle] of dir.entries()) {
		if (handle.kind === 'directory') names.add(name);
	}
	return names;
}

/**
 * Writes a blob, creating parent directories as needed.
 * Retries because writing thousands of files into a cloud-synced folder
 * (OneDrive, iCloud) intermittently fails — myfaveTT's own troubleshooting page
 * calls this out.
 */
export async function writeFile(parts, name, blob, { retries = 2 } = {}) {
	let lastErr;
	for (let attempt = 0; attempt <= retries; attempt++) {
		try {
			const dir = await getDir(parts, { create: true });
			const fh = await dir.getFileHandle(name, { create: true });
			const w = await fh.createWritable();
			await w.write(blob);
			await w.close();
			return true;
		} catch (err) {
			lastErr = err;
			await new Promise((r) => setTimeout(r, 250 * (attempt + 1)));
		}
	}
	throw lastErr;
}

export async function readBlob(parts, name) {
	const dir = await tryGetDir(parts);
	if (!dir) return null;
	try {
		const fh = await dir.getFileHandle(name);
		return await fh.getFile();
	} catch (_) {
		return null;
	}
}

export async function readText(parts, name) {
	const file = await readBlob(parts, name);
	return file ? file.text() : null;
}

export async function fileSize(parts, name) {
	const file = await readBlob(parts, name);
	return file ? file.size : null;
}
