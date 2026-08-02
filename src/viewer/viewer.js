/**
 * Runtime for the generated viewer.html.
 *
 * Inlined into that file by src/archive/standalone.js, so: a classic script,
 * no imports, no fetch. A `file://` document gets a unique opaque origin, which
 * makes `fetch('archive.json')` a CORS failure — the metadata is therefore baked
 * into the page as JSON rather than read at runtime. Media is exempt: `<img>`
 * and `<video>` load siblings off `file://` perfectly well, so tiles point at
 * videos/ and images/ by relative path.
 *
 * Two modes:
 *
 *   snapshot — what you get by double-clicking the file. Everything works except
 *              that the metadata is as old as the last sync.
 *   live     — a content script answered, so the extension is attached and can
 *              hand over current state and start a sync. Chromium only, and only
 *              once the user has ticked "Allow access to file URLs"; Gecko does
 *              not run extensions on local files at all.
 *
 * Thumbnails are `<video>` elements seeked a little way in, not canvas frames.
 * The archive page decodes frames with canvas.toBlob (see viewer.js there), and
 * that throws here: a `file://` video taints the canvas.
 */

(function () {
	'use strict';

	const $ = (id) => document.getElementById(id);
	const PAGE = 200;
	/** Tiles mounted without waiting for the observer — see appendPage. */
	const EAGER = 24;

	const raw = JSON.parse($('ttarchive-data').textContent);
	const config = raw.config || {};

	let items = raw.items || [];
	let filtered = [];
	let shown = 0;
	let observer = null;
	let live = false;
	let pollTimer = null;

	// ------------------------------------------------------------------ bridge

	/**
	 * Talks to the extension's content script over window.postMessage. Nothing
	 * here works without it, and nothing here is required for the page to work.
	 */
	const pending = new Map();
	let reqId = 0;

	window.addEventListener('message', (ev) => {
		if (ev.source !== window) return;
		const d = ev.data;
		if (!d || typeof d !== 'object') return;
		if (d.__ttarchive === 'bridge') {
			connect();
			return;
		}
		if (d.__ttarchive !== 'res') return;
		const resolve = pending.get(d.rid);
		if (resolve) {
			pending.delete(d.rid);
			resolve(d.payload);
		}
	});

	/** Resolves to null if nothing answers — which is the normal, offline case. */
	function call(cmd, args, timeout) {
		const rid = ++reqId;
		return new Promise((resolve) => {
			pending.set(rid, resolve);
			window.postMessage({ __ttarchive: 'req', rid, cmd, args: args || {} }, '*');
			setTimeout(() => {
				if (pending.delete(rid)) resolve(null);
			}, timeout || 10000);
		});
	}

	let connecting = false;

	async function connect() {
		// Called twice in the normal case — once on load, once when the content
		// script announces itself — and the second one must not re-fetch state.
		if (live || connecting) return;
		connecting = true;
		try {
			await probe();
		} finally {
			connecting = false;
		}
	}

	async function probe() {
		const res = await call('status', {}, 2500);
		if (!res || !res.ok) {
			// A bridge that answers 'no-archive-page' is still a bridge: the archive
			// tab is just closed. Say so rather than falling back to the generic
			// "this browser can't attach" copy.
			if (res && res.error === 'no-archive-page') showBanner('closed');
			return;
		}
		live = true;
		renderBanner(res);
		const fresh = await call('state', {}, 30000);
		if (fresh && fresh.ok && fresh.items) {
			items = fresh.items;
			applyFilters();
			setSub();
		}
		if (res.syncing) startPolling();
	}

	function startPolling() {
		clearInterval(pollTimer);
		pollTimer = setInterval(async () => {
			const res = await call('status', {}, 5000);
			if (!res || !res.ok) return;
			renderBanner(res);
			if (!res.syncing) {
				clearInterval(pollTimer);
				const fresh = await call('state', {}, 30000);
				if (fresh && fresh.ok && fresh.items) {
					items = fresh.items;
					applyFilters();
					setSub();
				}
			}
		}, 2000);
	}

	// ------------------------------------------------------------------ banner

	function el(tag, cls, text) {
		const node = document.createElement(tag);
		if (cls) node.className = cls;
		if (text != null) node.textContent = text;
		return node;
	}

	/** A read-only field plus a copy button, for the extension page's URL. */
	function urlRow() {
		if (!config.bridgeURL) return null;
		const row = el('div', 'row');
		const field = document.createElement('input');
		field.className = 'url';
		field.readOnly = true;
		field.value = config.bridgeURL;
		field.addEventListener('focus', () => field.select());
		const copy = el('button', 'btn', 'Copy');
		copy.addEventListener('click', async () => {
			field.select();
			try {
				await navigator.clipboard.writeText(config.bridgeURL);
				copy.textContent = 'Copied';
			} catch (_) {
				// Clipboard access can be refused even on a file:// page; the field
				// is already selected, so Ctrl+C still works.
				copy.textContent = 'Press Ctrl+C';
			}
			setTimeout(() => (copy.textContent = 'Copy'), 2000);
		});
		row.append(field, copy);
		return row;
	}

	function renderBanner(status) {
		const b = $('banner');
		b.className = 'banner live';
		b.replaceChildren();

		const head = el('div', 'head');
		head.append(el('span', 'dot', '● '), document.createTextNode('Connected to the extension'));
		b.appendChild(head);

		if (status.syncing) {
			const s = status.stats || {};
			b.appendChild(
				el(
					'p',
					'muted',
					`Syncing — seen ${(status.seen || 0).toLocaleString()}, saved ${(s.done || 0).toLocaleString()}, failed ${(s.failed || 0).toLocaleString()}.`
				)
			);
		} else {
			b.appendChild(
				el('p', 'muted', `Reading live from “${status.folder || 'the archive folder'}”. This page is current.`)
			);
		}

		const row = el('div', 'row');
		const sync = el('button', 'btn primary', status.syncing ? 'Syncing…' : 'Sync likes');
		sync.disabled = !!status.syncing;
		sync.addEventListener('click', async () => {
			sync.disabled = true;
			const res = await call('sync', {}, 20000);
			if (!res || !res.ok) {
				b.appendChild(el('p', 'muted', `Could not start: ${(res && res.error) || 'no response'}`));
				sync.disabled = false;
				return;
			}
			startPolling();
		});

		const open = el('button', 'btn', 'Open the archiver ↗');
		open.addEventListener('click', () => call('open', {}, 5000));

		row.append(sync, open);
		b.appendChild(row);
		b.classList.remove('hidden');
	}

	function showBanner(kind) {
		const b = $('banner');
		b.className = 'banner';
		b.replaceChildren();

		if (kind === 'closed') {
			b.appendChild(el('div', 'head', 'The archiver is installed, but its page is closed'));
			b.appendChild(
				el('p', 'muted', 'Open it to sync, or to let this page read current metadata instead of the snapshot below.')
			);
			const row = el('div', 'row');
			const open = el('button', 'btn primary', 'Open the archiver ↗');
			open.addEventListener('click', async () => {
				await call('open', {}, 5000);
				setTimeout(connect, 1500);
			});
			row.appendChild(open);
			b.appendChild(row);
		} else if (kind === 'chromium') {
			b.className = 'banner warn';
			b.appendChild(el('div', 'head', 'Snapshot only — the extension can’t see local files yet'));
			b.appendChild(
				el(
					'p',
					null,
					'Chromium won’t run an extension on a file:// page until you allow it, one time, per extension:'
				)
			);
			const ol = document.createElement('ol');
			for (const step of [
				'Open chrome://extensions (or edge://extensions).',
				'Find TikTok Likes Archiver and click Details.',
				'Turn on “Allow access to file URLs”.',
				'Reload this page.',
			]) {
				ol.appendChild(el('li', null, step));
			}
			b.appendChild(ol);
			const row = el('div', 'row');
			const again = el('button', 'btn', 'Check again');
			again.addEventListener('click', () => {
				window.location.reload();
			});
			row.appendChild(again);
			b.appendChild(row);
		} else if (kind === 'gecko') {
			b.appendChild(el('div', 'head', 'Snapshot — Firefox can’t attach the extension to a local file'));
			b.appendChild(
				el(
					'p',
					null,
					'Gecko doesn’t run extensions on file:// pages at all, so this page can’t reach the archiver or start a sync. Everything else works: search, playback and metadata all read straight off this folder.'
				)
			);
			b.appendChild(el('p', 'muted', 'Open the archiver’s own page to sync. If the link doesn’t open, copy it:'));
			const row = urlRow();
			if (row) b.appendChild(row);
		} else {
			b.appendChild(el('div', 'head', 'Snapshot'));
			b.appendChild(
				el(
					'p',
					null,
					'The archiver extension isn’t attached to this page, so the metadata below is from the last sync. Media plays from this folder either way.'
				)
			);
			const row = urlRow();
			if (row) b.appendChild(row);
		}

		b.classList.remove('hidden');
	}

	// ------------------------------------------------------------------ media

	/** Archive-relative path -> something safe to put in a src attribute. */
	function src(path) {
		return String(path).split('/').map(encodeURIComponent).join('/');
	}

	function videoPath(item) {
		// The convention fallback covers metadata written before file paths were
		// recorded; images can't be guessed the same way, since their extension
		// depends on what the CDN served.
		return (item.files && item.files.video) || (item.type !== 'photo' ? `videos/${item.id}.mp4` : null);
	}

	function photoPaths(item) {
		return (item.files && item.files.photos) || [];
	}

	function present(item) {
		return item.type === 'photo' ? photoPaths(item).length > 0 : !!(item.files && item.files.video);
	}

	// ------------------------------------------------------------------ tiles

	function fmtCount(n) {
		if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
		if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
		return String(n || 0);
	}

	function tile(item) {
		const node = el('div', 'tile' + (present(item) ? '' : ' missing'));
		node.dataset.id = item.id;

		if (item.type === 'photo') {
			node.appendChild(el('span', 'badge', `🖼 ${item.photoCount || photoPaths(item).length || ''}`));
		}

		const cap = el('div', 'cap');
		cap.appendChild(el('div', 'who', item.author && item.author.uniqueId ? `@${item.author.uniqueId}` : ''));
		cap.appendChild(document.createTextNode(item.desc || ''));
		node.appendChild(cap);

		observer.observe(node);
		node.addEventListener('click', () => openLightbox(item));
		return node;
	}

	/**
	 * Mount the preview only while the tile is on screen, and tear it down when it
	 * leaves. A 6k-item archive would otherwise hold 6k decoders open.
	 */
	function mount(node) {
		if (node.dataset.mounted) return;
		node.dataset.mounted = '1';
		const item = byId.get(node.dataset.id);
		if (!item) return;

		if (item.type === 'photo') {
			const first = photoPaths(item)[0];
			if (!first) return;
			const img = document.createElement('img');
			img.loading = 'lazy';
			img.src = src(first);
			node.insertBefore(img, node.firstChild);
			return;
		}

		const path = videoPath(item);
		if (!path) return;
		const v = document.createElement('video');
		v.muted = true;
		v.playsInline = true;
		v.preload = 'metadata';
		// The media fragment is what produces a frame rather than a black poster:
		// TikTok's frame 0 is very often a fade-in.
		v.src = `${src(path)}#t=0.5`;
		v.addEventListener('error', () => node.classList.add('missing'), { once: true });
		node.insertBefore(v, node.firstChild);
	}

	function unmount(node) {
		if (!node.dataset.mounted) return;
		node.dataset.mounted = '';
		const media = node.querySelector('img, video');
		if (!media) return;
		if (media.tagName === 'VIDEO') {
			media.removeAttribute('src');
			media.load();
		}
		media.remove();
	}

	function setupObserver() {
		if (observer) observer.disconnect();
		observer = new IntersectionObserver(
			(entries) => {
				for (const e of entries) {
					if (e.isIntersecting) mount(e.target);
					else unmount(e.target);
				}
			},
			{ rootMargin: '400px 0px' }
		);
	}

	// --------------------------------------------------------------- filtering

	let byId = new Map();

	function applyFilters() {
		byId = new Map(items.map((i) => [String(i.id), i]));

		const q = $('search').value.trim().toLowerCase();
		const kind = $('kind').value;

		let list = items;
		if (kind !== 'all') list = list.filter((i) => (i.type || 'video') === kind);
		if (q) {
			list = list.filter((i) => {
				const a = i.author || {};
				return `${i.desc || ''} ${a.uniqueId || ''} ${a.nickname || ''}`.toLowerCase().includes(q);
			});
		}

		const cmp = {
			'date-desc': (a, b) => (b.createTime || 0) - (a.createTime || 0),
			'date-asc': (a, b) => (a.createTime || 0) - (b.createTime || 0),
			'likes-desc': (a, b) => ((b.stats || {}).diggCount || 0) - ((a.stats || {}).diggCount || 0),
			'plays-desc': (a, b) => ((b.stats || {}).playCount || 0) - ((a.stats || {}).playCount || 0),
		}[$('sort').value];

		filtered = list.slice().sort(cmp);
		shown = 0;
		setupObserver();
		$('grid').replaceChildren();
		$('empty').classList.toggle('hidden', filtered.length > 0);
		appendPage();
	}

	function appendPage() {
		const frag = document.createDocumentFragment();
		const start = shown;
		const end = Math.min(filtered.length, shown + PAGE);
		for (let i = shown; i < end; i++) frag.appendChild(tile(filtered[i]));
		shown = end;
		const grid = $('grid');
		grid.appendChild(frag);
		$('more').classList.toggle('hidden', shown >= filtered.length);

		// The observer is what mounts media, and it only runs once the page has
		// painted a frame. Somewhere that never happens — a hidden window, a
		// headless render, a printout — the grid would otherwise be captions on
		// empty boxes. Mounting the first screenful outright also gets it on screen
		// a frame earlier; the observer takes over from there and unmounts these
		// again when they scroll away.
		const eager = Math.min(EAGER, end - start);
		for (let i = 0; i < eager; i++) mount(grid.children[start + i]);
	}

	// ---------------------------------------------------------------- lightbox

	function closeLightbox() {
		const stage = $('lbStage');
		for (const v of stage.querySelectorAll('video')) v.pause();
		stage.replaceChildren();
		$('lbMeta').replaceChildren();
		$('lightbox').classList.add('hidden');
	}

	function openLightbox(item) {
		const stage = $('lbStage');
		stage.replaceChildren();
		$('lightbox').classList.remove('hidden');

		if (item.type === 'photo') {
			const paths = photoPaths(item);
			for (const p of paths) {
				const img = document.createElement('img');
				img.src = src(p);
				stage.appendChild(img);
			}
			if (!paths.length) stage.textContent = 'No image paths recorded for this post.';
		} else {
			const path = videoPath(item);
			if (path) {
				const v = document.createElement('video');
				v.src = src(path);
				v.controls = true;
				v.autoplay = true;
				v.loop = true;
				v.addEventListener('error', () => (stage.textContent = 'This file isn’t in the folder.'), { once: true });
				stage.appendChild(v);
			} else {
				stage.textContent = 'Never downloaded.';
			}
		}

		const dl = document.createElement('dl');
		const add = (k, v) => {
			if (v == null || v === '') return;
			dl.append(el('dt', null, k), el('dd', null, v));
		};
		const author = item.author || {};
		const stats = item.stats || {};
		add('Caption', item.desc);
		add('Author', author.uniqueId ? `@${author.uniqueId} — ${author.nickname || ''}` : '');
		add('Posted', item.createTime ? new Date(item.createTime * 1000).toLocaleString() : '');
		add('Likes', fmtCount(stats.diggCount));
		add('Plays', fmtCount(stats.playCount));
		add('Type', item.type === 'photo' ? `photo post (${item.photoCount || '?'} images)` : 'video');
		add(
			'Status',
			{
				saved: 'saved',
				pending: 'in your likes, not downloaded',
				unavailable: 'download failed',
				gone: 'no longer in your likes — deleted, privated or unliked',
			}[item.status] || ''
		);
		add('ID', item.id);

		const link = document.createElement('a');
		link.href = `https://www.tiktok.com/@${author.uniqueId || 'x'}/video/${item.id}`;
		link.target = '_blank';
		link.rel = 'noreferrer';
		link.textContent = 'Open on TikTok ↗';
		link.style.color = 'var(--accent)';

		$('lbMeta').replaceChildren(dl, document.createElement('br'), link);
	}

	// -------------------------------------------------------------------- boot

	function setSub() {
		const saved = items.filter(present).length;
		const when = config.generatedAt ? new Date(config.generatedAt).toLocaleString() : null;
		const parts = [
			`${items.length.toLocaleString()} items`,
			`${saved.toLocaleString()} on disk`,
			live ? 'live' : when ? `snapshot from ${when}` : 'snapshot',
		];
		$('sub').textContent = parts.join(' · ');
	}

	let debounce;
	$('search').addEventListener('input', () => {
		clearTimeout(debounce);
		debounce = setTimeout(applyFilters, 200);
	});
	$('sort').addEventListener('change', applyFilters);
	$('kind').addEventListener('change', applyFilters);
	$('loadMore').addEventListener('click', appendPage);
	$('lbClose').addEventListener('click', closeLightbox);
	$('lightbox').addEventListener('click', (e) => {
		if (e.target.id === 'lightbox') closeLightbox();
	});
	document.addEventListener('keydown', (e) => {
		if (e.key === 'Escape' && !$('lightbox').classList.contains('hidden')) closeLightbox();
	});

	applyFilters();
	setSub();

	// The content script announces itself when it loads and `connect()` runs
	// again then, so this first probe only has to catch the case where it was
	// already there. Everything below is the answer for when it never arrives.
	connect().then(() => {
		if (live) return;
		if (!$('banner').classList.contains('hidden')) return;
		const ua = navigator.userAgent;
		if (/Firefox|Gecko\//.test(ua) && !/Chrome|Chromium|Edg/.test(ua)) showBanner('gecko');
		else if (/Chrome|Chromium|Edg/.test(ua)) showBanner('chromium');
		else showBanner('plain');
		setSub();
	});
})();
