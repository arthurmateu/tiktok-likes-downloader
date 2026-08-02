/**
 * Library browser.
 *
 * Reads media straight off the chosen folder through the same storage backend
 * the downloader writes with, so it works offline and never re-hits TikTok.
 * Thumbnails are loaded lazily and their object URLs are revoked on scroll-out
 * — at 6k+ items holding them all alive is a few GB of blob memory.
 *
 * There are no cover files in the archive: a thumbnail is either a photo post's
 * first image, or a frame decoded out of the video itself. The decoded frames
 * are cached as small JPEGs so scrolling back over a tile is free.
 *
 * On a backend that can't read its own output (Gecko's downloads folder) every
 * read simply returns null until the user scans the folder, so tiles fall back
 * to their metadata and the lightbox says the file isn't readable.
 */

import { LAYOUT, readBlob, listFiles, hasReadableFiles } from '../lib/fs.js';
import { disk } from '../lib/state.js';

const $ = (id) => document.getElementById(id);
const PAGE = 200;

let getState = () => null;
let filtered = [];
let shown = 0;
let observer = null;

// ------------------------------------------------------------------ helpers

async function blobURL(parts, name) {
	const blob = await readBlob(parts, name);
	return blob ? URL.createObjectURL(blob) : null;
}

/** Shown in place of the media when the backend can't read the folder back. */
function unreadableNote() {
	return hasReadableFiles()
		? 'Not downloaded yet.'
		: "Downloaded, but Firefox can't read it back until you use “Scan an existing folder…” on the Sync tab.";
}

function fmtCount(n) {
	if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
	if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
	return String(n || 0);
}

function present(item) {
	if (item.type === 'photo') return disk.photoDirs.has(item.id);
	return disk.videos.has(item.id);
}

// ------------------------------------------------------------------ filtering

function applyFilters(state) {
	const q = $('search').value.trim().toLowerCase();
	const kind = $('kind').value;
	const sort = $('sort').value;

	let list = Object.values(state?.items || {});

	if (kind !== 'all') list = list.filter((i) => (i.type || 'video') === kind);
	if (q) {
		list = list.filter((i) => {
			const hay = `${i.desc || ''} ${i.author?.uniqueId || ''} ${i.author?.nickname || ''}`;
			return hay.toLowerCase().includes(q);
		});
	}

	const cmp = {
		'date-desc': (a, b) => (b.createTime || 0) - (a.createTime || 0),
		'date-asc': (a, b) => (a.createTime || 0) - (b.createTime || 0),
		'likes-desc': (a, b) => (b.stats?.diggCount || 0) - (a.stats?.diggCount || 0),
		'plays-desc': (a, b) => (b.stats?.playCount || 0) - (a.stats?.playCount || 0),
	}[sort];
	list.sort(cmp);

	filtered = list;
	shown = 0;
	$('grid').replaceChildren();
	$('libCount').textContent = `${list.length.toLocaleString()} items`;
	appendPage();
}

function appendPage() {
	const frag = document.createDocumentFragment();
	const end = Math.min(filtered.length, shown + PAGE);
	for (let i = shown; i < end; i++) frag.appendChild(tile(filtered[i]));
	shown = end;
	$('grid').appendChild(frag);
	$('libMore').classList.toggle('hidden', shown >= filtered.length);
}

// ------------------------------------------------------------------ tiles

function tile(item) {
	const el = document.createElement('div');
	el.className = 'tile' + (present(item) ? '' : ' missing');
	el.dataset.id = item.id;

	const img = document.createElement('img');
	img.loading = 'lazy';
	el.appendChild(img);

	if (item.type === 'photo') {
		const b = document.createElement('span');
		b.className = 'badge';
		b.textContent = `🖼 ${item.photoCount || disk.photoDirs.get(item.id) || ''}`;
		el.appendChild(b);
	}

	const cap = document.createElement('div');
	cap.className = 'cap';
	const who = document.createElement('div');
	who.className = 'who';
	who.textContent = item.author?.uniqueId ? `@${item.author.uniqueId}` : '';
	cap.appendChild(who);
	cap.appendChild(document.createTextNode(item.desc || ''));
	el.appendChild(cap);

	el.addEventListener('click', () => openLightbox(item));
	observer.observe(el);
	return el;
}

