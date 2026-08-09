/**
 * ISOLATED-world collector.
 *
 * Bridges hook.js (MAIN world) to the service worker, and drives the list
 * pagination. Two ways, in order:
 *
 *   1. Background paging — ask hook.js to replay the last signed item_list
 *      request with the next cursor. No scrolling, so the tab can sit in the
 *      background while you carry on using the browser.
 *   2. Scrolling the page, the way this used to work throughout. Slower, needs
 *      the tab visible, but it is TikTok's own code making the requests, so it
 *      survives signing changes that break (1).
 */
(() => {
	'use strict';

	// See src/lib/ext.js — Gecko only returns promises from `browser.*`.
	const ext = globalThis.browser ?? globalThis.chrome;

	const state = {
		hooked: false,
		profileUser: null,
		me: null,
		harvesting: false,
		abort: false,
		focusBorrowed: false,
		lastCapture: null,
		seen: new Set(),
	};

	// ---------------------------------------------------------------- normalize

	/**
	 * Rank the bitrateInfo gears best-first and flatten every candidate URL.
	 *
	 * Resolution decides, bitrate only breaks ties. Sorting on bitrate alone —
	 * which this used to do — hands the win to the h264 540/720 rung whenever
	 * HEVC's efficiency puts the 1080 rung below it in bits per second, and that
	 * is the common case: of 29 videos read off a live feed, 16 had a
	 * higher-resolution gear than the bitrate winner. TikTok scores the swap
	 * itself in each gear's `MVMAF` field — for 7665751835969326368,
	 * normal_540_0 (576×1024, 802 kbps) is 81.98 VMAF against the original while
	 * adapt_lowest_1080_1 (1080×1920, 676 kbps) is 94.29.
	 *
	 * Payloads that predate `PlayAddr.Width` fall back to the old bitrate order,
	 * since every gear then scores zero pixels.
	 *
	 * `Format: 'dash'` gears are skipped, and that check has to come before the
	 * ranking rather than after it. Those gears are the adaptive ladder: a
	 * video-only representation, served from a `media-video-hvc1/` path, whose
	 * sound lives in a separate `bitrateAudioInfo` entry it names in
	 * `VideoExtra.audio_file_id`. They are ordinary playable mp4 files, so
	 * nothing downstream notices — the archive just gets a silent copy. Ranking
	 * on resolution walked straight into them, since the dash ladder is where
	 * the 1080 rungs are: for 7669983946771336462 the gears are `normal_720_0`
	 * (mp4, 720×1280) and `adapt_lowest_1080_1` (dash, 1080×1920), and the
	 * 15,450,455-byte silent file in the archive is that second one to the byte.
	 * Only `Format === 'dash'` is excluded, never a missing `Format` — payloads
	 * older than the dash ladder don't carry the field and are all progressive.
	 *
	 * `downloadAddr` is deliberately excluded. Verified against
	 * tiktok.com/@soupy_cos/video/7669190146864074006: playAddr and downloadAddr
	 * are different encodes of the same clip (1,219,617 vs 1,252,838 bytes), and
	 * downloadAddr carries the bouncing "TikTok / @author" watermark burned in.
	 * Never fall back to it — a watermarked file is worse than a missing one.
	 */
	function videoUrls(v) {
		const urls = [];
		const all = Array.isArray(v.bitrateInfo) ? v.bitrateInfo : [];
		const gears = all.filter((g) => String(g.Format ?? g.format ?? '').toLowerCase() !== 'dash');
		const pixels = (g) => (g.PlayAddr?.Width || 0) * (g.PlayAddr?.Height || 0);
		gears.sort((a, b) => pixels(b) - pixels(a) || (b.Bitrate || 0) - (a.Bitrate || 0));
		for (const g of gears) {
			const list = g.PlayAddr?.UrlList || [];
			for (const u of list) urls.push(u);
		}
		if (v.playAddr) urls.push(v.playAddr);
		return [...new Set(urls.filter(Boolean))];
	}

	function coverUrls(item) {
		const v = item.video || {};
		const ip = item.imagePost || {};
		const out = [
			...(ip.cover?.imageURL?.urlList || []),
			v.cover,
			v.originCover,
			v.dynamicCover,
			...(item.imagePost?.images?.[0]?.imageURL?.urlList || []),
		];
		return [...new Set(out.filter(Boolean))];
	}

	function normalize(item) {
		if (!item || !item.id) return null;
		const isPhoto = !!(item.imagePost && Array.isArray(item.imagePost.images) && item.imagePost.images.length);
		const a = item.author || {};
		const s = item.stats || item.statsV2 || {};
		const m = item.music || {};
		const num = (x) => (x == null ? 0 : Number(x) || 0);

		return {
			id: String(item.id),
			type: isPhoto ? 'photo' : 'video',
			desc: item.desc || item.imagePost?.title || '',
			createTime: num(item.createTime),
			author: {
				id: String(a.id || ''),
				uniqueId: a.uniqueId || '',
				nickname: a.nickname || '',
				avatar: a.avatarThumb || '',
			},
			stats: {
				diggCount: num(s.diggCount),
				playCount: num(s.playCount),
				commentCount: num(s.commentCount),
				shareCount: num(s.shareCount),
				collectCount: num(s.collectCount),
			},
			music: { id: String(m.id || ''), title: m.title || '', authorName: m.authorName || '' },
			duration: num(item.video?.duration),
			width: num(item.video?.width),
			height: num(item.video?.height),
			cover: coverUrls(item),
			video: isPhoto ? [] : videoUrls(item.video || {}),
			photos: isPhoto
				? item.imagePost.images.map((im) => (im.imageURL?.urlList || []).filter(Boolean))
				: [],
		};
	}

	// ---------------------------------------------------------------- messaging

	function toBackground(type, payload) {
		try {
			ext.runtime.sendMessage({ type, payload }).catch(() => {});
		} catch (_) {
			/* extension context invalidated (reload); harmless */
		}
	}

	window.addEventListener('message', (ev) => {
		if (ev.source !== window) return;
		const d = ev.data;
		if (!d || d.__ttarchive !== true) return;

		if (d.kind === 'hooked') {
			state.hooked = true;
			return;
		}
		if (d.kind === 'pagestate') {
			if (d.payload.profileUser) state.profileUser = d.payload.profileUser;
			if (d.payload.me) state.me = d.payload.me;
			toBackground('pagestate', d.payload);
			return;
		}
		if (d.kind === 'paginate-result') {
			const resolve = pendingPages.get(d.payload.rid);
			if (resolve) {
				pendingPages.delete(d.payload.rid);
				resolve(d.payload);
			}
			return;
		}
		if (d.kind === 'capture') {
			const p = d.payload;
			state.lastCapture = { at: Date.now(), ...p };
			const items = [];
			for (const raw of p.itemList || []) {
				const n = normalize(raw);
				if (!n) continue;
				if (state.seen.has(n.id)) continue;
				state.seen.add(n.id);
				items.push(n);
			}
			toBackground('items', {
				endpoint: p.endpoint,
				items,
				hasMore: p.hasMore,
				total: p.total,
				seenTotal: state.seen.size,
			});
		}
	});

	// ---------------------------------------------------------------- harvest

	const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

	/**
	 * Hand the event loop back for one turn, without going through a timer —
	 * `setTimeout(0)` is clamped in a background tab like every other timer.
	 *
	 * Every wait ends with one of these. Without it, a wait that resolves on a
	 * microtask (the worker answering instantly, or not being there at all) turns
	 * a polling loop into a spin that starves the page: the fetch and postMessage
	 * callbacks it is waiting for are tasks, and tasks never get to run.
	 */
	function yieldToPage() {
		return new Promise((resolve) => {
			const ch = new MessageChannel();
			ch.port1.onmessage = () => {
				ch.port1.close();
				resolve();
			};
			ch.port2.postMessage(0);
		});
	}

	/**
	 * A sleep that survives being in a background tab.
	 *
	 * Chrome clamps a hidden tab's timers to 1s, and to once a minute once it has
	 * been hidden a while — which is exactly the state we want this tab to be in.
	 * The service worker's clock isn't clamped, so race the two and take whichever
	 * comes back first: the worker normally, the local timer if it has been shut
	 * down between messages. A rejection means the worker is gone, which is not
	 * the same as the wait being over — that side just never settles.
	 */
	function nap(ms) {
		const local = sleep(ms);
		let remote = null;
		try {
			const p = ext.runtime.sendMessage({ type: 'sleep', ms });
			if (p && typeof p.then === 'function') {
				remote = p.then(
					() => true,
					() => new Promise(() => {})
				);
			}
		} catch (_) {
			/* extension context invalidated */
		}
		return (remote ? Promise.race([remote, local]) : local).then(yieldToPage);
	}

	function status(msg, extra = {}) {
		toBackground('status', { msg, seenTotal: state.seen.size, ...extra });
	}

	// ---------------------------------------------------------------- throttling
	//
	// The same rules as src/lib/throttle.js, restated rather than imported: a
	// content script can't be an ES module, and neither can the MAIN-world hook.
	// The archive page holds the real Guard; these two halves keep each other
	// informed through the background, so a limit met while downloading media
	// also stops the list being paged, and vice versa.

	const BASE_PAUSE_MS = 20000;
	const MAX_PAUSE_MS = 10 * 60000;
	const MAX_PAGE_RETRIES = 3;
	/** Backstop on a single run: ~30 items a page, so far past any real list. */
	const MAX_PAGES = 1200;

	const throttle = { until: 0, level: 0, halted: null };

	const jitter = (ms) => Math.round(ms * (1 + (Math.random() * 2 - 1) * 0.3));
	const waitMs = () => Math.max(0, throttle.until - Date.now());

	/**
	 * A fixed 400ms between pages was its own tell — no one scrolls on a metronome
	 * for three hundred pages. This is both slower and irregular.
	 */
	const pageDelay = () => 800 + Math.floor(Math.random() * 1700);

	function classifyStatus(s) {
		if (s === 429) return 'rate-limit';
		if (s === 502 || s === 503 || s === 504) return 'server';
		return null;
	}

	function share(kind) {
		toBackground('throttle', { ...throttle, kind });
	}

	function penalise(kind, hintMs = 0) {
		throttle.level = Math.min(throttle.level + 1, 8);
		const backoff = Math.min(BASE_PAUSE_MS * 2 ** (throttle.level - 1), MAX_PAUSE_MS);
		throttle.until = Math.max(throttle.until, Date.now() + jitter(Math.max(backoff, hintMs)));
		share(kind);
		return waitMs();
	}

	function halt(reason) {
		if (throttle.halted) return;
		throttle.halted = reason;
		share('challenge');
	}

	/** Park until the pause is over. False means the run has been halted. */
	async function passThrottle() {
		while (!state.abort && !throttle.halted && waitMs() > 0) {
			await nap(Math.min(waitMs(), 5000));
		}
		return !throttle.halted;
	}

	/** Borrow the foreground for the few seconds something needs to be rendered. */
	async function borrowFocus() {
		if (state.focusBorrowed) return;
		state.focusBorrowed = true;
		try {
			await ext.runtime.sendMessage({ type: 'borrow-focus' });
		} catch (_) {}
	}

	async function returnFocus() {
		if (!state.focusBorrowed) return;
		state.focusBorrowed = false;
		try {
			await ext.runtime.sendMessage({ type: 'return-focus' });
		} catch (_) {}
	}

	async function waitFor(fn, { timeout = 15000, step = 250 } = {}) {
		const deadline = Date.now() + timeout;
		while (Date.now() < deadline) {
			if (state.abort) return null;
			const v = fn();
			if (v) return v;
			await nap(step);
		}
		return null;
	}

	const TAB_SELECTOR = {
		likes: '[data-e2e="liked-tab"]',
		bookmarks: '[data-e2e="favorites-tab"]',
		posts: '[data-e2e="user-post-item-list"]',
	};

	/** Which item_list endpoint each profile tab pages through. */
	const ENDPOINT = { likes: 'favorite', bookmarks: 'collect', posts: 'post' };

	async function openTab(which) {
		const sel = TAB_SELECTOR[which];
		if (!sel) return true;
		let el = await waitFor(() => document.querySelector(sel), { timeout: 8000 });
		if (!el && document.visibilityState === 'hidden') {
			// A hidden tab still builds its DOM, but TikTok doesn't always get
			// that far unprompted. Showing the tab for a moment is cheaper than
			// failing the whole sync.
			status('Showing the TikTok tab for a moment to open the list…');
			await borrowFocus();
			el = await waitFor(() => document.querySelector(sel), { timeout: 15000 });
		}
		if (!el) return false;
		el.click();
		await nap(1200);
		return true;
	}

	function itemCount() {
		return document.querySelectorAll('[data-e2e="user-liked-item"], [data-e2e="user-post-item"]').length;
	}

	function privateNotice() {
		const t = document.body.innerText || '';
		return /liked videos are private|This user's liked videos/i.test(t);
	}

	// ------------------------------------------------------------ paging mode

	/** @type {Map<number, (payload: any) => void>} */
	const pendingPages = new Map();
	let pageReqId = 0;

	function requestPage(endpoint, cursor) {
		const rid = ++pageReqId;
		return new Promise((resolve) => {
			pendingPages.set(rid, resolve);
			window.postMessage(
				{ __ttarchiveCmd: true, kind: 'paginate', rid, payload: { endpoint, cursor } },
				'*'
			);
			// Only a backstop for a hook that never answers; late is fine.
			setTimeout(() => {
				if (pendingPages.delete(rid)) resolve({ ok: false, error: 'the page never answered' });
			}, 45000);
		});
	}

	/**
	 * Walk the list by cursor. Returns why it stopped so harvest() can decide
	 * whether that's the end of the list or a reason to fall back to scrolling.
	 */
	async function harvestByPaging(which, { maxPages = MAX_PAGES } = {}) {
		const endpoint = ENDPOINT[which];
		if (!endpoint) return { pages: 0, error: `no list endpoint for ${which}` };

		let cursor = state.lastCapture ? state.lastCapture.cursor : null;
		if (cursor == null) return { pages: 0, error: 'TikTok did not send a cursor to continue from' };

		let pages = 0;
		let retries = 0;
		while (!state.abort) {
			if (pages >= maxPages) {
				return { pages, error: `hit the ${maxPages}-page ceiling for one run` };
			}
			if (!(await passThrottle())) return { pages, halted: throttle.halted };

			const res = await requestPage(endpoint, cursor);

			if (!res.ok) {
				// A captcha is not something waiting fixes, and it is emphatically not
				// a reason to fall back to scrolling — that would go on making the
				// same requests from the same session while TikTok is objecting.
				if (res.challenged) {
					halt(res.error || 'TikTok is asking for a captcha');
					return { pages, halted: throttle.halted };
				}
				const kind = classifyStatus(res.status);
				if (kind) {
					if (++retries > MAX_PAGE_RETRIES) {
						halt(`TikTok kept refusing the list (HTTP ${res.status}) after ${MAX_PAGE_RETRIES} backoffs`);
						return { pages, halted: throttle.halted };
					}
					const ms = penalise(kind, res.retryAfter || 0);
					status(`TikTok asked us to slow down (HTTP ${res.status}). Waiting ${Math.round(ms / 1000)}s…`);
					continue; // same cursor: nothing was collected
				}
				// Anything else is a signing or shape problem, which scrolling fixes.
				return { pages, error: res.error };
			}

			retries = 0;
			if (throttle.level) throttle.level -= 1;
			pages += 1;
			status(`Collected ${state.seen.size} items…`);

			if (!res.hasMore) return { pages, done: true };
			if (res.cursor == null || res.cursor === cursor) {
				return { pages, error: 'the cursor stopped moving' };
			}
			cursor = res.cursor;
			await nap(pageDelay());
		}
		return { pages, aborted: true };
	}

	// ----------------------------------------------------------- scroll mode

	async function harvestByScrolling({ maxIdleRounds = 6 } = {}) {
		let idle = 0;
		let lastSeen = state.seen.size;
		let lastCount = itemCount();

		while (!state.abort) {
			if (state.lastCapture && state.lastCapture.hasMore === false) {
				status('Reached the end of the list.', { done: true });
				return;
			}
			// Covers a challenge the *downloads* ran into: this loop never sees a
			// status code of its own, so the archive page's Guard is the only
			// warning it gets.
			if (!(await passThrottle())) {
				status(`Paused: ${throttle.halted}`, { fatal: true });
				return;
			}

			window.scrollTo(0, document.documentElement.scrollHeight);
			// Nudge: TikTok sometimes needs a scroll event on the grid container.
			window.dispatchEvent(new Event('scroll'));
			await sleep(900);

			const grew = state.seen.size > lastSeen || itemCount() > lastCount;
			if (grew) {
				idle = 0;
				lastSeen = state.seen.size;
				lastCount = itemCount();
				status(`Collected ${state.seen.size} items…`);
			} else {
				idle += 1;
				// Bounce up and back down; the observer occasionally misses a hit.
				window.scrollBy(0, -600);
				await sleep(400);
				if (idle >= maxIdleRounds) {
					status(`Stopped: no new items after ${idle} attempts.`, { done: true });
					return;
				}
			}
		}
		if (state.abort) status('Stopped.', { done: true });
	}

	// ------------------------------------------------------------- harvest

	/**
	 * @param {{which?: string, mode?: 'auto'|'paging'|'scroll', maxIdleRounds?: number}} opts
	 */
	async function harvest({ which = 'likes', mode = 'auto', maxIdleRounds = 6 } = {}) {
		if (state.harvesting) return;
		state.harvesting = true;
		state.abort = false;

		// Every run reports the whole list, not just what this page hasn't sent
		// before: the archive page decides what's already on disk, and it needs a
		// complete list to tell a removed like from one we simply never reached.
		const startedAt = Date.now();
		state.seen = new Set();
		// A new run is the user's answer to whatever stopped the last one.
		throttle.until = 0;
		throttle.level = 0;
		throttle.halted = null;

		try {
			status(`Opening ${which}…`);
			if (!(await openTab(which))) {
				status(`Could not find the ${which} tab on this page.`, { fatal: true });
				return;
			}

			// Either mode needs one request from TikTok's own code: paging replays
			// it with a new cursor, scrolling just waits for the next one. It has to
			// be from this run — an older one's cursor points into the middle of the
			// list, and everything before it would look like it had been unliked.
			const first = await waitFor(
				() => (state.lastCapture && state.lastCapture.at >= startedAt ? state.lastCapture : null),
				{ timeout: 20000 }
			);
			if (!first) {
				if (privateNotice()) {
					status('TikTok says these liked videos are private. Open them in Settings → Privacy.', {
						fatal: true,
					});
				} else {
					status('No list request seen. Are you logged in and on your own profile?', { fatal: true });
				}
				return;
			}
			// Whatever the seed cost us, the paging loop doesn't need to be watched.
			await returnFocus();

			if (mode !== 'scroll') {
				status('Paging the list in the background — carry on browsing, nothing needs to be in front.');
				const res = await harvestByPaging(which);
				if (res.done) {
					status('Reached the end of the list.', { done: true });
					return;
				}
				if (res.aborted) {
					status('Stopped.', { done: true });
					return;
				}
				if (res.halted) {
					status(
						`Stopped after ${res.pages} page(s): ${res.halted}. Open the TikTok tab and clear it, ` +
							'then Sync again — everything already downloaded is kept.',
						{ fatal: true }
					);
					return;
				}
				if (mode === 'paging') {
					status(`Background paging stopped after ${res.pages} page(s): ${res.error}.`, { fatal: true });
					return;
				}
				status(
					`Background paging stopped after ${res.pages} page(s): ${res.error}. ` +
						'Falling back to scrolling — the TikTok tab has to stay visible for that.'
				);
				// Scrolling needs a rendered tab; a background one never grows.
				await borrowFocus();
			}

			await harvestByScrolling({ maxIdleRounds });
		} finally {
			state.harvesting = false;
			returnFocus();
		}
	}

	// ---------------------------------------------------------------- commands

	ext.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
		if (!msg || !msg.cmd) return;
		if (msg.cmd === 'ping') {
			sendResponse({
				ok: true,
				hooked: state.hooked,
				href: location.href,
				profileUser: state.profileUser,
				me: state.me,
				harvesting: state.harvesting,
				seenTotal: state.seen.size,
			});
			return true;
		}
		if (msg.cmd === 'harvest') {
			harvest(msg.opts || {});
			sendResponse({ ok: true });
			return true;
		}
		if (msg.cmd === 'stop') {
			state.abort = true;
			sendResponse({ ok: true });
			return true;
		}
		// The archive page's downloads were refused. Adopt the longer pause of the
		// two; never notify back, or the two sides echo each other indefinitely.
		if (msg.cmd === 'throttle') {
			const p = msg.payload || {};
			if (p.until > throttle.until) throttle.until = p.until;
			if (p.level > throttle.level) throttle.level = p.level;
			if (p.halted && !throttle.halted) throttle.halted = p.halted;
			sendResponse({ ok: true });
			return true;
		}
		if (msg.cmd === 'rescan') {
			window.dispatchEvent(new Event('ttarchive:rescan'));
			sendResponse({ ok: true });
			return true;
		}
	});

	toBackground('collector-ready', { href: location.href });
})();
