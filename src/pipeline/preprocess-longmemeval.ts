import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

export interface LongMemEvalQuestion {
  questionId: string;
  questionType: string;
  question: string;
  answer: string;
  questionDate: string;
  sessions: string[]; // Each session flattened to a single string
  answerSessionIds: string[];
}

interface RawTurn {
  role: "user" | "assistant";
  content: string;
  has_answer?: boolean;
}

interface RawQuestion {
  question_id: string;
  question_type: string;
  question: string;
  answer: string;
  question_date: string;
  answer_session_ids: string[];
  haystack_dates: string[];
  haystack_session_ids: string[];
  haystack_sessions: RawTurn[][];
}

const MAX_SESSION_CHARS = 9500; // CI limit is 10K, leave room for prefix

/**
 * Flatten a conversation session (array of turns) into a single string.
 * Truncates to fit CI's 10K character limit.
 */
function flattenSession(turns: RawTurn[], date?: string): string {
  const prefix = date ? `[${date}] ` : "";
  const dialogue = turns
    .map((t) => `${t.role === "user" ? "User" : "Assistant"}: ${t.content}`)
    .join("\n");
  const full = `${prefix}${dialogue}`;
  if (full.length <= MAX_SESSION_CHARS) return full;
  return full.substring(0, MAX_SESSION_CHARS) + "...";
}

/**
 * Load and preprocess LongMemEval S variant.
 * Returns array of questions with their haystack sessions flattened to strings.
 */
export function preprocessLongMemEval(dataDir: string): LongMemEvalQuestion[] {
  const dataPath = join(dataDir, "longmemeval-repo", "data", "longmemeval_s_cleaned.json");

  if (!existsSync(dataPath)) {
    throw new Error(`LongMemEval data not found at ${dataPath}. Download it first.`);
  }

  const raw: RawQuestion[] = JSON.parse(readFileSync(dataPath, "utf-8"));
  console.log(`  Loaded ${raw.length} LongMemEval questions`);

  return raw.map((q) => ({
    questionId: q.question_id,
    questionType: q.question_type,
    question: q.question,
    answer: q.answer,
    questionDate: q.question_date,
    answerSessionIds: q.answer_session_ids,
    sessions: q.haystack_sessions.map((turns, i) =>
      flattenSession(turns, q.haystack_dates?.[i])
    ),
  }));
}