function setupObserver() {
	observer?.disconnect();
	observer = new IntersectionObserver(
		(entries) => {
			for (const e of entries) {
				const el = e.target;
				const img = el.querySelector('img');
				if (e.isIntersecting) {
					if (img.dataset.loaded) continue;
					img.dataset.loaded = '1';
					loadThumb(el.dataset.id).then((url) => {
						if (url) img.src = url;
						else img.dataset.loaded = '';
					});
				} else if (img.src.startsWith('blob:')) {
					URL.revokeObjectURL(img.src);
					img.removeAttribute('src');
					img.dataset.loaded = '';
				}
			}
		},
		{ rootMargin: '400px 0px' }
	);
}

// ------------------------------------------------------------------ thumbnails

/**
 * Decoded video frames, id -> JPEG blob. Bounded because a full scroll through
 * a 6k archive would otherwise pin every frame it ever drew; at ~20 KB each the
 * cap is a few MB and a re-decode costs one seek.
 */
const THUMB_CACHE_MAX = 400;
const thumbs = new Map();

function cacheThumb(id, blob) {
	thumbs.set(id, blob);
	while (thumbs.size > THUMB_CACHE_MAX) thumbs.delete(thumbs.keys().next().value);
	return blob;
}

/**
 * Draw one frame out of a video file.
 *
 * Seeks a little way in rather than taking frame 0, which on TikTok is very
 * often black or a fade-in. The source blob is a File handle, so the decoder
 * reads only the bytes it needs and not the whole clip.
 */
function frameFrom(blob) {
	return new Promise((resolve) => {
		const url = URL.createObjectURL(blob);
		const v = document.createElement('video');
		v.muted = true;
		v.preload = 'metadata';

		let settled = false;
		const done = (out) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			URL.revokeObjectURL(url);
			v.removeAttribute('src');
			v.load();
			resolve(out);
		};
		const timer = setTimeout(() => done(null), 10000);

		v.addEventListener('error', () => done(null), { once: true });
		v.addEventListener(
			'loadeddata',
			() => {
				v.currentTime = Math.min(0.5, (v.duration || 1) / 4);
			},
			{ once: true }
		);
		v.addEventListener(
			'seeked',
			() => {
				try {
					const w = 360;
					const h = Math.round(w * (v.videoHeight / v.videoWidth || 16 / 9));
					const c = document.createElement('canvas');
					c.width = w;
					c.height = h;
					c.getContext('2d').drawImage(v, 0, 0, w, h);
					c.toBlob((out) => done(out), 'image/jpeg', 0.72);
				} catch (_) {
					done(null);
				}
			},
			{ once: true }
		);

		v.src = url;
	});
}

/**
 * Decoding is serialized two at a time. A screenful of tiles all becoming
 * visible at once would otherwise spin up twenty video decoders together, which
 * stalls the page for longer than the thumbnails are worth.
 */
let decoding = 0;
const decodeQueue = [];

function pumpDecode() {
	while (decoding < 2 && decodeQueue.length) {
		const job = decodeQueue.shift();
		decoding++;
		job().finally(() => {
			decoding--;
			pumpDecode();
		});
	}
}

function queueDecode(fn) {
	return new Promise((resolve) => {
		decodeQueue.push(() => fn().then(resolve, () => resolve(null)));
		pumpDecode();
	});
}

/** Exported so src/dev/thumbs.html can drive it without an IntersectionObserver. */
export async function loadThumb(id) {
	if (disk.photoDirs.has(id)) {
		const files = [...(await listFiles([...LAYOUT.images, id]))].sort();
		if (files.length) return blobURL([...LAYOUT.images, id], files[0]);
		return null;
	}

	const cached = thumbs.get(id);
	if (cached) return URL.createObjectURL(cached);
	if (!disk.videos.has(id)) return null;

	return queueDecode(async () => {
		const file = await readBlob(LAYOUT.videos, `${id}.mp4`);
		if (!file) return null;
		const frame = await frameFrom(file);
		return frame ? URL.createObjectURL(cacheThumb(id, frame)) : null;
	});
}

