/**
 * File System Access helpers.
 *
 * Everything is relative to a single root directory handle that the user picks
 * (and can re-pick at any time, like myfaveTT does). The handle is persisted in
 * IndexedDB so a reload doesn't force another picker, but Chromium still
 * requires a user gesture to re-grant read/write on a new session.
 */

import { idbGet, idbSet, idbDel } from './idb.js';

const HANDLE_KEY = 'rootHandle';

/** Folder layout inside the archive root. Mirrors myfaveTT so files collide by design. */
export const LAYOUT = {
	videos: ['data', 'Likes', 'videos'],
	covers: ['data', 'Likes', 'covers'],
	photos: ['data', 'Likes', 'photos'],
	appdata: ['data', '.ttarchive'],
	legacy: ['data', '.appdata'],
};

let root = null;

export function currentRoot() {
	return root;
}

export function rootName() {
	return root ? root.name : null;
}

export function supported() {
	return typeof window !== 'undefined' && typeof window.showDirectoryPicker === 'function';
}

/** Must be called from a user gesture. */
export async function pickFolder() {
	const handle = await window.showDirectoryPicker({
		id: 'ttarchive-root',
		mode: 'readwrite',
		startIn: 'videos',
	});
	root = handle;
	await idbSet(HANDLE_KEY, handle);
	return handle;
}

/** Returns 'granted' | 'prompt' | 'denied' | 'none' without prompting. */
export async function restoreFolder() {
	const handle = await idbGet(HANDLE_KEY);
	if (!handle) return { state: 'none', handle: null };
	const state = await handle.queryPermission({ mode: 'readwrite' });
	if (state === 'granted') root = handle;
	return { state, handle };
}

/** Must be called from a user gesture. */
export async function requestAccess() {
	const handle = await idbGet(HANDLE_KEY);
	if (!handle) return 'none';
	const state = await handle.requestPermission({ mode: 'readwrite' });
	if (state === 'granted') root = handle;
	return state;
}

export async function forgetFolder() {
	root = null;
	await idbDel(HANDLE_KEY);
}

function requireRoot() {
	if (!root) throw new Error('No archive folder selected');
	return root;
}

/** @param {string[]} parts */
export async function getDir(parts, { create = false } = {}) {
	let dir = requireRoot();
	for (const part of parts) {
		dir = await dir.getDirectoryHandle(part, { create });
	}
	return dir;
}

export async function tryGetDir(parts) {
	try {
		return await getDir(parts, { create: false });
	} catch (_) {
		return null;
	}
}

/** Names of every file directly inside a directory. Empty set if it doesn't exist. */
export async function listFiles(parts) {
	const names = new Set();
	const dir = await tryGetDir(parts);
	if (!dir) return names;
	for await (const [name, handle] of dir.entries()) {
		if (handle.kind === 'file') names.add(name);
	}
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

export async function readTextFile(parts, name) {
	const dir = await tryGetDir(parts);
	if (!dir) return null;
	try {
		const fh = await dir.getFileHandle(name);
		return await (await fh.getFile()).text();
	} catch (_) {
		return null;
	}
}

export async function fileSize(parts, name) {
	const dir = await tryGetDir(parts);
	if (!dir) return null;
	try {
		const fh = await dir.getFileHandle(name);
		return (await fh.getFile()).size;
	} catch (_) {
		return null;
	}
}
