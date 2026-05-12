// Workflow-scope reports receive step.modelType as a string, but
// dataRepository.getContent wants a ModelType class instance. Build a
// minimal shim that exposes the two methods getContentPath actually calls.
function asModelType(raw: string) {
  const normalized = raw
    .toLowerCase()
    .replace(/::/g, "/")
    .replace(/\s+/g, "/")
    .replace(/\./g, "/")
    .replace(/\/+/g, "/")
    .replace(/^\/|\/$/g, "");
  return {
    raw,
    normalized,
    toDirectoryPath: () => normalized,
    // deno-lint-ignore no-explicit-any
    equals: (other: any) => other?.normalized === normalized,
  };
}

export const report = {
  name: "@keeb/library-audit",
  description:
    "Hoarder's evaluation of Jellyfin library health — duplicates, misplacements, structural issues",
  scope: "workflow" as const,
  labels: ["jellyfin", "audit", "hoarder"],
  // deno-lint-ignore no-explicit-any
  execute: async (context: any) => {
    const status = context.workflowStatus;

    // Walk every step in the workflow run looking for audit-shaped data
    // deno-lint-ignore no-explicit-any
    let audit: any = null;
    outer: for (const step of context.stepExecutions ?? []) {
      const type = asModelType(step.modelType);
      for (const handle of step.dataHandles ?? []) {
        const content = await context.dataRepository.getContent(
          type,
          step.modelId,
          handle.name,
        );
        if (!content) continue;
        try {
          const data = JSON.parse(new TextDecoder().decode(content));
          if (data.duplicateSeries !== undefined) {
            audit = data;
            break outer;
          }
        } catch {
          /* skip */
        }
      }
    }

    if (!audit) {
      return {
        markdown:
          "# Library Audit\n\nNo audit data found. Run the `audit` method first.\n",
        json: { error: "no_audit_data" },
      };
    }

    const {
      duplicateSeries,
      duplicateMovies,
      misplacedItems,
      totalSeries,
      totalMovies,
    } = audit;

    // deno-lint-ignore no-explicit-any
    const trueDupeSeries = duplicateSeries.filter((d: any) =>
      d.kind === "true_duplicate"
    );
    // deno-lint-ignore no-explicit-any
    const sharedTmdbSeries = duplicateSeries.filter((d: any) =>
      d.kind === "shared_tmdb_id"
    );
    // deno-lint-ignore no-explicit-any
    const trueDupeMovies = duplicateMovies.filter((d: any) =>
      d.kind === "true_duplicate"
    );
    // deno-lint-ignore no-explicit-any
    const sharedTmdbMovies = duplicateMovies.filter((d: any) =>
      d.kind === "shared_tmdb_id"
    );

    const totalIssues = trueDupeSeries.length + trueDupeMovies.length +
      misplacedItems.length;

    // Build markdown through the Hoarder's lens
    let md = `# Library Audit — The Hoarder's Evaluation\n\n`;
    md +=
      `**${totalSeries} series, ${totalMovies} movies** across all Jellyfin libraries.\n`;
    md += `**${totalIssues} issues found.**`;
    if (sharedTmdbSeries.length + sharedTmdbMovies.length > 0) {
      md += ` (${
        sharedTmdbSeries.length + sharedTmdbMovies.length
      } shared-TMDB-ID entries are distinct content, not issues.)`;
    }
    md += `\n\n`;

    if (totalIssues === 0) {
      md +=
        `The library is clean. Every item has a single entry, lives in the correct library, and the tree is unambiguous.\n`;
    }

    // True duplicate series
    if (trueDupeSeries.length > 0) {
      md += `## Duplicate Series (${trueDupeSeries.length})\n\n`;
      md +=
        `The Hoarder says: *"One show, one directory."* These are the same content in multiple locations.\n\n`;

      for (const dupe of trueDupeSeries) {
        md += `### ${dupe.name} (TMDB ${dupe.tmdbId})\n\n`;
        for (const entry of dupe.entries) {
          const yearStr = entry.year ? ` (${entry.year})` : "";
          md += `- \`${entry.path}\`${yearStr} — ${entry.library}\n`;
        }
        md += `\n`;
      }
    }

    // True duplicate movies
    if (trueDupeMovies.length > 0) {
      md += `## Duplicate Movies (${trueDupeMovies.length})\n\n`;
      md +=
        `Same movie, multiple files. Keep the better encode, delete the rest.\n\n`;

      for (const dupe of trueDupeMovies) {
        md += `### ${dupe.name} (TMDB ${dupe.tmdbId})\n\n`;
        for (const entry of dupe.entries) {
          const yearStr = entry.year ? ` (${entry.year})` : "";
          md += `- \`${entry.path}\`${yearStr}\n`;
        }
        md += `\n`;
      }
    }

    // Misplaced items
    if (misplacedItems.length > 0) {
      md += `## Misplaced Items (${misplacedItems.length})\n\n`;
      md +=
        `The Hoarder says: *"Group by what it is, not when I got it."* These items are in the wrong library.\n\n`;
      md += `| Name | Current Library | Issue | Path |\n`;
      md += `| ---- | --------------- | ----- | ---- |\n`;
      for (const item of misplacedItems) {
        md +=
          `| ${item.name} | ${item.currentLibrary} | ${item.issue} | \`${item.path}\` |\n`;
      }
      md += `\n`;
    }

    // Shared TMDB ID (informational, not issues)
    if (sharedTmdbSeries.length + sharedTmdbMovies.length > 0) {
      md += `## Shared TMDB IDs (not issues)\n\n`;
      md +=
        `These share a TMDB ID but are distinct content (different years, adaptations, or productions).\n\n`;

      for (const item of [...sharedTmdbSeries, ...sharedTmdbMovies]) {
        md += `- **${item.name}** (TMDB ${item.tmdbId}) — ${item.reason}\n`;
      }
      md += `\n`;
    }

    return {
      markdown: md,
      json: {
        status,
        totalSeries,
        totalMovies,
        totalIssues,
        duplicateSeries: trueDupeSeries.length,
        duplicateMovies: trueDupeMovies.length,
        sharedTmdbSeries: sharedTmdbSeries.length,
        sharedTmdbMovies: sharedTmdbMovies.length,
        misplacedItems: misplacedItems.length,
        details: {
          duplicateSeries: trueDupeSeries,
          duplicateMovies: trueDupeMovies,
          sharedTmdb: [...sharedTmdbSeries, ...sharedTmdbMovies],
          misplacedItems,
        },
      },
    };
  },
};
