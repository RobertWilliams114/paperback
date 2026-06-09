import {
    Chapter,
    ChapterDetails,
    ContentRating,
    DUIForm,
    DUISection,
    HomeSection,
    HomeSectionType,
    PagedResults,
    PartialSourceManga,
    Request,
    Response,
    SearchRequest,
    Source,
    SourceInfo,
    SourceIntents,
    SourceManga,
    SourceStateManager,
    Tag,
    TagSection,
} from "@paperback/types"

// ---------------------------------------------------------------------------
//  Weeb Central source
// ---------------------------------------------------------------------------
//  Weeb Central (the successor to MangaSee/MangaLife) has no public JSON API, so
//  this source parses its server-rendered HTML. That is inherently more fragile
//  than the MangaDex source — to soften that, the base domain is a user-editable
//  setting, so if Weeb Central ever moves, fixing it is a one-field change rather
//  than a broken source. Its value here is coverage: it hosts many popular and
//  licensed titles that MangaDex leaves blank.

const DEFAULT_BASE = "https://weebcentral.com"
const COVER_BASE = "https://temp.compsci88.com/cover/normal"
const PAGE_SIZE = 32

const STATUS_MAP: Record<string, string> = {
    complete: "Completed",
    completed: "Completed",
    ongoing: "Ongoing",
    hiatus: "Hiatus",
    canceled: "Cancelled",
    cancelled: "Cancelled",
}

export const WeebCentralInfo: SourceInfo = {
    version: "1.0.0",
    name: "Weeb Central",
    icon: "icon.png",
    author: "rjwil",
    description:
        "Weeb Central source (manga / manhwa / manhua). Useful as a companion to " +
        "MangaDex for popular and licensed titles. Base domain is configurable in " +
        "settings so it survives a site move.",
    contentRating: ContentRating.MATURE,
    websiteBaseURL: DEFAULT_BASE,
    intents:
        SourceIntents.MANGA_CHAPTERS |
        SourceIntents.HOMEPAGE_SECTIONS |
        SourceIntents.SETTINGS_UI,
    sourceTags: [],
}

async function getBaseURL(stateManager: SourceStateManager): Promise<string> {
    const stored = (await stateManager.retrieve("base_url")) as string
    return (stored || DEFAULT_BASE).replace(/\/+$/, "")
}

export class WeebCentral extends Source {
    stateManager: SourceStateManager = App.createSourceStateManager()

