/**
 * Brings up posts that were uploaded far too quietly.
 *
 * An upload's sound is stored as it was mixed, and some are mixed well below
 * everything around them. TikTok's web player hides that by bringing every post
 * to -12 LUFS as it plays, so a file that is exactly the one TikTok served can
 * still sound nearly silent in the archive.
 *
 * Only that quiet end is corrected here. A post under QUIET_LUFS is raised to it
 * and no further. Everything else stays out of Web Audio altogether and plays
 * exactly as it was saved, which is the difference from TikTok's rule: applied
 * to everything, that one changes the level of nearly every post in the archive.
 *
 * This happens in the player and nowhere else. The number comes from the file
 * as it is opened, rather than from TikTok's own `video.volumeInfo` — they agree
 * to about a tenth of a decibel, and measuring means no change to what a sync
 * collects, nothing written to the archive, and the same result for a post saved
 * before this existed or since deleted from TikTok.
 *
 * A classic script that hangs off globalThis, because it has two kinds of home:
 * src/archive/viewer.js imports it for the side effect, and
 * src/archive/standalone.js inlines it ahead of src/viewer/viewer.js.
 */

globalThis.ttLevelling = (() => {
	/**
	 * Quieter than this counts as a quiet post: about the quietest seventh of a
	 * real archive, whose median sits at -15.
	 *
	 * Also where they end up, on purpose. Landing any higher would put a post
	 * above others that started out louder and were left alone.
	 */
	const QUIET_LUFS = -22;
	/**
	 * Below this there is no programme to raise, only the noise floor of a clip
	 * that is meant to be silent, and turning that up is all hiss.
	 */
	const NOISE_LUFS = -50;
	/**
	 * Decoding puts the whole soundtrack in memory as raw samples, which for a
	 * long video is hundreds of megabytes. Those few just play at their own level.
	 */
	const MAX_FILE_BYTES = 64 * 1024 * 1024;
	/** How long a clip holds off starting so that its very first sound is right. */
	const PATIENCE_MS = 200;
	/** Time constant of the change, when a measurement lands after the clip has started. */
	const GLIDE_SECONDS = 0.03;

	/**
	 * A page opened straight from disk gets neither half of this. The browser
	 * treats its media as another origin, so an element routed through Web Audio
	 * comes out as digital silence rather than failing, and `fetch` can't read
	 * the file either. So it is left alone completely: its own level beats none.
	 */
	const supported = typeof location !== 'undefined' && location.protocol !== 'file:' && typeof AudioContext === 'function';

	let ctx = null;
	/** Element -> its nodes, to be let go of when the element goes. */
	const routes = new WeakMap();
	/** Post id -> gain, so that stepping back to a post starts at the right level. */
	const gains = new Map();

	const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
	const lufs = (power) => -0.691 + 10 * Math.log10(power);
	const mean = (list) => list.reduce((sum, x) => sum + x, 0) / list.length;

	/**
	 * BS.1770's two filters as biquad coefficients, [b0, b1, b2, a1, a2]. Worked
	 * out from the analogue parameters because the standard tabulates them for
	 * 48 kHz only, and what a file decodes to depends on the output device.
	 */
	function kWeighting(rate) {
		let k = Math.tan((Math.PI * 1681.974450955533) / rate);
		let q = 0.7071752369554196;
		const vh = 10 ** (3.999843853973347 / 20);
		const vb = vh ** 0.4996667741545416;
		let a0 = 1 + k / q + k * k;
		const shelf = [
			(vh + (vb * k) / q + k * k) / a0,
			(2 * (k * k - vh)) / a0,
			(vh - (vb * k) / q + k * k) / a0,
			(2 * (k * k - 1)) / a0,
			(1 - k / q + k * k) / a0,
		];
		k = Math.tan((Math.PI * 38.13547087602444) / rate);
		q = 0.5003270373238773;
		a0 = 1 + k / q + k * k;
		return { shelf, highPass: [(2 * (k * k - 1)) / a0, (1 - k / q + k * k) / a0] };
	}

	/**
	 * Integrated loudness (ITU-R BS.1770-4) and sample peak of decoded audio.
	 *
	 * Overlapping 400 ms blocks are built from 100 ms hops of filtered power.
	 * Blocks of near-silence, then blocks well under the clip's own average, don't
	 * count: a song with a long quiet intro is as loud as the song.
	 *
	 * Silence, or a clip too short to fill one block, reads -Infinity.
	 */
	function loudness(buffer) {
		const { shelf: s, highPass: h } = kWeighting(buffer.sampleRate);
		const hop = Math.round(buffer.sampleRate / 10);
		const power = new Float64Array(Math.ceil(buffer.length / hop));
		let peak = 0;

		for (let c = 0; c < buffer.numberOfChannels; c++) {
			const data = buffer.getChannelData(c);
			// One history for the shelf's output and the high-pass's input: they are
			// the same signal.
			let x1 = 0;
			let x2 = 0;
			let y1 = 0;
			let y2 = 0;
			let z1 = 0;
			let z2 = 0;
			for (let i = 0; i < data.length; i++) {
				const x = data[i];
				const size = x < 0 ? -x : x;
				if (size > peak) peak = size;
				const y = s[0] * x + s[1] * x1 + s[2] * x2 - s[3] * y1 - s[4] * y2;
				const z = y - 2 * y1 + y2 - h[0] * z1 - h[1] * z2;
				x2 = x1;
				x1 = x;
				y2 = y1;
				y1 = y;
				z2 = z1;
				z1 = z;
				power[(i / hop) | 0] += z * z;
			}
		}

		const blocks = [];
		const whole = Math.floor(buffer.length / hop);
		for (let b = 0; b + 4 <= whole; b++) {
			const p = (power[b] + power[b + 1] + power[b + 2] + power[b + 3]) / (4 * hop);
			if (lufs(p) > -70) blocks.push(p);
		}
		if (!blocks.length) return { lufs: -Infinity, peak };
		const gate = lufs(mean(blocks)) - 10;
		return { lufs: lufs(mean(blocks.filter((p) => lufs(p) > gate))), peak };
	}

	/**
	 * 1 for anything that isn't a quiet post. Otherwise up to the line, unless that
	 * would take its peaks past full scale, and never below 1: nothing here turns
	 * a post down.
	 */
	function gainFor({ lufs: measured, peak }) {
		if (!Number.isFinite(measured) || measured <= NOISE_LUFS || measured >= QUIET_LUFS || !(peak > 0)) return 1;
		return Math.max(1, Math.min(10 ** ((QUIET_LUFS - measured) / 20), 1 / peak));
	}

	/** 1 for anything that can't be measured: no sound in it, too long, gone. */
	async function measure(url) {
		try {
			const res = await fetch(url);
			if (!res.ok) return 1;
			if (Number(res.headers.get('content-length')) > MAX_FILE_BYTES) {
				res.body?.cancel();
				return 1;
			}
			return gainFor(loudness(await ctx.decodeAudioData(await res.arrayBuffer())));
		} catch (_) {
			return 1;
		}
	}

	/**
	 * Call from the gesture that opens the player. An AudioContext only runs with
	 * one behind it, and stepping onward from there often doesn't count as one.
	 */
	function wake() {
		if (!supported) return;
		try {
			ctx ||= new AudioContext();
			if (ctx.state !== 'running') ctx.resume().catch(() => {});
		} catch (_) {}
	}

	async function raise(el, value) {
		if (value === 1) return;
		// A context allowed to run still reads 'suspended' for a moment after it is
		// made, and one that isn't allowed never settles its resume().
		if (ctx.state !== 'running') await Promise.race([ctx.resume(), sleep(PATIENCE_MS)]);
		// An element routed into a stopped context plays nothing, so this is the
		// line between a clip at its own level and a silent one.
		if (ctx.state !== 'running' || !el.isConnected || routes.has(el)) return;

		const gain = ctx.createGain();
		gain.gain.value = el.paused ? value : 1;
		gain.connect(ctx.destination);
		const source = ctx.createMediaElementSource(el);
		source.connect(gain);
		routes.set(el, { source, gain });
		// Only a long clip gets here already playing, its measurement having taken
		// longer than it was worth waiting for.
		if (!el.paused) gain.gain.setTargetAtTime(value, ctx.currentTime, GLIDE_SECONDS);
	}

	/**
	 * Raise a media element if it is a quiet post. Call once it is in the page and
	 * before playing it; once this settles it is ready to start. Never rejects,
	 * since a clip that can't be measured still has to play.
	 */
	async function level(el, key) {
		if (!supported) return;
		wake();
		if (!ctx) return;
		const value = gains.has(key)
			? Promise.resolve(gains.get(key))
			: measure(el.src).then((v) => {
					gains.set(key, v);
					return v;
				});
		const raised = value.then((v) => raise(el, v)).catch(() => {});
		await Promise.race([raised, sleep(PATIENCE_MS)]);
	}

	/** Disconnected or it stays alive in the audio graph for as long as the page does. */
	function release(el) {
		const nodes = routes.get(el);
		if (!nodes) return;
		routes.delete(el);
		nodes.source.disconnect();
		nodes.gain.disconnect();
	}

	return { wake, level, release, loudness, gainFor };
})();
