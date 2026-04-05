# LifeBench Analysis: Central Intelligence v0.5.0

**Date:** April 5, 2026
**Benchmark:** LifeBench (March 2026, Nanjing University + Huawei)
**Paper:** https://arxiv.org/abs/2603.03781
**User tested:** fenghaoran (14,910 memories, 207 questions)

---

## Executive Summary

Central Intelligence scored **9.2%** on LifeBench, significantly below MemOS (55.2%) and Hindsight (41.0%). The root cause is a single architectural bottleneck: CI's vector search scans only the **500 most recent memories**, making 96.7% of the 14,910-memory corpus invisible to semantic retrieval. This is not a fundamental limitation -- a focused 1-week sprint on three improvements (pgvector indexing, cross-encoder reranking, temporal filtering) would likely bring CI to 35-45%, competitive with Hindsight.

---

## Results

| Category | Correct | Total | Accuracy |
|----------|---------|-------|----------|
| Information Extraction | 3 | 72 | 4.2% |
| Multi-hop Reasoning | 6 | 68 | 8.8% |
| Temporal & Knowledge Updating | 3 | 28 | 10.7% |
| Nondeclarative | 7 | 39 | 17.9% |
| **Overall** | **19** | **207** | **9.2%** |

**Published comparisons:**

| System | Overall |
|--------|---------|
| MemOS | 55.2% |
| Hindsight | 41.0% |
| **Central Intelligence** | **9.2%** |

---

## Failure Mode Analysis

### The dominant failure: retrieval miss (80.2%)

| Failure Mode | Count | % |
|-------------|-------|---|
| Retrieval failure (LLM says "not available") | 166 | 80.2% |
| Retrieved something, answered wrong | 22 | 10.6% |
| Correct | 19 | 9.2% |

In 80% of cases, CI returns 20 memories but **none contain the answer**. The LLM correctly reports the information is unavailable. This is a precision-at-k problem in the retrieval layer, not a generation problem.

When retrieval does succeed, the answer is correct **46% of the time** -- proving the generation pipeline works fine when given relevant context.

### Per-category failure breakdown

| Category | Retrieval Fail | Wrong Answer | Correct |
|----------|---------------|-------------|---------|
| Information Extraction | 90% | 6% | 4% |
| Multi-hop Reasoning | 78% | 13% | 9% |
| Nondeclarative | 67% | 15% | 18% |
| Temporal & Knowledge Updating | 79% | 11% | 11% |

**Information Extraction** is hardest -- 90% retrieval failure. These are needle-in-a-haystack factoid questions (specific dates, places, names) that require matching one exact memory chunk out of 15K.

**Nondeclarative** performs best at 18% -- questions about habits and preferences match broader semantic themes that appear across multiple memories, improving retrieval odds.

### What separates correct from incorrect answers

**Correct answers** share a pattern: the question contains **distinctive proper nouns or domain-specific terms** that create sharp embedding matches.

- "EDGAR database on the official website of the U.S. SEC" -> unique embedding, easy match
- "Lanzhou Lamian Restaurant, Jinying Road" -> specific place name, unique match
- "CFA Level III exam" -> distinctive domain term

**Failed answers** involve: routine events described with common vocabulary, implicit contextual knowledge, or vocabulary mismatch between question and stored memory (e.g., question says "art exhibition" but the memory says "gallery visit").

### Generic vs. entity-specific questions

| Question Type | n | Accuracy |
|--------------|---|----------|
| With named entities/dates | 168 | 6.5% |
| Generic (no names/dates) | 39 | 20.5% |

Generic questions ("What challenges might I be facing?") perform **3x better** because they match broad themes across multiple memories. Entity-specific questions ("On which day did Feng Haoran visit the art exhibition with Peng Yuqing?") require matching one exact chunk -- and fail when that chunk isn't in the 500-memory scan window.

---

## Root Cause: The 500-Row Vector Scan Cap

CI's retrieval algorithm in `services/memories.ts`:

1. **Vector search**: Fetches the **500 most recent** memories (by `created_at DESC`), computes cosine similarity in-app against the query embedding
2. **BM25 search**: PostgreSQL `ts_rank_cd` against `content_tsv`, limited to 50 results
3. **RRF fusion**: Merges vector + BM25 with k=60
4. **Temporal decay**: Exponential decay (half-life 90 days), 85% relevance + 15% recency
5. **Quality gate**: Minimum cosine similarity 0.25

With 14,910 memories stored, the vector search scans only the **most recent 500** -- meaning **96.7% of memories are invisible** to semantic search. BM25 helps recover some keyword matches, but with a 50-result cap it can't compensate.

This architecture was designed for ~100-500 memories per user. At 15K, it breaks down fundamentally.

---

## How MemOS and Hindsight Beat CI

### MemOS (55.2%) -- Hierarchical memory architecture
- **3-tier memory**: working memory (active session), long-term memory (persistent), cold archive (rarely accessed)
- **MemCube abstraction**: each memory unit has plaintext + activation score + parametric weights
- **Intent-aware scheduling**: proactively preloads relevant memories based on predicted query patterns
- **Version management**: tracks temporal evolution of facts for knowledge-update questions

### Hindsight (41.0%) -- Parallel hybrid retrieval
- **4-way parallel search**: semantic + BM25 + graph traversal + temporal search simultaneously
- **Cross-encoder reranking**: reranks top 300 candidates for precision
- **4 logical memory networks**: facts / experiences / entities / beliefs
- **Entity graph**: co-occurrence links between people, places, events enable graph-based traversal

