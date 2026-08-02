/**
 * Dev-only verification harness.
 *
 * Exercises the shipping fetchFirst() from src/lib/downloader.js against real
 * TikTok CDN URLs, from the extension's own origin, with the declarativeNetRequest
 * Referer rule active — i.e. exactly the conditions a real sync runs under.
 * Bytes go to a local receiver so ffmpeg can inspect them.
 */

import { fetchFirst } from '../lib/downloader.js';

const RECEIVER = 'http://127.0.0.1:8899';
const TARGETS = `${RECEIVER}/targets.json`;

const out = document.getElementById('out');
const lines = [];
function say(msg, cls = '') {
	lines.push(msg);
	out.innerHTML = lines.map((l) => `<span class="${cls}">${l}</span>`).join('\n');
	console.log(msg);
}

async function post(name, body) {
	try {
		await fetch(`${RECEIVER}/${name}`, { method: 'POST', body });
		return true;
	} catch (e) {
		say(`  receiver POST failed: ${e.message}`, 'err');
		return false;
	}
}

(async () => {
	const report = { at: new Date().toISOString(), assets: [] };

	// Let the TikTok tab that Edge opened alongside us finish running its security
	// SDK — that's what plants ttwid / tt_chain_token. Without a session the CDN
	// answers media requests with a captcha page.
	const warmup = 20;
	for (let i = warmup; i > 0; i--) {
		out.textContent = `waiting ${i}s for the TikTok tab to establish a session…`;
		await new Promise((r) => setTimeout(r, 1000));
	}
	say(`cookies visible to extension: (opaque — set on tiktok.com)`);

	let targets;
	try {
		targets = await (await fetch(TARGETS, { cache: 'no-store' })).json();
	} catch (e) {
		say(`cannot read targets.json: ${e.message}`, 'err');
		await post('report.json', JSON.stringify({ fatal: String(e) }, null, 2));
		return;
	}

	say(`loaded ${targets.assets.length} assets`);

	for (const a of targets.assets) {
		const t0 = performance.now();
		try {
			const { blob, url } = await fetchFirst(a.urls);
			const ms = Math.round(performance.now() - t0);
			await post(a.name, blob);
			say(`OK   ${a.name}  ${blob.size} bytes  ${blob.type}  ${ms}ms`, 'ok');
			report.assets.push({
				name: a.name,
				ok: true,
				size: blob.size,
				type: blob.type,
				ms,
				urlIndexUsed: a.urls.indexOf(url),
			});
		} catch (e) {
			say(`FAIL ${a.name}  ${e.message}`, 'err');
			report.assets.push({ name: a.name, ok: false, error: String(e.message || e) });
		}
	}

	// --- self-sourced: obtain the video URL from within this very profile, so the
	// URL and the download share one cookie jar. Distinguishes "header problem"
	// from "URL is session-bound".
	for (const page of targets.selfSourced || []) {
		try {
			const html = await (await fetch(page, { credentials: 'include' })).text();
			const m = html.match(/id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>([\s\S]*?)<\/script>/);
			if (!m) throw new Error('no SSR blob in page html');
			const it = JSON.parse(m[1]).__DEFAULT_SCOPE__['webapp.video-detail'].itemInfo.itemStruct;
			const v = it.video;
			const br = (v.bitrateInfo || []).slice().sort((a, b) => (b.Bitrate || 0) - (a.Bitrate || 0));
			const cands = [];
			for (const b of br) for (const u of b.PlayAddr?.UrlList || []) cands.push(u);
			if (v.playAddr) cands.push(v.playAddr);
			say(`self-sourced ${it.id}: ${cands.length} candidates, declared size ${v.size}`);

			const { blob, url } = await fetchFirst([...new Set(cands)]);
			await post(`${it.id}_selfsourced.mp4`, blob);
			say(`OK   ${it.id}_selfsourced.mp4  ${blob.size} bytes  ${blob.type}`, 'ok');
			report.assets.push({
				name: `${it.id}_selfsourced.mp4`,
				ok: true,
				size: blob.size,
				declaredSize: Number(v.size),
				type: blob.type,
				selfSourced: true,
			});

			const wm = await fetchFirst([v.downloadAddr]);
			await post(`${it.id}_selfsourced_downloadAddr.mp4`, wm.blob);
			say(`OK   ${it.id}_selfsourced_downloadAddr.mp4  ${wm.blob.size} bytes`, 'ok');
			report.assets.push({
				name: `${it.id}_selfsourced_downloadAddr.mp4`,
				ok: true,
				size: wm.blob.size,
				selfSourced: true,
			});
		} catch (e) {
			say(`FAIL self-sourced ${page}: ${e.message}`, 'err');
			report.assets.push({ name: `selfsourced:${page}`, ok: false, error: String(e.message || e) });
		}
	}

	report.summary = {
		total: report.assets.length,
		ok: report.assets.filter((a) => a.ok).length,
		failed: report.assets.filter((a) => !a.ok).length,
	};
	say(`\ndone: ${report.summary.ok}/${report.summary.total} succeeded`);
	await post('report.json', JSON.stringify(report, null, 2));
})();
