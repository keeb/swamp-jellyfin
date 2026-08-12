# @keeb/jellyfin

A swamp extension that integrates a Jellyfin media server into swamp workflows.
It exposes the `@keeb/jellyfin` model type for library inventory, full library
refresh, duplicate/misplacement auditing, unidentified media detection, and
applying matches through the Jellyfin RemoteSearch API. Two bundled reports
(`@keeb/library-audit` and `@keeb/unidentified-media`) turn model output into
human-readable markdown summaries.

## Installation

```sh
swamp extension install @keeb/jellyfin
```

## Usage

Add a model definition that points at your Jellyfin server and an API key, then
run the `inventory`, `audit`, or `unidentified` methods:

```yaml
models:
  - name: media
    type: "@keeb/jellyfin"
    globalArguments:
      jellyfinUrl: "http://jellyfin.lan:8096"
      jellyfinApiKey: "${{ vault.jellyfin.apiKey }}"
```

```sh
swamp model method run media inventory
swamp model method run media audit
swamp model method run media unidentified --args '{"types":"Series,Movie"}'
```

The `identify` method applies metadata matches by name or path substring:

```sh
swamp model method run media identify \
  --args '{"mappings":"{\"dragonball-z-remastered\":\"Dragon Ball Z\"}","dryRun":true}'
```

## How it works

The model wraps a handful of Jellyfin HTTP endpoints (`/Library/VirtualFolders`,
`/Users/{id}/Items`, `/Items/RemoteSearch/{type}`) behind named methods. Each
method writes a structured resource (`inventory`, `audit`, `unidentified`,
`identification`, `scan`) into the swamp data repository, which downstream
reports and CEL expressions can reference with `data.latest(...)`. The audit
method classifies duplicate detections as either `true_duplicate` or
`shared_tmdb_id` by comparing production years, titles, and directory stems, so
distinct productions that share a TMDB ID are not flagged as issues.
