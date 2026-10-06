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

ext.runtime.onMessage.addListener((msg, sender, sendResponse) => {
	if (!msg || !msg.type) return;

	// Checked before the broadcast below: these come from a tab too, but they are
	// requests with an answer, not collector output to fan out.
	if (msg.type === 'viewer-token') {
		viewerToken().then((token) => sendResponse({ ok: true, token }));
		return true;
	}
	if (msg.type === 'viewer-request') {
		handleViewerRequest(msg).then(sendResponse);
		return true;
	}
	if (msg.type === 'open-archive') {
		openArchive().then(() => sendResponse({ ok: true }));
		return true;
	}
	if (msg.type === 'show-in-folder') {
		showInFolder(msg.path).then(sendResponse);
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

	// Still fanned out below like any other, but a tab being got ready for a sync
	// may be waiting on exactly this — see ensureProfileTab.
	if (msg.type === 'collector-ready' && sender.tab) {
		for (const arrived of arrivalWatches) arrived(sender.tab.id, msg.payload && msg.payload.instance);
	}

	if (sender.tab) {
		broadcast(msg.type, { ...msg.payload, tabId: sender.tab.id });
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
	// Answered here, not by the archive page: the helper needs no folder handle,
	// so the button works with that page closed.
	if (msg.cmd === 'show-in-folder') return showInFolder(msg.args && msg.args.path);
	if (!archivePorts.size) return { ok: false, error: 'no-archive-page' };
	return askArchivePage(msg.cmd, msg.args);
}

// ------------------------------------------------------------ show in folder

/**
 * "Show in folder" on Chromium. File System Access never says where a handle is
 * on disk and no extension API opens Explorer on a file it didn't download, so
 * the work is done by a native helper, tools/show_in_folder.py, which reads the
 * folder's path out of the browser's own record of what was picked. `path` is
 * archive-relative.
 *
 * Gecko never comes here: its backend downloaded every file itself and asks
 * `downloads.show` instead.
 */
const FOLDER_HOST = 'com.ttarchive.show_in_folder';

async function showInFolder(path) {
	// Printed by the Library when the helper is missing. It needs no arguments: the
	// helper finds this extension's id, and the folder, in the browser's profile.
	const setup = 'python tools/show_in_folder.py install';
	if (typeof path !== 'string' || !path) return { ok: false, error: 'no path' };
	try {
		const res = await ext.runtime.sendNativeMessage(FOLDER_HOST, { path });
		if (res && res.error === 'no-helper') return { ...res, setup };
		return res || { ok: false, error: 'the helper gave no answer' };
	} catch (err) {
		// Chromium's own wording: "Specified native messaging host not found." when
		// nothing is registered, "…is forbidden." when it is but not for this id.
		const text = String((err && err.message) || err);
		// `detail` keeps Chromium's wording, which the Library quotes: "not found"
		// once the helper is installed means the lookup is failing, not the setup.
		return { ok: false, error: /not found|forbidden/i.test(text) ? 'no-helper' : text, detail: text, setup };
	}
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

	// Chromium stops this worker after thirty seconds without an extension API
	// call or event, in-flight request or not, and the port dies with it. Most
	// of what is below finishes well inside that; ensure-profile need not — a
	// profile reload can sit between tab events for longer, with the archive
	// page still waiting on the reply. Any API call resets the clock, so one is
	// made every so often for as long as a request is being handled.
	const heartbeat = setInterval(() => {
		try {
			ext.runtime.getPlatformInfo();
		} catch (_) {}
	}, 20000);

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
			// Downloads run on the archive page and the list is paged in the tab, so
			// a refusal met by one is news the other can't get any other way.
			case 'throttle':
				reply(await sendToTab(msg.tabId, { cmd: 'throttle', payload: msg.payload }));
				break;
			// The song pass's inner step, driven from the archive page in short asks
			// — see readPostPage there for why it is not one request here.
			case 'detail-tab':
				reply(await sendToTab(msg.tabId, { cmd: 'item-detail', id: msg.postId }));
				break;
			case 'navigate-tab':
				reply(await navigateTab(msg.tabId, msg.url));
				break;
			case 'ping-tab':
				reply(await sendToTab(msg.tabId, { cmd: 'ping' }));
				break;
			case 'focus-tab':
				await ext.tabs.update(msg.tabId, { active: true });
				reply({ ok: true });
				break;
			default:
				reply({ ok: false, error: `unknown command ${msg.cmd}` });
		}
	} catch (err) {
		reply({ ok: false, error: String((err && err.message) || err) });
	} finally {
		clearInterval(heartbeat);
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
		const res = await ext.tabs.sendMessage(tabId, message);
		return res || { ok: false, error: 'no response' };
	} catch (err) {
		return { ok: false, error: String((err && err.message) || err) };
	}
}

async function findTikTokTab() {
	const tabs = await ext.tabs.query({ url: ['*://*.tiktok.com/*'] });
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

	/**
	 * The profile itself, not merely something underneath it.
	 *
	 * `/@user/photo/123` starts with `/@user` and is not the profile — and the
	 * song pass leaves the tab on exactly that. Reusing one "in place" reloads it
	 * rather than navigating, so a sync that mistook a post page for the profile
	 * would reload the post and then wait out its timeout for a list request that
	 * page never makes.
	 */
	const isProfile = (url) => {
		if (!(url || '').startsWith(target)) return false;
		const rest = url.slice(target.length);
		return rest === '' || rest === '/' || rest.startsWith('?') || rest.startsWith('#');
	};

	const tabs = await ext.tabs.query({ url: ['*://*.tiktok.com/*'] });
	// In background mode a tab already sitting on this profile is the only one
	// worth having; otherwise any TikTok tab will do and gets navigated. A tab the
	// song pass parked on a post counts as neither, and is navigated like any other.
	const onProfile = tabs.find((t) => isProfile(t.url));
	let tab = background ? onProfile || tabs.find((t) => (t.url || '').startsWith(target)) : onProfile || tabs[0];
	const reusedInPlace = !!tab && isProfile(tab.url);

	// Begun before the tab is touched, so that a page quick enough to announce
	// itself before the call below returns is not missed.
	const arrivals = watchArrivals();
	try {
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
		}

		// Either way the page that was there is on its way out, and it goes on
		// answering pings — ready as ever — until the new one replaces it. Asked too
		// early, it is the old page that says yes, the harvest is started on it, and
		// it is destroyed a moment later: the run collects nothing and never hears
		// another word. So nothing is asked until the new page has said it is here.
		//
		// This used to be a wait for the tab to stop reporting `complete`, given
		// three seconds. A page that has sat in a background tab for days can take
		// longer than that to let go — its renderer has been pushed down the queue,
		// and the reload does not begin until it has run its unload handlers — and
		// that is the first sync after a long while failing where the next one, on
		// a page now minutes old, went through.
		if (!(await arrivals.from(tab.id, ARRIVAL_MS))) {
			return {
				ok: false,
				tabId: tab.id,
				error: `the TikTok tab did not load the profile within ${ARRIVAL_MS / 1000}s`,
			};
		}
		await waitForComplete(tab.id);
		for (let i = 0; i < 20; i++) {
			const ping = await sendToTab(tab.id, { cmd: 'ping' });
			if (ping.ok && arrivals.isNew(tab.id, ping.instance)) return { ok: true, tabId: tab.id, ping };
			await new Promise((r) => setTimeout(r, 500));
		}
		return { ok: false, tabId: tab.id, error: 'content script never responded' };
	} finally {
		arrivals.stop();
	}
}

