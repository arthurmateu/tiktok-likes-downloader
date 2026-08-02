document.getElementById('open').addEventListener('click', async () => {
	await chrome.runtime.sendMessage({ type: 'open-archive' });
	window.close();
});

(async () => {
	const tabs = await chrome.tabs.query({ url: ['*://*.tiktok.com/*'] });
	document.getElementById('status').textContent = tabs.length
		? `${tabs.length} TikTok tab${tabs.length > 1 ? 's' : ''} open.`
		: 'No TikTok tab open — the archive page will open one for you.';
})();
