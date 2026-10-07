/**
 * Local-helper backend: the archive folder, written by tools/helper.py.
 *
 * Experimental, and only ever chosen on purpose — see `init` in fs.js. The
 * extension still fetches every file itself, in the session TikTok handed the
 * URL to; what changes is where the bytes go. Instead of a File System Access
 * handle they are PUT to a small server on 127.0.0.1, which the background
 * starts over native messaging and which writes them with an ordinary path.
 *
 * What that gets over File System Access: no folder permission to grant again
 * every session, media the Library can stream by URL rather than read into a
 * blob first, and the folder served at an address a tab can open.
 *
 * Chromium only, like the helper itself, which registers for Chromium browsers
 * alone.
 */

import { ext } from '../ext.js';

export const id = 'helper';

export const capabilities = {
	/** Any folder: the helper opens a real folder dialog. */
	pick: 'directory',
	readBack: true,
	/** The helper lists the folder itself on every ask. */
	liveListing: true,
};

const HOST = 'com.ttarchive.helper';
const TOKEN_HEADER = 'X-Ttarchive-Token';

/**
 * What the background said when it last started the helper or was asked about
 * it: `{ base, token, root, rootOk }`. `base` can change — a helper started
 * again after the worker restarted may not get its old port back.
 */
let conn = null;

export function supported() {
	return typeof globalThis.showDirectoryPicker === 'function' && typeof ext?.runtime?.connectNative === 'function';
}

/**
 * The helper, running. Throws with the background's answer on `err.helper`
 * when it can't be — `error: 'no-helper'` with a `setup` command when it isn't
 * installed, `'stale-worker'` when the background predates the helper or
 * isn't running at all.
 */
async function connect({ fresh = false } = {}) {
	if (conn && !fresh) return conn;
	let res;
	try {
		res = await ext.runtime.sendMessage({ type: 'helper-ensure' });
	} catch (err) {
		// No worker to receive it at all — one that failed to start, or died
		// holding the request. Reloading the extension is the cure for that too.
		res = { ok: false, error: 'stale-worker', detail: String((err && err.message) || err) };
	}
	// Received, and nobody answered: a worker from before this backend existed.
	// Chromium keeps an unpacked extension's worker through changes to its files,
	// and through browser restarts, until the extension is reloaded.
	if (res === undefined) res = { ok: false, error: 'stale-worker' };
	if (!res || !res.ok) {
		const err = new Error((res && (res.detail || res.error)) || 'the extension worker did not answer');
		err.helper = res || { ok: false, error: 'no answer' };
		throw err;
	}
	conn = res;
	return conn;
}

/**
 * A request, asked again once on a helper started afresh if the first one
 * couldn't reach it. The helper lives as long as the background's pipe to it,
 * so a worker restart takes it down mid-sync, and the next ask is what brings
 * another one up — possibly on another port.
 */
async function request(path, init = {}) {
	const go = (c) =>
		fetch(`${c.base}/${path}`, {
			cache: 'no-store',
			...init,
			headers: { [TOKEN_HEADER]: c.token, ...(init.headers || {}) },
		});
	const c = await connect();
	try {
		return await go(c);
	} catch (_) {
		return go(await connect({ fresh: true }));
	}
}

async function api(path, init) {
	const res = await request(`api/${path}`, init);
	const body = await res.json().catch(() => null);
	if (!body || !body.ok) throw new Error((body && body.error) || `the helper answered ${res.status}`);
	return body;
}

function filePath(parts, name) {
	return [...parts, name].map(encodeURIComponent).join('/');
}

// ------------------------------------------------------------------ the root

export function rootLabel() {
	return conn && conn.root ? conn.root.split(/[\\/]/).filter(Boolean).pop() || conn.root : null;
}

/** The whole path, which File System Access never knows and this always does. */
export function rootPath() {
	return conn ? conn.root : null;
}

