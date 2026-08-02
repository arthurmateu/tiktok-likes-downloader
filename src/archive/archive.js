/**
 * Archive page controller.
 *
 * This page owns the storage backend and therefore owns all disk I/O and all
 * media fetching. The content script only supplies normalized records.
 */

import { ext } from '../lib/ext.js';
import * as fs from '../lib/fs.js';
import {
	loadState,
	saveState,
	scanDisk,
	mergeLegacy,
	upsertItem,
	missingParts,
	disk,
} from '../lib/state.js';
import { DownloadQueue } from '../lib/downloader.js';
import { renderLibrary, wireLibrary } from './viewer.js';

const $ = (id) => document.getElementById(id);

const app = {
	state: null,
	queue: null,
	tabId: null,
	syncing: false,
	seen: 0,
	newItems: 0,
	expectedTotal: 0,
};

// ---------------------------------------------------------------- background

const port = ext.runtime.connect({ name: 'archive' });
let msgId = 0;
const waiting = new Map();

port.onMessage.addListener((msg) => {
	if (msg.type === 'reply') {
		const r = waiting.get(msg.id);
		if (r) {
			waiting.delete(msg.id);
			r(msg.payload);
		}
		return;
	}
	onContentMessage(msg.type, msg.payload || {});
});

function ask(cmd, extra = {}) {
	const id = ++msgId;
	return new Promise((resolve) => {
		waiting.set(id, resolve);
		port.postMessage({ id, cmd, ...extra });
		setTimeout(() => {
			if (waiting.has(id)) {
				waiting.delete(id);
				resolve({ ok: false, error: 'timed out' });
			}
		}, 60000);
	});
}

// ---------------------------------------------------------------- logging

function log(msg, cls = '') {
	const el = $('log');
	const line = document.createElement('span');
	line.className = cls;
	const t = new Date().toLocaleTimeString();
	line.textContent = `[${t}] ${msg}\n`;
	el.appendChild(line);
	el.scrollTop = el.scrollHeight;
}

function fmtBytes(n) {
	if (!n) return '0 B';
	const u = ['B', 'KB', 'MB', 'GB', 'TB'];
	const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
	return `${(n / 1024 ** i).toFixed(i ? 1 : 0)} ${u[i]}`;
}

// ---------------------------------------------------------------- folder

async function afterFolderReady() {
	$('folderName').textContent = fs.rootName();
	$('grantFolder').classList.add('hidden');
	$('noFolder').classList.add('hidden');
	$('syncBody').classList.remove('hidden');
	$('pickFolder').textContent = 'Change folder…';

	log('Scanning folder…');
	const counts = await scanDisk();
	app.state = await loadState();
	const legacy = await mergeLegacy(app.state);

	if (legacy.found) {
		$('legacyNote').classList.remove('hidden');
		$('legacyNote').textContent =
			`Detected a myfaveTT archive here. Imported metadata for ${Object.keys(app.state.items).length} items` +
			(legacy.counts
				? ` (it recorded ${legacy.counts.downloaded} downloaded of ${legacy.counts.total} likes, ${legacy.counts.disappeared} no longer available).`
				: '.') +
			' Its files are left untouched.';
	}
	if (legacy.merged) await saveState(app.state, { immediate: true });

	const uid = app.state.user?.uniqueId || '';
	if (uid && !$('username').value) $('username').value = uid;

	renderStats(counts);
	log(
		`Found ${counts.videos} videos, ${counts.photoSets} photo posts, ${counts.covers} covers.`,
		'ok'
	);
	renderLibrary(app.state);
}

function renderStats(counts) {
	$('statVideos').textContent = counts.videos.toLocaleString();
	$('statPhotos').textContent = counts.photoSets.toLocaleString();
	$('statCovers').textContent = counts.covers.toLocaleString();
	$('statKnown').textContent = Object.keys(app.state.items).length.toLocaleString();
}

