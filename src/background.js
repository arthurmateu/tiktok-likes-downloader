/**
 * Background relay (a service worker on Chromium, an event page on Gecko).
 *
 * Content scripts can't talk to the archive page directly, and the archive page
 * is where the storage backend lives — neither a service worker nor an event
 * page can call showDirectoryPicker or hold an <input> full of File objects. So
 * everything routes through here.
 *
 * Deliberately import-free: Gecko event pages load this as a classic script.
 */

// See src/lib/ext.js — Gecko only returns promises from `browser.*`.
const ext = globalThis.browser ?? globalThis.chrome;

const ARCHIVE_URL = ext.runtime.getURL('src/archive/archive.html');

/** @type {Set<chrome.runtime.Port>} */
const archivePorts = new Set();

ext.runtime.onConnect.addListener((port) => {
	if (port.name !== 'archive') return;
	archivePorts.add(port);
	port.onDisconnect.addListener(() => archivePorts.delete(port));
	port.onMessage.addListener((msg) => handleArchiveMessage(msg, port));
});

function broadcast(type, payload) {
	for (const port of archivePorts) {
		try {
			port.postMessage({ type, payload });
		} catch (_) {
			archivePorts.delete(port);
		}
	}
}

// ---------------------------------------------------------------- from content

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
	if (!msg || !msg.type) return;
	if (sender.tab) {
		broadcast(msg.type, { ...msg.payload, tabId: sender.tab.id });
	}
	if (msg.type === 'open-archive') {
		openArchive().then(() => sendResponse({ ok: true }));
		return true;
	}

	// The collector's clock. Its own timers are clamped while its tab is in the
	// background — which is where we want that tab — and ours are not.
	if (msg.type === 'sleep') {
		const ms = Math.max(0, Math.min(60000, Number(msg.ms) || 0));
		setTimeout(() => sendResponse({ ok: true }), ms);
		return true;
	}
	if (msg.type === 'borrow-focus') {
		borrowFocus(sender.tab).then(sendResponse);
		return true;
	}
	if (msg.type === 'return-focus') {
		returnFocus(sender.tab).then(sendResponse);
		return true;
	}
});

// ----------------------------------------------------------------- from viewer

/**
 * A generated viewer.html asking the archive page for something, relayed by
 * src/content/viewer-bridge.js.
 *
 * The token is issued once and kept here rather than in the page, so that a
 * local HTML file that isn't one of ours gets nothing but 'not-recognised' no
 * matter what meta tags it carries.
 */
const VIEWER_TOKEN_KEY = 'viewerToken';

async function viewerToken() {
	const stored = await ext.storage.local.get(VIEWER_TOKEN_KEY);
	if (stored && stored[VIEWER_TOKEN_KEY]) return stored[VIEWER_TOKEN_KEY];
	// Stable once issued: regenerating would silently orphan every viewer.html
	// already written into a folder.
	const token = crypto.randomUUID();
	await ext.storage.local.set({ [VIEWER_TOKEN_KEY]: token });
	return token;
}

let viewerReqId = 0;
/** @type {Map<number, (payload: any) => void>} */
const viewerWaiting = new Map();

function askArchivePage(cmd, args) {
	const port = archivePorts.values().next().value;
	const rid = ++viewerReqId;
	return new Promise((resolve) => {
		viewerWaiting.set(rid, resolve);
		port.postMessage({ type: 'viewer-request', payload: { rid, cmd, args } });
		setTimeout(() => {
			if (viewerWaiting.delete(rid)) resolve({ ok: false, error: 'the archive page did not answer' });
		}, 30000);
	});
}

async function handleViewerRequest(msg) {
	if (!msg.token || msg.token !== (await viewerToken())) {
		return { ok: false, error: 'not-recognised' };
	}
	if (msg.cmd === 'open') {
		await openArchive();
		return { ok: true };
	}
	if (!archivePorts.size) return { ok: false, error: 'no-archive-page' };
	return askArchivePage(msg.cmd, msg.args);
}

// ---------------------------------------------------------------- from archive

async function handleArchiveMessage(msg, port) {
	const reply = (payload) => port.postMessage({ type: 'reply', id: msg.id, payload });

	// An answer to a viewer request, not a request of its own — it resolves the
	// pending sendMessage instead of getting a reply.
	if (msg.cmd === 'viewer-response') {
		const resolve = viewerWaiting.get(msg.rid);
		if (resolve) {
			viewerWaiting.delete(msg.rid);
			resolve(msg.payload);
		}
		return;
	}

	try {
		switch (msg.cmd) {
			case 'find-tiktok-tab':
				reply(await findTikTokTab());
				break;
			case 'ensure-profile':
				reply(await ensureProfileTab(msg.uniqueId, { background: !!msg.background }));
				break;
			case 'start-harvest':
				reply(await sendToTab(msg.tabId, { cmd: 'harvest', opts: msg.opts }));
				break;
			case 'stop-harvest':
				reply(await sendToTab(msg.tabId, { cmd: 'stop' }));
				break;
			case 'ping-tab':
				reply(await sendToTab(msg.tabId, { cmd: 'ping' }));
				break;
			case 'focus-tab':
				await chrome.tabs.update(msg.tabId, { active: true });
				reply({ ok: true });
				break;
			default:
				reply({ ok: false, error: `unknown command ${msg.cmd}` });
		}
	} catch (err) {
		reply({ ok: false, error: String((err && err.message) || err) });
	}
}

// ------------------------------------------------------------- borrowed focus

