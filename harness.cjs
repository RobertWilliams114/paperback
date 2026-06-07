// Minimal stand-in for the Paperback app runtime, enough to exercise the bundle.
const https = require("https")
const { URL } = require("url")

const identity = (x) => x
global.App = {
  createRequest: (i) => ({ headers: {}, cookies: [], ...i }),
  createRequestManager: (info) => ({
    interceptor: info.interceptor,
    requestsPerSecond: info.requestsPerSecond,
    requestTimeout: info.requestTimeout,
    getDefaultUserAgent: async () => "harness",
    schedule: async (request, _retry) => {
      if (info.interceptor) request = await info.interceptor.interceptRequest(request)
      const data = await new Promise((res, rej) => {
        const u = new URL(request.url)
        const req = https.request(
          u,
          { method: request.method || "GET", headers: request.headers },
          (r) => {
            let body = ""
            r.on("data", (c) => (body += c))
            r.on("end", () => res({ status: r.statusCode, data: body }))
          },
        )
        req.on("error", rej)
        if (request.data) req.write(typeof request.data === "string" ? request.data : JSON.stringify(request.data))
        req.end()
      })
      let response = { status: data.status, data: data.data, headers: {}, request }
      if (info.interceptor) response = await info.interceptor.interceptResponse(response)
      return response
    },
  }),
  createSourceStateManager: () => {
    const store = {}
    return { keychain: {}, store: async (k, v) => { store[k] = v }, retrieve: async (k) => store[k] }
  },
  createSourceManga: identity,
  createMangaInfo: identity,
  createChapter: identity,
  createChapterDetails: identity,
  createPartialSourceManga: identity,
  createPagedResults: identity,
  createHomeSection: identity,
  createTag: identity,
  createTagSection: identity,
}

const { Sources } = require("./bundles/MangaDexAPI/source.js")
const src = new Sources.MangaDexAPI({}) // cheerio stub not needed for JSON

;(async () => {
  console.log("Source name:", Sources.MangaDexAPIInfo.name, "v" + Sources.MangaDexAPIInfo.version)

  console.log("\n== search('chainsaw man') ==")
  const search = await src.getSearchResults({ title: "chainsaw man", includedTags: [], excludedTags: [], parameters: {} }, {})
  console.log("results:", search.results.length, "| first:", search.results[0].title)
  const mangaId = search.results[0].mangaId
  console.log("cover ok:", search.results[0].image.startsWith("https://uploads.mangadex.org"))

  console.log("\n== getMangaDetails ==")
  const details = await src.getMangaDetails(mangaId)
  console.log("title:", details.mangaInfo.titles[0], "| status:", details.mangaInfo.status, "| author:", details.mangaInfo.author, "| tags:", details.mangaInfo.tags[0].tags.length)

  console.log("\n== getChapters ==")
  const chapters = await src.getChapters(mangaId)
  console.log("english chapters:", chapters.length, "| latest:", chapters[0].chapNum, "by", chapters[0].group)

  console.log("\n== getChapterDetails (first chapter) ==")
  const cd = await src.getChapterDetails(mangaId, chapters[chapters.length - 1].id)
  console.log("pages:", cd.pages.length, "| first page url ok:", /https:\/\/.*\/data\/.*\.(jpg|png|jpeg)/.test(cd.pages[0]))

  console.log("\n== getSearchTags ==")
  const tags = await src.getSearchTags()
  console.log("tag sections:", tags.map((t) => t.label + "(" + t.tags.length + ")").join(", "))

  console.log("\n== getHomePageSections ==")
  const secs = []
  await src.getHomePageSections((s) => { const i = secs.findIndex((x) => x.id === s.id); if (i >= 0) secs[i] = s; else secs.push(s) })
  for (const s of secs) console.log(" -", s.title, "->", s.items.length, "items")

  console.log("\nALL CHECKS PASSED")
})().catch((e) => { console.error("HARNESS ERROR:", e); process.exit(1) })