$('pickFolder').addEventListener('click', async () => {
	if (!fs.supported()) {
		alert('This browser can neither pick a folder nor write through the downloads API.');
		return;
	}
	// The downloads backend has no picker to open — it takes a folder name.
	if (fs.capabilities.pick === 'name') {
		$('dlSetup').classList.remove('hidden');
		$('dlFolderName').focus();
		$('dlFolderName').select();
		return;
	}
	try {
		await fs.pickFolder();
		await afterFolderReady();
	} catch (err) {
		if (err && err.name !== 'AbortError') log(`Folder selection failed: ${err.message}`, 'err');
	}
});

$('dlFolderSave').addEventListener('click', async () => {
	try {
		await fs.pickFolder({ name: $('dlFolderName').value });
		$('dlSetup').classList.add('hidden');
		log(`Writing into “${fs.rootName()}” under your browser's download folder.`);
		await afterFolderReady();
	} catch (err) {
		log(`Could not set the folder: ${err.message || err}`, 'err');
	}
});

$('grantFolder').addEventListener('click', async () => {
	const state = await fs.requestAccess();
	if (state === 'granted') await afterFolderReady();
	else log('Access was not granted.', 'err');
});

// A directory handed over here is read-only; it's the only way a browser
// without File System Access can see an existing archive at all.
$('scanFolder').addEventListener('click', () => $('scanInput').click());

$('scanInput').addEventListener('change', async (ev) => {
	const files = ev.target.files;
	ev.target.value = '';
	if (!files || !files.length) return;

	const info = fs.scanFolder(files);
	log(`Read ${info.files.toLocaleString()} files from “${info.name}”.`, 'ok');
	if (fs.rootName()) await afterFolderReady();
	else log('Now set a folder name above so new downloads have somewhere to go.');
});

$('rescan').addEventListener('click', async () => {
	const counts = await scanDisk();
	renderStats(counts);
	renderLibrary(app.state);
	log(`Rescan: ${counts.videos} videos, ${counts.photoSets} photo posts, ${counts.covers} covers.`);
});

// ---------------------------------------------------------------- sync

function updateCounters() {
	const s = app.queue?.stats || { done: 0, skipped: 0, failed: 0, bytes: 0 };
	$('cSeen').textContent = app.seen.toLocaleString();
	$('cNew').textContent = app.newItems.toLocaleString();
	$('cDone').textContent = s.done.toLocaleString();
	$('cSkip').textContent = s.skipped.toLocaleString();
	$('cFail').textContent = s.failed.toLocaleString();
	$('cBytes').textContent = fmtBytes(s.bytes);

	const total = app.expectedTotal || 0;
	$('bar').style.width = total ? `${Math.min(100, (app.seen / total) * 100).toFixed(1)}%` : '0%';
}

function onContentMessage(type, payload) {
	if (type === 'status') {
		log(payload.msg, payload.fatal ? 'err' : '');
		if (payload.fatal || payload.done) finishSync(payload.fatal ? 'error' : 'complete');
		return;
	}

	if (type === 'pagestate' && payload.profileUser) {
		if (!app.state) return;
		app.state.user = { ...(app.state.user || {}), ...payload.profileUser };
		return;
	}

	if (type === 'items') {
		if (!app.syncing || !app.state) return;
		app.seen = Math.max(app.seen, payload.seenTotal || 0);
		if (payload.total) app.expectedTotal = payload.total;

		const toDownload = [];
		for (const rec of payload.items || []) {
			upsertItem(app.state, rec);
			if (missingParts(rec).length) {
				toDownload.push(rec);
				app.newItems++;
			}
		}
		if (toDownload.length) app.queue.addMany(toDownload);
		saveState(app.state);
		updateCounters();
	}
}

