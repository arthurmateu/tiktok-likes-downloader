/**
 * ISOLATED-world collector.
 *
 * Bridges hook.js (MAIN world) to the service worker, and drives the page's own
 * infinite scroll so TikTok issues the paginated item_list requests we harvest.
 */
(() => {
	'use strict';

	const state = {
		hooked: false,
		profileUser: null,
		me: null,
		harvesting: false,
		abort: false,
		lastCapture: null,
		seen: new Set(),
	};

	// ---------------------------------------------------------------- normalize

	/**
	 * Sort bitrateInfo high→low and flatten every candidate URL we could try.
	 *
	 * `downloadAddr` is deliberately excluded. Verified against
	 * tiktok.com/@soupy_cos/video/7669190146864074006: playAddr and downloadAddr
	 * are different encodes of the same clip (1,219,617 vs 1,252,838 bytes), and
	 * downloadAddr carries the bouncing "TikTok / @author" watermark burned in.
	 * Never fall back to it — a watermarked file is worse than a missing one.
	 */
	function videoUrls(v) {
		const urls = [];
		const bitrates = Array.isArray(v.bitrateInfo) ? v.bitrateInfo.slice() : [];
		bitrates.sort((a, b) => (b.Bitrate || 0) - (a.Bitrate || 0));
		for (const b of bitrates) {
			const list = b.PlayAddr?.UrlList || [];
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
			chrome.runtime.sendMessage({ type, payload }).catch(() => {});
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

	function status(msg, extra = {}) {
		toBackground('status', { msg, seenTotal: state.seen.size, ...extra });
	}

	async function waitFor(fn, { timeout = 15000, step = 250 } = {}) {
		const deadline = Date.now() + timeout;
		while (Date.now() < deadline) {
			if (state.abort) return null;
			const v = fn();
			if (v) return v;
			await sleep(step);
		}
		return null;
	}

	const TAB_SELECTOR = {
		likes: '[data-e2e="liked-tab"]',
		bookmarks: '[data-e2e="favorites-tab"]',
		posts: '[data-e2e="user-post-item-list"]',
	};

	async function openTab(which) {
		const sel = TAB_SELECTOR[which];
		if (!sel) return true;
		const el = await waitFor(() => document.querySelector(sel), { timeout: 20000 });
		if (!el) return false;
		el.click();
		await sleep(1200);
		return true;
	}

	function itemCount() {
		return document.querySelectorAll('[data-e2e="user-liked-item"], [data-e2e="user-post-item"]').length;
	}

	function privateNotice() {
		const t = document.body.innerText || '';
		return /liked videos are private|This user's liked videos/i.test(t);
	}

	async function harvest({ which = 'likes', maxIdleRounds = 6 } = {}) {
		if (state.harvesting) return;
		state.harvesting = true;
		state.abort = false;

		try {
			status(`Opening ${which}…`);
			if (!(await openTab(which))) {
				status(`Could not find the ${which} tab on this page.`, { fatal: true });
				return;
			}

			const first = await waitFor(() => state.lastCapture, { timeout: 20000 });
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

			let idle = 0;
			let lastSeen = state.seen.size;
			let lastCount = itemCount();

			while (!state.abort) {
				if (state.lastCapture && state.lastCapture.hasMore === false) {
					status('Reached the end of the list.', { done: true });
					break;
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
						break;
					}
				}
			}
			if (state.abort) status('Stopped.', { done: true });
		} finally {
			state.harvesting = false;
		}
	}

	// ---------------------------------------------------------------- commands

	chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
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
		if (msg.cmd === 'rescan') {
			window.dispatchEvent(new Event('ttarchive:rescan'));
			sendResponse({ ok: true });
			return true;
		}
	});

	toBackground('collector-ready', { href: location.href });
})();
