import type { LifeBenchResult } from "../types.js";

function pct(n: number): string {
  return (n * 100).toFixed(1) + "%";
}

export function generateMarkdown(result: LifeBenchResult): string {
  const lines: string[] = [];

  lines.push(`# LifeBench Results: ${result.provider}`);
  lines.push("");
  lines.push(`**Date:** ${new Date(result.timestamp).toLocaleDateString()}`);
  lines.push(`**Users:** ${result.users.join(", ")}`);
  lines.push(`**Answer Model:** ${result.answerModel}`);
  lines.push(`**Judge Model:** ${result.judgeModel}`);
  lines.push(`**Top-K Retrieval:** ${result.topK}`);
  lines.push("");

  // Overall
  lines.push(`## Overall Score: ${pct(result.overall.accuracy)}`);
  lines.push("");
  lines.push(`- **Correct:** ${result.overall.correctQuestions} / ${result.overall.totalQuestions}`);
  lines.push(`- **Average F1:** ${result.overall.avgF1.toFixed(3)}`);
  lines.push("");

  // Category breakdown
  lines.push("## Per-Category Accuracy");
  lines.push("");
  lines.push("| Category | Correct | Total | Accuracy | Avg F1 |");
  lines.push("|----------|---------|-------|----------|--------|");
  for (const cat of result.categories) {
    lines.push(
      `| ${cat.category} | ${cat.correct} | ${cat.total} | ${pct(cat.accuracy)} | ${cat.avgF1.toFixed(3)} |`
    );
  }
  lines.push("");

  // Per-user breakdown
  if (result.perUser.length > 1) {
    lines.push("## Per-User Accuracy");
    lines.push("");
    lines.push("| User | Questions | Accuracy |");
    lines.push("|------|-----------|----------|");
    for (const u of result.perUser) {
      lines.push(`| ${u.userId} | ${u.totalQuestions} | ${pct(u.accuracy)} |`);
    }
    lines.push("");
  }

  // Meta
  lines.push("## Benchmark Metadata");
  lines.push("");
  lines.push(`- **Total Store Operations:** ${result.meta.totalStoreOps.toLocaleString()}`);
  lines.push(`- **Total Search Operations:** ${result.meta.totalSearchOps.toLocaleString()}`);
  lines.push(`- **Total LLM Calls:** ${result.meta.totalLLMCalls.toLocaleString()}`);
  lines.push(`- **Ingestion Time:** ${(result.meta.ingestionTimeMs / 1000).toFixed(0)}s`);
  lines.push(`- **Evaluation Time:** ${(result.meta.evaluationTimeMs / 1000).toFixed(0)}s`);
  lines.push("");

  return lines.join("\n");
}
