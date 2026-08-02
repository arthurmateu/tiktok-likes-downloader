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

import { LAYOUT, readBlob, hasReadableFiles } from '../lib/fs.js';
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
	if (item.type === 'photo') return disk.photos.has(item.id);
	return disk.videos.has(item.id);
}

// ------------------------------------------------------------------ filtering

function applyFilters(state) {
	// A sync finishing re-runs this while someone is watching. Hold the position
	// by id rather than by number: the list it indexes into is about to change.
	const openId = lbOpen() ? String(filtered[lbIndex].id) : null;

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

	if (openId) {
		const at = filtered.findIndex((i) => String(i.id) === openId);
		// Only the counter is redrawn: the item on screen hasn't changed, and
		// re-rendering it would restart the clip under whoever is watching.
		if (at < 0) closeLightbox();
		else {
			lbIndex = at;
			renderCount();
		}
	}
}

function appendPage() {
	const frag = document.createDocumentFragment();
	const end = Math.min(filtered.length, shown + PAGE);
	for (let i = shown; i < end; i++) frag.appendChild(tile(filtered[i], i));
	shown = end;
	$('grid').appendChild(frag);
	$('libMore').classList.toggle('hidden', shown >= filtered.length);
}

// ------------------------------------------------------------------ tiles

function tile(item, index) {
	const el = document.createElement('div');
	el.className = 'tile' + (present(item) ? '' : ' missing');
	el.dataset.id = item.id;
	el.dataset.index = index;

	const img = document.createElement('img');
	img.loading = 'lazy';
	el.appendChild(img);

	if (item.type === 'photo') {
		const b = document.createElement('span');
		b.className = 'badge';
		b.textContent = `🖼 ${item.photoCount || disk.photos.get(item.id)?.length || ''}`;
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

	el.addEventListener('click', () => openLightbox(index));
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
	const photos = disk.photos.get(id);
	if (photos) {
		return photos.length ? blobURL(LAYOUT.images, photos[0]) : null;
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

/**
 * The lightbox is a feed, not one item: it holds a position in `filtered` and
 * steps through it with the wheel, the arrow keys or the two buttons.
 *
 * Each step tears the media down and builds it again — holding neighbours open
 * would mean a decoder and a live object URL per clip nobody is watching, which
 * is the same reason the grid revokes its thumbnails on scroll-out.
 */
let lbIndex = -1;
/** Which image of a photo post is on the stage; ← → move within a post. */
let lbPhoto = 0;
/** Whether that post is opened out into every image at once. */
let lbSheet = false;
/** Carried between items, so muting once stays muted for the rest of the run. */
let lbMuted = false;
/** Bumped per render: reads are async, and a slow one must not land on a later item. */
let lbSeq = 0;

const openURLs = [];

function lbOpen() {
	return lbIndex >= 0;
}

function photoNames(item) {
	return disk.photos.get(item.id) || [];
}

function clearStage() {
	const stage = $('lbStage');
	for (const v of stage.querySelectorAll('video')) {
		v.pause();
		v.removeAttribute('src');
		v.load();
	}
	stage.replaceChildren();
	while (openURLs.length) URL.revokeObjectURL(openURLs.pop());
}

function closeLightbox() {
	if (!lbOpen()) return;
	lbSeq++;
	clearStage();
	$('lbMeta').replaceChildren();
	$('lightbox').classList.add('hidden');
	const at = lbIndex;
	lbIndex = -1;
	revealTile(at);
}

/** Bring the grid to wherever the feed got to, so closing doesn't lose it. */
function revealTile(at) {
	if (!filtered[at]) return;
	while (shown <= at && shown < filtered.length) appendPage();
	const node = $('grid').querySelector(`[data-index="${at}"]`);
	if (!node) return;
	for (const old of $('grid').querySelectorAll('.tile.current')) old.classList.remove('current');
	node.classList.add('current');
	node.scrollIntoView({ block: 'center' });
}

function openLightbox(at) {
	if (at < 0 || at >= filtered.length) return;
	lbIndex = at;
	lbPhoto = 0;
	lbSheet = false;
	$('lightbox').classList.remove('hidden');
	renderLightbox();
}

function nextIndex(delta) {
	for (let at = lbIndex + delta; at >= 0 && at < filtered.length; at += delta) {
		if (present(filtered[at])) return at;
	}
	return -1;
}

/**
 * Stepping skips whatever isn't on disk. The grid still opens those tiles —
 * their metadata is worth reading — but a feed that stops on them is a feed that
 * stops on nothing to watch.
 */
function step(delta) {
	if (!lbOpen()) return;
	const at = nextIndex(delta);
	if (at < 0) return bump(delta);
	lbIndex = at;
	lbPhoto = 0;
	lbSheet = false;
	renderLightbox();
}

/** Nothing that way: say so with a nudge rather than by doing nothing. */
function bump(delta) {
	const stage = $('lbStage');
	const cls = delta > 0 ? 'edge-down' : 'edge-up';
	stage.classList.remove('edge-down', 'edge-up');
	// Reading offsetWidth restarts the animation; without it a second bump in the
	// same direction is a no-op, which looks like a dropped keypress.
	void stage.offsetWidth;
	stage.classList.add(cls);
}

function stepPhoto(delta) {
	const item = filtered[lbIndex];
	if (!item) return;
	const n = photoNames(item).length;
	if (n < 2) return;
	lbPhoto = (lbPhoto + delta + n) % n;
	// Paging is a request to look at one image, so it also leaves the sheet.
	lbSheet = false;
	renderStage(item);
	renderCount();
}

function toggleSheet() {
	const item = filtered[lbIndex];
	if (!item || item.type !== 'photo' || photoNames(item).length < 2) return;
	lbSheet = !lbSheet;
	renderStage(item);
	renderCount();
}

function renderCount() {
	if (!lbOpen()) return;
	const item = filtered[lbIndex];
	const n = item?.type === 'photo' ? photoNames(item).length : 0;
	const where = `${(lbIndex + 1).toLocaleString()} / ${filtered.length.toLocaleString()}`;
	const shot = lbSheet ? `all ${n} images` : `image ${lbPhoto + 1} of ${n}`;
	$('lbCount').textContent = n > 1 ? `${where} · ${shot}` : where;
	$('lbPrev').disabled = nextIndex(-1) < 0;
	$('lbNext').disabled = nextIndex(1) < 0;
}

function sheetToggle(label) {
	const b = document.createElement('button');
	b.className = 'all';
	b.textContent = label;
	b.title = 'Show every image in this post (g)';
	b.addEventListener('click', (e) => {
		e.stopPropagation();
		toggleSheet();
	});
	return b;
}

/** One image, arrows, dots — the shape TikTok's own slideshow player has. */
function photoShot(names, url) {
	const shot = document.createElement('div');
	shot.className = 'lb-shot';
	const img = document.createElement('img');
	img.src = url;
	img.alt = '';
	shot.appendChild(img);

	if (names.length < 2) return shot;

	const page = (cls, glyph, delta, title) => {
		const b = document.createElement('button');
		b.className = `page ${cls}`;
		b.textContent = glyph;
		b.title = title;
		b.addEventListener('click', (e) => {
			e.stopPropagation();
			stepPhoto(delta);
		});
		return b;
	};

	const dots = document.createElement('div');
	dots.className = 'dots';
	for (let i = 0; i < names.length; i++) {
		const dot = document.createElement('i');
		if (i === lbPhoto) dot.className = 'on';
		dot.addEventListener('click', (e) => {
			e.stopPropagation();
			lbPhoto = i;
			renderStage(filtered[lbIndex]);
			renderCount();
		});
		dots.appendChild(dot);
	}

	shot.append(
		page('prev', '‹', -1, 'Previous image (←)'),
		page('next', '›', 1, 'Next image (→)'),
		dots,
		sheetToggle(`⊞ all ${names.length}`)
	);
	return shot;
}

/**
 * Rebuild the stage for one item.
 *
 * Every await is followed by a sequence check: a folder read can outlast the
 * step that asked for it, and its blob URL would otherwise be appended over
 * whatever the feed has moved on to — or leak, having been dropped from the
 * revoke list.
 */
async function renderStage(item) {
	const seq = ++lbSeq;
	const stage = $('lbStage');
	clearStage();

	const stale = (url) => {
		if (seq === lbSeq) return false;
		if (url) URL.revokeObjectURL(url);
		return true;
	};

	if (item.type === 'photo') {
		const names = photoNames(item);
		if (!names.length) {
			stage.textContent = unreadableNote();
			return;
		}

		// The whole post at once — the “unless I want to” half of one-at-a-time.
		if (lbSheet && names.length > 1) {
			const sheet = document.createElement('div');
			sheet.className = 'lb-sheet';
			// The toggle gets a row to itself: as a flex item it would be stretched
			// to the full width of one, and a pill that wide reads as a header bar.
			const head = document.createElement('div');
			head.className = 'head';
			head.appendChild(sheetToggle('✕ close all'));
			sheet.appendChild(head);
			stage.appendChild(sheet);
			for (let i = 0; i < names.length; i++) {
				const url = await blobURL(LAYOUT.images, names[i]);
				if (stale(url)) return;
				if (!url) continue;
				openURLs.push(url);
				const img = document.createElement('img');
				img.src = url;
				img.alt = '';
				img.title = `Image ${i + 1}`;
				img.addEventListener('click', () => {
					lbPhoto = i;
					lbSheet = false;
					renderStage(filtered[lbIndex]);
					renderCount();
				});
				sheet.appendChild(img);
			}
			return;
		}

		lbPhoto = Math.min(lbPhoto, names.length - 1);
		const url = await blobURL(LAYOUT.images, names[lbPhoto]);
		if (stale(url)) return;
		if (!url) {
			stage.textContent = unreadableNote();
			return;
		}
		openURLs.push(url);
		stage.appendChild(photoShot(names, url));
		return;
	}

	const url = await blobURL(LAYOUT.videos, `${item.id}.mp4`);
	if (stale(url)) return;
	if (!url) {
		stage.textContent = unreadableNote();
		return;
	}
	openURLs.push(url);

	const v = document.createElement('video');
	v.src = url;
	v.controls = true;
	v.loop = true;
	v.muted = lbMuted;
	v.addEventListener('volumechange', () => (lbMuted = v.muted));
	stage.appendChild(v);

	// Sound needs a gesture behind it, and stepping with the wheel or the keys
	// isn't always counted as one. A refused play is retried muted rather than
	// left as a still frame.
	try {
		await v.play();
	} catch (_) {
		v.muted = true;
		lbMuted = true;
		v.play().catch(() => {});
	}
}

function renderLightbox() {
	const item = filtered[lbIndex];
	if (!item) return closeLightbox();

	renderStage(item);
	renderCount();

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
	$('lbPrev').addEventListener('click', () => step(-1));
	$('lbNext').addEventListener('click', () => step(1));
	$('lightbox').addEventListener('click', (e) => {
		if (e.target.id === 'lightbox') closeLightbox();
	});

	document.addEventListener('keydown', (e) => {
		if (!lbOpen()) return;
		if (e.ctrlKey || e.altKey || e.metaKey) return;
		const tag = e.target?.tagName;
		if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;

		const item = filtered[lbIndex];
		const shots = item?.type === 'photo' ? photoNames(item).length : 0;

		switch (e.key) {
			case 'Escape':
				closeLightbox();
				break;
			case 'ArrowDown':
			case 'PageDown':
			case 'j':
				step(1);
				break;
			case 'ArrowUp':
			case 'PageUp':
			case 'k':
				step(-1);
				break;
			// Sideways is the post's own images where there are any, and the feed
			// otherwise — nothing else is competing for those two keys.
			case 'ArrowRight':
				shots > 1 ? stepPhoto(1) : step(1);
				break;
			case 'ArrowLeft':
				shots > 1 ? stepPhoto(-1) : step(-1);
				break;
			case ' ':
				togglePlay();
				break;
			case 'm':
				lbMuted = !lbMuted;
				for (const v of $('lbStage').querySelectorAll('video')) v.muted = lbMuted;
				break;
			case 'g':
				toggleSheet();
				break;
			default:
				return;
		}
		// Only reached by a key this handler took: arrows and space scroll the page
		// underneath otherwise, and space would reach the video's own controls too.
		e.preventDefault();
	});

	/**
	 * Wheel to step. One trackpad flick arrives as a long tail of small deltas, so
	 * a step needs both a threshold and a cooldown — without the cooldown a single
	 * gesture runs through half a dozen clips.
	 */
	let wheelAcc = 0;
	let wheelUntil = 0;
	$('lightbox').addEventListener(
		'wheel',
		(e) => {
			if (!lbOpen()) return;
			// The metadata panel is taller than the screen on a long caption and
			// keeps its own scrolling; so does the opened-out photo sheet.
			if (e.target.closest?.('.lb-meta, .lb-sheet')) return;
			e.preventDefault();
			const now = performance.now();
			if (now < wheelUntil) {
				wheelAcc = 0;
				return;
			}
			wheelAcc += e.deltaY;
			if (Math.abs(wheelAcc) < 40) return;
			step(wheelAcc > 0 ? 1 : -1);
			wheelAcc = 0;
			wheelUntil = now + 320;
		},
		{ passive: false }
	);

	/** Same gesture on a touchscreen: a swipe up is the next one. */
	let touchY = null;
	$('lightbox').addEventListener(
		'touchstart',
		(e) => {
			touchY = e.touches.length === 1 ? e.touches[0].clientY : null;
		},
		{ passive: true }
	);
	$('lightbox').addEventListener(
		'touchend',
		(e) => {
			if (touchY == null || !lbOpen()) return;
			const dy = (e.changedTouches[0] || {}).clientY - touchY;
			touchY = null;
			if (Math.abs(dy) > 60) step(dy < 0 ? 1 : -1);
		},
		{ passive: true }
	);
}

function togglePlay() {
	const v = $('lbStage').querySelector('video');
	if (!v) return;
	if (v.paused) v.play().catch(() => {});
	else v.pause();
}

export function renderLibrary(state) {
	if (!state) return;
	applyFilters(state);
}
