// ---- Adapter types (compatible with AMB) ----

export interface MemoryEntry {
  id: string;
  content: string;
  metadata?: Record<string, unknown>;
  tags?: string[];
  createdAt?: string;
  score?: number;
}

export interface StoreOptions {
  agentId?: string;
  userId?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
  scope?: "agent" | "user" | "org";
}

export interface SearchOptions {
  agentId?: string;
  userId?: string;
  tags?: string[];
  limit?: number;
  scope?: "agent" | "user" | "org";
}

export interface MemoryAdapter {
  name: string;
  capabilities?: {
    multiAgent?: boolean;
    scoping?: boolean;
    temporalDecay?: boolean;
  };
  initialize(): Promise<void>;
  store(content: string, options?: StoreOptions): Promise<MemoryEntry>;
  search(query: string, options?: SearchOptions): Promise<MemoryEntry[]>;
  delete(id: string): Promise<boolean>;
  cleanup(): Promise<void>;
}

// ---- LifeBench data types ----

export type SourceType =
  | "event"
  | "sms"
  | "calendar"
  | "call"
  | "contact"
  | "fitness"
  | "note"
  | "photo"
  | "push"
  | "agent_chat"
  | "persona"
  | "summary";

export interface LifeBenchMemory {
  userId: string;
  sourceType: SourceType;
  sourceId: string;
  content: string;
  timestamp: string; // ISO date
}

export type QuestionCategory =
  | "Information Extraction"
  | "Multi-hop reasoning"
  | "Temporal and Knowledge Updating"
  | "Nondeclarative"
  | "Unanswerable";

export interface LifeBenchQuestion {
  userId: string;
  index: number;
  question: string;
  answer: string;
  category: QuestionCategory;
  askTime?: string;
  requiredEventsId?: string[];
  evidence?: Array<{ type: string; id: string }>;
}

// ---- Results ----

export interface QuestionResult {
  userId: string;
  questionIndex: number;
  question: string;
  groundTruth: string;
  predicted: string;
  retrievedCount: number;
  category: QuestionCategory;
  correct: boolean;
  f1Score: number;
  retrievalLatencyMs: number;
  answerLatencyMs: number;
  judgeLatencyMs: number;
}

export interface CategoryScore {
  category: QuestionCategory;
  correct: number;
  total: number;
  accuracy: number;
  avgF1: number;
}

export interface UserScore {
  userId: string;
  accuracy: number;
  totalQuestions: number;
  categories: CategoryScore[];
}

export interface LifeBenchResult {
  provider: string;
  timestamp: string;
  version: string;
  users: string[];
  answerModel: string;
  judgeModel: string;
  topK: number;
  overall: {
    accuracy: number;
    avgF1: number;
    totalQuestions: number;
    correctQuestions: number;
  };
  categories: CategoryScore[];
  perUser: UserScore[];
  meta: {
    totalStoreOps: number;
    totalSearchOps: number;
    totalLLMCalls: number;
    ingestionTimeMs: number;
    evaluationTimeMs: number;
  };
}

// ---- Config ----

export interface LifeBenchConfig {
  provider: string;
  apiKey?: string;
  apiUrl?: string;
  phase: "preprocess" | "ingest" | "evaluate" | "all" | "compare";
  users: string[];
  topK: number;
  answerModel: string;
  judgeModel: string;
  dataDir: string;
  outputDir: string;
  verbose: boolean;
  resume: boolean;
  concurrency: number;
  storeDelayMs: number;
}

export const QUESTION_CATEGORIES: QuestionCategory[] = [
  "Information Extraction",
  "Multi-hop reasoning",
  "Temporal and Knowledge Updating",
  "Nondeclarative",
  "Unanswerable",
];

export const DEFAULT_CONFIG: Partial<LifeBenchConfig> = {
  topK: 20,
  answerModel: "gpt-4o-mini",
  judgeModel: "gpt-4.1-mini",
  dataDir: "./data",
  outputDir: "./results",
  verbose: false,
  resume: true,
  concurrency: 3,
  storeDelayMs: 0,
};
