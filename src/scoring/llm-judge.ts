import { callLLM, type LLMResponse } from "../utils/llm.js";

const SYSTEM_PROMPT = `You are evaluating whether a predicted answer is correct given the ground truth answer to a question.

Rules:
- Consider the predicted answer CORRECT if it conveys the same essential information as the ground truth, even if worded differently.
- Be generous: longer answers are fine as long as they address the core concept.
- For numerical answers, allow minor formatting differences (e.g., "3 times" vs "three times").
- For lists, the order doesn't matter, but the key items should be present.
- If the predicted answer says the information is unavailable/unknown but the ground truth has a real answer, mark as WRONG.
- If the ground truth says "unanswerable" or similar and the predicted answer also indicates uncertainty, mark as CORRECT.

Respond with exactly one word: CORRECT or WRONG`;

export interface JudgeResult {
  correct: boolean;
  latencyMs: number;
}

export async function judgeAnswer(
  question: string,
  groundTruth: string,
  predicted: string,
  model: string
): Promise<JudgeResult> {
  const userPrompt = `Question: ${question}

Ground Truth Answer: ${groundTruth}

Predicted Answer: ${predicted}

Verdict:`;

  let response: LLMResponse;
  try {
    response = await callLLM(model, SYSTEM_PROMPT, userPrompt);
  } catch (err) {
    console.warn(`  Judge LLM error: ${err instanceof Error ? err.message : err}`);
    return { correct: false, latencyMs: 0 };
  }

  const verdict = response.content.trim().toUpperCase();
  return {
    correct: verdict.startsWith("CORRECT"),
    latencyMs: response.latencyMs,
  };
}
