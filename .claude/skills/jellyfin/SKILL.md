---
name: jellyfin
description: >
  Manage a Jellyfin media server with the @keeb/jellyfin swamp extension —
  inventory libraries, trigger rescans, audit for duplicates and misplaced
  content, find unidentified media (no TMDB/TVDB/IMDB match), and apply
  metadata matches via the Jellyfin RemoteSearch API. Provides the
  @keeb/jellyfin model plus the @keeb/library-audit and
  @keeb/unidentified-media reports. Use when the user wants to "audit
  jellyfin", "scan jellyfin libraries", "find duplicate movies/shows on
  jellyfin", "find unidentified media", "rescan jellyfin", "match jellyfin
  metadata", "identify jellyfin items", "list jellyfin libraries", "jellyfin
  inventory", "library audit", "fix jellyfin duplicates", "find misplaced
  shows", or any task involving the Jellyfin server, library health,
  duplicate detection, or media identification.
---

# Jellyfin Extension

The `@keeb/jellyfin` extension wraps the Jellyfin HTTP API as a swamp model so
library inventory, audits, rescans, and metadata identification become
reproducible model methods with structured outputs.

## Model

**Type:** `@keeb/jellyfin`

### Global arguments

Both are required on every model instance:

- `jellyfinUrl` — Jellyfin server URL (e.g. `https://jellyfin.example.com`)
- `jellyfinApiKey` — Jellyfin API key, marked sensitive (store in a vault)

### Methods

| Method         | Purpose                                                                                                       | Arguments                                       |
| -------------- | ------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| `refresh`      | Triggers a full library rescan on the server. Writes a `scan` resource with `status: "started"`.              | none                                            |
| `inventory`    | Walks every virtual folder and counts series/episodes/movies per library. Writes the `inventory` resource.    | none                                            |
| `unidentified` | Finds items with zero metadata provider IDs (no TMDB/TVDB/IMDB). Writes the `unidentified` resource.          | `types` (string, default `"Series,Movie"`)      |
| `audit`        | Full library audit — duplicate series/movies (by TMDB ID) and misplaced items (by disk path). Writes `audit`. | none                                            |
| `identify`     | Looks up unidentified items via Jellyfin's RemoteSearch and applies the best match. Writes `identification`.  | `mappings` (JSON string), `dryRun` (bool=false) |

### Resources

- `inventory` — `{ timestamp, libraries[], totals }` — infinite lifetime, GC=10
- `scan` — `{ timestamp, status, detail? }` — 7d lifetime, GC=20
- `unidentified` — `{ timestamp, items[], count }` — infinite, GC=10
- `audit` — duplicates + misplacements + totals — infinite, GC=10
- `identification` — `{ timestamp, results[], matched, failed }` — infinite,
  GC=10

## Reports

Both reports are scoped to a single method execution and read their data
straight off the method's data handles.

- `@keeb/library-audit` — Hoarder-style markdown summary of the `audit`
  resource. Splits true duplicates from "shared TMDB ID" entries (different
  productions that legitimately share an ID), lists misplaced items as a table.
  Run after the `audit` method.
- `@keeb/unidentified-media` — Markdown table of unidentified items grouped by
  type then library. Run after the `unidentified` method.

The model declares both reports in its `reports: [...]` list, so they auto-run
when their method completes (depending on the model definition's report
configuration).

## Method behavior and gotchas

### `refresh`

POSTs `/Library/Refresh`. Returns immediately after the server accepts the
request — the scan resource only records that a refresh was _triggered_, not
that it finished. Wait before running `inventory`/`audit` if you need fresh
counts.

### `inventory`

Reads `/Library/VirtualFolders` then issues a count query per library. Only
counts `Series`+`Episode` for `tvshows` collections and `Movie` for `movies`
collections — other collection types report zeros.

### `unidentified`

- Resolves the library name by matching the item's disk `Path` against the
  library's `Locations` (first matching prefix wins, falls back to `"unknown"`).
