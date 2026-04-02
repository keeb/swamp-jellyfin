import { z } from "npm:zod@4";

const GlobalArgsSchema = z.object({
  jellyfinUrl: z.string().url().describe("Jellyfin server URL"),
  jellyfinApiKey: z
    .string()
    .describe("Jellyfin API key")
    .meta({ sensitive: true }),
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

function headers(apiKey: string): Record<string, string> {
  return { "X-Emby-Token": apiKey };
}

export const model = {
  type: "@keeb/jellyfin",
  version: "2026.03.30.1",
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
            'JSON object mapping current item name (or path substring) to search query, e.g. {"dragonball-z-remastered":"Dragon Ball Z"}. If the key contains "/" it matches against the item path instead of name.',
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

        const mappings: Record<string, string> = JSON.parse(args.mappings);
        // deno-lint-ignore no-explicit-any
        const results: any[] = [];
        let matched = 0;
        let failed = 0;

        for (const [currentKey, searchQuery] of Object.entries(mappings)) {
          const matchByPath = currentKey.includes("/");
          context.logger
            .info`Identifying "${currentKey}" → searching "${searchQuery}" (match by ${
            matchByPath ? "path" : "name"
          })`;

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

          // Search metadata providers
          const searchResp = await fetch(
            `${url}/Items/RemoteSearch/${itemType}`,
            {
              method: "POST",
              headers: { ...hdrs, "Content-Type": "application/json" },
              body: JSON.stringify({
                SearchInfo: { Name: searchQuery },
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

          const best = searchResults[0];
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
  },
};

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
