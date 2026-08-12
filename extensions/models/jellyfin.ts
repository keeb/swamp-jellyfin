import { z } from "npm:zod@4";

const GlobalArgsSchema = z.object({
  jellyfinUrl: z.string().url().describe("Jellyfin server URL"),
  jellyfinApiKey: z
    .string()
    .describe("Jellyfin API key")
    .meta({ sensitive: true }),
  libraryMap: z
    .record(z.string(), z.string())
    .optional()
    .describe(
      'Map of source mediaType → Jellyfin library name (e.g. anime → "weeb shit"). Used by reindex_recent to decide which libraries to reindex.',
    ),
  organizeSource: z
    .object({
      model: z.string().describe(
        "Source model to read recently-processed items from",
      ),
      spec: z.string().describe("Resource spec on that model"),
      mediaTypeField: z.string().describe(
        "Attribute holding the media type key that indexes libraryMap",
      ),
      timestampField: z.string().describe(
        "Attribute holding the per-item processed timestamp (ISO)",
      ),
      statusField: z.string().optional().describe(
        "Optional attribute to gate on (e.g. status)",
      ),
      statusValue: z.string().optional().describe(
        "Required value of statusField to count an item",
      ),
    })
    .optional()
    .describe("Where reindex_recent reads 'what was just organized' from"),
});

const LibrarySchema = z.object({
  name: z.string(),
  libraryId: z.string(),
  collectionType: z.string(),
  seriesCount: z.number(),
  episodeCount: z.number(),
  movieCount: z.number(),
});

const InventorySchema = z.object({
  timestamp: z.iso.datetime(),
  libraries: z.array(LibrarySchema),
  totals: z.object({
    series: z.number(),
    episodes: z.number(),
    movies: z.number(),
  }),
});

const ScanResultSchema = z.object({
  timestamp: z.iso.datetime(),
  status: z.enum(["started", "completed", "failed"]),
  detail: z.string().optional(),
});

const UnidentifiedItemSchema = z.object({
  name: z.string(),
  path: z.string(),
  type: z.string(),
  library: z.string(),
  parentName: z.string().optional(),
});

const UnidentifiedReportSchema = z.object({
  timestamp: z.iso.datetime(),
  items: z.array(UnidentifiedItemSchema),
  count: z.number(),
});

const SeriesListItemSchema = z.object({
  id: z.string(),
  name: z.string(),
  path: z.string().optional(),
  productionYear: z.number().optional(),
  communityRating: z.number().optional(),
  officialRating: z.string().optional(),
  overview: z.string().optional(),
  genres: z.array(z.string()),
  tags: z.array(z.string()),
  studios: z.array(z.string()),
  providerIds: z.record(z.string(), z.string()),
  episodeCount: z.number().optional(),
  endDate: z.string().optional(),
  status: z.string().optional(),
});

const SeriesListSchema = z.object({
  timestamp: z.iso.datetime(),
  library: z.string(),
  libraryId: z.string(),
  count: z.number(),
  items: z.array(SeriesListItemSchema),
});

function headers(apiKey: string): Record<string, string> {
  return { "X-Emby-Token": apiKey };
}

/** Canonical Jellyfin ProviderIds keys, indexed by lowercase alias. */
const PROVIDER_KEYS: Record<string, string> = {
  imdb: "Imdb",
  tmdb: "Tmdb",
  tvdb: "Tvdb",
  anidb: "AniDB",
  anilist: "AniList",
  mal: "MyAnimeList",
  myanimelist: "MyAnimeList",
};

/**
 * Pull provider IDs out of a mapping value, normalizing key casing.
 * Unrecognized keys pass through untouched so new providers still work.
 */
function normalizeProviderIds(
  spec: Record<string, unknown>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(spec)) {
    const lower = k.toLowerCase();
    if (lower === "name" || lower === "year") continue;
    if (v === null || v === undefined) continue;
    out[PROVIDER_KEYS[lower] ?? k] = String(v);
  }
  return out;
}

