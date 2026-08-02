/**
 * Minimal IndexedDB key/value store.
 *
 * chrome.storage can't hold a FileSystemDirectoryHandle (it isn't JSON), but
 * IndexedDB can — that's the only reason this file exists.
 */

const DB_NAME = 'ttarchive';
const STORE = 'kv';

function open() {
	return new Promise((resolve, reject) => {
		const req = indexedDB.open(DB_NAME, 1);
		req.onupgradeneeded = () => {
			if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
		};
		req.onsuccess = () => resolve(req.result);
		req.onerror = () => reject(req.error);
	});
}

async function tx(mode, fn) {
	const db = await open();
	try {
		return await new Promise((resolve, reject) => {
			const t = db.transaction(STORE, mode);
			const store = t.objectStore(STORE);
			const req = fn(store);
			t.oncomplete = () => resolve(req ? req.result : undefined);
			t.onerror = () => reject(t.error);
			t.onabort = () => reject(t.error);
		});
	} finally {
		db.close();
	}
}

export const idbGet = (key) => tx('readonly', (s) => s.get(key));
export const idbSet = (key, value) => tx('readwrite', (s) => s.put(value, key));
export const idbDel = (key) => tx('readwrite', (s) => s.delete(key));
