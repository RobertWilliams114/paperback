# Resilient Paperback Sources

Personal [Paperback](https://paperback.moe) **0.8** extensions, built on stable
public **JSON APIs** instead of HTML scraping — so they don't break when a
website redesigns its pages or hides behind Cloudflare.

## Sources

### MangaDex (API)

A full-featured source for manga / manhwa / manhua / etc., powered entirely by
the official [`api.mangadex.org`](https://api.mangadex.org/docs/) JSON API.

- Browse: Popular, Recently Updated, Top Rated, Recently Added
- Search with included/excluded tags (genre, theme, format, content)
- Full chapter lists with scanlation-group names
- Reads pages via the MangaDex@Home image CDN
- **Settings:** translation languages (multi-select), content ratings, Data Saver

**Why it's durable:** MangaDex *wants* you to use their API — it's documented,
versioned, not Cloudflare-gated, and the domain hasn't changed in years. That's
the opposite of a scraper, which is at the mercy of a site's HTML.

> Note: Comick was the original plan, but as of this build Comick has stopped
> returning image data from its API (`md_images` comes back empty), which is why
> Comick-based sources have been flaking. MangaDex was chosen for resilience.

## Build locally

```bash
npm install
npm run bundle      # outputs ./bundles (with versioning.json)
npm test            # type-check only
node harness.cjs    # smoke-test the bundle against the live API
```

## Install into Paperback

This repo auto-builds and publishes to GitHub Pages via
`.github/workflows/build.yml`. After the first successful Pages deploy:

1. In Paperback: **Settings → Extensions → Add a repository**
2. Enter your Pages URL, e.g. `https://<your-username>.github.io/<repo-name>/`
3. Install **MangaDex (API)** from the list.

To publish: push to `main`, then enable **Settings → Pages → Source:
GitHub Actions** in the GitHub repo.
