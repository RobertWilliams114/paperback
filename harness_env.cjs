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

