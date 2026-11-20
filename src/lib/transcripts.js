/**
 * transcripts.json: what is said in each post and what is written on it, read
 * out of the files by tools/index.py. Optional — an archive without it searches
 * by caption and author, as it always did.
 *
 * Only ever read here. The indexer is its one writer, and it replaces the file
 * whole, so a read never sees half of one.
 */

import { LAYOUT, readTextFile } from './fs.js';
import '../viewer/search.js';

export const TRANSCRIPTS_FILE = 'transcripts.json';

let items = {};
let readAt = 0;

/**
 * Read it again and hand it to the search. Whether there was one at all.
 *
 * `maxAge` lets a caller that asks often — a live viewer.html refreshing — use
 * the copy it has, since the indexer runs for hours and saves once a minute.
 */
export async function loadTranscripts({ maxAge = 0 } = {}) {
	if (maxAge && Date.now() - readAt < maxAge) return Object.keys(items).length > 0;
	readAt = Date.now();
	let next = {};
	try {
		const raw = await readTextFile(LAYOUT.root, TRANSCRIPTS_FILE);
		if (raw) next = JSON.parse(raw).items || {};
	} catch (_) {
		/* missing or half-written: search without it until the next read */
	}
	setTranscripts(next);
	return Object.keys(items).length > 0;
}

/** transcripts.json's `items`, from wherever they came. */
export function setTranscripts(next) {
	items = next || {};
	globalThis.ttSearch.useTranscripts(items);
}

export function transcriptOf(id) {
	return items[id] || null;
}
