/**
 * Saved replies: the sticker or photo out of a TikTok comment, kept beside the
 * likes.
 *
 * TikTok keeps no list of the comments you've liked, so there is nothing here to
 * sync. A reply comes in by its share link — long-press the comment, Share, Copy
 * link — and costs one request to find, plus the media itself.
 *
 * Finding it takes a detour. TikTok's web API leaves out every comment whose
 * sticker the website can't draw, which is why they show on the phone and not
 * in the browser. The same endpoint answers like the iPhone app when it is asked
 * with that app's `aid` and `device_platform`, and then lists those comments
 * with their sticker; `insert_ids` puts the shared comment — or the thread it
 * replies in — on the first page. A photo reply is listed either way, but
 * asking the one way gets both.
 *
 * None of it carries your login. A sync has to — the likes list is yours — but a
 * comment is public, so these requests go without cookies and nothing about
 * them is attributable to the account.
 *
 * A sticker is kept as a GIF when it moves and a PNG when it doesn't (see
 * src/lib/gif.js); a photo as the JPEG TikTok serves. Files go in replies/,
 * named by the comment's id, and the comment itself — who, what they wrote,
 * which post — goes in archive.json under `replies`.
 */

import { LAYOUT, photoName, writeFile } from './fs.js';
import { fetchFirst } from './downloader.js';
import { disk, hasReply, upsertReply } from './state.js';
import { sniffImageType, stickerFile } from './gif.js';

const API = 'https://www.tiktok.com/api/comment/list/';
/**
 * The iPhone app, as far as the comment list is concerned. The website's own
 * aid (1988) never gets the sticker comments; the app's lists them, and only an
 * iphone client with a version_code gets `cmt_sticker_struct` with them.
 */
const APP = { aid: '1233', device_platform: 'iphone', version_code: '41.5.0' };
const POST_PATH = /\/(?:video|photo|v)\/(\d+)/;
const RESOLUTIONS = ['high_resolution_url', 'mid_resolution_url', 'low_resolution_url'];

const EXT_BY_TYPE = {
	'image/webp': 'webp',
	'image/gif': 'gif',
	'image/png': 'png',
	'image/jpeg': 'jpg',
	'image/heic': 'heic',
	'image/avif': 'avif',
};

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Every link in whatever was pasted, once each and in order. Pasted text is
 * whatever the clipboard held — a link on its own, a list of them, or a link in
 * the middle of a sentence a share sheet wrapped around it.
 */
