/**
 * Library browser.
 *
 * Reads media straight off the chosen folder through the same directory handle
 * the downloader uses, so it works offline and never re-hits TikTok. Covers are
 * loaded lazily and their object URLs are revoked on scroll-out — at 6k+ items
 * holding them all alive is a few GB of blob memory.
 */

import { LAYOUT, tryGetDir, listFiles } from '../lib/fs.js';
import { disk } from '../lib/state.js';

const $ = (id) => document.getElementById(id);
const PAGE = 200;

let getState = () => null;
let filtered = [];
let shown = 0;
let observer = null;

// ------------------------------------------------------------------ helpers

async function blobURL(parts, name) {
	const dir = await tryGetDir(parts);
	if (!dir) return null;
	try {
		const fh = await dir.getFileHandle(name);
		return URL.createObjectURL(await fh.getFile());
	} catch (_) {
		return null;
	}
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
					loadCover(el.dataset.id).then((url) => {
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

async function loadCover(id) {
	const name = disk.covers.get(id);
	if (name) return blobURL(LAYOUT.covers, name);
	// Photo posts written before a cover existed: fall back to the first image.
	if (disk.photoDirs.has(id)) {
		const files = [...(await listFiles([...LAYOUT.photos, id]))].sort();
		if (files.length) return blobURL([...LAYOUT.photos, id], files[0]);
	}
	return null;
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
		const files = [...(await listFiles([...LAYOUT.photos, item.id]))].sort();
		for (const f of files) {
			const url = await blobURL([...LAYOUT.photos, item.id], f);
			if (!url) continue;
			openURLs.push(url);
			const img = document.createElement('img');
			img.src = url;
			stage.appendChild(img);
		}
		if (!files.length) stage.textContent = 'Not downloaded yet.';
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
			stage.textContent = 'Not downloaded yet.';
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
