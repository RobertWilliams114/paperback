import {
    Chapter,
    ChapterDetails,
    ContentRating,
    DUIBinding,
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
    TagSection,
} from "@paperback/types"

// ---------------------------------------------------------------------------
//  Constants
// ---------------------------------------------------------------------------
//  Everything is driven by MangaDex's official, documented, versioned JSON API
//  (https://api.mangadex.org/docs/). It is meant for programmatic access, is
//  not behind Cloudflare, and has been domain-stable for years — which is what
//  makes this source resilient compared to HTML scrapers.

const API_BASE = "https://api.mangadex.org"
const COVER_BASE = "https://uploads.mangadex.org/covers"
const SITE_BASE = "https://mangadex.org"

// MangaDex enforces ~5 requests/second globally. Stay safely under it.
const REQUESTS_PER_SECOND = 4
const PAGE_SIZE = 40

// All possible content ratings. Default excludes "pornographic".
const ALL_RATINGS = ["safe", "suggestive", "erotica", "pornographic"]
const DEFAULT_RATINGS = ["safe", "suggestive", "erotica"]
const DEFAULT_LANGUAGES = ["en"]

// A curated subset of MangaDex's ~70 translation languages. These are the codes
// the API expects (mostly ISO-639-1, with regional variants where MangaDex uses
// them). Kept as a constant so the source never has to scrape a language list.
const LANGUAGES: { code: string; name: string }[] = [
    { code: "en", name: "English" },
    { code: "ja", name: "Japanese" },
    { code: "ko", name: "Korean" },
    { code: "zh", name: "Chinese (Simp.)" },
    { code: "zh-hk", name: "Chinese (Trad.)" },
    { code: "es", name: "Spanish (Es)" },
    { code: "es-la", name: "Spanish (LATAM)" },
    { code: "fr", name: "French" },
    { code: "de", name: "German" },
    { code: "it", name: "Italian" },
    { code: "pt", name: "Portuguese (Pt)" },
    { code: "pt-br", name: "Portuguese (Br)" },
    { code: "ru", name: "Russian" },
    { code: "pl", name: "Polish" },
    { code: "id", name: "Indonesian" },
    { code: "vi", name: "Vietnamese" },
    { code: "th", name: "Thai" },
    { code: "ar", name: "Arabic" },
    { code: "tr", name: "Turkish" },
    { code: "uk", name: "Ukrainian" },
]

// Human-readable map for status values returned by the API.
const STATUS_MAP: Record<string, string> = {
    ongoing: "Ongoing",
    completed: "Completed",
    hiatus: "Hiatus",
    cancelled: "Cancelled",
}

// ---------------------------------------------------------------------------
//  Source metadata (read by the bundler to build versioning.json)
// ---------------------------------------------------------------------------

export const MangaDexAPIInfo: SourceInfo = {
    version: "1.0.0",
    name: "MangaDex (API)",
    icon: "icon.png",
    author: "rjwil",
    description:
        "Resilient MangaDex source built on the official api.mangadex.org JSON API. " +
        "Supports manga, manhwa, manhua and more, with configurable languages, " +
        "content ratings and data-saver images.",
    contentRating: ContentRating.MATURE,
    websiteBaseURL: SITE_BASE,
    intents:
        SourceIntents.MANGA_CHAPTERS |
        SourceIntents.HOMEPAGE_SECTIONS |
        SourceIntents.SETTINGS_UI,
    sourceTags: [],
}

// ---------------------------------------------------------------------------
//  Settings helpers (persisted via the app's SourceStateManager)
// ---------------------------------------------------------------------------

async function getLanguages(stateManager: SourceStateManager): Promise<string[]> {
    return (await stateManager.retrieve("languages")) as string[] ?? DEFAULT_LANGUAGES
}

async function getRatings(stateManager: SourceStateManager): Promise<string[]> {
    return (await stateManager.retrieve("ratings")) as string[] ?? DEFAULT_RATINGS
}

async function getDataSaver(stateManager: SourceStateManager): Promise<boolean> {
    return (await stateManager.retrieve("data_saver")) as boolean ?? false
}

// ---------------------------------------------------------------------------
//  Source implementation
// ---------------------------------------------------------------------------

export class MangaDexAPI extends Source {
    stateManager: SourceStateManager = App.createSourceStateManager()

