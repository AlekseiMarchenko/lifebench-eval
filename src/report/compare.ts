import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { LifeBenchResult } from "../types.js";

function pct(n: number): string {
  return (n * 100).toFixed(1) + "%";
}

// Published results from LifeBench paper
const PAPER_RESULTS: Record<string, Record<string, number>> = {
  MemOS: {
    overall: 0.5522,
  },
  Hindsight: {
    overall: 0.4099,
  },
};

export function generateComparison(outputDir: string): string {
  // Discover all provider results
  const providers: LifeBenchResult[] = [];

  if (!existsSync(outputDir)) return "No results found.";

  for (const entry of readdirSync(outputDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const resultsPath = join(outputDir, entry.name, "results.json");
    if (existsSync(resultsPath)) {
      try {
        providers.push(JSON.parse(readFileSync(resultsPath, "utf-8")) as LifeBenchResult);
      } catch {}
    }
  }

  if (providers.length === 0) return "No results found. Run evaluations first.";

  const lines: string[] = [];
  lines.push("# LifeBench Comparison Report");
  lines.push("");
  lines.push(`**Generated:** ${new Date().toLocaleDateString()}`);
  lines.push("");

  // Build comparison table header
  const providerNames = providers.map((p) => p.provider);
  const allNames = [...providerNames, ...Object.keys(PAPER_RESULTS).filter((n) => !providerNames.includes(n))];

  lines.push("## Overall Accuracy");
  lines.push("");
  const header = ["| Category", ...allNames.map((n) => `| ${n}`), "|"].join(" ");
  const divider = ["|---", ...allNames.map(() => "|---"), "|"].join("");
  lines.push(header);
  lines.push(divider);

  // Category rows
  const categories = [
    "Information Extraction",
    "Multi-hop reasoning",
    "Temporal and Knowledge Updating",
    "Nondeclarative",
    "Unanswerable",
  ];

  for (const cat of categories) {
    const cells = allNames.map((name) => {
      const p = providers.find((r) => r.provider === name);
      if (p) {
        const catScore = p.categories.find((c) => c.category === cat);
        return catScore ? pct(catScore.accuracy) : "—";
      }
      // Paper results don't have per-category breakdown
      return "—";
    });
    lines.push(`| ${cat} | ${cells.join(" | ")} |`);
  }

  // Overall row
  const overallCells = allNames.map((name) => {
    const p = providers.find((r) => r.provider === name);
    if (p) return `**${pct(p.overall.accuracy)}**`;
    const paper = PAPER_RESULTS[name];
    if (paper?.overall) return `**${pct(paper.overall)}** (paper)`;
    return "—";
  });
  lines.push(`| **Overall** | ${overallCells.join(" | ")} |`);
  lines.push("");

  // F1 table
  lines.push("## Average F1 Score");
  lines.push("");
  const f1Header = ["| Provider", "| F1", "|"].join(" ");
  lines.push(f1Header);
  lines.push("|---|---|");
  for (const p of providers) {
    lines.push(`| ${p.provider} | ${p.overall.avgF1.toFixed(3)} |`);
  }
  lines.push("");

  // Metadata comparison
  lines.push("## Benchmark Configuration");
  lines.push("");
  lines.push("| Property | " + providers.map((p) => p.provider).join(" | ") + " |");
  lines.push("|---|" + providers.map(() => "---").join("|") + "|");
  lines.push("| Users | " + providers.map((p) => p.users.length).join(" | ") + " |");
  lines.push("| Questions | " + providers.map((p) => p.overall.totalQuestions).join(" | ") + " |");
  lines.push("| Top-K | " + providers.map((p) => p.topK).join(" | ") + " |");
  lines.push("| Answer Model | " + providers.map((p) => p.answerModel).join(" | ") + " |");
  lines.push("| Judge Model | " + providers.map((p) => p.judgeModel).join(" | ") + " |");
  lines.push("");

  return lines.join("\n");
}
