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

	function tile(item, index) {
		const node = el('div', 'tile' + (present(item) ? '' : ' missing'));
		node.dataset.id = item.id;
		node.dataset.index = index;

		if (item.type === 'photo') {
			node.appendChild(el('span', 'badge', `🖼 ${item.photoCount || photoPaths(item).length || ''}`));
		}

		const cap = el('div', 'cap');
		cap.appendChild(el('div', 'who', item.author && item.author.uniqueId ? `@${item.author.uniqueId}` : ''));
		cap.appendChild(document.createTextNode(item.desc || ''));
		node.appendChild(cap);

		observer.observe(node);
		node.addEventListener('click', () => openLightbox(index));
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

	/**
	 * Sort by where an item sits in your likes list rather than when it was
	 * posted. `likeRank` 0 is the most recent like — the likes list carries no
	 * timestamp, so its order is the only thing that records when.
	 *
	 * An archive last synced before the order was recorded has no ranks at all,
	 * and one scanned in off disk never will. Those sort last, by post date, so
	 * the control still does something sensible instead of nothing.
	 */
	function byLikeOrder(dir) {
		const rank = (i) => (i.likeRank == null ? Infinity : i.likeRank);
		return (a, b) => {
			const ra = rank(a);
			const rb = rank(b);
			if (ra === rb) return dir * ((b.createTime || 0) - (a.createTime || 0));
			if (ra === Infinity || rb === Infinity) return ra === Infinity ? 1 : -1;
			return dir * (ra - rb);
		};
	}

	let byId = new Map();

	function applyFilters() {
		byId = new Map(items.map((i) => [String(i.id), i]));

		// A live refresh re-runs this while someone is watching. Hold the position
		// by id rather than by number: the list it indexes into is about to change.
		const openId = lbOpen() ? String(filtered[lbIndex].id) : null;

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
			'liked-recent': byLikeOrder(1),
			'liked-first': byLikeOrder(-1),
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
		const start = shown;
		const end = Math.min(filtered.length, shown + PAGE);
		for (let i = shown; i < end; i++) frag.appendChild(tile(filtered[i], i));
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

	/**
	 * The lightbox is a feed, not one item: it holds a position in `filtered` and
	 * steps through it with the wheel, the arrow keys or the two buttons.
	 *
	 * Each step tears the media down and builds it again. Keeping neighbours
	 * mounted would play better, but it also means holding decoders open for clips
	 * nobody is watching — the same reason the grid unmounts on scroll-out.
	 */
	let lbIndex = -1;
	/** Which image of a photo post is on the stage; ← → move within a post. */
	let lbPhoto = 0;
	/** Whether that post is opened out into every image at once. */
	let lbSheet = false;
	/** Carried between items, so muting once stays muted for the rest of the run. */
	let lbMuted = false;
	/** The other two a fresh element resets: speed and level both carry the same way. */
	let lbRate = 1;
	let lbVolume = 1;

	function lbOpen() {
		return lbIndex >= 0;
	}

	// ------------------------------------------------------------------ playback

	/**
	 * The rungs a player's own speed menu offers, and what [ and ] step through.
	 * A ladder rather than arithmetic: 1.25 and 1.75 are worth having either side
	 * of 1×, and nothing past 2× is worth a quarter of.
	 */
	const RATES = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4];
	const STORE = 'ttarchive-playback';

	/** Everything a new <video> defaults away from, applied in one place. */
	function applyPlayback(v) {
		// Both, because `load()` resets playbackRate to whatever the default is.
		v.defaultPlaybackRate = lbRate;
		v.playbackRate = lbRate;
		v.volume = lbVolume;
		v.muted = lbMuted;
	}

	function eachVideo(fn) {
		for (const v of $('lbStage').querySelectorAll('video')) fn(v);
	}

	/**
	 * Best-effort and no more: a file:// document has an opaque origin, and a
	 * browser is within its rights to refuse it storage. Where that happens the
	 * settings still carry between items — the run just starts at 1× again.
	 *
	 * Mute is deliberately not kept. The autoplay fallback below sets it on the
	 * viewer's behalf, so persisting it would mostly persist a mute nobody asked
	 * for, and a silent archive with the control reading unmuted is a puzzle.
	 */
	function remember() {
		try {
			localStorage.setItem(STORE, JSON.stringify({ rate: lbRate, volume: lbVolume }));
		} catch (_) {}
	}

	function recall() {
		try {
			const saved = JSON.parse(localStorage.getItem(STORE) || '{}');
			// Comparisons rather than truthiness: a stored null or string is out on
			// the same test, and a stored 0 volume is silence dressed as a setting.
			if (saved.rate > 0) lbRate = Math.min(4, saved.rate);
			if (saved.volume > 0 && saved.volume <= 1) lbVolume = saved.volume;
		} catch (_) {}
	}

	function setRate(rate) {
		lbRate = rate;
		remember();
		eachVideo(applyPlayback);
		renderCount();
	}

	function stepRate(delta) {
		// An off-ladder rate can arrive from the player's own menu; step from the
		// rung next to it rather than snapping back to the start of the ladder.
		let at = RATES.findIndex((r) => r >= lbRate);
		if (at < 0) at = RATES.length - 1;
		else if (delta > 0 && RATES[at] > lbRate) at--;
		setRate(RATES[Math.min(RATES.length - 1, Math.max(0, at + delta))]);
	}

	function clearStage() {
		const stage = $('lbStage');
		for (const v of stage.querySelectorAll('video')) {
			v.pause();
			v.removeAttribute('src');
			v.load();
		}
		stage.replaceChildren();
	}

	function closeLightbox() {
		if (!lbOpen()) return;
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

	/**
	 * Stepping skips whatever isn't on disk. The grid still opens those tiles —
	 * their metadata is worth reading — but a feed that stops on them is a feed
	 * that stops on nothing to watch.
	 */
	function nextIndex(delta) {
		for (let at = lbIndex + delta; at >= 0 && at < filtered.length; at += delta) {
			if (present(filtered[at])) return at;
		}
		return -1;
	}

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
		// Reading offsetWidth restarts the animation; without it a second bump in
		// the same direction is a no-op, which looks like a dropped keypress.
		void stage.offsetWidth;
		stage.classList.add(cls);
	}

	function stepPhoto(delta) {
		const item = filtered[lbIndex];
		if (!item) return;
		const n = photoPaths(item).length;
		if (n < 2) return;
		lbPhoto = (lbPhoto + delta + n) % n;
		// Paging is a request to look at one image, so it also leaves the sheet.
		lbSheet = false;
		renderStage(item);
		renderCount();
	}

	function renderCount() {
		if (!lbOpen()) return;
		const item = filtered[lbIndex];
		const n = item && item.type === 'photo' ? photoPaths(item).length : 0;
		const where = `${(lbIndex + 1).toLocaleString()} / ${filtered.length.toLocaleString()}`;
		const shot = lbSheet ? `all ${n} images` : `image ${lbPhoto + 1} of ${n}`;
		// The rate is a setting with no control of its own on screen, so the counter
		// is where it says so — and only where there is something for it to act on.
		const speed = lbRate !== 1 && item && item.type !== 'photo' ? ` · ${lbRate}×` : '';
		$('lbCount').textContent = (n > 1 ? `${where} · ${shot}` : where) + speed;
		$('lbPrev').disabled = nextIndex(-1) < 0;
		$('lbNext').disabled = nextIndex(1) < 0;
	}

	/** One image, arrows, dots — the shape TikTok's own slideshow player has. */
	function photoShot(paths) {
		const shot = el('div', 'lb-shot');
		const img = document.createElement('img');
		img.src = src(paths[lbPhoto]);
		img.alt = '';
		img.addEventListener('error', () => (img.alt = 'This image isn’t in the folder.'), { once: true });
		shot.appendChild(img);

		if (paths.length < 2) return shot;

		const page = (cls, glyph, delta, title) => {
			const b = el('button', `page ${cls}`, glyph);
			b.title = title;
			b.addEventListener('click', (e) => {
				e.stopPropagation();
				stepPhoto(delta);
			});
			return b;
		};

		const dots = el('div', 'dots');
		for (let i = 0; i < paths.length; i++) {
			const dot = el('i', i === lbPhoto ? 'on' : null);
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
			sheetToggle(`⊞ all ${paths.length}`)
		);
		return shot;
	}

	/** The whole post at once — the “unless I want to” half of one-at-a-time. */
	function photoSheet(paths) {
		const sheet = el('div', 'lb-sheet');
		// The toggle gets a row to itself: as a flex item it would be stretched to
		// the full width of one, and a pill that wide reads as a header bar.
		const head = el('div', 'head');
		head.appendChild(sheetToggle('✕ close all'));
		sheet.appendChild(head);
		paths.forEach((p, i) => {
			const img = document.createElement('img');
			img.src = src(p);
			img.alt = '';
			img.title = `Image ${i + 1}`;
			img.addEventListener('click', () => {
				lbPhoto = i;
				lbSheet = false;
				renderStage(filtered[lbIndex]);
				renderCount();
			});
			// The shape of the post is only known once something has arrived, and
			// each arrival can change it: one landscape image among portraits is a
			// different sheet.
			img.addEventListener('load', () => fitSheet(sheet, paths.length), { once: true });
			sheet.appendChild(img);
		});
		return sheet;
	}

	/**
	 * How big one image in the sheet may be — a cell, in pixels, for the CSS.
	 *
	 * The row count is chosen rather than fixed, because the best shape depends on
	 * the images: nine tall ones go far bigger in two rows of five than in three
	 * rows of three, while nine wide ones do not. Every row count is tried and the
	 * one that shows an image biggest wins.
	 *
	 * Until an image has loaded there is nothing to measure and the stylesheet's
	 * own fallback stands; each load calls back in with a better answer.
	 */
	function fitSheet(sheet, n) {
		const shapes = [...sheet.querySelectorAll('img')]
			.filter((img) => img.naturalWidth)
			.map((img) => img.naturalWidth / img.naturalHeight);
		if (!shapes.length) return;

		// The widest one decides: sized for the average, a panorama among portraits
		// is the image that overflows the row it was given.
		const aspect = Math.max(...shapes);
		const gap = 10;
		const room = sheetRoom(sheet);

		let best = { rows: n, cols: 1, size: 0 };
		for (let rows = 1; rows <= n; rows++) {
			const cols = Math.ceil(n / rows);
			const size = Math.min(
				(room.height - (rows - 1) * gap) / rows,
				(room.width - (cols - 1) * gap) / cols / aspect
			);
			if (size > best.size) best = { rows, cols, size };
		}

		// The height is the winning size itself, not the row's share of the box: a
		// row too narrow for it is what decides on a wide post, and taking the
		// share instead leaves the image letterboxed in a cell it can't fill.
		//
		// Floored, both of them: a cell a fraction of a pixel too wide is a row
		// that wraps one image early, and the sheet then scrolls for a post that
		// had fitted.
		sheet.style.setProperty('--cell-h', `${Math.floor(best.size)}px`);
		sheet.style.setProperty('--cell-w', `${Math.floor((room.width - (best.cols - 1) * gap) / best.cols)}px`);
	}

	/**
	 * What the sheet actually has, which is not 60vw × 88vh: the metadata panel
	 * and the arrows take their share off the width first, and on a narrow window
	 * that is most of it. Measured rather than assumed — the stylesheet's cap and
	 * a page scrollbar both land here.
	 */
	function sheetRoom(sheet) {
		const frame = sheet.closest('.lightbox');
		const style = getComputedStyle(frame);
		const gap = parseFloat(style.columnGap) || 0;
		let width = frame.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
		for (const part of frame.children) {
			// The count, the hint and the close button are out of flow and take
			// nothing; the stage is the sheet's own.
			if (part.contains(sheet) || getComputedStyle(part).position === 'absolute') continue;
			width -= part.getBoundingClientRect().width + gap;
		}
		const height = frame.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
		return {
			width: Math.min(width, window.innerWidth * 0.6) - 8,
			// The toggle's row, the gap under it and the sheet's own padding.
			height: Math.min(height, window.innerHeight * 0.88) - 44,
		};
	}

	function sheetToggle(label) {
		const b = el('button', 'all', label);
		b.title = 'Show every image in this post (g)';
		b.addEventListener('click', (e) => {
			e.stopPropagation();
			toggleSheet();
		});
		return b;
	}

	function toggleSheet() {
		const item = filtered[lbIndex];
		if (!item || item.type !== 'photo' || photoPaths(item).length < 2) return;
		lbSheet = !lbSheet;
		renderStage(item);
		renderCount();
	}

	/**
	 * Wrap the loop when the pictures run out rather than when the file does.
	 *
	 * TikTok's MP4s nearly always carry an audio track that outlasts the video
	 * track by 150–250ms — AAC encoder padding, mostly. The container's duration
	 * is the longer of the two, so `loop` holds the final frame frozen for a
	 * fifth of a second before it wraps, which reads as the clip stopping a few
	 * frames short and then hesitating.
	 *
	 * Where the video track ends isn't exposed anywhere, so it's learned by
	 * watching frames arrive: once playback has run past the newest frame by
	 * more than a couple of frame intervals, and it's near the end of the file
	 * at that, the tail has started. The point is remembered so later laps wrap
	 * on time instead of finding it again. `loop` is left on throughout — this
	 * only ever wraps *early*, so a file whose tracks do end together, or a
	 * browser that can't report frames at all, keeps the plain behaviour.
	 *
	 * Both ways of hearing that a frame happened are wired up, because neither
	 * is everywhere: `requestVideoFrameCallback`, which Chrome has had since 83
	 * and Firefox only since 132, and the playback-quality counter, which goes
	 * back much further. Either way it's only the *news* that is taken from
	 * them — where the clip had got to is read off `currentTime` at that moment.
	 *
	 * The frame callback does carry a timestamp of its own, and using it is the
	 * obvious thing, but it can't be trusted to mean what it says: measured on
	 * Firefox 153, `mediaTime` keeps climbing across a native loop instead of
	 * starting the new lap over — 36.6s into a 7.1s clip, five laps in. Reading
	 * it would put the newest frame permanently ahead of playback and the tail
	 * would never be noticed at all. `currentTime` is late by up to a paint,
	 * which the slack in the threshold covers, but it is always this lap's.
	 */
	function loopOnLastFrame(v) {
		const exact = !!v.requestVideoFrameCallback;
		if (!exact && !v.getVideoPlaybackQuality) return;

		let frameAt = 0; // Where the newest frame to appear sits in the clip.
		let gap = 1 / 30; // And how far apart those have been arriving.
		let seeded = false; // Whether frameAt is this lap's rather than the last's.
		let made = -1; // Frames produced so far, when that's all there is to go on.
		let tail = Infinity; // The first instant with no picture behind it,
		let guess = 0; // once a second lap has agreed with the first one's answer.

		/** A picture has appeared, and it sits at `at` in the clip. */
		function mark(at) {
			const step = at - frameAt;
			// A negative step is the wrap itself; an implausible one is a seek.
			if (seeded && step > 0 && step < 0.5) gap = step;
			seeded = true;
			frameAt = at;
		}

		if (exact) {
			v.requestVideoFrameCallback(function seen() {
				if (!v.isConnected) return;
				mark(v.currentTime);
				v.requestVideoFrameCallback(seen);
			});
		}

		(function watch() {
			if (!v.isConnected) return;
			requestAnimationFrame(watch);
			if (v.paused || v.seeking) return;

			if (!exact) {
				const n = v.getVideoPlaybackQuality().totalVideoFrames;
				if (n !== made) {
					if (made >= 0) mark(v.currentTime);
					made = n;
				}
			}

			// Only ever the last second of the clip: a frame dropped in the middle
			// of one, or a callback starved by a hidden tab, isn't a tail.
			if (!(v.duration - v.currentTime < 1)) return;
			if (v.currentTime < tail && v.currentTime - frameAt < gap * 1.5 + 0.03) return;
			// A single lap's answer can be a stutter rather than the tail, and a
			// memo taken from one would trim every lap after it short. It's held
			// until a second lap lands in the same place, and trusted only then.
			const end = frameAt + gap;
			if (Math.abs(end - guess) < gap * 1.5) tail = Math.min(tail, end);
			guess = end;
			frameAt = 0;
			seeded = false;
			v.currentTime = 0;
		})();
	}

	function renderStage(item) {
		const stage = $('lbStage');
		clearStage();

		if (item.type === 'photo') {
			const paths = photoPaths(item);
			if (!paths.length) {
				stage.textContent = 'No image paths recorded for this post.';
				return;
			}
			stage.appendChild(lbSheet && paths.length > 1 ? photoSheet(paths) : photoShot(paths));
			return;
		}

		const path = videoPath(item);
		if (!path) {
			stage.textContent = 'Never downloaded.';
			return;
		}

		const v = document.createElement('video');
		v.src = src(path);
		v.controls = true;
		v.loop = true;
		applyPlayback(v);
		// The element's own controls are the other way to set these, and what they
		// set has to carry onward exactly as what the keys set does.
		v.addEventListener('volumechange', () => {
			lbMuted = v.muted;
			lbVolume = v.volume;
			remember();
		});
		v.addEventListener('ratechange', () => {
			lbRate = v.playbackRate;
			remember();
			renderCount();
		});
		// `isConnected` because tearing this element down to step onward can itself
		// raise an error, and a stale handler would blank the item now on the stage.
		v.addEventListener(
			'error',
			() => {
				if (v.isConnected) stage.textContent = 'This file isn’t in the folder.';
			},
			{ once: true }
		);
		stage.appendChild(v);
		loopOnLastFrame(v);

		// Sound needs a gesture behind it, and stepping with the wheel or the keys
		// isn't always counted as one. A refused play is retried muted rather than
		// left as a still frame.
		const started = v.play();
		if (started && started.catch) {
			started.catch(() => {
				v.muted = true;
				lbMuted = true;
				v.play().catch(() => {});
			});
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
	$('lbPrev').addEventListener('click', () => step(-1));
	$('lbNext').addEventListener('click', () => step(1));
	$('lightbox').addEventListener('click', (e) => {
		if (e.target.id === 'lightbox') closeLightbox();
	});

	// The sheet is measured in pixels, so a window that changes size has to have
	// the sum done again.
	window.addEventListener('resize', () => {
		const sheet = $('lbStage').querySelector('.lb-sheet');
		if (sheet) fitSheet(sheet, sheet.querySelectorAll('img').length);
	});

	function togglePlay() {
		const v = $('lbStage').querySelector('video');
		if (!v) return;
		if (v.paused) v.play().catch(() => {});
		else v.pause();
	}

	document.addEventListener('keydown', (e) => {
		if (!lbOpen()) return;
		if (e.ctrlKey || e.altKey || e.metaKey) return;
		const tag = e.target && e.target.tagName;
		if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;

		const item = filtered[lbIndex];
		const shots = item && item.type === 'photo' ? photoPaths(item).length : 0;

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
				// Unmuting into a level of zero is silence with the control saying
				// otherwise. The player's own slider and its mute flag move together;
				// so do these.
				if (!lbMuted && !lbVolume) lbVolume = 1;
				remember();
				eachVideo(applyPlayback);
				break;
			// Speed, on the two keys next to each other and on YouTube's pair for the
			// same job. Nothing else here wants them.
			case '[':
			case '<':
				stepRate(-1);
				break;
			case ']':
			case '>':
				stepRate(1);
				break;
			case '\\':
				setRate(1);
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
			if (e.target.closest && e.target.closest('.lb-meta, .lb-sheet')) return;
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

	recall();
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
