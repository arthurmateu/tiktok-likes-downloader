/**
 * Generator for the folder's own viewer.html.
 *
 * The archive page can only be reached at a chrome-extension:// or
 * moz-extension:// URL, which is not something anyone wants to keep to hand. So
 * a browsing front-end is written into the archive folder itself, next to
 * archive.json, and opens by double-clicking it.
 *
 * It has to be one file. A `file://` document has a unique opaque origin, so it
 * can neither fetch archive.json nor load a module script from beside itself —
 * the CSS, the JS and a slimmed copy of the metadata are therefore all inlined.
 * Media is the exception and stays on relative paths: `<img>` and `<video>` load
 * siblings off `file://` without complaint, which is the whole reason this
 * works at all.
 *
 * Sources live in src/viewer/ as ordinary files and are fetched from the
 * extension's own origin at generation time, rather than kept here as template
 * literals.
 */

import { ext } from '../lib/ext.js';
import { LAYOUT, writeFile, rootName } from '../lib/fs.js';

export const VIEWER_FILE = 'viewer.html';

const SOURCES = {
	template: 'src/viewer/template.html',
	css: 'src/viewer/viewer.css',
	js: 'src/viewer/viewer.js',
};

async function source(path) {
	const res = await fetch(ext.runtime.getURL(path));
	if (!res.ok) throw new Error(`could not read ${path} (${res.status})`);
	return res.text();
}

/**
 * `String.replace` reads `$&`, `$1` and friends out of the *replacement*, which
 * would corrupt any inlined code or caption containing them. Splitting on the
 * marker has no such reading.
 */
function fill(text, marker, value) {
	if (!text.includes(marker)) throw new Error(`template is missing ${marker}`);
	return text.split(marker).join(value);
}

/**
 * `</script` inside a `<script>` ends the element no matter where it appears in
 * the JavaScript — including inside a string. The backslash form is equivalent
 * in both languages and invisible to the parser that matters.
 */
function forScriptElement(code) {
	return code.replace(/<\/(script|style)/gi, '<\\/$1');
}

/** Same problem for the JSON blob, plus the two separators JSON leaves raw. */
function forJSONElement(value) {
	return JSON.stringify(value)
		.replace(/</g, '\\u003c')
		.replace(/>/g, '\\u003e')
		.replace(/&/g, '\\u0026')
		.replace(/\u2028/g, '\\u2028')
		.replace(/\u2029/g, '\\u2029');
}

function escapeAttr(value) {
	return String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Only what the grid, the search box and the lightbox actually read. Music,
 * dimensions and internal bookkeeping stay in archive.json — at six thousand
 * items the difference is megabytes of page.
 *
 * Exported because a live viewer asks for this same shape over the bridge, and
 * the two must not drift.
 */
export function slimItems(state) {
	const out = [];
	for (const item of Object.values(state.items || {})) {
		const author = item.author || {};
		const stats = item.stats || {};
		out.push({
			id: item.id,
			type: item.type || 'video',
			desc: item.desc || '',
			createTime: item.createTime || 0,
			author: { uniqueId: author.uniqueId || '', nickname: author.nickname || '' },
			stats: { diggCount: stats.diggCount || 0, playCount: stats.playCount || 0 },
			photoCount: item.photoCount || 0,
			status: item.status || '',
			files: item.files || undefined,
		});
	}
	return out;
}

/**
 * The token the content script presents before the extension will answer this
 * page. Not a secret — it sits in a file on disk — but it does mean that opening
 * some other local HTML file can't drive the extension just by carrying the
 * right meta tag.
 */
async function viewerToken() {
	const res = await ext.runtime.sendMessage({ type: 'viewer-token' });
	if (!res || !res.token) throw new Error('background did not issue a viewer token');
	return res.token;
}

export async function buildViewerHTML(state) {
	const [template, css, js] = await Promise.all([source(SOURCES.template), source(SOURCES.css), source(SOURCES.js)]);

	const title = rootName() ? `${rootName()} — TikTok archive` : 'TikTok archive';
	const payload = {
		config: {
			generatedAt: Date.now(),
			bridgeURL: ext.runtime.getURL('src/archive/archive.html'),
			version: ext.runtime.getManifest().version,
		},
		items: slimItems(state),
	};

	let html = template;
	html = fill(html, '__TOKEN__', escapeAttr(await viewerToken()));
	html = fill(html, '__TITLE__', escapeAttr(title));
	html = fill(html, '/*__CSS__*/', forScriptElement(css));
	html = fill(html, '/*__JS__*/', forScriptElement(js));
	html = fill(html, '__DATA__', forJSONElement(payload));
	return html;
}

/**
 * Write it into the archive root.
 *
 * Deliberately not `text: true`: that flag mirrors a file into IndexedDB so it
 * survives into the next session, which archive.json needs and a few megabytes
 * of regenerable HTML does not.
 */
export async function writeViewer(state) {
	const html = await buildViewerHTML(state);
	await writeFile(LAYOUT.root, VIEWER_FILE, new Blob([html], { type: 'text/html' }));
	return { file: VIEWER_FILE, bytes: html.length };
}