// ------------------------------------------------------------------ lightbox

const openURLs = [];

function closeLightbox() {
	const stage = $('lbStage');
	for (const v of stage.querySelectorAll('video')) v.pause();
	stage.replaceChildren();
	$('lbMeta').replaceChildren();
	while (openURLs.length) URL.revokeObjectURL(openURLs.pop());
	$('lightbox').classList.add('hidden');
}

async function openLightbox(item) {
	const stage = $('lbStage');
	stage.replaceChildren();
	$('lightbox').classList.remove('hidden');

	if (item.type === 'photo') {
		const files = [...(await listFiles([...LAYOUT.images, item.id]))].sort();
		for (const f of files) {
			const url = await blobURL([...LAYOUT.images, item.id], f);
			if (!url) continue;
			openURLs.push(url);
			const img = document.createElement('img');
			img.src = url;
			stage.appendChild(img);
		}
		if (!stage.childElementCount) stage.textContent = unreadableNote();
	} else {
		const url = await blobURL(LAYOUT.videos, `${item.id}.mp4`);
		if (url) {
			openURLs.push(url);
			const v = document.createElement('video');
			v.src = url;
			v.controls = true;
			v.autoplay = true;
			v.loop = true;
			stage.appendChild(v);
		} else {
			stage.textContent = unreadableNote();
		}
	}

	const dl = document.createElement('dl');
	const add = (k, v) => {
		if (v == null || v === '') return;
		const dt = document.createElement('dt');
		dt.textContent = k;
		const dd = document.createElement('dd');
		dd.textContent = v;
		dl.append(dt, dd);
	};
	add('Caption', item.desc);
	add('Author', item.author?.uniqueId ? `@${item.author.uniqueId} — ${item.author.nickname || ''}` : '');
	add('Posted', item.createTime ? new Date(item.createTime * 1000).toLocaleString() : '');
	add('Likes', fmtCount(item.stats?.diggCount));
	add('Plays', fmtCount(item.stats?.playCount));
	add('Type', item.type === 'photo' ? `photo post (${item.photoCount || '?'} images)` : 'video');
	add(
		'Status',
		{
			saved: 'saved',
			pending: 'in your likes, not downloaded',
			unavailable: `download failed${typeof item.unavailable === 'string' ? ` — ${item.unavailable}` : ''}`,
			gone: 'no longer in your likes — deleted, privated or unliked',
		}[item.status] || ''
	);
	add('ID', item.id);

	const link = document.createElement('a');
	link.href = `https://www.tiktok.com/@${item.author?.uniqueId || 'x'}/video/${item.id}`;
	link.target = '_blank';
	link.rel = 'noreferrer';
	link.textContent = 'Open on TikTok ↗';
	link.style.color = 'var(--accent)';

	$('lbMeta').replaceChildren(dl, document.createElement('br'), link);
}

// ------------------------------------------------------------------ wiring

export function wireLibrary(stateGetter) {
	getState = stateGetter;
	setupObserver();

	let debounce;
	$('search').addEventListener('input', () => {
		clearTimeout(debounce);
		debounce = setTimeout(() => applyFilters(getState()), 200);
	});
	$('sort').addEventListener('change', () => applyFilters(getState()));
	$('kind').addEventListener('change', () => applyFilters(getState()));
	$('loadMore').addEventListener('click', appendPage);
	$('lbClose').addEventListener('click', closeLightbox);
	$('lightbox').addEventListener('click', (e) => {
		if (e.target.id === 'lightbox') closeLightbox();
	});
	document.addEventListener('keydown', (e) => {
		if (e.key === 'Escape' && !$('lightbox').classList.contains('hidden')) closeLightbox();
	});
}

export function renderLibrary(state) {
	if (!state) return;
	applyFilters(state);
}