/**
 * 'granted' once the helper is up with a folder that is there; 'missing' for
 * one it remembers that isn't (a drive not plugged in); 'unavailable', with
 * the reason on `problem`, when the helper itself can't be had.
 */
export async function restore() {
	try {
		await connect({ fresh: true });
	} catch (err) {
		return { state: 'unavailable', label: null, problem: err.helper };
	}
	if (!conn.root) return { state: 'none', label: null };
	if (!conn.rootOk) return { state: 'missing', label: conn.root };
	return { state: 'granted', label: rootLabel() };
}

async function useRoot(path) {
	const res = await ext.runtime.sendMessage({ type: 'helper-root', root: path });
	if (!res || !res.ok) throw new Error((res && res.error) || 'the extension worker did not answer');
	conn = res;
	return { label: rootLabel() };
}

/**
 * Opens a folder dialog, from a helper process of its own started by this
 * click — Windows lets that one come to the front, where the long-running
 * server's dialog would open behind the browser. Rejects with an AbortError
 * when the dialog is cancelled, as the File System Access picker does.
 */
export async function pick() {
	await connect();
	const res = await ext.runtime.sendNativeMessage(HOST, { cmd: 'pick', initial: conn.root || null });
	if (!res || !res.ok) {
		if (res && res.error === 'cancelled') throw new DOMException('No folder chosen', 'AbortError');
		throw new Error((res && res.error) || 'the helper gave no answer');
	}
	return useRoot(res.root);
}

export async function requestAccess() {
	return (await restore()).state;
}

export async function forget() {
	await useRoot(null);
}

// -------------------------------------------------------------------- files

export async function listFiles(parts, { onProgress, onBatch } = {}) {
	const { files } = await api(`list?dir=${encodeURIComponent(parts.join('/'))}`);
	// One answer, all at once — the helper lists a folder of thousands in a few
	// milliseconds, so there are no batches to report as they come.
	if (onBatch && files.length) onBatch(files);
	onProgress?.(files.length);
	return new Set(files);
}

export async function listDirs(parts) {
	const { dirs } = await api(`list?dir=${encodeURIComponent(parts.join('/'))}`);
	return new Set(dirs);
}

export async function writeFile(parts, name, blob, { retries = 2 } = {}) {
	let lastErr;
	for (let attempt = 0; attempt <= retries; attempt++) {
		try {
			const res = await request(filePath(parts, name), { method: 'PUT', body: blob });
			if (res.ok) return true;
			const body = await res.json().catch(() => null);
			lastErr = new Error((body && body.error) || `the helper answered ${res.status}`);
		} catch (err) {
			lastErr = err;
		}
		await new Promise((r) => setTimeout(r, 250 * (attempt + 1)));
	}
	throw lastErr;
}

export async function readBlob(parts, name) {
	try {
		const res = await request(filePath(parts, name));
		return res.ok ? await res.blob() : null;
	} catch (_) {
		return null;
	}
}

export async function readText(parts, name) {
	const blob = await readBlob(parts, name);
	return blob ? blob.text() : null;
}

export async function fileSize(parts, name) {
	try {
		const res = await request(filePath(parts, name), { method: 'HEAD' });
		return res.ok ? Number(res.headers.get('Content-Length')) : null;
	} catch (_) {
		return null;
	}
}

/**
 * Where a media element can load this file from directly, by range, as it
 * would off disk. The token rides in the query because an element can't send
 * a header.
 */
export function mediaURL(parts, name) {
	if (!conn) return null;
	return `${conn.base}/${filePath(parts, name)}?t=${encodeURIComponent(conn.token)}`;
}

/** The folder's own Library at the helper's address; the visit leaves a cookie that keeps it working. */
export function libraryURL() {
	return conn ? `${conn.base}/?t=${encodeURIComponent(conn.token)}` : null;
}

/** The background knows which helper to ask; see `showInFolder` there. */
export async function showInFolder(parts, name) {
	return ext.runtime.sendMessage({ type: 'show-in-folder', path: [...parts, name].join('/') });
}