/**
 * Tabs we pulled to the front, and what was in front before.
 *
 * The collector borrows the foreground for the parts that genuinely need a
 * rendered page — finding the Liked tab, and the scroll fallback — and gives it
 * back afterwards. Best-effort: if this worker is restarted mid-sync the tab
 * just stays where it is, which is untidy but not broken.
 *
 * @type {Map<number, number|null>}
 */
const borrowedFocus = new Map();

async function borrowFocus(tab) {
	if (!tab) return { ok: false, error: 'no tab' };
	if (!borrowedFocus.has(tab.id)) {
		const [active] = await ext.tabs.query({ active: true, windowId: tab.windowId });
		borrowedFocus.set(tab.id, active && active.id !== tab.id ? active.id : null);
	}
	try {
		await ext.tabs.update(tab.id, { active: true });
	} catch (_) {
		return { ok: false, error: 'tab is gone' };
	}
	return { ok: true };
}

async function returnFocus(tab) {
	if (!tab || !borrowedFocus.has(tab.id)) return { ok: true, restored: false };
	const previous = borrowedFocus.get(tab.id);
	borrowedFocus.delete(tab.id);
	if (previous == null) return { ok: true, restored: false };
	try {
		await ext.tabs.update(previous, { active: true });
	} catch (_) {
		/* the user closed it in the meantime */
	}
	return { ok: true, restored: true };
}

async function sendToTab(tabId, message) {
	try {
		const res = await chrome.tabs.sendMessage(tabId, message);
		return res || { ok: false, error: 'no response' };
	} catch (err) {
		return { ok: false, error: String((err && err.message) || err) };
	}
}

async function findTikTokTab() {
	const tabs = await chrome.tabs.query({ url: ['*://*.tiktok.com/*'] });
	const results = [];
	for (const t of tabs) {
		const ping = await sendToTab(t.id, { cmd: 'ping' });
		results.push({ tabId: t.id, url: t.url, title: t.title, ...ping });
	}
	return { ok: true, tabs: results };
}

/**
 * Make sure a tab is sitting on the given profile. Reuses an existing TikTok tab
 * so we don't pile up windows across repeated syncs.
 *
 * In background mode it only reuses a tab already on that profile — normally the
 * one an earlier sync left behind. Navigating away from whatever the user is
 * watching is exactly the interruption background mode exists to avoid.
 */
async function ensureProfileTab(uniqueId, { background = false } = {}) {
	const target = `https://www.tiktok.com/@${uniqueId}`;
	const tabs = await ext.tabs.query({ url: ['*://*.tiktok.com/*'] });
	const onProfile = tabs.find((t) => (t.url || '').startsWith(target));
	let tab = background ? onProfile : onProfile || tabs[0];
	const reusedInPlace = !!tab && (tab.url || '').startsWith(target);

	if (!tab) {
		tab = await ext.tabs.create({ url: target, active: !background });
	} else if (!reusedInPlace) {
		tab = await ext.tabs.update(tab.id, { url: target, active: !background });
	} else {
		if (!background) await ext.tabs.update(tab.id, { active: true });
		// A tab left behind by an earlier sync is still holding that run's cursor
		// and its set of already-seen ids. Both are wrong now: paging would resume
		// from the end of the last run, and anything it remembers seeing would be
		// filtered out before the archive page ever hears about it.
		await ext.tabs.reload(tab.id);
		await waitForLoading(tab.id);
	}

	await waitForComplete(tab.id);
	// The content script needs a beat after load before it answers pings.
	for (let i = 0; i < 20; i++) {
		const ping = await sendToTab(tab.id, { cmd: 'ping' });
		if (ping.ok) return { ok: true, tabId: tab.id, ping };
		await new Promise((r) => setTimeout(r, 500));
	}
	return { ok: false, tabId: tab.id, error: 'content script never responded' };
}

/**
 * Wait for a reload to actually start, so waitForComplete doesn't return on the
 * "complete" the tab is still reporting from the page we just told it to leave.
 */
async function waitForLoading(tabId, timeout = 3000) {
	const deadline = Date.now() + timeout;
	while (Date.now() < deadline) {
		try {
			const t = await ext.tabs.get(tabId);
			if (t.status !== 'complete') return;
		} catch (_) {
			return;
		}
		await new Promise((r) => setTimeout(r, 100));
	}
}

function waitForComplete(tabId) {
	return new Promise((resolve) => {
		const check = async () => {
			try {
				const t = await chrome.tabs.get(tabId);
				if (t.status === 'complete') {
					chrome.tabs.onUpdated.removeListener(listener);
					resolve();
					return true;
				}
			} catch (_) {
				chrome.tabs.onUpdated.removeListener(listener);
				resolve();
				return true;
			}
			return false;
		};
		const listener = (id) => {
			if (id === tabId) check();
		};
		chrome.tabs.onUpdated.addListener(listener);
		check();
		setTimeout(() => {
			chrome.tabs.onUpdated.removeListener(listener);
			resolve();
		}, 30000);
	});
}

// ---------------------------------------------------------------- archive tab

async function openArchive() {
	const existing = await chrome.tabs.query({ url: ARCHIVE_URL });
	if (existing.length) {
		await chrome.tabs.update(existing[0].id, { active: true });
		await chrome.windows.update(existing[0].windowId, { focused: true });
		return existing[0];
	}
	return chrome.tabs.create({ url: ARCHIVE_URL, active: true });
}

chrome.runtime.onInstalled.addListener(({ reason }) => {
	if (reason === 'install') openArchive();
});
