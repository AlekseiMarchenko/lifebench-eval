import { join } from "node:path";
import type { MemoryAdapter, LifeBenchMemory } from "../types.js";
import { RateLimiter } from "../utils/rate-limiter.js";
import { withRetry } from "../utils/retry.js";
import { loadCheckpoint, saveCheckpoint, type CheckpointData } from "../utils/checkpoint.js";

export interface IngestOptions {
  adapter: MemoryAdapter;
  memories: LifeBenchMemory[];
  userId: string;
  outputDir: string;
  provider: string;
  concurrency: number;
  storeDelayMs: number;
  verbose: boolean;
}

export interface IngestResult {
  stored: number;
  skipped: number;
  failed: number;
  durationMs: number;
}

export async function ingestUser(opts: IngestOptions): Promise<IngestResult> {
  const {
    adapter,
    memories,
    userId,
    outputDir,
    provider,
    storeDelayMs,
    verbose,
  } = opts;

  const checkpointPath = join(outputDir, provider, userId, "ingest-checkpoint.json");
  const checkpoint = loadCheckpoint(checkpointPath);
  const startIndex = checkpoint?.lastIndex ?? -1;
  const storedIds = checkpoint?.storedIds ?? [];

  const limiter = new RateLimiter(100); // conservative rate
  const agentId = `lifebench-${userId}`;
  const start = Date.now();
  let stored = 0;
  let skipped = startIndex + 1;
  let failed = 0;

  console.log(
    `  Ingesting ${memories.length} memories for ${userId} (resuming from index ${startIndex + 1})`
  );

  for (let i = startIndex + 1; i < memories.length; i++) {
    const mem = memories[i];
    await limiter.acquire();

    try {
      const entry = await withRetry(
        () => adapter.store(mem.content, { agentId, tags: [mem.sourceType] }),
        {
          maxRetries: 3,
          onRetry: (err, attempt) => {
            if (verbose) console.log(`    Retry ${attempt} for memory ${i}: ${err.message}`);
          },
        }
      );

      storedIds.push(entry.id);
      stored++;

      if (storeDelayMs > 0) {
        await new Promise((r) => setTimeout(r, storeDelayMs));
      }
    } catch (err) {
      failed++;
      if (verbose) {
        console.log(`    Failed to store memory ${i}: ${err instanceof Error ? err.message : err}`);
      }
    }

    // Checkpoint every 50 stores
    if ((i + 1) % 50 === 0 || i === memories.length - 1) {
      saveCheckpoint(checkpointPath, {
        lastIndex: i,
        storedIds,
        updatedAt: new Date().toISOString(),
      });
      const pct = ((i + 1) / memories.length * 100).toFixed(1);
      console.log(`    Progress: ${i + 1}/${memories.length} (${pct}%) — ${stored} stored, ${failed} failed`);
    }
  }

  const durationMs = Date.now() - start;
  console.log(
    `  Ingestion complete for ${userId}: ${stored} stored, ${skipped} skipped (resumed), ${failed} failed in ${(durationMs / 1000).toFixed(1)}s`
  );

  return { stored, skipped, failed, durationMs };
}
