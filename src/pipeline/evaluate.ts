import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type {
  MemoryAdapter,
  LifeBenchQuestion,
  QuestionResult,
  CategoryScore,
  LifeBenchResult,
  QuestionCategory,
  QUESTION_CATEGORIES,
} from "../types.js";
import { callLLM } from "../utils/llm.js";
import { withRetry } from "../utils/retry.js";
import { judgeAnswer } from "../scoring/llm-judge.js";
import { computeF1 } from "../scoring/f1.js";

// --- Date extraction from questions ---

const MONTH_MAP: Record<string, string> = {
  january: "01", february: "02", march: "03", april: "04",
  may: "05", june: "06", july: "07", august: "08",
  september: "09", october: "10", november: "11", december: "12",
  jan: "01", feb: "02", mar: "03", apr: "04",
  jun: "06", jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12",
  "spring festival": "01", // Chinese New Year, late Jan/early Feb
};

interface DateRange {
  dateFrom?: string;
  dateTo?: string;
}

/**
 * Extract date range from a question to narrow memory retrieval.
 * Returns ISO date strings for the CI API's date_from/date_to params.
 */
function extractDateRange(question: string): DateRange {
  const q = question.toLowerCase();
  const year = "2025"; // LifeBench data year

  // Specific date: "January 25, 2025" or "January 25"
  const specificDate = q.match(
    /(?:on\s+)?(\w+)\s+(\d{1,2})(?:st|nd|rd|th)?,?\s*(?:2025)?/
  );
  if (specificDate) {
    const month = MONTH_MAP[specificDate[1]];
    if (month) {
      const day = specificDate[2].padStart(2, "0");
      // Widen to ±7 days for context
      const center = new Date(`${year}-${month}-${day}`);
      const from = new Date(center.getTime() - 7 * 86400000);
      const to = new Date(center.getTime() + 7 * 86400000);
      return {
        dateFrom: from.toISOString(),
        dateTo: to.toISOString(),
      };
    }
  }

  // "in January" / "in mid-January" / "in late April" / "In October,"
  const monthPatterns = [
    /(?:in\s+(?:early|mid|late)\s*[-]?\s*)(\w+)/i,
    /^in\s+(\w+)[,\s]/i,
    /in\s+(\w+)\s+(?:2025|this year)/i,
    /during\s+(?:the\s+)?(?:\w+\s+)*?(?:in\s+)?(\w+)/i,
  ];
  for (const pat of monthPatterns) {
    const monthRef = q.match(pat);
    if (monthRef) {
      const month = MONTH_MAP[monthRef[1].toLowerCase()];
      if (month) {
        const mi = parseInt(month);
        return {
          dateFrom: `${year}-${month}-01T00:00:00Z`,
          dateTo: `${year}-${String(mi === 12 ? 12 : mi + 1).padStart(2, "0")}-${mi === 12 ? "31" : "01"}T00:00:00Z`,
        };
      }
    }
  }

  // Season references
  if (q.includes("spring festival") || q.includes("chinese new year") || q.includes("lunar new year")) {
    return { dateFrom: `${year}-01-20T00:00:00Z`, dateTo: `${year}-02-15T00:00:00Z` };
  }

  // "this year" / "in 2025"
  if (q.includes("this year") || q.includes("in 2025")) {
    return { dateFrom: `${year}-01-01T00:00:00Z`, dateTo: `${year}-12-31T23:59:59Z` };
  }

  return {};
}

const ANSWER_SYSTEM_PROMPT = `You are answering questions about a person's life based on their personal data records (messages, calendar, health data, notes, calls, photos, fitness data, etc.).

Rules:
- Answer based on the provided memories. Do not make up information.
- Prioritize facts directly stated in the memories. If the answer is not stated verbatim, derive it from sufficient evidence: paraphrase, date arithmetic, counting distinct events, or selecting the latest value. Do not guess from weak clues.
- If the evidence is missing, contradictory, or only partially relevant, say "The information is not available in the provided records."
- Be concise and direct. Give the shortest specific answer.
- For numerical questions (counts, dates, durations), provide the specific number or date.
- For counting questions: count unique events or items only. If two memories refer to the same event, count it once. Use date, location, and details to decide whether mentions are the same event.
- For yes/no questions, start with Yes or No.
- Use the most recent memory only when the question asks about the current or latest state. If the question asks about a previous or earlier state, answer with that earlier state.
- Preferences may be implied. If a memory shows someone loved X, frequently used Y, or chose Z over alternatives, that indicates a preference.`;

