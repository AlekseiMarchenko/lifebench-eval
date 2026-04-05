import type { MemoryAdapter, MemoryEntry, StoreOptions, SearchOptions } from "../types.js";

export class HindsightAdapter implements MemoryAdapter {
  name = "Hindsight";
  capabilities = { multiAgent: false, scoping: false, temporalDecay: true };
  private apiUrl: string;
  private bankId: string;

  constructor(apiUrl: string = "http://localhost:8888", bankId: string = "default") {
    this.apiUrl = apiUrl;
    this.bankId = bankId;
  }

  private bankPath(): string {
    return `${this.apiUrl}/v1/default/banks/${this.bankId}`;
  }

  async initialize(): Promise<void> {
    try {
      const res = await fetch(`${this.apiUrl}/v1/default/banks`);
      if (!res.ok) throw new Error(`Banks list returned ${res.status}`);
    } catch (err) {
      throw new Error(
        `Hindsight not reachable at ${this.apiUrl}. ` +
          `Start it: docker run --rm -it -p 8888:8888 -p 9999:9999 ` +
          `-e HINDSIGHT_API_LLM_API_KEY=$OPENAI_API_KEY ` +
          `-v $HOME/.hindsight-docker:/home/hindsight/.pg0 ` +
          `ghcr.io/vectorize-io/hindsight:latest. ` +
          `Error: ${err instanceof Error ? err.message : err}`
      );
    }
  }

  async store(content: string, options?: StoreOptions): Promise<MemoryEntry> {
    const res = await fetch(`${this.bankPath()}/memories/retain`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content, tags: options?.tags || [], async: false }),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Hindsight retain failed (${res.status}): ${text}`);
    }

    const data = (await res.json()) as { units?: Array<{ id: string }> };
    const id = data.units?.[0]?.id || `hs-${Date.now()}`;
    return { id, content, createdAt: new Date().toISOString() };
  }

  async search(query: string, options?: SearchOptions): Promise<MemoryEntry[]> {
    const res = await fetch(`${this.bankPath()}/memories/recall`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, tags: options?.tags || [] }),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Hindsight recall failed (${res.status}): ${text}`);
    }

    const data = (await res.json()) as {
      memories?: Array<{ id: string; content: string; score?: number }>;
      units?: Array<{ id: string; content: string; score?: number }>;
    };
    const items = data.memories || data.units || [];
    return items.slice(0, options?.limit || 20).map((m) => ({
      id: m.id,
      content: m.content,
      score: m.score,
    }));
  }

  async delete(_id: string): Promise<boolean> {
    return true; // Hindsight only supports bulk delete
  }

  async cleanup(): Promise<void> {
    try {
      await fetch(`${this.bankPath()}/memories`, { method: "DELETE" });
    } catch {}
  }
}