export const model = {
  type: "@keeb/jellyfin",
  version: "2026.08.12.1",
  reports: ["@keeb/unidentified-media", "@keeb/library-audit"],
  globalArguments: GlobalArgsSchema,
  resources: {
    inventory: {
      description: "Library inventory snapshot",
      schema: InventorySchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    scan: {
      description: "Library scan result",
      schema: ScanResultSchema,
      lifetime: "7d" as const,
      garbageCollection: 20,
    },
    reindexWatermark: {
      description:
        "High-water mark for reindex_recent — timestamp of the last run and the libraries it reindexed",
      schema: z.object({
        lastReindexAt: z.iso.datetime(),
        libraries: z.array(z.string()),
      }),
      lifetime: "infinite" as const,
      garbageCollection: 5,
    },
    unidentified: {
      description: "Items Jellyfin could not match to a metadata provider",
      schema: UnidentifiedReportSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    audit: {
      description:
        "Full library audit — duplicates, misplacements, structural issues",
      schema: z.object({
        timestamp: z.iso.datetime(),
        duplicateSeries: z.array(z.object({
          name: z.string(),
          tmdbId: z.string(),
          kind: z.enum(["true_duplicate", "shared_tmdb_id"]),
          reason: z.string().optional(),
          entries: z.array(
            z.object({
              path: z.string(),
              library: z.string(),
              year: z.number().optional(),
            }),
          ),
        })),
        duplicateMovies: z.array(z.object({
          name: z.string(),
          tmdbId: z.string(),
          kind: z.enum(["true_duplicate", "shared_tmdb_id"]),
          reason: z.string().optional(),
          entries: z.array(
            z.object({ path: z.string(), year: z.number().optional() }),
          ),
        })),
        misplacedItems: z.array(z.object({
          name: z.string(),
          path: z.string(),
          currentLibrary: z.string(),
          issue: z.string(),
        })),
        totalSeries: z.number(),
        totalMovies: z.number(),
      }),
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    series: {
      description:
        "Per-library listing of series with genres, tags, overview, and provider IDs",
      schema: SeriesListSchema,
      lifetime: "infinite" as const,
      garbageCollection: 5,
    },
    identification: {
      description: "Result of identifying items via metadata search",
      schema: z.object({
        timestamp: z.iso.datetime(),
        results: z.array(
          z.object({
            name: z.string(),
            searchQuery: z.string(),
            status: z.enum(["matched", "no_results", "failed"]),
            matchedTo: z.string().optional(),
            providerIds: z.record(z.string(), z.string()).optional(),
          }),
        ),
        matched: z.number(),
        failed: z.number(),
      }),
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    encodingConfig: {
      description:
        "Snapshot of Jellyfin's EncodingOptions (server-wide transcoding config)",
      schema: z.object({
        timestamp: z.iso.datetime(),
        action: z.enum(["read", "updated"]),
        config: z.record(z.string(), z.unknown()),
      }),
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
  },
  methods: {
    refresh: {
      description: "Trigger a full library rescan on all Jellyfin libraries",
      arguments: z.object({}),
      // deno-lint-ignore no-explicit-any
      execute: async (_args: unknown, context: any) => {
        const { jellyfinUrl, jellyfinApiKey } = context.globalArgs;
        const url = jellyfinUrl.replace(/\/+$/, "");

        const resp = await fetch(`${url}/Library/Refresh`, {
          method: "POST",
          headers: headers(jellyfinApiKey),
        });

        if (!resp.ok) {
          const body = await resp.text();
          throw new Error(
            `Jellyfin library refresh failed: ${resp.status} ${body}`,
          );
        }

        const handle = await context.writeResource("scan", "current", {
          timestamp: new Date().toISOString(),
          status: "started",
          detail: "Full library refresh triggered",
        });

        return { dataHandles: [handle] };
      },
    },
    reindex: {
      description:
        "Re-scan a library to fill in missing metadata and artwork. By default uses Jellyfin's Default refresh mode, which only fetches items that are missing data — fast and cheap. Use force=true to re-query providers for every item (slow, hammers TMDB/AniDB). Library is resolved from existing inventory data — run `inventory` first if it's stale or missing.",
      arguments: z.object({
        library: z
          .string()
          .describe(
            'Library name to reindex (e.g. "weeb shit"). Must match a library present in the latest inventory data.',
          ),
        force: z
          .boolean()
          .default(false)
          .describe(
            "If true, uses FullRefresh mode — re-queries providers for EVERY item, even ones with complete metadata. Slow and rate-limit-heavy. Default false uses Default mode (gaps only).",
          ),
        replaceMetadata: z
          .boolean()
          .default(false)
          .describe(
            "If true, wipes existing metadata before re-fetching. Default false — only fills gaps.",
          ),
        replaceImages: z
          .boolean()
          .default(false)
          .describe(
            "If true, wipes existing images before re-fetching. Default false — only fills gaps.",
          ),
      }),
      // deno-lint-ignore no-explicit-any
      execute: async (args: any, context: any) => {
        const { jellyfinUrl, jellyfinApiKey } = context.globalArgs;
        const url = jellyfinUrl.replace(/\/+$/, "");
        const hdrs = headers(jellyfinApiKey);

        // has(attributes.libraries) forces the query service to parse the JSON
        // content — without referencing attributes the field comes back undefined.
        const inventoryRecords = await context.queryData(
          'modelName == "jellyfin" && specName == "inventory" && has(attributes.libraries)',
        );
        if (!inventoryRecords || inventoryRecords.length === 0) {
          throw new Error(
            "No inventory data found. Run `jellyfin inventory` first so reindex can resolve library IDs.",
          );
        }
        const latestInventory = inventoryRecords
          // deno-lint-ignore no-explicit-any
          .sort((a: any, b: any) => b.version - a.version)[0];
        const libraries = latestInventory.attributes?.libraries ?? [];

        // deno-lint-ignore no-explicit-any
        const match = libraries.find((l: any) => l.name === args.library);
        if (!match) {
          // deno-lint-ignore no-explicit-any
          const known = libraries.map((l: any) => l.name).join(", ");
          throw new Error(
            `Library "${args.library}" not found in inventory. Known: ${known}`,
          );
        }

        const refreshMode = args.force ? "FullRefresh" : "Default";
        await refreshLibrary(url, hdrs, match.libraryId, {
          mode: refreshMode,
          replaceMetadata: args.replaceMetadata,
          replaceImages: args.replaceImages,
        });

        context.logger
          .info`Reindex queued for "${args.library}" (${match.libraryId}), mode=${refreshMode}`;

        const handle = await context.writeResource("scan", "current", {
          timestamp: new Date().toISOString(),
          status: "started",
          detail:
            `Recursive reindex queued on library "${args.library}" (mode=${refreshMode}, replaceMetadata=${args.replaceMetadata}, replaceImages=${args.replaceImages})`,
        });

        return { dataHandles: [handle] };
      },
    },
    reindex_recent: {
      description:
        "Smart reindex: read recently-organized items from the configured organizeSource, map their mediaType to Jellyfin libraries via libraryMap, and Default-mode reindex only the touched libraries. Advances a watermark each run so the next run only sees items processed since. Use seedWatermark=true on first run to skip the backlog.",
      arguments: z.object({
        seedWatermark: z
          .boolean()
          .default(false)
          .describe(
            "If true, skip all reindexing and just set the watermark to now. Use once on first run so the whole historical backlog isn't reindexed.",
          ),
        force: z
          .boolean()
          .default(false)
          .describe(
            "Use FullRefresh mode (re-query every provider) instead of Default (gaps only).",
          ),
        settleSeconds: z
          .number()
          .default(45)
          .describe(
            "After firing refreshes, wait for the scan to be continuously idle this long before returning. 0 disables the wait (fire-and-forget).",
          ),
        timeoutSeconds: z
          .number()
          .default(1800)
          .describe("Hard cap on the post-refresh settle wait."),
        pollSeconds: z
          .number()
          .default(10)
          .describe("Seconds between settle polls."),
      }),
      // deno-lint-ignore no-explicit-any
      execute: async (args: any, context: any) => {
        const { jellyfinUrl, jellyfinApiKey, libraryMap, organizeSource } =
          context.globalArgs;
        if (!libraryMap || !organizeSource) {
          throw new Error(
            "reindex_recent requires `libraryMap` and `organizeSource` in the jellyfin model's globalArguments.",
          );
        }
        const url = jellyfinUrl.replace(/\/+$/, "");
        const hdrs = headers(jellyfinApiKey);
        const now = new Date().toISOString();

        // Read the current watermark (default to epoch if none yet).
        const wmRecords = await context.queryData(
          'modelName == "jellyfin" && specName == "reindexWatermark" && has(attributes.lastReindexAt)',
        );
        const lastReindexAt = (wmRecords && wmRecords.length)
          // deno-lint-ignore no-explicit-any
          ? wmRecords.sort((a: any, b: any) => b.version - a.version)[0]
            .attributes.lastReindexAt
          : "1970-01-01T00:00:00.000Z";

        if (args.seedWatermark) {
          const handle = await context.writeResource(
            "reindexWatermark",
            "watermark",
            { lastReindexAt: now, libraries: [] },
          );
          context.logger
            .info`Seeded reindex watermark to ${now}; nothing reindexed`;
          return { dataHandles: [handle] };
        }

        // Collect libraries touched since the watermark.
        const {
          model: srcModel,
          spec: srcSpec,
          mediaTypeField,
          timestampField,
          statusField,
          statusValue,
        } = organizeSource;
        const records = await context.queryData(
          `modelName == "${srcModel}" && specName == "${srcSpec}" && has(attributes.${mediaTypeField})`,
        );
        const touched = new Set<string>();
        for (const r of records ?? []) {
          const a = r.attributes ?? {};
          if (statusField && a[statusField] !== statusValue) continue;
          if (timestampField && !(a[timestampField] > lastReindexAt)) continue;
          const lib = libraryMap[a[mediaTypeField]];
          if (lib) touched.add(lib);
        }

        if (touched.size === 0) {
          const handle = await context.writeResource(
            "reindexWatermark",
            "watermark",
            { lastReindexAt: now, libraries: [] },
          );
          context.logger
            .info`No libraries touched since ${lastReindexAt}; watermark advanced to ${now}`;
          return { dataHandles: [handle] };
        }

        // Resolve library IDs live from Jellyfin. Reading them from stored
        // `inventory` data would be fragile inside a workflow run — an earlier
        // step's writeResource output isn't queryable by this step until the
        // run commits — so hit the API directly, like `inventory` does.
        const libResp = await fetch(`${url}/Library/VirtualFolders`, {
          headers: hdrs,
        });
        if (!libResp.ok) {
          throw new Error(
            `Failed to list Jellyfin libraries: ${libResp.status} ${await libResp
              .text()}`,
          );
        }
        // deno-lint-ignore no-explicit-any
        const libraries: any[] = await libResp.json();

        const mode = args.force ? "FullRefresh" : "Default";
        const handles = [];
        const done: string[] = [];
        for (const name of touched) {
          const match = libraries.find((l) => l.Name === name);
          if (!match) {
            const known = libraries.map((l) => l.Name).join(", ");
            context.logger
              .info`Touched library "${name}" not found in Jellyfin (have: ${known}) — skipping`;
            continue;
          }
          await refreshLibrary(url, hdrs, match.ItemId, {
            mode,
            replaceMetadata: false,
            replaceImages: false,
          });
          context.logger
            .info`Reindex queued for "${name}" (${match.ItemId}, mode=${mode})`;
          done.push(name);
        }

        // Wait for the refreshes to settle before returning, so a downstream
        // audit sees the reindexed state. Done here (not a separate step)
        // because only this method knows a refresh actually fired — a later
        // step can't see this run's uncommitted `scan` output via queryData.
        let settleDetail = "wait skipped (settleSeconds=0)";
        if (done.length > 0 && args.settleSeconds > 0) {
          const settle = await waitForScanSettle(url, hdrs, {
            settleSeconds: args.settleSeconds,
            timeoutSeconds: args.timeoutSeconds,
            pollSeconds: args.pollSeconds,
          });
          settleDetail = settle.detail;
          context.logger.info(settle.detail);
        }

        handles.push(
          await context.writeResource("scan", "current", {
            timestamp: now,
            status: "completed",
            detail: `reindex_recent queued: ${
              done.join(", ")
            } (mode=${mode}); ${settleDetail}`,
          }),
        );
        handles.push(
          await context.writeResource("reindexWatermark", "watermark", {
            lastReindexAt: now,
            libraries: done,
          }),
        );
        return { dataHandles: handles };
      },
    },
    scan_status: {
      description:
        "Wait for Jellyfin to settle after a reindex before auditing. If no reindex was queued in the last `recentMinutes` (no recent `scan` resource with status 'started'), returns immediately — nothing to wait for. Otherwise it truly waits out any running RefreshLibrary scheduled task (the `refresh`/full-scan path), then applies a bounded `settleSeconds` idle window. NOTE: Jellyfin exposes no completion signal for item-tree metadata refreshes (what `reindex`/`reindex_recent` trigger) — those never register as a scheduled task — so for that path the settle window is the effective wait, not true completion detection.",
      arguments: z.object({
        settleSeconds: z
          .number()
          .default(45)
          .describe(
            "Require the RefreshLibrary task to be continuously idle for this long before returning. For item-tree refreshes (no task signal) this is the effective settle wait.",
          ),
        recentMinutes: z
          .number()
          .default(15)
          .describe(
            "Only wait if a reindex was queued within this many minutes; otherwise return immediately.",
          ),
        timeoutSeconds: z
          .number()
          .default(1800)
          .describe("Hard cap on total wait before giving up."),
        pollSeconds: z
          .number()
          .default(10)
          .describe("Seconds between polls."),
      }),
      // deno-lint-ignore no-explicit-any
      execute: async (args: any, context: any) => {
        const { jellyfinUrl, jellyfinApiKey } = context.globalArgs;
        const url = jellyfinUrl.replace(/\/+$/, "");
        const hdrs = headers(jellyfinApiKey);

        // Skip the wait entirely if nothing was reindexed recently. reindex /
        // reindex_recent write a `scan` resource with status "started"; a no-op
        // reindex_recent writes none, so there's nothing to settle.
        const cutoff = new Date(Date.now() - args.recentMinutes * 60 * 1000)
          .toISOString();
        const recent = await context.queryData(
          `modelName == "jellyfin" && specName == "scan" && attributes.status == "started" && attributes.timestamp > "${cutoff}"`,
        );
        if (!recent || recent.length === 0) {
          const handle = await context.writeResource("scan", "current", {
            timestamp: new Date().toISOString(),
            status: "completed",
            detail:
              `No reindex queued in the last ${args.recentMinutes}m — nothing to wait for`,
          });
          context.logger
            .info`No recent reindex; scan_status returning immediately`;
          return { dataHandles: [handle] };
        }

        const { settled, detail } = await waitForScanSettle(url, hdrs, {
          settleSeconds: args.settleSeconds,
          timeoutSeconds: args.timeoutSeconds,
          pollSeconds: args.pollSeconds,
        });
        const handle = await context.writeResource("scan", "current", {
          timestamp: new Date().toISOString(),
          status: settled ? "completed" : "failed",
          detail,
        });
        context.logger.info(detail);
        return { dataHandles: [handle] };
      },
    },
    inventory: {
      description:
        "Query all Jellyfin libraries and return item counts per library",
      arguments: z.object({}),
      // deno-lint-ignore no-explicit-any
      execute: async (_args: unknown, context: any) => {
        const { jellyfinUrl, jellyfinApiKey } = context.globalArgs;
        const url = jellyfinUrl.replace(/\/+$/, "");
        const hdrs = headers(jellyfinApiKey);

        // Get libraries
        const libResp = await fetch(`${url}/Library/VirtualFolders`, {
          headers: hdrs,
        });
        if (!libResp.ok) {
          throw new Error(`Failed to get libraries: ${libResp.status}`);
        }
        const libs = await libResp.json();

        const libraries = [];
        let totalSeries = 0;
        let totalEpisodes = 0;
        let totalMovies = 0;

        for (const lib of libs) {
          const name = lib.Name ?? "";
          const libId = lib.ItemId ?? "";
          const collectionType = lib.CollectionType ?? "";

          let seriesCount = 0;
          let episodeCount = 0;
          let movieCount = 0;

          if (collectionType === "tvshows") {
            seriesCount = await getItemCount(url, hdrs, libId, "Series");
            episodeCount = await getItemCount(url, hdrs, libId, "Episode");
          } else if (collectionType === "movies") {
            movieCount = await getItemCount(url, hdrs, libId, "Movie");
          }

          libraries.push({
            name,
            libraryId: libId,
            collectionType,
            seriesCount,
            episodeCount,
            movieCount,
          });

          totalSeries += seriesCount;
          totalEpisodes += episodeCount;
          totalMovies += movieCount;
        }

        const handle = await context.writeResource("inventory", "current", {
          timestamp: new Date().toISOString(),
          libraries,
          totals: {
            series: totalSeries,
            episodes: totalEpisodes,
            movies: totalMovies,
          },
        });

        return { dataHandles: [handle] };
      },
    },
    series: {
      description:
        "List all series in a library with metadata (genres, tags, overview, provider IDs) for taste matching and cross-referencing with MAL/TMDB. Library is resolved from existing inventory data — run `inventory` first if stale.",
      arguments: z.object({
        library: z
          .string()
          .describe(
            'Library name to list (e.g. "weeb shit"). Must match a library present in the latest inventory data.',
          ),
      }),
      // deno-lint-ignore no-explicit-any
      execute: async (args: any, context: any) => {
        const { jellyfinUrl, jellyfinApiKey } = context.globalArgs;
        const url = jellyfinUrl.replace(/\/+$/, "");
        const hdrs = headers(jellyfinApiKey);

        const inventoryRecords = await context.queryData(
          'modelName == "jellyfin" && specName == "inventory" && has(attributes.libraries)',
        );
        if (!inventoryRecords || inventoryRecords.length === 0) {
          throw new Error(
            "No inventory data found. Run `jellyfin inventory` first so series can resolve library IDs.",
          );
        }
        const latestInventory = inventoryRecords
          // deno-lint-ignore no-explicit-any
          .sort((a: any, b: any) => b.version - a.version)[0];
        const libraries = latestInventory.attributes?.libraries ?? [];
        // deno-lint-ignore no-explicit-any
        const match = libraries.find((l: any) => l.name === args.library);
        if (!match) {
          // deno-lint-ignore no-explicit-any
          const known = libraries.map((l: any) => l.name).join(", ");
          throw new Error(
            `Library "${args.library}" not found in inventory. Known: ${known}`,
          );
        }

        const usersResp = await fetch(`${url}/Users`, { headers: hdrs });
        if (!usersResp.ok) {
          throw new Error(`Failed to get users: ${usersResp.status}`);
        }
        const users = await usersResp.json();
        if (!users || users.length === 0) throw new Error("No users found");
        const userId = users[0].Id;

        // deno-lint-ignore no-explicit-any
        const items: any[] = [];
        const batchSize = 200;
        let startIndex = 0;
        while (true) {
          const params = new URLSearchParams({
            ParentId: match.libraryId,
            IncludeItemTypes: "Series",
            Recursive: "true",
            Fields:
              "ProviderIds,Path,ProductionYear,Overview,Genres,Tags,Studios,CommunityRating,OfficialRating,EndDate,Status,ChildCount",
            Limit: String(batchSize),
            StartIndex: String(startIndex),
          });
          const resp = await fetch(
            `${url}/Users/${userId}/Items?${params}`,
            { headers: hdrs },
          );
          if (!resp.ok) {
            throw new Error(`Failed to fetch series: ${resp.status}`);
          }
          const data = await resp.json();
          const batch = data.Items ?? [];
          if (batch.length === 0) break;
          for (const s of batch) {
            items.push({
              id: s.Id ?? "",
              name: s.Name ?? "",
              path: s.Path ?? undefined,
              productionYear: s.ProductionYear ?? undefined,
              communityRating: s.CommunityRating ?? undefined,
              officialRating: s.OfficialRating ?? undefined,
              overview: s.Overview ?? undefined,
              genres: s.Genres ?? [],
              tags: s.Tags ?? [],
              // deno-lint-ignore no-explicit-any
              studios: (s.Studios ?? []).map((st: any) => st.Name ?? ""),
              providerIds: s.ProviderIds ?? {},
              episodeCount: s.ChildCount ?? undefined,
              endDate: s.EndDate ?? undefined,
              status: s.Status ?? undefined,
            });
          }
          startIndex += batchSize;
          if (startIndex >= (data.TotalRecordCount ?? 0)) break;
        }

        const instanceName = args.library
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-+|-+$/g, "");

        const handle = await context.writeResource("series", instanceName, {
          timestamp: new Date().toISOString(),
          library: args.library,
          libraryId: match.libraryId,
          count: items.length,
          items,
        });

        return { dataHandles: [handle] };
      },
    },
    unidentified: {
      description:
        "Find items with no metadata provider match (no TMDB/TVDB/IMDB ID)",
      arguments: z.object({
        types: z
          .string()
          .default("Series,Movie")
          .describe("Comma-separated item types to check"),
      }),
      // deno-lint-ignore no-explicit-any
      execute: async (args: any, context: any) => {
        const { jellyfinUrl, jellyfinApiKey } = context.globalArgs;
        const url = jellyfinUrl.replace(/\/+$/, "");
        const hdrs = headers(jellyfinApiKey);

        // Get libraries for name lookup — map paths to library names
        const libResp = await fetch(`${url}/Library/VirtualFolders`, {
          headers: hdrs,
        });
        if (!libResp.ok) {
          throw new Error(`Failed to get libraries: ${libResp.status}`);
        }
        const libs = await libResp.json();
        const libPaths: { name: string; paths: string[] }[] = [];
        for (const lib of libs) {
          libPaths.push({
            name: lib.Name ?? "",
            paths: lib.Locations ?? [],
          });
        }

        function resolveLibrary(itemPath: string): string {
          for (const lib of libPaths) {
            for (const p of lib.paths) {
              if (itemPath.startsWith(p)) return lib.name;
            }
          }
          return "unknown";
        }

        // Get first user ID — Users endpoint returns ProviderIds correctly
        const usersResp = await fetch(`${url}/Users`, { headers: hdrs });
        if (!usersResp.ok) {
          throw new Error(`Failed to get users: ${usersResp.status}`);
        }
        const users = await usersResp.json();
        if (!users || users.length === 0) throw new Error("No users found");
        const userId = users[0].Id;

        // deno-lint-ignore no-explicit-any
        const unidentified: any[] = [];
        const batchSize = 200;

        for (const itemType of args.types.split(",")) {
          let startIndex = 0;
          while (true) {
            const params = new URLSearchParams({
              IncludeItemTypes: itemType.trim(),
              Recursive: "true",
              Fields: "ProviderIds,Path,ParentId",
              Limit: String(batchSize),
              StartIndex: String(startIndex),
            });
            const resp = await fetch(
              `${url}/Users/${userId}/Items?${params}`,
              { headers: hdrs },
            );
            if (!resp.ok) break;
            const data = await resp.json();
            const items = data.Items ?? [];
            if (items.length === 0) break;

            for (const item of items) {
              const providerIds = item.ProviderIds ?? {};
              const hasProvider = Object.keys(providerIds).length > 0;
              if (!hasProvider) {
                const library = resolveLibrary(item.Path ?? "");
                unidentified.push({
                  name: item.Name ?? "",
                  path: item.Path ?? "",
                  type: item.Type ?? itemType.trim(),
                  library,
                  parentName: item.SeriesName ?? item.Album ?? undefined,
                });
              }
            }

            startIndex += batchSize;
            if (startIndex >= (data.TotalRecordCount ?? 0)) break;
          }
        }

        const handle = await context.writeResource(
          "unidentified",
          "current",
          {
            timestamp: new Date().toISOString(),
            items: unidentified,
            count: unidentified.length,
          },
        );

        return { dataHandles: [handle] };
      },
    },
    audit: {
      description:
        "Full library audit: find duplicates, misplacements, and structural issues",
      arguments: z.object({}),
      // deno-lint-ignore no-explicit-any
      execute: async (_args: unknown, context: any) => {
        const { jellyfinUrl, jellyfinApiKey } = context.globalArgs;
        const url = jellyfinUrl.replace(/\/+$/, "");
        const hdrs = headers(jellyfinApiKey);

        // Get user ID and library paths
        const usersResp = await fetch(`${url}/Users`, { headers: hdrs });
        if (!usersResp.ok) {
          throw new Error(`Failed to get users: ${usersResp.status}`);
        }
        const users = await usersResp.json();
        const userId = users[0].Id;

        const libResp = await fetch(`${url}/Library/VirtualFolders`, {
          headers: hdrs,
        });
        if (!libResp.ok) {
          throw new Error(`Failed to get libraries: ${libResp.status}`);
        }
        const libs = await libResp.json();
        const libPaths: { name: string; paths: string[] }[] = [];
        for (const lib of libs) {
          libPaths.push({ name: lib.Name ?? "", paths: lib.Locations ?? [] });
        }

        function resolveLibrary(itemPath: string): string {
          for (const lib of libPaths) {
            for (const p of lib.paths) {
              if (itemPath.startsWith(p)) return lib.name;
            }
          }
          return "unknown";
        }

        // Fetch all series and movies
        // deno-lint-ignore no-explicit-any
        async function fetchAll(itemType: string): Promise<any[]> {
          // deno-lint-ignore no-explicit-any
          const all: any[] = [];
          let startIndex = 0;
          const batchSize = 200;
          while (true) {
            const params = new URLSearchParams({
              IncludeItemTypes: itemType,
              Recursive: "true",
              Fields: "ProviderIds,Path,ProductionYear",
              Limit: String(batchSize),
              StartIndex: String(startIndex),
            });
            const resp = await fetch(
              `${url}/Users/${userId}/Items?${params}`,
              { headers: hdrs },
            );
            if (!resp.ok) break;
            const data = await resp.json();
            const items = data.Items ?? [];
            if (items.length === 0) break;
            all.push(...items);
            startIndex += batchSize;
            if (startIndex >= (data.TotalRecordCount ?? 0)) break;
          }
          return all;
        }

        const allSeries = await fetchAll("Series");
        const allMovies = await fetchAll("Movie");

        // Find duplicate series (same TMDB ID, multiple entries)
        // Classify as true_duplicate vs shared_tmdb_id by comparing years,
        // names, and directory structure
        // deno-lint-ignore no-explicit-any
        const seriesByTmdb = new Map<string, any[]>();
        for (const s of allSeries) {
          const tmdb = s.ProviderIds?.Tmdb;
          if (tmdb) {
            if (!seriesByTmdb.has(tmdb)) seriesByTmdb.set(tmdb, []);
            seriesByTmdb.get(tmdb)!.push(s);
          }
        }
        const duplicateSeries = [...seriesByTmdb.entries()]
          .filter(([_, items]) => items.length > 1)
          .map(([tmdbId, items]) => {
            // deno-lint-ignore no-explicit-any
            const years = items.map((i: any) => i.ProductionYear).filter(
              Boolean,
            );
            const names = new Set(
              // deno-lint-ignore no-explicit-any
              items.map((i: any) => (i.Name ?? "").toLowerCase()),
            );
            const uniqueYears = new Set(years);

            // Different production years → different adaptations
            if (uniqueYears.size > 1) {
              return {
                name: items[0].Name,
                tmdbId,
                kind: "shared_tmdb_id" as const,
                reason: `Different production years: ${
                  [...uniqueYears].join(", ")
                }`,
                // deno-lint-ignore no-explicit-any
                entries: items.map((i: any) => ({
                  path: i.Path ?? "",
                  library: resolveLibrary(i.Path ?? ""),
                  year: i.ProductionYear ?? undefined,
                })),
              };
            }

            // Different names (e.g. "One Piece" vs "One Piece Log") and both
            // have distinct directory stems → likely distinct productions
            if (names.size > 1) {
              // deno-lint-ignore no-explicit-any
              const stems = items.map((i: any) => {
                const p = i.Path ?? "";
                const parts = p.split("/");
                return parts[parts.length - 1] ?? "";
              });
              const uniqueStems = new Set(stems);
              // If directory names share a common prefix but have distinct suffixes
              // (e.g. "one-piece" vs "one-piece-log-..."), check if they look like
              // a main series vs a spinoff/recap rather than romaji vs English dupe
              const allSharePrefix = stems.every((s: string) =>
                s.startsWith(stems[0].split("-").slice(0, 2).join("-"))
              );
              if (uniqueStems.size > 1 && names.size > 1 && !allSharePrefix) {
                return {
                  name: items[0].Name,
                  tmdbId,
                  kind: "shared_tmdb_id" as const,
                  reason: `Different names: ${[...names].join(", ")}`,
                  // deno-lint-ignore no-explicit-any
                  entries: items.map((i: any) => ({
                    path: i.Path ?? "",
                    library: resolveLibrary(i.Path ?? ""),
                    year: i.ProductionYear ?? undefined,
                  })),
                };
              }
            }

            return {
              name: items[0].Name,
              tmdbId,
              kind: "true_duplicate" as const,
              // deno-lint-ignore no-explicit-any
              entries: items.map((i: any) => ({
                path: i.Path ?? "",
                library: resolveLibrary(i.Path ?? ""),
                year: i.ProductionYear ?? undefined,
              })),
            };
          });

        // Find duplicate movies (same TMDB ID, multiple files)
        // Classify by comparing production years — different years = different films
        // deno-lint-ignore no-explicit-any
        const moviesByTmdb = new Map<string, any[]>();
        for (const m of allMovies) {
          const tmdb = m.ProviderIds?.Tmdb;
          if (tmdb) {
            if (!moviesByTmdb.has(tmdb)) moviesByTmdb.set(tmdb, []);
            moviesByTmdb.get(tmdb)!.push(m);
          }
        }
        const duplicateMovies = [...moviesByTmdb.entries()]
          .filter(([_, items]) => items.length > 1)
          .map(([tmdbId, items]) => {
            // deno-lint-ignore no-explicit-any
            const years = items.map((i: any) => i.ProductionYear).filter(
              Boolean,
            );
            const uniqueYears = new Set(years);

            if (uniqueYears.size > 1) {
              return {
                name: items[0].Name,
                tmdbId,
                kind: "shared_tmdb_id" as const,
                reason: `Different production years: ${
                  [...uniqueYears].join(", ")
                }`,
                // deno-lint-ignore no-explicit-any
                entries: items.map((i: any) => ({
                  path: i.Path ?? "",
                  year: i.ProductionYear ?? undefined,
                })),
              };
            }

            return {
              name: items[0].Name,
              tmdbId,
              kind: "true_duplicate" as const,
              // deno-lint-ignore no-explicit-any
              entries: items.map((i: any) => ({
                path: i.Path ?? "",
                year: i.ProductionYear ?? undefined,
              })),
            };
          });

        // Find misplaced items — content whose disk path doesn't match the
        // Jellyfin library it appears in. The disk path is the source of truth
        // for media type: /anime/ = anime, /shows/ = TV, /movies/ = movies,
        // /chinese/ = chinese shows.
        // deno-lint-ignore no-explicit-any
        const misplacedItems: any[] = [];
        for (const s of allSeries) {
          const path = s.Path ?? "";
          const library = resolveLibrary(path);
          const libLower = library.toLowerCase();

          // Anime on disk but in a non-anime library
          if (
            path.includes("/anime/") && !libLower.includes("anime") &&
            !libLower.includes("weeb")
          ) {
            misplacedItems.push({
              name: s.Name,
              path,
              currentLibrary: library,
              issue: "Anime content in non-anime library",
            });
          }
          // TV shows on disk but in an anime library
          if (
            path.includes("/shows/") &&
            (libLower.includes("anime") || libLower.includes("weeb"))
          ) {
            misplacedItems.push({
              name: s.Name,
              path,
              currentLibrary: library,
              issue: "TV show content in anime library",
            });
          }
          // Chinese on disk but in wrong library
          if (path.includes("/chinese/") && !libLower.includes("chinese")) {
            misplacedItems.push({
              name: s.Name,
              path,
              currentLibrary: library,
              issue: "Chinese content in wrong library",
            });
          }
        }

        const handle = await context.writeResource("audit", "current", {
          timestamp: new Date().toISOString(),
          duplicateSeries,
          duplicateMovies,
          misplacedItems,
          totalSeries: allSeries.length,
          totalMovies: allMovies.length,
        });

        return { dataHandles: [handle] };
      },
    },
    identify: {
      description:
        "Search Jellyfin metadata providers and apply matches for unidentified items",
      arguments: z.object({
        mappings: z
          .string()
          .describe(
            'JSON object mapping current item name (or path substring) to either a search query string, e.g. {"dragonball-z-remastered":"Dragon Ball Z"}, or an object pinning explicit provider IDs, e.g. {"bleach-tybw":{"imdb":"tt14986406","name":"Bleach: Thousand-Year Blood War"}}. Accepted ID keys: imdb, tmdb, tvdb, anidb, anilist, mal (plus optional name/year to seed the search). When IDs are pinned, only a result carrying those exact IDs is applied — an unpinned first result is never used. If the key contains "/" it matches against the item path instead of name.',
          ),
        dryRun: z.boolean().default(false).describe(
          "Search only, don't apply matches",
        ),
      }),
      // deno-lint-ignore no-explicit-any
      execute: async (args: any, context: any) => {
        const { jellyfinUrl, jellyfinApiKey } = context.globalArgs;
        const url = jellyfinUrl.replace(/\/+$/, "");
        const hdrs = headers(jellyfinApiKey);

        const mappings: Record<string, string | Record<string, unknown>> = JSON
          .parse(args.mappings);
        // deno-lint-ignore no-explicit-any
        const results: any[] = [];
        let matched = 0;
        let failed = 0;

        for (const [currentKey, spec] of Object.entries(mappings)) {
          const isPinned = typeof spec === "object" && spec !== null;
          const pinnedIds = isPinned
            ? normalizeProviderIds(spec as Record<string, unknown>)
            : null;
          const pinnedYear = isPinned
            ? (spec as Record<string, unknown>).year
            : undefined;
          // Search string: explicit name when pinned, else the bare query.
          // Falls back to the item's own name once we've located it.
          let searchQuery = isPinned
            ? String((spec as Record<string, unknown>).name ?? "")
            : (spec as string);

          const matchByPath = currentKey.includes("/");
          context.logger
            .info`Identifying "${currentKey}" → ${
            pinnedIds && Object.keys(pinnedIds).length > 0
              ? `pinned ${JSON.stringify(pinnedIds)}`
              : `searching "${searchQuery}"`
          } (match by ${matchByPath ? "path" : "name"})`;

          // Find the item in Jellyfin
          // deno-lint-ignore no-explicit-any
          let item: any = null;
          for (const tryType of ["Series", "Movie"]) {
            if (!matchByPath) {
              // Try SearchTerm first for name-based matching
              const findParams = new URLSearchParams({
                SearchTerm: currentKey,
                IncludeItemTypes: tryType,
                Recursive: "true",
                Fields: "ProviderIds,Path",
                Limit: "10",
              });
              const findResp = await fetch(`${url}/Items?${findParams}`, {
                headers: hdrs,
              });
              if (findResp.ok) {
                const found = await findResp.json();
                item = (found.Items ?? []).find(
                  // deno-lint-ignore no-explicit-any
                  (i: any) =>
                    (i.Name ?? "").toLowerCase() === currentKey.toLowerCase(),
                );
              }
              if (item) break;
            }

            // Scan all items for name or path match
            let startIdx = 0;
            while (!item) {
              const scanParams = new URLSearchParams({
                IncludeItemTypes: tryType,
                Recursive: "true",
                Fields: "ProviderIds,Path",
                Limit: "200",
                StartIndex: String(startIdx),
              });
              const scanResp = await fetch(`${url}/Items?${scanParams}`, {
                headers: hdrs,
              });
              if (!scanResp.ok) break;
              const scanData = await scanResp.json();
              const scanItems = scanData.Items ?? [];
              if (scanItems.length === 0) break;
              // deno-lint-ignore no-explicit-any
              item = scanItems.find((i: any) =>
                matchByPath
                  ? (i.Path ?? "").includes(currentKey)
                  : (i.Name ?? "").toLowerCase() === currentKey.toLowerCase()
              );
              startIdx += 200;
              if (startIdx >= (scanData.TotalRecordCount ?? 0)) break;
            }
            if (item) break;
          }

          if (!item) {
            context.logger.warn`Item "${currentKey}" not found in Jellyfin`;
            results.push({
              name: currentKey,
              searchQuery,
              status: "failed",
            });
            failed++;
            continue;
          }

          const itemId = item.Id;
          const itemType = item.Type === "Movie" ? "Movie" : "Series";

          // A pinned mapping may omit `name`; the item's own name seeds the search.
          if (!searchQuery) searchQuery = item.Name ?? currentKey;

          // Search metadata providers. Pinned IDs go into SearchInfo so
          // providers can resolve the exact entry rather than a title guess.
          // deno-lint-ignore no-explicit-any
          const searchInfo: any = { Name: searchQuery };
          if (pinnedIds && Object.keys(pinnedIds).length > 0) {
            searchInfo.ProviderIds = pinnedIds;
          }
          if (pinnedYear !== undefined && pinnedYear !== null) {
            searchInfo.Year = Number(pinnedYear);
          }

          const searchResp = await fetch(
            `${url}/Items/RemoteSearch/${itemType}`,
            {
              method: "POST",
              headers: { ...hdrs, "Content-Type": "application/json" },
              body: JSON.stringify({
                SearchInfo: searchInfo,
                IncludeDisabledProviders: false,
              }),
            },
          );
          if (!searchResp.ok) {
            context.logger
              .warn`Metadata search failed for "${currentKey}": ${searchResp.status}`;
            results.push({
              name: currentKey,
              searchQuery,
              status: "failed",
            });
            failed++;
            continue;
          }
          const searchResults = await searchResp.json();

          if (!searchResults || searchResults.length === 0) {
            context.logger.warn`No metadata results for "${currentKey}"`;
            results.push({
              name: currentKey,
              searchQuery,
              status: "no_results",
            });
            failed++;
            continue;
          }

          // Unpinned: keep the historical first-result behavior.
          // Pinned: only a result carrying every pinned ID is acceptable.
          // Refusing here is the point — applying result[0] is exactly how a
          // parent series gets stamped onto a cour that shares no ID with it.
          let best = searchResults[0];
          if (pinnedIds && Object.keys(pinnedIds).length > 0) {
            // deno-lint-ignore no-explicit-any
            const hit = searchResults.find((r: any) => {
              const ids = r.ProviderIds ?? {};
              return Object.entries(pinnedIds).every(([k, v]) =>
                String(ids[k] ?? "").toLowerCase() === v.toLowerCase()
              );
            });
            if (!hit) {
              context.logger
                .warn`No result matching pinned IDs ${
                JSON.stringify(pinnedIds)
              } for "${currentKey}" — refusing to apply "${
                searchResults[0]?.Name ?? "unknown"
              }"`;
              results.push({
                name: currentKey,
                searchQuery,
                status: "no_results",
              });
              failed++;
              continue;
            }
            best = hit;
          }
          const providerIds = best.ProviderIds ?? {};

          if (!args.dryRun) {
            // Apply the match
            const applyResp = await fetch(
              `${url}/Items/RemoteSearch/Apply/${itemId}?ReplaceAllMetadata=true`,
              {
                method: "POST",
                headers: { ...hdrs, "Content-Type": "application/json" },
                body: JSON.stringify(best),
              },
            );
            if (!applyResp.ok) {
              context.logger
                .warn`Failed to apply match for "${currentKey}": ${applyResp.status}`;
              results.push({
                name: currentKey,
                searchQuery,
                status: "failed",
                matchedTo: best.Name,
                providerIds,
              });
              failed++;
              continue;
            }
          }

          context.logger.info`${
            args.dryRun ? "Would match" : "Matched"
          } "${currentKey}" → "${best.Name}" (${JSON.stringify(providerIds)})`;
          results.push({
            name: currentKey,
            searchQuery,
            status: "matched",
            matchedTo: best.Name,
            providerIds,
          });
          matched++;
        }

        const handle = await context.writeResource(
          "identification",
          "current",
          {
            timestamp: new Date().toISOString(),
            results,
            matched,
            failed,
          },
        );

        return { dataHandles: [handle] };
      },
    },
    encoding_config: {
      description:
        "Read and optionally update Jellyfin's server-wide encoding/transcoding config (EncodingOptions). Without `patch`, just reads. With `patch`, shallow-merges the object into the current config and POSTs it back. Use this to enable subtitle burn-in (needed for Samsung Tizen, which can't render ASS/SSA) by setting fields like `EncodingThreadCount`, `HardwareAccelerationType`, or codec lists. The current config is always written as a resource so you can inspect field names via `swamp data query`.",
      arguments: z.object({
        patch: z
          .record(z.string(), z.unknown())
          .optional()
          .describe(
            "Shallow merge into the current EncodingOptions object. Pass field names exactly as Jellyfin's API uses them (PascalCase). Omit to just read.",
          ),
      }),
      // deno-lint-ignore no-explicit-any
      execute: async (args: any, context: any) => {
        const { jellyfinUrl, jellyfinApiKey } = context.globalArgs;
        const url = jellyfinUrl.replace(/\/+$/, "");
        const hdrs = headers(jellyfinApiKey);

        const getResp = await fetch(`${url}/System/Configuration/encoding`, {
          headers: hdrs,
        });
        if (!getResp.ok) {
          const body = await getResp.text();
          throw new Error(
            `Failed to read encoding config: ${getResp.status} ${body}`,
          );
        }
        const current = await getResp.json();

        let action: "read" | "updated" = "read";
        let finalConfig = current;

        if (args.patch && Object.keys(args.patch).length > 0) {
          const merged = { ...current, ...args.patch };
          const postResp = await fetch(
            `${url}/System/Configuration/encoding`,
            {
              method: "POST",
              headers: { ...hdrs, "Content-Type": "application/json" },
              body: JSON.stringify(merged),
            },
          );
          if (!postResp.ok) {
            const body = await postResp.text();
            throw new Error(
              `Failed to update encoding config: ${postResp.status} ${body}`,
            );
          }
          action = "updated";
          finalConfig = merged;
          context.logger.info`Updated EncodingOptions: ${
            Object.keys(args.patch).join(", ")
          }`;
        } else {
          context.logger.info`Read EncodingOptions (${
            Object.keys(current).length
          } fields)`;
        }

        const handle = await context.writeResource(
          "encodingConfig",
          "current",
          {
            timestamp: new Date().toISOString(),
            action,
            config: finalConfig,
          },
        );

        return { dataHandles: [handle] };
      },
    },
  },
  upgrades: [
    {
      fromVersion: "2026.03.30.1",
      toVersion: "2026.04.11.1",
      description: "Add reindex method; no schema changes",
      upgradeAttributes: (old: unknown) => old,
    },
    {
      fromVersion: "2026.04.11.1",
      toVersion: "2026.04.11.2",
      description: "Add series method and series resource spec",
      upgradeAttributes: (old: unknown) => old,
    },
    {
      fromVersion: "2026.04.11.2",
      toVersion: "2026.04.26.1",
      description:
        "Add encoding_config method + encodingConfig resource spec for managing transcoding settings",
      upgradeAttributes: (old: unknown) => old,
    },
    {
      fromVersion: "2026.04.26.1",
      toVersion: "2026.07.14.1",
      description:
        "Add reindex_recent + scan_status methods, reindexWatermark resource, and libraryMap/organizeSource globalArgs; no schema changes to existing resources",
      upgradeAttributes: (old: unknown) => old,
    },
    {
      fromVersion: "2026.07.14.1",
      toVersion: "2026.08.12.1",
      description:
        "identify mappings accept an object pinning explicit provider IDs (imdb/tmdb/tvdb/anidb/anilist/mal, plus optional name/year); pinned lookups refuse to apply a result that lacks those IDs instead of falling back to the first hit. String mappings behave as before; no schema changes",
      upgradeAttributes: (old: unknown) => old,
    },
  ],
};

async function refreshLibrary(
  url: string,
  hdrs: Record<string, string>,
  libraryId: string,
  opts: { mode: string; replaceMetadata: boolean; replaceImages: boolean },
): Promise<void> {
  const params = new URLSearchParams({
    Recursive: "true",
    MetadataRefreshMode: opts.mode,
    ImageRefreshMode: opts.mode,
    ReplaceAllMetadata: String(opts.replaceMetadata),
    ReplaceAllImages: String(opts.replaceImages),
  });
  const resp = await fetch(`${url}/Items/${libraryId}/Refresh?${params}`, {
    method: "POST",
    headers: hdrs,
  });
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(
      `Reindex failed for library ${libraryId}: ${resp.status} ${body}`,
    );
  }
}

// Wait for Jellyfin to settle after a refresh. Truly waits out a running
// RefreshLibrary scheduled task (the full-scan path); for item-tree refreshes,
// which Jellyfin never surfaces as a task, applies a bounded idle settle.
async function waitForScanSettle(
  url: string,
  hdrs: Record<string, string>,
  opts: { settleSeconds: number; timeoutSeconds: number; pollSeconds: number },
): Promise<{ settled: boolean; detail: string; waited: number }> {
  const deadline = Date.now() + opts.timeoutSeconds * 1000;
  const start = Date.now();
  let state = "Unknown";
  let idleSince: number | null = null;
  let sawRunning = false;

  while (Date.now() < deadline) {
    const resp = await fetch(`${url}/ScheduledTasks`, { headers: hdrs });
    if (!resp.ok) {
      throw new Error(
        `Failed to query scheduled tasks: ${resp.status} ${await resp.text()}`,
      );
    }
    const tasks = await resp.json();
    // deno-lint-ignore no-explicit-any
    const scan = (tasks ?? []).find((t: any) => t.Key === "RefreshLibrary");
    state = scan?.State ?? "Unknown";

    if (state === "Running") {
      sawRunning = true;
      idleSince = null;
    } else {
      if (idleSince === null) idleSince = Date.now();
      if (Date.now() - idleSince >= opts.settleSeconds * 1000) break;
    }
    await new Promise((r) => setTimeout(r, opts.pollSeconds * 1000));
  }

  const settled = idleSince !== null &&
    Date.now() - idleSince >= opts.settleSeconds * 1000;
  const waited = Math.round((Date.now() - start) / 1000);
  const detail = settled
    ? `Settled after ~${waited}s${
      sawRunning
        ? " (waited out a running library scan)"
        : " (bounded settle; item refresh has no completion signal)"
    }`
    : `scan_status timed out after ${opts.timeoutSeconds}s (last task state=${state}${
      sawRunning ? ", a scan was still running" : ""
    })`;
  return { settled, detail, waited };
}

async function getItemCount(
  url: string,
  hdrs: Record<string, string>,
  libraryId: string,
  itemType: string,
): Promise<number> {
  const params = new URLSearchParams({
    ParentId: libraryId,
    IncludeItemTypes: itemType,
    Recursive: "true",
    Limit: "0",
  });
  const resp = await fetch(`${url}/Items?${params}`, { headers: hdrs });
  if (!resp.ok) return 0;
  const data = await resp.json();
  return data.TotalRecordCount ?? 0;
}
