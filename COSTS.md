# CI Cost Analysis: Current + Projected

## Current Architecture (pgvector, no reranking)

### Per-Operation Costs

#### `store()` — writing a memory
| Component | Cost | Notes |
|-----------|------|-------|
| OpenAI embedding (text-embedding-3-small) | **$0.000005** | ~250 tokens avg × $0.02/1M |
| Postgres INSERT (2 queries) | ~$0 | Covered by infra |
| **Total per store** | **$0.000005** | Essentially free |

#### `recall()` — searching memories
| Component | Cost | Notes |
|-----------|------|-------|
| OpenAI embedding (query) | **$0.000001** | ~50 tokens × $0.02/1M |
| pgvector ANN search (5-6 SQL queries) | ~$0 | Covered by infra |
| **Total per recall** | **$0.000001** | Essentially free |

### Monthly Infrastructure

| Component | Cost/month | Notes |
|-----------|-----------|-------|
| Fly.io API machine (shared-cpu-1x, 256MB) | **$1.94** | Always-on, auto-stop when idle |
| Fly Postgres (1GB provisioned) | **$0.15** | Unmanaged, includes pgvector |
| Fly Postgres (10GB provisioned) | **$1.50** | For ~100K+ memories |
| Bandwidth (1GB egress) | **$0.02** | Minimal for API responses |
| **Total infra (small)** | **~$2.11/mo** | For <10K memories |
| **Total infra (medium)** | **~$3.50/mo** | For 10K-100K memories |

### Storage Per Memory

| Column | Size/row | Notes |
|--------|----------|-------|
| embedding_vec (vector 1536) | ~6.1 KB | pgvector native, HNSW indexed |
| embedding (JSONB) | ~18-22 KB | Legacy, can drop eventually |
| content (encrypted) | ~0.5-2 KB | AES-256-GCM |
| content_tsv (tsvector) | ~0.1-0.5 KB | BM25 index |
| Other columns | ~0.2 KB | IDs, timestamps, tags |
| **Total per memory** | **~25-31 KB** | With both embedding columns |
| **After dropping JSONB** | **~7-9 KB** | Just pgvector + content |

**At 15K memories:** ~375-465 MB (both columns) or ~105-135 MB (pgvector only)

---

## With Cohere Reranking (next improvement)

### Additional Per-Recall Cost

| Component | Cost | Notes |
|-----------|------|-------|
| Cohere rerank-v3.5 | **$0.002** | 1 search × 100 docs per recall |
| **New total per recall** | **$0.002** | Reranking dominates |

### At Scale

| Monthly Volume | Recall Cost | Store Cost | Infra | Total |
|---------------|-------------|------------|-------|-------|
| 1K recalls + 500 stores | $2.00 | $0.003 | $2.11 | **$4.11** |
| 10K recalls + 5K stores | $20.00 | $0.025 | $2.11 | **$22.14** |
| 100K recalls + 50K stores | $200.00 | $0.25 | $3.50 | **$203.75** |
| 1M recalls + 500K stores | $2,000 | $2.50 | $15 | **$2,017** |

**Cohere reranking is the cost driver** at $0.002/recall. Without it, 1M recalls cost ~$1 in embedding fees.

### Optimization: Conditional Reranking

Only rerank when the top vector result has similarity < 0.8 (indicating uncertainty):
- Estimated 40-60% of recalls skip reranking
- Reduces Cohere cost by 40-60%
- 1M recalls: ~$800-1,200 instead of $2,000

---

## With Temporal Filtering (next improvement)

### Additional Cost: Zero

Temporal filtering is a SQL WHERE clause (`created_at >= X AND created_at <= X`). No external API calls, no additional cost. Just faster and more precise queries.

**Impact:** Reduces noise in retrieval, potentially allowing smaller candidate set → fewer docs to rerank → lower Cohere cost.

---

## With Entity Extraction (future improvement)

### Option A: OpenAI GPT-4o-mini for NER on Store

| Component | Cost/store | Notes |
|-----------|-----------|-------|
| GPT-4o-mini input | ~$0.00003 | ~200 tokens (memory + prompt) × $0.15/1M |
| GPT-4o-mini output | ~$0.00003 | ~50 tokens (entity list) × $0.60/1M |
| **Total per store** | **~$0.00006** | Still very cheap |

At scale:
| Volume | Entity Extraction Cost |
|--------|----------------------|
| 1K stores | $0.06 |
| 10K stores | $0.60 |
| 100K stores | $6.00 |
| 1M stores | $60.00 |