async function startSync() {
	const uniqueId = $('username').value.trim().replace(/^@/, '');
	if (!uniqueId) {
		log('Enter your TikTok username first.', 'err');
		return;
	}

	app.syncing = true;
	app.seen = 0;
	app.newItems = 0;
	// favorite/item_list doesn't report a total, so the bar is seeded from
	// whatever we last knew and corrected if a total ever does arrive.
	app.expectedTotal = app.state.legacy?.counts?.total || Object.keys(app.state.items).length || 0;
	$('startSync').disabled = true;
	$('stopSync').disabled = false;

	app.queue = new DownloadQueue({
		concurrency: Math.max(1, Math.min(8, Number($('concurrency').value) || 4)),
		state: app.state,
		onProgress: updateCounters,
		onError: (rec, err) => log(`✗ ${rec.id}: ${err.message || err}`, 'err'),
	});

	log(`Opening https://www.tiktok.com/@${uniqueId} …`);
	const res = await ask('ensure-profile', { uniqueId });
	if (!res.ok) {
		log(`Could not prepare the TikTok tab: ${res.error || 'unknown error'}`, 'err');
		finishSync('error');
		return;
	}
	app.tabId = res.tabId;
	log('Tab ready. Harvesting the Liked tab — leave that tab open and visible.');
	await ask('start-harvest', { tabId: app.tabId, opts: { which: 'likes' } });
}

async function finishSync(reason) {
	if (!app.syncing) return;
	app.syncing = false;
	$('stopSync').disabled = true;

	if (app.queue) {
		log(`Harvest ${reason}. Finishing ${app.queue.pending} queued downloads…`);
		await app.queue.idle();
		if (app.queue.failed.length) {
			log(
				`${app.queue.failed.length} item(s) failed — usually expired media URLs. Run Sync again to retry just those.`,
				'err'
			);
		}
	}

	const counts = await scanDisk();
	renderStats(counts);
	await saveState(app.state, { immediate: true });
	renderLibrary(app.state);
	log('Done. state.json written.', 'ok');
	$('startSync').disabled = false;
}

$('startSync').addEventListener('click', () => startSync());

$('stopSync').addEventListener('click', async () => {
	if (app.tabId) await ask('stop-harvest', { tabId: app.tabId });
	app.queue?.stop();
	finishSync('stopped');
});

// ---------------------------------------------------------------- tabs

for (const tab of document.querySelectorAll('.tab')) {
	tab.addEventListener('click', () => {
		for (const t of document.querySelectorAll('.tab')) t.classList.remove('active');
		for (const p of document.querySelectorAll('.panel')) p.classList.remove('active');
		tab.classList.add('active');
		$(`panel-${tab.dataset.panel}`).classList.add('active');
	});
}

// ---------------------------------------------------------------- boot

/**
 * Firefox's MV3 host permissions are optional by default: they sit in the
 * manifest ungranted until the user says yes, and every media fetch is a CORS
 * failure until they do. On Chromium `contains` is already true and this is a
 * no-op.
 */
async function checkHostAccess() {
	const origins = ext.runtime.getManifest().host_permissions || [];
	if (!origins.length || !ext.permissions) return;

	try {
		if (await ext.permissions.contains({ origins })) return;
	} catch (_) {
		return;
	}

	$('hostAccess').classList.remove('hidden');
	$('grantHost').addEventListener('click', async () => {
		const granted = await ext.permissions.request({ origins });
		if (granted) {
			$('hostAccess').classList.add('hidden');
			log('Access granted.', 'ok');
		} else {
			log('Access refused — every download will fail until it is granted.', 'err');
		}
	});
}

(async function boot() {
	wireLibrary(() => app.state);

	if (!fs.supported()) {
		$('noFolder').textContent =
			'This browser has neither the File System Access API nor a usable downloads API, so there is nowhere to write. Use Firefox 128+, Edge, or Chrome 111+.';
		return;
	}

	await checkHostAccess();

	const byName = fs.capabilities.pick === 'name';
	if (byName) $('pickFolder').textContent = 'Set folder…';
	if (fs.canScanFolder()) $('scanRow').classList.remove('hidden');

	const { state, label } = await fs.restoreFolder();
	if (state === 'granted') {
		await afterFolderReady();
	} else if (label) {
		$('folderName').textContent = `${label} (access needs re-granting)`;
		$('grantFolder').classList.remove('hidden');
	} else if (byName) {
		$('noFolder').classList.add('hidden');
		$('dlSetup').classList.remove('hidden');
	}
})();

window.addEventListener('beforeunload', (e) => {
	if (app.syncing || (app.queue && app.queue.pending > 0)) {
		e.preventDefault();
		e.returnValue = '';
	}
});
