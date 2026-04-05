#!/usr/bin/env node
import { Command } from "commander";
import { writeFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { downloadLifeBenchData } from "./pipeline/download.js";
import { preprocessUser } from "./pipeline/preprocess.js";
import { ingestUser } from "./pipeline/ingest.js";
import { evaluateUser, aggregateResults } from "./pipeline/evaluate.js";
import { createAdapter, type ProviderName } from "./adapters/index.js";
import { generateMarkdown } from "./report/markdown.js";
import { generateComparison } from "./report/compare.js";
import type { LifeBenchConfig, QuestionResult } from "./types.js";

const program = new Command();

program
  .name("lifebench")
  .description("LifeBench evaluation harness for memory providers")
  .version("0.1.0");

program
  .command("run")
  .description("Run LifeBench evaluation")
  .requiredOption("--provider <name>", "Memory provider: ci, mem0, hindsight")
  .option("--api-key <key>", "API key (or set CI_API_KEY / MEM0_API_KEY env var)")
  .option("--api-url <url>", "API URL override")
  .option("--phase <phase>", "Phase: preprocess, ingest, evaluate, all", "all")
  .option("--users <list>", "Comma-separated user IDs or 'all'", "all")
  .option("--top-k <n>", "Memories to retrieve per question", "20")
  .option("--answer-model <model>", "LLM for answer generation", "gpt-4o-mini")
  .option("--judge-model <model>", "LLM for judging", "gpt-4.1-mini")
  .option("--data-dir <dir>", "Path to data directory", "./data")
  .option("--output <dir>", "Output directory", "./results")
  .option("--verbose", "Show per-question output", false)
  .option("--no-resume", "Do not resume from checkpoints")
  .option("--concurrency <n>", "Parallel API calls", "3")
  .option("--store-delay <ms>", "Delay between stores (ms)", "0")
  .action(async (opts) => {
    const dataDir = resolve(opts.dataDir);
    const outputDir = resolve(opts.output);

    // Resolve API key
    const apiKey =
      opts.apiKey ||
      (opts.provider === "ci" ? process.env.CI_API_KEY : undefined) ||
      (opts.provider === "mem0" ? process.env.MEM0_API_KEY : undefined);

    const config: LifeBenchConfig = {
      provider: opts.provider,
      apiKey,
      apiUrl: opts.apiUrl,
      phase: opts.phase,
      users: [],
      topK: parseInt(opts.topK),
      answerModel: opts.answerModel,
      judgeModel: opts.judgeModel,
      dataDir,
      outputDir,
      verbose: opts.verbose,
      resume: opts.resume !== false,
      concurrency: parseInt(opts.concurrency),
      storeDelayMs: parseInt(opts.storeDelay),
    };

    const shouldPreprocess = config.phase === "preprocess" || config.phase === "all";
    const shouldIngest = config.phase === "ingest" || config.phase === "all";
    const shouldEvaluate = config.phase === "evaluate" || config.phase === "all";

    // Download data
    console.log("\n=== Downloading LifeBench data ===");
    const availableUsers = downloadLifeBenchData(dataDir);

    // Resolve users
    if (opts.users === "all") {
      config.users = availableUsers;
    } else {
      config.users = opts.users.split(",").map((u: string) => u.trim());
      for (const u of config.users) {
        if (!availableUsers.includes(u)) {
          console.error(`User '${u}' not found. Available: ${availableUsers.join(", ")}`);
          process.exit(1);
        }
      }
    }

    console.log(`\nProvider: ${config.provider}`);
    console.log(`Users: ${config.users.join(", ")}`);
    console.log(`Phase: ${config.phase}`);
    console.log(`Top-K: ${config.topK}`);
    console.log(`Answer model: ${config.answerModel}`);
    console.log(`Judge model: ${config.judgeModel}`);

    // Create adapter (only needed for ingest/evaluate)
    let adapter: ReturnType<typeof createAdapter> | null = null;
    if (shouldIngest || shouldEvaluate) {
      adapter = createAdapter(config.provider as ProviderName, config.apiKey, config.apiUrl);
      console.log("\n=== Initializing adapter ===");
      await adapter.initialize();
    }

    let totalStoreOps = 0;
    let totalIngestionMs = 0;
    const allQuestionResults: QuestionResult[] = [];

    for (const userId of config.users) {
      console.log(`\n=== Processing user: ${userId} ===`);

      // Preprocess
      console.log("\n--- Preprocessing ---");
      const { memories, questions, stats } = preprocessUser(dataDir, userId);
      console.log(`  Stats: ${JSON.stringify(stats)}`);

      // Ingest
      if (shouldIngest && adapter) {
        console.log("\n--- Ingestion ---");
        const ingestResult = await ingestUser({
          adapter,
          memories,
          userId,
          outputDir,
          provider: config.provider,
          concurrency: config.concurrency,
          storeDelayMs: config.storeDelayMs,
          verbose: config.verbose,
        });
        totalStoreOps += ingestResult.stored + ingestResult.skipped;
        totalIngestionMs += ingestResult.durationMs;
      }

      // Evaluate
      if (shouldEvaluate && adapter) {
        console.log("\n--- Evaluation ---");
        const evalResult = await evaluateUser({
          adapter,
          questions,
          userId,
          provider: config.provider,
          topK: config.topK,
          answerModel: config.answerModel,
          judgeModel: config.judgeModel,
          outputDir,
          verbose: config.verbose,
          resume: config.resume,
        });
        allQuestionResults.push(...evalResult.results);
      }
    }

    // Generate final report
    if (shouldEvaluate && allQuestionResults.length > 0) {
      console.log("\n=== Generating Report ===");

      const finalResult = aggregateResults(config.provider, allQuestionResults, config.users, {
        answerModel: config.answerModel,
        judgeModel: config.judgeModel,
        topK: config.topK,
        totalStoreOps,
        ingestionTimeMs: totalIngestionMs,
      });

      const providerDir = join(outputDir, config.provider);
      mkdirSync(providerDir, { recursive: true });

      writeFileSync(join(providerDir, "results.json"), JSON.stringify(finalResult, null, 2));

      const markdown = generateMarkdown(finalResult);
      writeFileSync(join(providerDir, "report.md"), markdown);

      console.log(`\nOverall accuracy: ${(finalResult.overall.accuracy * 100).toFixed(1)}%`);
      console.log(`Results saved to ${providerDir}/`);

      // Print category summary
      console.log("\nPer-category accuracy:");
      for (const cat of finalResult.categories) {
        const bar = "█".repeat(Math.round(cat.accuracy * 20));
        console.log(`  ${cat.category.padEnd(38)} ${(cat.accuracy * 100).toFixed(1).padStart(5)}% ${bar}`);
      }
    }
  });

program
  .command("compare")
  .description("Generate comparison report across providers")
  .option("--output <dir>", "Results directory", "./results")
  .action((opts) => {
    const outputDir = resolve(opts.output);
    const report = generateComparison(outputDir);
    const reportPath = join(outputDir, "comparison.md");
    writeFileSync(reportPath, report);
    console.log(report);
    console.log(`\nSaved to ${reportPath}`);
  });

program
  .command("longmemeval")
  .description("Run LongMemEval benchmark (generates predictions JSONL)")
  .requiredOption("--provider <name>", "Memory provider: ci, mem0, hindsight")
  .option("--api-key <key>", "API key")
  .option("--api-url <url>", "API URL override")
  .option("--top-k <n>", "Memories to retrieve per question", "20")
  .option("--answer-model <model>", "LLM for answer generation", "gpt-4o-mini")
  .option("--data-dir <dir>", "Path to data directory", "./data")
  .option("--output <dir>", "Output directory", "./results")
  .option("--verbose", "Show per-question output", false)
  .option("--no-resume", "Do not resume from checkpoint")
  .option("--store-delay <ms>", "Delay after storing sessions (ms)", "3000")
  .option("--limit <n>", "Only evaluate first N questions (for testing)")
  .action(async (opts) => {
    const dataDir = resolve(opts.dataDir);
    const outputDir = resolve(opts.output);

    const apiKey =
      opts.apiKey ||
      (opts.provider === "ci" ? process.env.CI_API_KEY : undefined) ||
      (opts.provider === "mem0" ? process.env.MEM0_API_KEY : undefined);

    const { preprocessLongMemEval } = await import("./pipeline/preprocess-longmemeval.js");
    const { evaluateLongMemEval } = await import("./pipeline/evaluate-longmemeval.js");

    console.log("\n=== LongMemEval Benchmark ===");
    console.log(`Provider: ${opts.provider}`);
    console.log(`Answer model: ${opts.answerModel}`);
    console.log(`Top-K: ${opts.topK}`);

    // Preprocess
    let questions = preprocessLongMemEval(dataDir);
    if (opts.limit) {
      questions = questions.slice(0, parseInt(opts.limit));
      console.log(`  Limited to first ${questions.length} questions`);
    }

    // Per-type counts
    const typeCounts: Record<string, number> = {};
    questions.forEach((q) => { typeCounts[q.questionType] = (typeCounts[q.questionType] || 0) + 1; });
    console.log(`  Types:`, typeCounts);

    // Create adapter
    const adapter = createAdapter(opts.provider as ProviderName, apiKey, opts.apiUrl);
    await adapter.initialize();

    // Evaluate
    const result = await evaluateLongMemEval({
      adapter,
      questions,
      provider: opts.provider,
      topK: parseInt(opts.topK),
      answerModel: opts.answerModel,
      outputDir,
      verbose: opts.verbose,
      resume: opts.resume !== false,
      storeDelayMs: parseInt(opts.storeDelay),
    });

    console.log(`\n=== Predictions generated ===`);
    console.log(`File: ${result.predictionsPath}`);
    console.log(`Questions: ${result.totalQuestions}`);
    console.log(`\nTo evaluate with official LongMemEval script:`);
    console.log(`  export OPENAI_API_KEY=$OPENAI_API_KEY`);
    console.log(`  cd ${dataDir}/longmemeval-repo/src/evaluation`);
    console.log(`  python3 evaluate_qa.py gpt-4o ${result.predictionsPath} ${join(dataDir, "longmemeval-repo/data/longmemeval_s_cleaned.json")}`);
  });

program.parse();