export interface EvaluateOptions {
  adapter: MemoryAdapter;
  questions: LifeBenchQuestion[];
  userId: string;
  provider: string;
  topK: number;
  answerModel: string;
  judgeModel: string;
  outputDir: string;
  verbose: boolean;
  resume: boolean;
}

export interface EvaluateResult {
  results: QuestionResult[];
  durationMs: number;
}

function loadExistingResults(path: string): QuestionResult[] {
  if (!existsSync(path)) return [];
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as QuestionResult[];
  } catch {
    return [];
  }
}

export async function evaluateUser(opts: EvaluateOptions): Promise<EvaluateResult> {
  const {
    adapter,
    questions,
    userId,
    provider,
    topK,
    answerModel,
    judgeModel,
    outputDir,
    verbose,
    resume,
  } = opts;

  const resultsDir = join(outputDir, provider, userId);
  mkdirSync(resultsDir, { recursive: true });
  const resultsPath = join(resultsDir, "question-results.json");

  // Resume from existing results
  const existing = resume ? loadExistingResults(resultsPath) : [];
  const existingIndices = new Set(existing.map((r) => r.questionIndex));
  const results = [...existing];

  const agentId = `lifebench-v4-${userId}`;
  const start = Date.now();
  let evaluated = 0;

  console.log(
    `  Evaluating ${questions.length} questions for ${userId} (${existingIndices.size} already done)`
  );

  for (const q of questions) {
    if (existingIndices.has(q.index)) continue;

    // 1. Retrieve memories
    // Note: date filtering on created_at doesn't help for LifeBench because all
    // memories were ingested at the same time. The event dates are in the content text,
    // which BM25 handles via keyword matching. Date filtering is useful for real-time
    // usage where created_at matches the actual event date.
    const retrievalStart = Date.now();
    let retrievedMemories: string[] = [];
    try {
      const memories = await withRetry(
        () => adapter.search(q.question, { agentId, limit: topK }),
        { maxRetries: 2 }
      );
      retrievedMemories = memories.map((m) => m.content);
    } catch (err) {
      if (verbose) console.log(`    Search failed for Q${q.index}: ${err}`);
    }
    const retrievalLatencyMs = Date.now() - retrievalStart;

    // 2. Generate answer
    const context = retrievedMemories.length > 0
      ? retrievedMemories.map((m, i) => `${i + 1}. ${m}`).join("\n")
      : "No relevant memories found.";

    // Detect multiple-choice questions and add format instruction
    // Matches: A) B) C) D), A. B. C. D., (A) (B), A: B:, or answer is a single letter A-D
    const isMultipleChoice =
      /\b[A-D]\)\s/.test(q.question) ||
      /\b[A-D]\.\s/.test(q.question) ||
      /\([A-D]\)/.test(q.question) ||
      /\b[A-D]:\s/.test(q.question) ||
      /^[A-D]$/i.test(q.answer.trim());
    const mcInstruction = isMultipleChoice
      ? "\nIMPORTANT: This is a multiple-choice question. Respond with ONLY the letter (A, B, C, or D). Do not include any explanation, just the single letter."
      : "";

    const userPrompt = `Memories:\n${context}\n\nQuestion: ${q.question}${mcInstruction}\nAnswer:`;

    let predicted = "";
    let answerLatencyMs = 0;
    try {
      const answerRes = await callLLM(answerModel, ANSWER_SYSTEM_PROMPT, userPrompt);
      predicted = answerRes.content;
      answerLatencyMs = answerRes.latencyMs;

      // Post-process MC answers: extract just the letter if LLM included explanation
      if (isMultipleChoice) {
        const letterMatch = predicted.trim().match(/^([A-D])\b/i);
        if (letterMatch) {
          predicted = letterMatch[1].toUpperCase();
        }
      }
    } catch (err) {
      predicted = "Error generating answer.";
      if (verbose) console.log(`    Answer gen failed for Q${q.index}: ${err}`);
    }

    // 3. Judge answer
    const judgeResult = await judgeAnswer(q.question, q.answer, predicted, judgeModel);

    // 4. Compute F1
    const f1Score = computeF1(predicted, q.answer);

    const result: QuestionResult = {
      userId,
      questionIndex: q.index,
      question: q.question,
      groundTruth: q.answer,
      predicted,
      retrievedCount: retrievedMemories.length,
      category: q.category,
      correct: judgeResult.correct,
      f1Score,
      retrievalLatencyMs,
      answerLatencyMs,
      judgeLatencyMs: judgeResult.latencyMs,
    };

    results.push(result);
    evaluated++;

    // Save after each question (crash recovery)
    writeFileSync(resultsPath, JSON.stringify(results, null, 2));

    if (verbose) {
      const mark = result.correct ? "CORRECT" : "WRONG";
      console.log(
        `    Q${q.index} [${q.category}] ${mark} (F1=${f1Score.toFixed(2)}) — retrieved ${retrievedMemories.length}`
      );
    } else if (evaluated % 20 === 0) {
      console.log(`    Progress: ${evaluated + existingIndices.size}/${questions.length}`);
    }
  }

  const durationMs = Date.now() - start;
  console.log(`  Evaluation complete for ${userId}: ${evaluated} new, ${existingIndices.size} cached, ${(durationMs / 1000).toFixed(1)}s`);

  return { results, durationMs };
}

