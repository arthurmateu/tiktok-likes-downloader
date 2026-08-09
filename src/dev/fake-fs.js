/**
 * In-memory storage backend, for src/dev/thumbs.html.
 *
 * The dev page swaps this in for src/lib/fs.js with an import map, so state.js
 * and viewer.js run completely unmodified against a folder that exists only in
 * a Map. Dev-only; nothing in the extension imports it.
 *
 * The layout is re-exported from the real module (`?real` keeps the import map
 * from redirecting it back here), so a change to LAYOUT can't leave this fake
 * quietly testing a folder shape that no longer exists.
 */

export { LAYOUT, photoName, photoOwner, audioOwner } from '../lib/fs.js?real';

/** rel path -> Blob */
const files = new Map();

export function seed(path, blob) {
	files.set(path, blob);
}

export function remove(path) {
	files.delete(path);
}

export function reset() {
	files.clear();
}

/**
 * How many names a listing hands over at a time, 0 meaning all of them at once.
 *
 * The File System Access backend reports its folder in pieces because a real one
 * takes seconds to read, and the scan is built to use each piece as it lands.
 * This is how a test gets to watch that happen to a Map that is instant.
 */
let chunk = 0;

export function batchEvery(n) {
	chunk = n;
}

const prefixOf = (parts) => (parts.length ? `${parts.join('/')}/` : '');

export async function listFiles(parts, { onProgress, onBatch } = {}) {
	const prefix = prefixOf(parts);
	const names = new Set();
	for (const path of files.keys()) {
		if (!path.startsWith(prefix)) continue;
		const rest = path.slice(prefix.length);
		if (rest && !rest.includes('/')) names.add(rest);
	}
	// Reported in one go by default, like the downloads backend: a Map has no
	// incremental work to describe. Kept only so the fake honours the same
	// contract as the real one — and `batchEvery` makes it honour the other half.
	if (!onBatch || !names.size) {
		onProgress?.(names.size);
		return names;
	}
	const all = [...names];
	const step = chunk || all.length;
	for (let at = 0; at < all.length; at += step) {
		onBatch(all.slice(at, at + step));
		onProgress?.(Math.min(all.length, at + step));
		// The real backend yields here so the page can paint between batches.
		await new Promise((r) => setTimeout(r, 0));
	}
	return names;
}

export async function listDirs(parts) {
	const prefix = prefixOf(parts);
	const names = new Set();
	for (const path of files.keys()) {
		if (!path.startsWith(prefix)) continue;
		const cut = path.slice(prefix.length).indexOf('/');
		if (cut > 0) names.add(path.slice(prefix.length, prefix.length + cut));
	}
	return names;
}

export async function readBlob(parts, name) {
	return files.get([...parts, name].join('/')) || null;
}

export async function readTextFile(parts, name) {
	const blob = await readBlob(parts, name);
	return blob ? blob.text() : null;
}

export async function writeFile(parts, name, blob) {
	files.set([...parts, name].join('/'), blob);
	return true;
}

export async function fileSize(parts, name) {
	const blob = await readBlob(parts, name);
	return blob ? blob.size : null;
}

export async function refresh() {}
export function hasReadableFiles() {
	return true;
}
export function supported() {
	return true;
}
export function backendId() {
	return 'fake';
}
export function rootName() {
	return 'fake';
}
export const capabilities = { pick: 'directory', readBack: true, liveListing: true };