**Storage:** Entities stored in JSONB column with GIN index. ~100-500 bytes/row.

### Option B: Local NER (spaCy/Hugging Face)

| Component | Cost | Notes |
|-----------|------|-------|
| API cost | **$0** | Runs locally |
| Compute overhead | ~50-100ms/store | Negligible on Fly machine |
| Fly machine upgrade | **+$1.94/mo** | May need shared-cpu-2x for Python runtime |

### Option C: PostgreSQL tsvector-based Entity Matching

| Component | Cost | Notes |
|-----------|------|-------|
| API cost | **$0** | Pure SQL |
| Storage | ~0 | Reuses existing tsvector |
| Accuracy | Lower | Pattern-based, misses novel entities |

### Recommendation

**Option A (GPT-4o-mini NER)** for best accuracy at negligible cost ($0.06 per 1K stores). The entity extraction runs once at store-time, not at recall-time, so it doesn't affect query latency.

---

## Full Stack Cost Summary

### Per-Operation Costs (all improvements)

| Operation | Current | + Reranking | + Entity Extraction |
|-----------|---------|------------|-------------------|
| store() | $0.000005 | $0.000005 | **$0.00007** |
| recall() | $0.000001 | **$0.002** | $0.002 |

### Monthly Cost at Different Scales

| Scale | Memories | Recalls/mo | Stores/mo | Monthly Cost |
|-------|----------|-----------|-----------|-------------|
| **Solo dev** | 500 | 1K | 200 | **$4** |
| **Small team** | 5K | 10K | 2K | **$23** |
| **Startup** | 50K | 100K | 20K | **$205** |
| **Growth** | 500K | 1M | 200K | **$2,030** |
| **Enterprise** | 5M+ | 10M | 2M | **$20,100** |

### Infrastructure Breakdown (Growth tier)

| Component | Monthly Cost | % of Total |
|-----------|-------------|-----------|
| Cohere reranking (1M recalls) | $2,000 | 98.5% |
| Fly.io API machine | $5 | 0.2% |
| Fly Postgres (50GB) | $7.50 | 0.4% |
| OpenAI embeddings | $15 | 0.7% |
| Entity extraction (GPT-4o-mini) | $3 | 0.1% |
| **Total** | **$2,030** | |

---

## Cost Optimization Strategies

### 1. Conditional Reranking
Skip rerank when top vector similarity > 0.85. Saves 40-60% of Cohere cost.
**Savings at Growth tier:** -$800-1,200/mo

### 2. Self-hosted Reranker
Run `BAAI/bge-reranker-v2-m3` on a Fly GPU machine or a $50/mo dedicated server.
**Saves:** 100% of Cohere cost at scale. Break-even at ~25K recalls/mo.

### 3. Embedding Model Caching
Cache query embeddings for repeated/similar queries (LRU in-memory).
**Saves:** ~30% of OpenAI embedding cost (negligible in absolute terms).

### 4. Drop JSONB Embedding Column
After pgvector migration is stable, remove the 18-22KB JSONB column.
**Saves:** ~60% of storage per row → significant at 500K+ memories.

### 5. Use halfvec(1536) Instead of vector(1536)
pgvector supports 16-bit floats. Halves vector storage and index size.
**Saves:** ~50% of vector storage and faster ANN queries.

---

## LifeBench Benchmark Cost

| Phase | Cost | Notes |
|-------|------|-------|
| Ingestion (15K stores) | $0.08 | Embeddings only |
| Evaluation (207 recalls + LLM) | $0.10 | Without reranking |
| Evaluation with reranking | $0.51 | + $0.41 Cohere |
| All 10 users (ingestion) | $0.80 | 150K stores |
| All 10 users (evaluation) | $5.10 | 2K recalls + Cohere |
| **Full benchmark** | **~$6** | All 10 users, all improvements |

---

## Comparison: CI vs Competitors Pricing

| Provider | Free Tier | Per Operation | Notes |
|----------|----------|---------------|-------|
| **CI (current)** | 500 memories | ~$0.002/recall | Mainly Cohere reranking |
| **Mem0** | 1K memories | $0.001/operation | Cloud-hosted, includes LLM processing |
| **Zep** | 1K sessions | Usage-based | Includes graph + temporal |
| **Hindsight** | Self-hosted | Compute-only | Requires Docker + OPENAI_API_KEY |

CI's cost structure is competitive: the $0.002/recall with reranking is similar to Mem0's $0.001/operation (which includes its own LLM processing). Without reranking, CI is 1000x cheaper per recall.