### CI (9.2%) -- Flat memory pool
- Single vector + BM25 search over a **capped subset** of memories
- No entity indexing, no graph, no hierarchical tiers
- No reranking stage
- No temporal filtering at query time

---

## Retrieval Improvements Roadmap

### Tier 1: The 80/20 path (1 week, target: 35-45%)

#### 1. pgvector ANN index -- remove the 500-row cap
**Effort:** Low (1-2 days)
**Expected impact:** +15-25 points

The single biggest win. Add the `pgvector` extension, store embeddings as `vector(1536)` instead of JSONB, create an HNSW index, and run `ORDER BY embedding <=> $query LIMIT N` in SQL. This makes ALL 15K memories searchable by semantic similarity, not just the 500 most recent.

```sql
ALTER TABLE memories ADD COLUMN embedding_vec vector(1536);
CREATE INDEX ON memories USING hnsw (embedding_vec vector_cosine_ops);
```

#### 2. Cross-encoder reranking
**Effort:** Medium (3-5 days)
**Expected impact:** +10-15 points

Retrieve a wider candidate set (100-300 via vector + BM25), then rerank with a cross-encoder (e.g., Cohere `rerank-v3.5` API or `cross-encoder/ms-marco-MiniLM-L-6-v2`). Cross-encoders jointly encode query+document for much higher precision than bi-encoder similarity. Hindsight attributes significant accuracy gains to this stage.

#### 3. Date/temporal filtering on recall
**Effort:** Low (2-3 days)
**Expected impact:** +8-12 points

Add optional `date_from` / `date_to` to the recall API. Extract date references from queries (regex or lightweight LLM call). Apply as a WHERE clause before vector search. Many LifeBench questions scope to specific months -- temporal filtering would eliminate 90% of noise for these.

### Tier 2: Competitive with MemOS (2-3 weeks, target: 45-60%)

#### 4. Entity extraction and indexing
**Effort:** Medium (4-6 days)
**Expected impact:** +10-20 points

On `store()`, extract named entities (people, places, organizations) via NER. Store in a `entities` JSONB column or junction table with a GIN index. On `recall()`, extract entities from the query, filter/boost memories sharing entities. This would make "What did I discuss with Peng Yuqing?" a precise filter rather than fuzzy embedding match.

#### 5. Query decomposition for multi-hop
**Effort:** Medium (3-4 days)
**Expected impact:** +8-12 points

Before retrieval, decompose complex questions into sub-queries via a lightweight LLM call. Run retrieval for each, merge results. Multi-hop reasoning is 33% of the benchmark (68/207 questions) and CI scores only 8.8% on it.

#### 6. Upgrade embedding model
**Effort:** Low (1-2 days + migration)
**Expected impact:** +5-8 points

Switch from `text-embedding-3-small` to `text-embedding-3-large` (3072 dims). Better semantic separation in dense life-event domains. Requires re-embedding existing memories.

### Tier 3: Long-term architecture (1-2 months)

#### 7. Hierarchical memory with compaction
Periodically cluster and summarize related memories. Search summaries first, then drill into constituent memories. Mirrors MemOS's 3-tier architecture.

#### 8. Entity graph
Build co-occurrence links between entities. Enable graph traversal alongside vector search (Hindsight's approach).

### Priority matrix

| # | Improvement | Effort | Impact | User Benefit |
|---|-------------|--------|--------|-------------|
| 1 | pgvector ANN index | Low | +15-25 | HIGH -- any user >500 memories |
| 2 | Cross-encoder rerank | Medium | +10-15 | HIGH -- better relevance for all |
| 3 | Temporal filtering | Low | +8-12 | HIGH -- natural for "last week" queries |
| 4 | Entity extraction | Medium | +10-20 | HIGH -- "what did I discuss with X" |
| 5 | Query decomposition | Medium | +8-12 | MEDIUM -- helps complex queries |
| 6 | Embedding upgrade | Low | +5-8 | MEDIUM -- marginal for short content |

**Cumulative projection:**
- Tier 1 only (1 week): **35-45%** -- competitive with Hindsight
- Tier 1 + 2 (3 weeks): **45-60%** -- competitive with MemOS
- All tiers (2 months): **60-75%** -- potential benchmark leader

---

## Methodology Notes

- **Data**: 14,910 memories from 10 source types (events, SMS, calendar, calls, contacts, health, notes, photos, notifications, agent chats)
- **Retrieval**: top-20 memories per question via CI's `/memories/recall` endpoint
- **Answer generation**: GPT-4o-mini with zero temperature
- **Judging**: GPT-4.1-mini binary CORRECT/WRONG (LoCoMo-standard protocol)
- **Secondary metric**: Token-overlap F1 (mean: 0.043)
- **Ingestion**: 14,910 stores, 0 failures, ~2.5 hours across 4 checkpoint-resumed runs
- **Evaluation**: 207 questions, 17 minutes, ~$0.10 in OpenAI API costs
- **Enterprise API key** used with $100 internal credit for billing bypass

### Multiple-choice format caveat

At least 3 questions have ground truths that are letter answers (A, B, C, D) but the model generates full-text answers. These score F1=0 even when the content may be correct. A format-aware answer template would fix these edge cases.

---

## Next Steps

1. **Implement Tier 1 improvements** (pgvector, reranking, temporal filtering) -- 1 week
2. **Re-run LifeBench** with improved retrieval to validate score gains
3. **Run against all 10 users** for publishable results (cost: ~$1 in API calls)
4. **Run Mem0 and Hindsight** through the same harness for direct comparison
5. **Publish results** on the LifeBench leaderboard and CI blog
