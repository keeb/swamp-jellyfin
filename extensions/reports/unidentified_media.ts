export const report = {
  name: "@keeb/unidentified-media",
  description:
    "Summarize Jellyfin items with no metadata provider match after library scan",
  scope: "workflow" as const,
  labels: ["jellyfin", "audit"],
  // deno-lint-ignore no-explicit-any
  execute: async (context: any) => {
    const status = context.workflowStatus;
    let modelName = "jellyfin";

    // Walk every step in the workflow run looking for unidentified-shaped data
    let items: {
      name: string;
      path: string;
      type: string;
      library: string;
      parentName?: string;
    }[] = [];
    let count = 0;

    outer: for (const step of context.stepExecutions ?? []) {
      for (const handle of step.dataHandles ?? []) {
        const content = await context.dataRepository.getContent(
          step.modelType,
          step.modelId,
          handle.name,
        );
        if (!content) continue;
        try {
          const data = JSON.parse(new TextDecoder().decode(content));
          if (data.items) {
            items = data.items;
            count = data.count ?? items.length;
            modelName = step.modelName;
            break outer;
          }
        } catch {
          /* skip */
        }
      }
    }

    // Group by type
    const byType = new Map<string, typeof items>();
    for (const item of items) {
      const t = item.type;
      if (!byType.has(t)) byType.set(t, []);
      byType.get(t)!.push(item);
    }

    // Group by library within each type
    let md = `# Unidentified Media: ${modelName} (${status})\n\n`;
    md +=
      `**${count} items** could not be matched to any metadata provider (TMDB/TVDB/IMDB).\n\n`;

    if (count === 0) {
      md += "All items are identified.\n";
    }

    for (const [type, typeItems] of byType) {
      md += `## ${type} (${typeItems.length})\n\n`;

      // Group by library
      const byLib = new Map<string, typeof items>();
      for (const item of typeItems) {
        const lib = item.library || "unknown";
        if (!byLib.has(lib)) byLib.set(lib, []);
        byLib.get(lib)!.push(item);
      }

      for (const [lib, libItems] of byLib) {
        md += `### ${lib}\n\n`;
        md += "| Name | Path |\n";
        md += "| ---- | ---- |\n";
        for (const item of libItems) {
          md += `| ${item.name} | \`${item.path}\` |\n`;
        }
        md += "\n";
      }
    }

    return {
      markdown: md,
      json: {
        status,
        count,
        byType: Object.fromEntries(
          [...byType].map(([type, typeItems]) => [
            type,
            typeItems.map((i) => ({
              name: i.name,
              path: i.path,
              library: i.library,
            })),
          ]),
        ),
      },
    };
  },
};