// ---- Aggregate results ----

export function aggregateResults(
  provider: string,
  allResults: QuestionResult[],
  users: string[],
  config: { answerModel: string; judgeModel: string; topK: number; totalStoreOps: number; ingestionTimeMs: number }
): LifeBenchResult {
  const categories: QuestionCategory[] = [
    "Information Extraction",
    "Multi-hop reasoning",
    "Temporal and Knowledge Updating",
    "Nondeclarative",
    "Unanswerable",
  ];

  function scoreCat(results: QuestionResult[], cat: QuestionCategory): CategoryScore {
    const catResults = results.filter((r) => r.category === cat);
    const correct = catResults.filter((r) => r.correct).length;
    const total = catResults.length;
    const avgF1 = total > 0 ? catResults.reduce((s, r) => s + r.f1Score, 0) / total : 0;
    return { category: cat, correct, total, accuracy: total > 0 ? correct / total : 0, avgF1 };
  }

  const overallCategories = categories.map((c) => scoreCat(allResults, c));
  const correctTotal = allResults.filter((r) => r.correct).length;
  const avgF1 = allResults.length > 0
    ? allResults.reduce((s, r) => s + r.f1Score, 0) / allResults.length
    : 0;

  const perUser = users.map((userId) => {
    const userResults = allResults.filter((r) => r.userId === userId);
    const userCats = categories.map((c) => scoreCat(userResults, c));
    const userCorrect = userResults.filter((r) => r.correct).length;
    return {
      userId,
      accuracy: userResults.length > 0 ? userCorrect / userResults.length : 0,
      totalQuestions: userResults.length,
      categories: userCats,
    };
  });

  return {
    provider,
    timestamp: new Date().toISOString(),
    version: "0.1.0",
    users,
    answerModel: config.answerModel,
    judgeModel: config.judgeModel,
    topK: config.topK,
    overall: {
      accuracy: allResults.length > 0 ? correctTotal / allResults.length : 0,
      avgF1,
      totalQuestions: allResults.length,
      correctQuestions: correctTotal,
    },
    categories: overallCategories,
    perUser,
    meta: {
      totalStoreOps: config.totalStoreOps,
      totalSearchOps: allResults.length,
      totalLLMCalls: allResults.length * 2, // answer + judge
      ingestionTimeMs: config.ingestionTimeMs,
      evaluationTimeMs: allResults.reduce(
        (s, r) => s + r.retrievalLatencyMs + r.answerLatencyMs + r.judgeLatencyMs,
        0
      ),
    },
  };
}