- Uses the **first user** returned by `/Users` because the `/Users/{id}/Items`
  endpoint is the one that returns `ProviderIds` correctly. If the first user
  has restricted library access, items will be missed.
- An item is "unidentified" when `ProviderIds` is empty — any single TMDB/TVDB
  /IMDB ID is enough to mark it identified.
- Pages 200 items at a time per type.

### `audit`

- Groups series and movies by `ProviderIds.Tmdb`. Only items with a TMDB ID
  participate — purely unidentified content is invisible to this method.
- Distinguishes `true_duplicate` from `shared_tmdb_id`:
  - **Different `ProductionYear`** across entries → `shared_tmdb_id` (different
    adaptations).
  - **Different names** with distinct directory stems that don't share a common
    prefix → `shared_tmdb_id`.
  - Otherwise → `true_duplicate`.
- Misplacement detection is **path-substring based**, not content-based:
  - `/anime/` in path but library name lacks `anime`/`weeb` → flagged.
  - `/shows/` in path but library name contains `anime`/`weeb` → flagged.
  - `/chinese/` in path but library name lacks `chinese` → flagged.
- These rules are hard-coded for the author's directory layout. If your library
  uses different conventions, the `misplacedItems` list will be empty or noisy —
  duplicate detection still works regardless.

### `identify`

- `mappings` is a JSON **string** (not a YAML object) — pass it as a literal
  JSON-encoded string.
- A mapping key containing `/` is treated as a path-substring match; otherwise
  it's a case-insensitive exact-name match against `Name`.
- Tries `Series` first, then `Movie`. Bails after the first match.
- Calls `POST /Items/RemoteSearch/{type}` then applies the **first** result via
  `POST /Items/RemoteSearch/Apply/{id}?ReplaceAllMetadata=true`. There is no
  ranking — if Jellyfin's first result is wrong, set `dryRun: true` first and
  inspect the `identification` resource.

## Typical usage

### Define a model instance

```yaml
# definition.yaml
name: my-jellyfin
type: "@keeb/jellyfin"
globalArguments:
  jellyfinUrl: "https://jellyfin.example.com"
  jellyfinApiKey: "{{ vault('jellyfin', 'apiKey') }}"
```

Store the API key in a vault first:

```bash
swamp vault set jellyfin apiKey
```

### Audit the library

```bash
swamp model method run my-jellyfin audit
swamp report run my-jellyfin --report @keeb/library-audit
```

### Find and fix unidentified media

```bash
# 1. List what's unidentified
swamp model method run my-jellyfin unidentified
swamp report run my-jellyfin --report @keeb/unidentified-media

# 2. Dry-run a batch of identifications
swamp model method run my-jellyfin identify \
  --arg mappings='{"dragonball-z-remastered":"Dragon Ball Z","/anime/one-piece-log":"One Piece"}' \
  --arg dryRun=true

# 3. Apply for real
swamp model method run my-jellyfin identify \
  --arg mappings='{"dragonball-z-remastered":"Dragon Ball Z"}'
```

### Reading data with CEL

```text
data.latest("my-jellyfin", "inventory").attributes.totals.series
data.latest("my-jellyfin", "audit").attributes.duplicateSeries
data.latest("my-jellyfin", "unidentified").attributes.count
```

## Workflow snippet

```yaml
jobs:
  - name: nightly-jellyfin-health
    steps:
      - name: refresh
        model: my-jellyfin
        method: refresh
      - name: inventory
        model: my-jellyfin
        method: inventory
        dependsOn: [refresh]
      - name: audit
        model: my-jellyfin
        method: audit
        dependsOn: [inventory]
      - name: unidentified
        model: my-jellyfin
        method: unidentified
        dependsOn: [inventory]
```

## Related skills

When working on this extension itself (editing `extensions/models/jellyfin.ts`
or the report files), load the `swamp-extension-model` and `swamp-report`
skills. For wiring the model into workflows, use `swamp-workflow`. For storing
the API key, use `swamp-vault`.
