import type { MemoryAdapter } from "../types.js";
import { CentralIntelligenceAdapter } from "./central-intelligence.js";
import { Mem0Adapter } from "./mem0.js";
import { HindsightAdapter } from "./hindsight.js";

export type ProviderName = "ci" | "mem0" | "hindsight";

export function createAdapter(provider: ProviderName, apiKey?: string, apiUrl?: string): MemoryAdapter {
  switch (provider) {
    case "ci":
      if (!apiKey) throw new Error("CI requires --api-key or CI_API_KEY env var");
      return new CentralIntelligenceAdapter(apiKey, apiUrl);
    case "mem0":
      if (!apiKey) throw new Error("Mem0 requires --api-key or MEM0_API_KEY env var");
      return new Mem0Adapter(apiKey, apiUrl);
    case "hindsight":
      return new HindsightAdapter(apiUrl);
    default:
      throw new Error(`Unknown provider: ${provider}`);
  }
}

export { CentralIntelligenceAdapter, Mem0Adapter, HindsightAdapter };
