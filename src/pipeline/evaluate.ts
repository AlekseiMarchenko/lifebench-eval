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

const ANSWER_SYSTEM_PROMPT = `You are answering questions about a person's life based on their personal data records (messages, calendar, health data, notes, calls, etc.).

Rules:
- Use ONLY the provided memories to answer. Do not make up information.
- If the information is not available in the memories, say "The information is not available in the provided records."
- Be concise and direct.
- For numerical questions (counts, dates, durations), provide the specific number/date.
- For yes/no questions, start with Yes or No.`;

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

  const agentId = `lifebench-${userId}`;
  const start = Date.now();
  let evaluated = 0;

  console.log(
    `  Evaluating ${questions.length} questions for ${userId} (${existingIndices.size} already done)`
  );

  for (const q of questions) {
    if (existingIndices.has(q.index)) continue;

    // 1. Retrieve memories
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

    const userPrompt = `Memories:\n${context}\n\nQuestion: ${q.question}\nAnswer:`;

    let predicted = "";
    let answerLatencyMs = 0;
    try {
      const answerRes = await callLLM(answerModel, ANSWER_SYSTEM_PROMPT, userPrompt);
      predicted = answerRes.content;
      answerLatencyMs = answerRes.latencyMs;
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
