/**
 * Token-overlap F1 scorer (LoCoMo-style).
 * Normalizes text, computes precision/recall/F1 over token sets.
 */

const ARTICLES = new Set(["a", "an", "the"]);
const PUNCT = /[^\w\s]/g;

function normalize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(PUNCT, " ")
    .split(/\s+/)
    .filter((t) => t.length > 0 && !ARTICLES.has(t));
}

export function computeF1(predicted: string, groundTruth: string): number {
  const predTokens = normalize(predicted);
  const truthTokens = normalize(groundTruth);

  if (truthTokens.length === 0 && predTokens.length === 0) return 1;
  if (truthTokens.length === 0 || predTokens.length === 0) return 0;

  const truthSet = new Set(truthTokens);
  const predSet = new Set(predTokens);

  let common = 0;
  for (const t of predSet) {
    if (truthSet.has(t)) common++;
  }

  if (common === 0) return 0;

  const precision = common / predSet.size;
  const recall = common / truthSet.size;
  return (2 * precision * recall) / (precision + recall);
}