/** How long a reloaded or redirected tab is given to bring its new page up. */
const ARRIVAL_MS = 30000;

/**
 * Collectors that start up while this is listening, by tab.
 *
 * Each announces itself as its page begins, under an id of its own, and every
 * ping it answers carries the same id. A page that announced itself after a
 * reload was asked for is the new page; any other answer is from the one being
 * left behind.
 *
 * @type {Set<(tabId: number, instance: string) => void>}
 */
const arrivalWatches = new Set();

function watchArrivals() {
	/** @type {Map<number, Set<string>>} */
	const seen = new Map();
	let wake = null;
	const arrived = (tabId, instance) => {
		if (!instance) return;
		if (!seen.has(tabId)) seen.set(tabId, new Set());
		seen.get(tabId).add(instance);
		if (wake) wake();
	};
	arrivalWatches.add(arrived);
	return {
		/** True once a new page is up in the tab; false if none is by `timeout`. */
		from(tabId, timeout) {
			return new Promise((resolve) => {
				const done = (ok) => {
					clearTimeout(timer);
					wake = null;
					resolve(ok);
				};
				const timer = setTimeout(() => done(false), timeout);
				wake = () => {
					if (seen.has(tabId)) done(true);
				};
				wake();
			});
		},
		isNew: (tabId, instance) => !!instance && !!seen.get(tabId)?.has(instance),
		stop: () => arrivalWatches.delete(arrived),
	};
}

/** Point a tab somewhere without bringing it forward. */
async function navigateTab(tabId, url) {
	try {
		await ext.tabs.update(tabId, { url, active: false });
	} catch (_) {
		return { ok: false, error: 'the TikTok tab has been closed' };
	}
	return { ok: true };
}

function waitForComplete(tabId) {
	return new Promise((resolve) => {
		const check = async () => {
			try {
				const t = await ext.tabs.get(tabId);
				if (t.status === 'complete') {
					ext.tabs.onUpdated.removeListener(listener);
					resolve();
					return true;
				}
			} catch (_) {
				ext.tabs.onUpdated.removeListener(listener);
				resolve();
				return true;
			}
			return false;
		};
		const listener = (id) => {
			if (id === tabId) check();
		};
		ext.tabs.onUpdated.addListener(listener);
		check();
		setTimeout(() => {
			ext.tabs.onUpdated.removeListener(listener);
			resolve();
		}, 30000);
	});
}

// ---------------------------------------------------------------- archive tab

async function openArchive() {
	const existing = await ext.tabs.query({ url: ARCHIVE_URL });
	if (existing.length) {
		await ext.tabs.update(existing[0].id, { active: true });
		await ext.windows.update(existing[0].windowId, { focused: true });
		return existing[0];
	}
	return ext.tabs.create({ url: ARCHIVE_URL, active: true });
}

ext.runtime.onInstalled.addListener(({ reason }) => {
	if (reason === 'install') openArchive();
});