    requestManager = App.createRequestManager({
        requestsPerSecond: REQUESTS_PER_SECOND,
        requestTimeout: 20000,
        interceptor: {
            interceptRequest: async (request: Request): Promise<Request> => {
                request.headers = {
                    ...(request.headers ?? {}),
                    referer: `${SITE_BASE}/`,
                    "user-agent":
                        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) " +
                        "AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Paperback",
                }
                return request
            },
            interceptResponse: async (response: Response): Promise<Response> => response,
        },
    })

    // -- Small JSON GET helper with one retry (handled by schedule's retry arg) --
    async fetchJSON(url: string): Promise<any> {
        const request = App.createRequest({ url, method: "GET" })
        const response = await this.requestManager.schedule(request, 2)
        if (response.status < 200 || response.status >= 300) {
            throw new Error(`MangaDex API request failed (${response.status}) for ${url}`)
        }
        try {
            return JSON.parse(response.data ?? "{}")
        } catch {
            throw new Error(`Could not parse MangaDex response for ${url}`)
        }
    }

    // -- Build a ?contentRating[]=...&contentRating[]=... query fragment --
    async ratingQuery(): Promise<string> {
        const ratings = await getRatings(this.stateManager)
        return ratings.map((r) => `contentRating[]=${r}`).join("&")
    }

    // -- Build a cover thumbnail URL for a manga + cover-art relationship --
    coverURL(mangaId: string, relationships: any[]): string {
        const coverRel = relationships?.find((r) => r.type === "cover_art")
        const fileName = coverRel?.attributes?.fileName
        if (!fileName) {
            return ""
        }
        // The ".512.jpg" suffix asks MangaDex for a sized thumbnail.
        return `${COVER_BASE}/${mangaId}/${fileName}.512.jpg`
    }

    // -- Map a /manga list item to a Paperback tile --
    toPartialManga(mangaItem: any): PartialSourceManga | undefined {
        const id = mangaItem.id
        const attributes = mangaItem.attributes
        if (!id || !attributes) {
            return undefined
        }
        const title =
            attributes.title?.en ??
            Object.values(attributes.title ?? {})[0] ??
            (attributes.altTitles ?? [])
                .map((t: Record<string, string>) => Object.values(t)[0])
                .find((v: string) => v) ??
            "Untitled"

        return App.createPartialSourceManga({
            mangaId: id,
            title: title as string,
            image: this.coverURL(id, mangaItem.relationships ?? []),
        })
    }

    // -----------------------------------------------------------------------
    //  Manga details
    // -----------------------------------------------------------------------
    async getMangaDetails(mangaId: string): Promise<SourceManga> {
        const url =
            `${API_BASE}/manga/${mangaId}` +
            `?includes[]=cover_art&includes[]=author&includes[]=artist`
        const json = await this.fetchJSON(url)
        const data = json.data
        const attributes = data.attributes
        const relationships: any[] = data.relationships ?? []

        // Titles: primary + alt titles, de-duplicated.
        const titles: string[] = []
        const primary =
            attributes.title?.en ?? Object.values(attributes.title ?? {})[0]
        if (primary) titles.push(primary as string)
        for (const alt of attributes.altTitles ?? []) {
            const v = Object.values(alt)[0]
            if (v && !titles.includes(v as string)) titles.push(v as string)
        }
        if (titles.length === 0) titles.push("Untitled")

        // Description: prefer English, fall back to first available.
        const description =
            attributes.description?.en ??
            (Object.values(attributes.description ?? {})[0] as string) ??
            ""

        // Authors / artists from the included relationships.
        const author = relationships
            .filter((r) => r.type === "author")
            .map((r) => r.attributes?.name)
            .filter((n) => n)
            .join(", ")
        const artist = relationships
            .filter((r) => r.type === "artist")
            .map((r) => r.attributes?.name)
            .filter((n) => n)
            .join(", ")

        // Tags grouped into a single readable section.
        const tags = (attributes.tags ?? [])
            .map((t: any) => {
                const name =
                    t.attributes?.name?.en ??
                    (Object.values(t.attributes?.name ?? {})[0] as string)
                return name ? App.createTag({ id: t.id, label: name }) : undefined
            })
            .filter((t: any) => t)

        const tagSections: TagSection[] = [
            App.createTagSection({ id: "tags", label: "Tags", tags }),
        ]

        const status = STATUS_MAP[attributes.status] ?? "Unknown"
        const isHentai =
            attributes.contentRating === "pornographic" ||
            attributes.contentRating === "erotica"

        return App.createSourceManga({
            id: mangaId,
            mangaInfo: App.createMangaInfo({
                titles,
                image: this.coverURL(mangaId, relationships),
                author: author || "Unknown",
                artist: artist || "Unknown",
                desc: description,
                status,
                hentai: isHentai,
                tags: tagSections,
            }),
        })
    }

    // -----------------------------------------------------------------------
    //  Chapter list (paginates the /feed endpoint, up to 500 per call)
    // -----------------------------------------------------------------------
    async getChapters(mangaId: string): Promise<Chapter[]> {
        const languages = await getLanguages(this.stateManager)
        const langQuery = languages.map((l) => `translatedLanguage[]=${l}`).join("&")
        const ratingQuery = ALL_RATINGS.map((r) => `contentRating[]=${r}`).join("&")

        const chapters: Chapter[] = []
        let offset = 0
        const limit = 500
        let total = Infinity
        let sortingIndex = 0

        while (offset < total) {
            const url =
                `${API_BASE}/manga/${mangaId}/feed` +
                `?limit=${limit}&offset=${offset}` +
                `&${langQuery}&${ratingQuery}` +
                `&includes[]=scanlation_group` +
                `&order[volume]=desc&order[chapter]=desc` +
                `&includeFutureUpdates=0`
            const json = await this.fetchJSON(url)
            total = json.total ?? 0

            for (const item of json.data ?? []) {
                const attributes = item.attributes
                // Skip externally-hosted chapters: they have no readable pages here.
                if (attributes.externalUrl && (attributes.pages ?? 0) === 0) {
                    continue
                }
                const group =
                    (item.relationships ?? [])
                        .filter((r: any) => r.type === "scanlation_group")
                        .map((r: any) => r.attributes?.name)
                        .filter((n: any) => n)
                        .join(", ") || "Unknown"

                const chapNum = parseFloat(attributes.chapter) || 0
                const volume = parseFloat(attributes.volume)

                chapters.push(
                    App.createChapter({
                        id: item.id,
                        chapNum,
                        volume: isNaN(volume) ? 0 : volume,
                        name: attributes.title || "",
                        langCode: attributes.translatedLanguage ?? "en",
                        group,
                        time: new Date(
                            attributes.publishAt ?? attributes.readableAt ?? Date.now(),
                        ),
                        sortingIndex: sortingIndex++,
                    }),
                )
            }
            offset += limit
            // Safety valve against runaway pagination.
            if ((json.data ?? []).length === 0) break
        }

        return chapters
    }

    // -----------------------------------------------------------------------
    //  Chapter pages (uses the MangaDex@Home image delivery endpoint)
    // -----------------------------------------------------------------------
    async getChapterDetails(
        mangaId: string,
        chapterId: string,
    ): Promise<ChapterDetails> {
        const json = await this.fetchJSON(`${API_BASE}/at-home/server/${chapterId}`)
        const baseUrl = json.baseUrl
        const hash = json.chapter?.hash
        const dataSaver = await getDataSaver(this.stateManager)
        const quality = dataSaver ? "data-saver" : "data"
        const files: string[] = dataSaver
            ? json.chapter?.dataSaver ?? []
            : json.chapter?.data ?? []

        const pages = files.map((f) => `${baseUrl}/${quality}/${hash}/${f}`)

        return App.createChapterDetails({
            id: chapterId,
            mangaId,
            pages,
        })
    }

    // -----------------------------------------------------------------------
    //  Search
    // -----------------------------------------------------------------------
    async getSearchResults(
        query: SearchRequest,
        metadata: any,
    ): Promise<PagedResults> {
        const offset: number = metadata?.offset ?? 0
        const ratingQuery = await this.ratingQuery()

        const params: string[] = [
            `limit=${PAGE_SIZE}`,
            `offset=${offset}`,
            ratingQuery,
            `includes[]=cover_art`,
            `order[relevance]=desc`,
        ]

        if (query.title) {
            params.push(`title=${encodeURIComponent(query.title)}`)
        }
        for (const tag of query.includedTags ?? []) {
            params.push(`includedTags[]=${tag.id}`)
        }
        for (const tag of query.excludedTags ?? []) {
            params.push(`excludedTags[]=${tag.id}`)
        }

        const json = await this.fetchJSON(`${API_BASE}/manga?${params.join("&")}`)
        const results: PartialSourceManga[] = []
        for (const item of json.data ?? []) {
            const tile = this.toPartialManga(item)
            if (tile) results.push(tile)
        }

        const total = json.total ?? 0
        const nextOffset = offset + PAGE_SIZE
        return App.createPagedResults({
            results,
            metadata: nextOffset < total ? { offset: nextOffset } : undefined,
        })
    }

    // Tags, grouped by MangaDex's own grouping (genre/theme/format/content).
    async getSearchTags(): Promise<TagSection[]> {
        const json = await this.fetchJSON(`${API_BASE}/manga/tag`)
        const groups: Record<string, any[]> = {}
        for (const item of json.data ?? []) {
            const group = item.attributes?.group ?? "other"
            const name =
                item.attributes?.name?.en ??
                (Object.values(item.attributes?.name ?? {})[0] as string)
            if (!name) continue
            ;(groups[group] ??= []).push(App.createTag({ id: item.id, label: name }))
        }
        return Object.entries(groups).map(([group, tags]) =>
            App.createTagSection({
                id: group,
                label: group.charAt(0).toUpperCase() + group.slice(1),
                tags,
            }),
        )
    }

    async supportsTagExclusion(): Promise<boolean> {
        return true
    }

    getMangaShareUrl(mangaId: string): string {
        return `${SITE_BASE}/title/${mangaId}`
    }

    // -----------------------------------------------------------------------
    //  Homepage sections
    // -----------------------------------------------------------------------
    private homeSections = [
        { id: "popular", title: "Popular", order: "order[followedCount]=desc" },
        {
            id: "latest",
            title: "Recently Updated",
            order: "order[latestUploadedChapter]=desc",
        },
        { id: "top_rated", title: "Top Rated", order: "order[rating]=desc" },
        { id: "new", title: "Recently Added", order: "order[createdAt]=desc" },
    ]

    async getHomePageSections(
        sectionCallback: (section: HomeSection) => void,
    ): Promise<void> {
        const ratingQuery = await this.ratingQuery()

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
            // Render the empty section immediately, then fill it.
            sectionCallback(section)

            const url =
                `${API_BASE}/manga` +
                `?limit=${PAGE_SIZE}&offset=0&${ratingQuery}` +
                `&includes[]=cover_art&${def.order}`
            const json = await this.fetchJSON(url)
            const items: PartialSourceManga[] = []
            for (const item of json.data ?? []) {
                const tile = this.toPartialManga(item)
                if (tile) items.push(tile)
            }
            section.items = items
            sectionCallback(section)
        }
    }

    async getViewMoreItems(
        homepageSectionId: string,
        metadata: any,
    ): Promise<PagedResults> {
        const def = this.homeSections.find((s) => s.id === homepageSectionId)
        if (!def) {
            return App.createPagedResults({ results: [] })
        }
        const offset: number = metadata?.offset ?? 0
        const ratingQuery = await this.ratingQuery()
        const url =
            `${API_BASE}/manga` +
            `?limit=${PAGE_SIZE}&offset=${offset}&${ratingQuery}` +
            `&includes[]=cover_art&${def.order}`
        const json = await this.fetchJSON(url)
        const results: PartialSourceManga[] = []
        for (const item of json.data ?? []) {
            const tile = this.toPartialManga(item)
            if (tile) results.push(tile)
        }
        const total = json.total ?? 0
        const nextOffset = offset + PAGE_SIZE
        return App.createPagedResults({
            results,
            metadata: nextOffset < total ? { offset: nextOffset } : undefined,
        })
    }

    // -----------------------------------------------------------------------
    //  Settings UI
    // -----------------------------------------------------------------------
    async getSourceMenu(): Promise<DUISection> {
        const stateManager = this.stateManager

        const settingsForm: DUIForm = App.createDUIForm({
            sections: async () => [
                App.createDUISection({
                    id: "content",
                    header: "Content",
                    isHidden: false,
                    rows: async () => [
                        App.createDUISelect({
                            id: "languages",
                            label: "Translation Languages",
                            options: LANGUAGES.map((l) => l.code),
                            labelResolver: async (code) =>
                                LANGUAGES.find((l) => l.code === code)?.name ?? code,
                            value: App.createDUIBinding({
                                get: async () => await getLanguages(stateManager),
                                set: async (value) =>
                                    await stateManager.store("languages", value),
                            }),
                            allowsMultiselect: true,
                        }),
                        App.createDUISelect({
                            id: "ratings",
                            label: "Content Ratings",
                            options: ALL_RATINGS,
                            labelResolver: async (code) =>
                                code.charAt(0).toUpperCase() + code.slice(1),
                            value: App.createDUIBinding({
                                get: async () => await getRatings(stateManager),
                                set: async (value) =>
                                    await stateManager.store("ratings", value),
                            }),
                            allowsMultiselect: true,
                        }),
                    ],
                }),
                App.createDUISection({
                    id: "images",
                    header: "Images",
                    footer:
                        "Data Saver loads smaller, compressed pages to save bandwidth.",
                    isHidden: false,
                    rows: async () => [
                        App.createDUISwitch({
                            id: "data_saver",
                            label: "Data Saver",
                            value: App.createDUIBinding({
                                get: async () => await getDataSaver(stateManager),
                                set: async (value) =>
                                    await stateManager.store("data_saver", value),
                            }),
                        }),
                    ],
                }),
            ],
        })

        return App.createDUISection({
            id: "main",
            header: "MangaDex Settings",
            isHidden: false,
            rows: async () => [
                App.createDUINavigationButton({
                    id: "settings_nav",
                    label: "Source Settings",
                    form: settingsForm,
                }),
            ],
        })
    }
}