    requestManager = App.createRequestManager({
        requestsPerSecond: 3,
        requestTimeout: 20000,
        interceptor: {
            interceptRequest: async (request: Request): Promise<Request> => {
                request.headers = {
                    ...(request.headers ?? {}),
                    referer: `${DEFAULT_BASE}/`,
                    "user-agent":
                        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) " +
                        "AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Paperback",
                }
                return request
            },
            interceptResponse: async (response: Response): Promise<Response> => response,
        },
    })

    // -- Fetch a URL and return a loaded cheerio instance --
    async fetchCheerio(url: string): Promise<any> {
        const request = App.createRequest({ url, method: "GET" })
        const response = await this.requestManager.schedule(request, 2)
        if (response.status < 200 || response.status >= 300) {
            throw new Error(`Weeb Central request failed (${response.status}) for ${url}`)
        }
        return this.cheerio.load(response.data ?? "")
    }

    // -- Extract the 26-char series/chapter ID from a Weeb Central URL --
    idFromHref(href: string): string {
        const match = href.match(/(?:series|chapters)\/([A-Z0-9]{26})/)
        return match ? match[1] : ""
    }

    coverURL(mangaId: string): string {
        return `${COVER_BASE}/${mangaId}.webp`
    }

    // -----------------------------------------------------------------------
    //  Manga details
    // -----------------------------------------------------------------------
    async getMangaDetails(mangaId: string): Promise<SourceManga> {
        const base = await getBaseURL(this.stateManager)
        const $ = await this.fetchCheerio(`${base}/series/${mangaId}`)

        const title = $("h1").first().text().trim() || "Untitled"
        let author = ""
        let artist = ""
        let status = "Unknown"
        let desc = ""
        let hentai = false
        const tags: Tag[] = []

        $("li").each((_: number, li: any) => {
            const label = $(li).find("strong").first().text().trim()
            if (label.startsWith("Author")) {
                author = $(li)
                    .find("a")
                    .map((_: number, a: any) => $(a).text().trim())
                    .get()
                    .filter((t: string) => t)
                    .join(", ")
            } else if (label.startsWith("Status")) {
                status = $(li).find("a").first().text().trim() || "Unknown"
            } else if (label.startsWith("Tags")) {
                $(li)
                    .find("a")
                    .each((_: number, a: any) => {
                        const t = $(a).text().trim()
                        if (t) tags.push(App.createTag({ id: t, label: t }))
                    })
            } else if (label.startsWith("Type")) {
                const t = $(li).find("a").first().text().trim()
                if (t) tags.push(App.createTag({ id: t, label: t }))
            } else if (label.startsWith("Adult Content")) {
                hentai = /yes/i.test($(li).text())
            } else if (label.startsWith("Description")) {
                desc = $(li).find("p").first().text().trim()
            }
        })

        const mappedStatus = STATUS_MAP[status.toLowerCase()] ?? status

        return App.createSourceManga({
            id: mangaId,
            mangaInfo: App.createMangaInfo({
                titles: [title],
                image: this.coverURL(mangaId),
                author: author || "Unknown",
                artist: artist || "Unknown",
                desc,
                status: mappedStatus,
                hentai,
                tags: [App.createTagSection({ id: "tags", label: "Tags", tags })],
            }),
        })
    }

    // -----------------------------------------------------------------------
    //  Chapter list
    // -----------------------------------------------------------------------
    async getChapters(mangaId: string): Promise<Chapter[]> {
        const base = await getBaseURL(this.stateManager)
        const $ = await this.fetchCheerio(`${base}/series/${mangaId}/full-chapter-list`)

        const collected: {
            id: string
            chapNum: number
            name: string
            time: Date
        }[] = []

        $('a[href*="/chapters/"]').each((_: number, a: any) => {
            const id = this.idFromHref($(a).attr("href") ?? "")
            if (!id) return
            const name =
                $(a).find("span.grow > span").first().text().trim() ||
                $(a).find("span").first().text().trim() ||
                "Chapter"
            const datetime = $(a).find("time").attr("datetime")
            // Prefer "Chapter N" so volume prefixes don't capture the wrong number.
            const chapMatch =
                name.match(/chapter\s*(\d+(?:\.\d+)?)/i) ?? name.match(/(\d+(?:\.\d+)?)/)
            collected.push({
                id,
                chapNum: chapMatch ? parseFloat(chapMatch[1]) : 0,
                name,
                time: datetime ? new Date(datetime) : new Date(),
            })
        })

        // Sort ascending and keep sortingIndex consistent with chapter number so
        // ordering is stable and never depends on the page's DOM order.
        collected.sort((a, b) => {
            if (a.chapNum !== b.chapNum) return a.chapNum - b.chapNum
            return a.time.getTime() - b.time.getTime()
        })

        return collected.map((c, index) =>
            App.createChapter({
                id: c.id,
                chapNum: c.chapNum,
                volume: 0,
                name: c.name,
                langCode: "en",
                group: "Weeb Central",
                time: c.time,
                sortingIndex: index,
            }),
        )
    }

    // -----------------------------------------------------------------------
    //  Chapter pages
    // -----------------------------------------------------------------------
    async getChapterDetails(
        mangaId: string,
        chapterId: string,
    ): Promise<ChapterDetails> {
        const base = await getBaseURL(this.stateManager)
        const $ = await this.fetchCheerio(
            `${base}/chapters/${chapterId}/images` +
                `?is_prev=False&current_page=1&reading_style=long_strip`,
        )

        const pages: string[] = []
        $("img").each((_: number, img: any) => {
            const src = $(img).attr("src")
            if (src && /^https?:\/\//.test(src)) pages.push(src)
        })

        return App.createChapterDetails({ id: chapterId, mangaId, pages })
    }

    // -----------------------------------------------------------------------
    //  Search (and shared list parser)
    // -----------------------------------------------------------------------
    private parseList($: any): PartialSourceManga[] {
        const results: PartialSourceManga[] = []
        const seen = new Set<string>()
        $('a[href*="/series/"]').each((_: number, a: any) => {
            const href = $(a).attr("href") ?? ""
            const id = this.idFromHref(href)
            if (!id || seen.has(id)) return
            // A series is linked twice per card (cover + title); take the one that
            // actually carries the title text.
            const title =
                $(a).find(".line-clamp-1").text().trim() ||
                $(a).text().trim() ||
                $(a).find("img").attr("alt")?.replace(/ cover$/, "").trim() ||
                ""
            if (!title) return
            seen.add(id)
            results.push(
                App.createPartialSourceManga({
                    mangaId: id,
                    title,
                    image: this.coverURL(id),
                }),
            )
        })
        return results
    }

    private searchURL(base: string, text: string, sort: string, offset: number): string {
        const params = [
            `text=${encodeURIComponent(text)}`,
            `limit=${PAGE_SIZE}`,
            `offset=${offset}`,
            `sort=${encodeURIComponent(sort)}`,
            `order=Descending`,
            `official=Any`,
            `display_mode=Full+Display`,
        ]
        return `${base}/search/data?${params.join("&")}`
    }

    async getSearchResults(
        query: SearchRequest,
        metadata: any,
    ): Promise<PagedResults> {
        const base = await getBaseURL(this.stateManager)
        const offset: number = metadata?.offset ?? 0
        const $ = await this.fetchCheerio(
            this.searchURL(base, query.title ?? "", "Best Match", offset),
        )
        const results = this.parseList($)
        return App.createPagedResults({
            results,
            metadata: results.length >= PAGE_SIZE ? { offset: offset + PAGE_SIZE } : undefined,
        })
    }

    getMangaShareUrl(mangaId: string): string {
        return `${DEFAULT_BASE}/series/${mangaId}`
    }

    // -----------------------------------------------------------------------
    //  Homepage
    // -----------------------------------------------------------------------
    private homeSections = [
        { id: "popular", title: "Popular", sort: "Popularity" },
        { id: "latest", title: "Latest Updates", sort: "Latest Updates" },
        { id: "added", title: "Recently Added", sort: "Recently Added" },
    ]

    async getHomePageSections(
        sectionCallback: (section: HomeSection) => void,
    ): Promise<void> {
        const base = await getBaseURL(this.stateManager)
        for (const def of this.homeSections) {
            const section = App.createHomeSection({
                id: def.id,
                title: def.title,
                type:
                    def.id === "popular"
                        ? HomeSectionType.featured
                        : HomeSectionType.singleRowNormal,
                containsMoreItems: true,
            })
            sectionCallback(section)
            try {
                const $ = await this.fetchCheerio(this.searchURL(base, "", def.sort, 0))
                section.items = this.parseList($)
            } catch {
                section.items = []
            }
            sectionCallback(section)
        }
    }

    async getViewMoreItems(
        homepageSectionId: string,
        metadata: any,
    ): Promise<PagedResults> {
        const def = this.homeSections.find((s) => s.id === homepageSectionId)
        if (!def) return App.createPagedResults({ results: [] })
        const base = await getBaseURL(this.stateManager)
        const offset: number = metadata?.offset ?? 0
        const $ = await this.fetchCheerio(this.searchURL(base, "", def.sort, offset))
        const results = this.parseList($)
        return App.createPagedResults({
            results,
            metadata: results.length >= PAGE_SIZE ? { offset: offset + PAGE_SIZE } : undefined,
        })
    }

    // -----------------------------------------------------------------------
    //  Settings — configurable base domain (resilience against site moves)
    // -----------------------------------------------------------------------
    async getSourceMenu(): Promise<DUISection> {
        const stateManager = this.stateManager
        const form: DUIForm = App.createDUIForm({
            sections: async () => [
                App.createDUISection({
                    id: "domain",
                    header: "Domain",
                    footer:
                        "If Weeb Central changes its address, set the new base URL " +
                        "here (e.g. https://weebcentral.com).",
                    isHidden: false,
                    rows: async () => [
                        App.createDUIInputField({
                            id: "base_url",
                            label: "Base URL",
                            value: App.createDUIBinding({
                                get: async () => await getBaseURL(stateManager),
                                set: async (value) =>
                                    await stateManager.store("base_url", value),
                            }),
                        }),
                    ],
                }),
            ],
        })

        return App.createDUISection({
            id: "main",
            header: "Weeb Central Settings",
            isHidden: false,
            rows: async () => [
                App.createDUINavigationButton({
                    id: "settings_nav",
                    label: "Source Settings",
                    form,
                }),
            ],
        })
    }
}
