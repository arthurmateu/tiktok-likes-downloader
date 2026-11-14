/**
 * The Library's search: what a query matches, and where in a post it matched.
 *
 * A post is found by its caption, its author, what is said in it and what is
 * written on it. The last two come from transcripts.json, which tools/index.py
 * writes by transcribing and reading every file in the archive; a post it hasn't
 * read yet is simply found by the first two.
 *
 * Case and accents are ignored on both sides — `cafe` finds `Café` — and every
 * word of the query has to appear somewhere in the post, not necessarily
 * together: `dog beach` finds a dog on a beach whether the caption says so or
 * someone does.
 *
 * A classic script that hangs off globalThis, like levelling.js and for the same
 * reason: src/archive/viewer.js imports it for the side effect, and
 * src/archive/standalone.js inlines it ahead of src/viewer/viewer.js.
 */

globalThis.ttSearch = (() => {
	const MARKS = /[̀-ͯ]/g;

	/** Lower case, without accents, so that two spellings of a word compare equal. */
	function fold(text) {
		return String(text || '').normalize('NFKD').replace(MARKS, '').toLowerCase();
	}

	/**
	 * Folded text and a map back to where each of its characters came from in the
	 * original, so a match found in the one can be highlighted in the other.
	 * `É` folds to `e` plus a dropped accent; `ﬁ` to two letters.
	 */
	function foldWithMap(text) {
		let out = '';
		const from = [];
		let i = 0;
		for (const ch of String(text || '')) {
			const f = fold(ch);
			for (let k = 0; k < f.length; k++) from.push(i);
			out += f;
			i += ch.length;
		}
		from.push(i);
		return { text: out, from };
	}

	/** The query as words to find. Empty for a blank query, which matches everything. */
	function parse(query) {
		return fold(query).split(/\s+/).filter(Boolean);
	}

	// What tools/index.py read out of each post, by id, for the pages that load
	// transcripts.json themselves. viewer.html carries the same text on its items
	// instead, as `said` and `seen`.
	let transcripts = new Map();
	let generation = 0;

	/** Hand over transcripts.json's `items`, or a Map of the same. */
	function useTranscripts(items) {
		transcripts = items instanceof Map ? items : new Map(Object.entries(items || {}));
		generation++;
	}

	function text(item, field) {
		return item[field] || transcripts.get(String(item.id))?.[field] || '';
	}

	// Kept on the item itself rather than in a map beside it: an item is replaced
	// wholesale when its record changes, which takes its folded copy with it.
	const HAY = Symbol('hay');

	function hay(item) {
		let h = item[HAY];
		if (!h || h.generation !== generation) {
			const a = item.author || {};
			h = {
				generation,
				about: fold(`${item.desc || ''} ${a.uniqueId || ''} ${a.nickname || ''}`),
				said: fold(text(item, 'said')),
				seen: fold(text(item, 'seen')),
			};
			try {
				Object.defineProperty(item, HAY, { value: h, configurable: true, writable: true });
			} catch (_) {
				/* a frozen item: fold every time */
			}
		}
		return h;
	}

	/** Whether every word is somewhere in the post. */
	function matches(item, words) {
		if (!words.length) return true;
		const h = hay(item);
		return words.every((w) => h.about.includes(w) || h.said.includes(w) || h.seen.includes(w));
	}

	/**
	 * Where the query was found beyond the caption and author, as the field and a
	 * short piece of its text around the first hit — the reason a post with no
	 * word of the query in its caption is in the results at all. Null when the
	 * caption and author account for it, or there is no query.
	 */
	function hit(item, words, width = 90) {
		if (!words.length) return null;
		const h = hay(item);
		if (words.every((w) => h.about.includes(w))) return null;
		for (const field of ['said', 'seen']) {
			if (!words.some((w) => !h.about.includes(w) && h[field].includes(w))) continue;
			return { field, ...snippet(text(item, field), words, width) };
		}
		return null;
	}

	/**
	 * Up to `width` characters of `text` around the first word found in it, as
	 * plain-text pieces with the found words marked: `[{text, mark}]`. Callers
	 * build nodes from these, so nothing out of a transcript is ever markup.
	 */
	function snippet(text, words, width = 90) {
		// A short piece is one line, with the line breaks between pieces of text
		// read off the screen still told apart. The whole text keeps them as they are.
		const flat = Number.isFinite(width)
			? String(text).replace(/\s*\n\s*/g, ' · ').replace(/\s+/g, ' ')
			: String(text);
		const { text: folded, from } = foldWithMap(flat);
		const spans = [];
		for (const w of words) {
			let at = folded.indexOf(w);
			while (at >= 0) {
				spans.push([from[at], from[at + w.length]]);
				at = folded.indexOf(w, at + w.length);
			}
		}
		spans.sort((a, b) => a[0] - b[0]);
		const first = spans.length ? spans[0][0] : 0;
		let start = Math.max(0, first - Math.floor(width / 3));
		let end = Math.min(flat.length, start + width);
		start = Math.max(0, end - width);
		// On a word boundary, where there is one near.
		if (start > 0) {
			const sp = flat.indexOf(' ', start);
			if (sp >= 0 && sp < first) start = sp + 1;
		}
		if (end < flat.length) {
			const sp = flat.lastIndexOf(' ', end);
			if (sp > first) end = sp;
		}
		const parts = [];
		let at = start;
		for (const [s, e] of spans) {
			if (e <= at || s >= end) continue;
			const s1 = Math.max(s, at);
			if (s1 > at) parts.push({ text: flat.slice(at, s1) });
			const e1 = Math.min(e, end);
			parts.push({ text: flat.slice(s1, e1), mark: true });
			at = e1;
		}
		if (at < end) parts.push({ text: flat.slice(at, end) });
		if (start > 0) parts.unshift({ text: '…' });
		if (end < flat.length) parts.push({ text: '…' });
		return { parts };
	}

	return { fold, parse, matches, hit, snippet, text, useTranscripts };
})();
