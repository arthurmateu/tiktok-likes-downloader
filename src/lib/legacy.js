/**
 * Read-only importer for a myfaveTT archive folder.
 *
 * Their DBs live in data/.appdata/db_*.js as `window.<var>_base64 = "<gzip+b64>"`.
 * We never write these files — if the user ever runs myfaveTT again it stays the
 * sole owner of its own state. We only read them so previously-downloaded items
 * show up in our viewer with real metadata instead of a bare filename.
 */

import { readTextFile, LAYOUT } from './fs.js';

const FILES = [
	{ file: 'db_likes.js', key: 'likes' },
	{ file: 'db_videos.js', key: 'videos' },
	{ file: 'db_texts.js', key: 'texts' },
	{ file: 'db_authors.js', key: 'authors' },
	{ file: 'db_bookmarked.js', key: 'bookmarked' },
	{ file: 'db_following.js', key: 'following' },
];

async function gunzipBase64(b64) {
	const bin = atob(b64);
	const bytes = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
	const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
	return await new Response(stream).text();
}

async function loadOne(file) {
	const text = await readTextFile(LAYOUT.legacy, file);
	if (!text) return null;
	const m = text.match(/=\s*"([A-Za-z0-9+/=]+)"/);
	if (!m) return null;
	try {
		return JSON.parse(await gunzipBase64(m[1]));
	} catch (_) {
		return null;
	}
}

/**
 * @returns {Promise<null | {
 *   user: object|null,
 *   items: Record<string, object>,
 *   authors: Record<string, object>,
 *   downloaded: string[],
 *   officialList: string[],
 *   counts: { total: number, downloaded: number, disappeared: number }
 * }>}
 */
export async function importLegacy() {
	const parts = {};
	for (const { file, key } of FILES) parts[key] = await loadOne(file);

	if (!parts.likes && !parts.videos) return null;

	const videos = parts.videos || {};
	const texts = parts.texts || {};
	const authorsRaw = parts.authors || {};
	const likes = parts.likes?.likes || {};

	const authors = {};
	for (const [id, a] of Object.entries(authorsRaw)) {
		authors[id] = {
			id,
			uniqueId: (a.uniqueIds || []).slice(-1)[0] || '',
			nickname: (a.nicknames || []).slice(-1)[0] || '',
			uniqueIds: a.uniqueIds || [],
			nicknames: a.nicknames || [],
			followerCount: a.followerCount || 0,
			heartCount: a.heartCount || 0,
			videoCount: a.videoCount || 0,
		};
	}

	const items = {};
	for (const [id, v] of Object.entries(videos)) {
		const author = authors[v.authorId] || {};
		items[id] = {
			id,
			type: 'video',
			desc: typeof texts[id] === 'string' ? texts[id] : '',
			createTime: v.createTime || 0,
			author: {
				id: String(v.authorId || ''),
				uniqueId: author.uniqueId || '',
				nickname: author.nickname || '',
			},
			stats: { diggCount: v.diggCount || 0, playCount: v.playCount || 0 },
			music: { id: String(v.audioId || '') },
			sizeText: v.size || '',
			source: 'myfavett',
		};
	}

	return {
		user: parts.likes?.user || null,
		items,
		authors,
		downloaded: likes.downloaded || [],
		officialList: likes.officialList || [],
		counts: {
			total: likes.total || 0,
			downloaded: (likes.downloaded || []).length,
			disappeared: likes.numDisappeared || 0,
		},
	};
}
