import { writeFileSync, readFileSync, existsSync, mkdirSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import type { MemoryAdapter } from "../types.js";
import type { LongMemEvalQuestion } from "./preprocess-longmemeval.js";
import { callLLM } from "../utils/llm.js";
import { withRetry } from "../utils/retry.js";

const ANSWER_SYSTEM_PROMPT = `You are answering questions about a user's past conversations. The user had many chat sessions with an AI assistant over time. Based on the retrieved conversation excerpts below, answer the question.

Rules:
- Answer based on the provided conversation excerpts.
- If you cannot find a direct answer, infer from context clues, mentions, and implications in the excerpts. Only say "I don't have enough information" if there is truly nothing relevant in any excerpt.
- Be concise and direct. Give the specific answer, not a summary.
- For temporal questions, pay attention to dates and time references.
- For preference questions: preferences are often implied, not stated directly. If someone says they loved X, frequently uses Y, or chose Z over alternatives, that indicates a preference.
- For counting questions: carefully count distinct events, don't double-count the same event mentioned in multiple excerpts.
- When multiple excerpts discuss the same topic, prefer the most recent one for current facts.`;

export interface LongMemEvalOptions {
  adapter: MemoryAdapter;
  questions: LongMemEvalQuestion[];
  provider: string;
  topK: number;
  answerModel: string;
  outputDir: string;
  verbose: boolean;
  resume: boolean;
  storeDelayMs: number;
  outputFile?: string; // custom predictions filename
}

export interface LongMemEvalPrediction {
  question_id: string;
  hypothesis: string;
}

/**
 * Run LongMemEval evaluation: for each question, store its sessions,
 * recall with the question, generate answer, write to JSONL.
 */
export async function evaluateLongMemEval(opts: LongMemEvalOptions): Promise<{
  predictionsPath: string;
  totalQuestions: number;
  durationMs: number;
}> {
  const {
    adapter,
    questions,
    provider,
    topK,
    answerModel,
    outputDir,
    verbose,
    resume,
    storeDelayMs,
  } = opts;

  const resultsDir = join(outputDir, provider);
  mkdirSync(resultsDir, { recursive: true });
  const predictionsPath = join(resultsDir, opts.outputFile || "longmemeval-predictions.jsonl");

  // Resume: load existing predictions
  const existing = new Set<string>();
  if (resume && existsSync(predictionsPath)) {
    const lines = readFileSync(predictionsPath, "utf-8").split("\n").filter(Boolean);
    for (const line of lines) {
      try {
        const pred = JSON.parse(line) as LongMemEvalPrediction;
        existing.add(pred.question_id);
      } catch {}
    }
    console.log(`  Resuming: ${existing.size} predictions already done`);
  } else {
    // Start fresh
    writeFileSync(predictionsPath, "");
  }

  const start = Date.now();
  let evaluated = 0;

  console.log(`  Evaluating ${questions.length} LongMemEval questions (${existing.size} cached)`);

  for (const q of questions) {
    if (existing.has(q.questionId)) continue;

    const agentId = `lme-${q.questionId}-${Date.now()}`;

    // 1. Store all haystack sessions as memories
    const storedIds: string[] = [];
    for (const session of q.sessions) {
      try {
        const entry = await withRetry(
          () => adapter.store(session, { agentId }),
          { maxRetries: 2 }
        );
        storedIds.push(entry.id);
      } catch (err) {
        if (verbose) console.log(`    Store failed for ${q.questionId}: ${err}`);
      }
    }

    // 2. Wait for indexing
    if (storeDelayMs > 0) {
      await new Promise((r) => setTimeout(r, storeDelayMs));
    }

    // 3. Recall with the question
    let retrievedContent: string[] = [];
    try {
      const memories = await withRetry(
        () => adapter.search(q.question, { agentId, limit: topK }),
        { maxRetries: 2 }
      );
      retrievedContent = memories.map((m) => m.content);
    } catch (err) {
      if (verbose) console.log(`    Search failed for ${q.questionId}: ${err}`);
    }

    // 4. Generate answer
    const context = retrievedContent.length > 0
      ? retrievedContent.map((c, i) => `[Excerpt ${i + 1}]\n${c}`).join("\n\n")
      : "No relevant conversation excerpts found.";

    let hypothesis = "";
    try {
      const res = await callLLM(
        answerModel,
        ANSWER_SYSTEM_PROMPT,
        `Conversation excerpts:\n${context}\n\nQuestion: ${q.question}\nAnswer:`
      );
      hypothesis = res.content;
    } catch (err) {
      hypothesis = "Error generating answer.";
      if (verbose) console.log(`    Answer gen failed for ${q.questionId}: ${err}`);
    }

    // 5. Write prediction
    const prediction: LongMemEvalPrediction = {
      question_id: q.questionId,
      hypothesis,
    };
    appendFileSync(predictionsPath, JSON.stringify(prediction) + "\n");

    // 6. Cleanup
    for (const id of storedIds) {
      try {
        await adapter.delete(id);
      } catch {}
    }

    evaluated++;
    if (verbose) {
      console.log(`    ${q.questionId} [${q.questionType}] — retrieved ${retrievedContent.length}, stored ${storedIds.length}`);
    } else if (evaluated % 20 === 0) {
      console.log(`    Progress: ${evaluated + existing.size}/${questions.length}`);
    }
  }

  const durationMs = Date.now() - start;
  console.log(`  Done: ${evaluated} new predictions in ${(durationMs / 1000).toFixed(1)}s`);
  console.log(`  Predictions: ${predictionsPath}`);

  return {
    predictionsPath,
    totalQuestions: existing.size + evaluated,
    durationMs,
  };
}
