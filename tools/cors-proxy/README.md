# Download proxy (optional)

Only for the **web version**, and only if you want to paste links from sites that block downloads from
other web pages. archive.org links and direct links from CORS-enabled hosts work without it, and the
desktop app never needs it.

1. Create a Cloudflare Worker (dash.cloudflare.com → Workers & Pages → Create → "Hello World").
2. Replace its code with [`worker.js`](worker.js) and put the address you play on into `ALLOWED_ORIGINS`.
3. Deploy, then enter `https://<name>.<account>.workers.dev/?url=` in the launcher under
   **Settings → Download proxy**.

Some sites protect their downloads with a browser check; a proxy can't pass that. Use the desktop
app (it opens the page in a window and takes over the download you start) or download the file yourself
and drop it into the launcher.