export function linksIn(text) {
	const seen = new Set();
	for (const m of String(text || '').matchAll(/https?:\/\/[^\s<>"']+/gi)) seen.add(m[0].replace(/[),.;]+$/, ''));
	return [...seen];
}

function idsIn(url) {
	const post = url.searchParams.get('share_item_id') || POST_PATH.exec(url.pathname)?.[1] || null;
	const comment = url.searchParams.get('share_comment_id') || null;
	return { post, comment };
}

/**
 * The post and comment a share link names.
 *
 * A link copied in the app is a short one (vm.tiktok.com, vt.tiktok.com,
 * tiktok.com/t/…) that names nothing until it is followed; it redirects to the
 * post's page with the comment in the query. The page itself is not wanted, so
 * the body is dropped as soon as the address is known.
 */
export async function resolveLink(link) {
	let url;
	try {
		url = new URL(link);
	} catch (_) {
		throw new Error('not a link');
	}
	if (!/(^|\.)tiktok\.com$/i.test(url.hostname)) throw new Error('not a TikTok link');

	let ids = idsIn(url);
	if (!ids.comment) {
		const res = await fetch(url.href, { credentials: 'omit', redirect: 'follow', cache: 'no-store' });
		res.body?.cancel().catch(() => {});
		ids = idsIn(new URL(res.url));
	}
	if (!ids.comment || !ids.post) {
		throw new Error(
			ids.post
				? 'that links to a post, not a comment — share the comment itself (long-press it, then Share)'
				: 'not a comment link — share the comment itself (long-press it, then Share)'
		);
	}
	return ids;
}

/**
 * The comment, as the app sees it. Resolves to `{ comment, thread }`, `thread`
 * being the comment it replies in when it is a reply; null if TikTok doesn't
 * have it any more.
 *
 * Retried twice, a second and then two apart: the endpoint now and then sends a
 * body cut off part-way, which is worth one more ask and not an error. A 429 is
 * not retried — see `RateLimited`.
 */
export async function findComment(post, comment) {
	const query = new URLSearchParams({ ...APP, aweme_id: post, count: '20', cursor: '0', insert_ids: comment });
	let data = null;
	for (let attempt = 0; ; attempt++) {
		try {
			const res = await fetch(`${API}?${query}`, { credentials: 'omit', cache: 'no-store' });
			if (res.status === 429) throw new RateLimited();
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			data = await res.json();
			break;
		} catch (err) {
			if (err instanceof RateLimited || attempt === 2) throw err;
			await wait(1000 * (attempt + 1));
		}
	}
	if (data.status_code) throw new Error(data.status_msg || `TikTok answered with status ${data.status_code}`);
	for (const top of data.comments || []) {
		if (top.cid === comment) return { comment: top, thread: null };
		for (const reply of top.reply_comment || []) if (reply.cid === comment) return { comment: reply, thread: top };
	}
	return null;
}

/**
 * TikTok is turning requests away. The rest of a batch would only be more of
 * the same, so it stops there rather than carrying on into the limit.
 */
export class RateLimited extends Error {
	constructor() {
		super('TikTok is rate-limiting requests — try the rest again later');
		this.name = 'RateLimited';
	}
}

function urlsOf(entry) {
	return (entry && entry.url_list) || [];
}

/** Download candidates for a sticker, best first: moving over still, then high > mid > low. */
export function stickerUrls(sticker) {
	const urls = [];
	for (const kind of ['animated_url', 'static_url']) {
		for (const res of RESOLUTIONS) {
			for (const u of urlsOf(sticker?.[kind]?.[res])) if (!urls.includes(u)) urls.push(u);
		}
	}
	return urls;
}

/**
 * Download candidates for one photo in a comment: the original before the
 * cropped copy, and JPEG before anything else. The `.image` links answer with
 * HEIC, which nothing in a browser can show.
 */
export function photoUrls(image) {
	const all = [...urlsOf(image?.origin_url), ...urlsOf(image?.crop_url)];
	const jpeg = (u) => /\.jpe?g(\?|$)/i.test(u.split('~').pop());
	return [...all.filter(jpeg), ...all.filter((u) => !jpeg(u))];
}

/** What a comment has worth keeping: `{ sticker: urls, photos: [urls…] }`, either possibly empty. */
export function replyMedia(comment) {
	return {
		sticker: comment.cmt_sticker_struct ? stickerUrls(comment.cmt_sticker_struct) : [],
		photos: (comment.image_list || []).map(photoUrls).filter((urls) => urls.length),
	};
}

/** The comment as archive.json keeps it: enough to show it and find it again, nothing else. */
export function replyRecord(comment, post, thread) {
	const user = comment.user || {};
	const media = replyMedia(comment);
	return {
		id: comment.cid,
		post: String(comment.aweme_id || post),
		// The comment this one answers, when it is a reply in a thread.
		thread: thread ? thread.cid : undefined,
		author: { id: user.uid || '', uniqueId: user.unique_id || '', nickname: user.nickname || '' },
		// A comment that is only a sticker carries this placeholder as its text.
		text: String(comment.text || '').replace('[Sticker]', '').trim(),
		createTime: comment.create_time || 0,
		diggCount: comment.digg_count || 0,
		kind: media.sticker.length ? 'sticker' : 'photo',
	};
}

/**
 * The file to keep for a sticker. A GIF or PNG where this browser can make one,
 * and TikTok's own file where it can't — the Library plays an animated WebP
 * just as well, it just doesn't go into a chat as easily.
 */
async function stickerToKeep(blob) {
	let made = null;
	try {
		made = await stickerFile(blob);
	} catch (_) {
		made = null;
	}
	if (made) return made;
	const type = sniffImageType(new Uint8Array(await blob.slice(0, 16).arrayBuffer()));
	return { blob, ext: EXT_BY_TYPE[type] || 'webp' };
}

/**
 * Save the sticker or photos out of one comment link.
 *
 * Resolves to `{ status: 'saved', reply, files, notes }`, or `{ status: 'have',
 * id }` for a comment already in the folder. Throws for a link that isn't a
 * comment, a comment that's gone, one with nothing in it to keep, and a refused
 * download; `RateLimited` is the one a caller should stop a batch for.
 */
export async function saveReply(state, link) {
	const { post, comment } = await resolveLink(link);
	if (hasReply(comment)) return { status: 'have', id: comment };

	const found = await findComment(post, comment);
	if (!found) throw new Error('TikTok no longer has that comment — deleted, or its post is gone');
	const media = replyMedia(found.comment);
	if (!media.sticker.length && !media.photos.length) throw new Error('that comment has no sticker or photo in it');

	const parts = [];
	const notes = [];
	if (media.sticker.length) {
		const { blob } = await fetchFirst(media.sticker, { expect: 'image', credentials: 'omit' });
		const kept = await stickerToKeep(blob);
		parts.push(kept);
		const size = `${kept.width}×${kept.height}`;
		if (kept.ext === 'gif') notes.push(`${size}, ${kept.frames} frames, ${(kept.ms / 1000).toFixed(1)}s`);
		else if (kept.ext === 'png') notes.push(`${size}, still`);
		else notes.push(`kept as .${kept.ext} — this browser can't decode it to make a GIF`);
	}
	for (const urls of media.photos) {
		const { blob } = await fetchFirst(urls, { expect: 'image', credentials: 'omit' });
		const type = sniffImageType(new Uint8Array(await blob.slice(0, 16).arrayBuffer()));
		parts.push({ blob, ext: EXT_BY_TYPE[type] || 'jpg' });
	}

	const names = [];
	for (let i = 0; i < parts.length; i++) {
		const name = photoName(comment, i + 1, parts.length, parts[i].ext);
		await writeFile(LAYOUT.replies, name, parts[i].blob);
		names.push(name);
	}
	disk.replies.set(comment, names.slice().sort());

	const files = names.map((name) => [...LAYOUT.replies, name].join('/'));
	const reply = upsertReply(state, replyRecord(found.comment, post, found.thread), files);
	const bytes = parts.reduce((n, p) => n + p.blob.size, 0);
	return { status: 'saved', reply, files, notes, bytes };
}
