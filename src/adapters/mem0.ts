import type { MemoryAdapter, MemoryEntry, StoreOptions, SearchOptions } from "../types.js";

export class Mem0Adapter implements MemoryAdapter {
  name = "Mem0";
  capabilities = { multiAgent: true, scoping: false, temporalDecay: false };
  private apiKey: string;
  private apiUrl: string;

  constructor(apiKey: string, apiUrl: string = "https://api.mem0.ai/v1") {
    this.apiKey = apiKey;
    this.apiUrl = apiUrl;
  }

  async initialize(): Promise<void> {
    const res = await fetch(`${this.apiUrl}/memories/`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Token ${this.apiKey}`,
      },
      body: JSON.stringify({
        messages: [{ role: "user", content: "test" }],
        user_id: "lifebench-health-check",
      }),
    });
    if (!res.ok && res.status !== 400) {
      throw new Error(`Mem0 API auth failed: ${res.status}`);
    }
  }

  async store(content: string, options?: StoreOptions): Promise<MemoryEntry> {
    const res = await fetch(`${this.apiUrl}/memories/`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Token ${this.apiKey}`,
      },
      body: JSON.stringify({
        messages: [{ role: "user", content }],
        user_id: options?.agentId || "lifebench",
      }),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Mem0 store failed (${res.status}): ${text}`);
    }

    const raw = (await res.json()) as
      | Array<{ id?: string; memory?: string; event?: string }>
      | { results: Array<{ id?: string; memory?: string; event?: string }> };

    const items = Array.isArray(raw) ? raw : raw.results || [];
    const added = items.find((r) => r.event === "ADD");
    const id = added?.id || `mem0-${Date.now()}`;

    return { id, content: added?.memory || content, createdAt: new Date().toISOString() };
  }

  async search(query: string, options?: SearchOptions): Promise<MemoryEntry[]> {
    const res = await fetch(`${this.apiUrl}/memories/search/`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Token ${this.apiKey}`,
      },
      body: JSON.stringify({
        query,
        user_id: options?.agentId || "lifebench",
        limit: options?.limit || 20,
      }),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Mem0 search failed (${res.status}): ${text}`);
    }

    const raw = (await res.json()) as
      | Array<{ id: string; memory: string; score: number; created_at: string }>
      | { results: Array<{ id: string; memory: string; score: number; created_at: string }> };

    const items = Array.isArray(raw) ? raw : raw.results || [];
    return items.map((m) => ({
      id: m.id,
      content: m.memory,
      score: m.score,
      createdAt: m.created_at,
    }));
  }

  async delete(id: string): Promise<boolean> {
    const res = await fetch(`${this.apiUrl}/memories/${id}/`, {
      method: "DELETE",
      headers: { Authorization: `Token ${this.apiKey}` },
    });
    return res.ok;
  }

  async cleanup(): Promise<void> {}
}
