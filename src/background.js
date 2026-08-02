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
});

// ---------------------------------------------------------------- from archive

async function handleArchiveMessage(msg, port) {
	const reply = (payload) => port.postMessage({ type: 'reply', id: msg.id, payload });

	try {
		switch (msg.cmd) {
			case 'find-tiktok-tab':
				reply(await findTikTokTab());
				break;
			case 'ensure-profile':
				reply(await ensureProfileTab(msg.uniqueId));
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
 */
async function ensureProfileTab(uniqueId) {
	const target = `https://www.tiktok.com/@${uniqueId}`;
	const tabs = await chrome.tabs.query({ url: ['*://*.tiktok.com/*'] });
	let tab = tabs.find((t) => (t.url || '').startsWith(target)) || tabs[0];

	if (!tab) {
		tab = await chrome.tabs.create({ url: target, active: true });
	} else if (!(tab.url || '').startsWith(target)) {
		tab = await chrome.tabs.update(tab.id, { url: target, active: true });
	} else {
		await chrome.tabs.update(tab.id, { active: true });
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
