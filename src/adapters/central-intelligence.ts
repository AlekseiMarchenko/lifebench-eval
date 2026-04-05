import type { MemoryAdapter, MemoryEntry, StoreOptions, SearchOptions } from "../types.js";

export class CentralIntelligenceAdapter implements MemoryAdapter {
  name = "Central Intelligence";
  capabilities = { multiAgent: true, scoping: true, temporalDecay: true };
  private apiKey: string;
  private apiUrl: string;

  constructor(apiKey: string, apiUrl: string = "https://central-intelligence-api.fly.dev") {
    this.apiKey = apiKey;
    this.apiUrl = apiUrl;
  }

  async initialize(): Promise<void> {
    const res = await fetch(`${this.apiUrl}/health`);
    if (!res.ok) throw new Error(`CI API health check failed: ${res.status}`);
  }

  async store(content: string, options?: StoreOptions): Promise<MemoryEntry> {
    const body: Record<string, unknown> = {
      content,
      agent_id: options?.agentId || "lifebench",
      tags: options?.tags || [],
      scope: options?.scope || "agent",
    };

    const res = await fetch(`${this.apiUrl}/memories/remember`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`CI store failed (${res.status}): ${text}`);
    }

    const data = (await res.json()) as {
      memory: { id: string; content: string; created_at: string };
    };

    return {
      id: data.memory.id,
      content: data.memory.content,
      createdAt: data.memory.created_at,
    };
  }

  async search(query: string, options?: SearchOptions): Promise<MemoryEntry[]> {
    const body: Record<string, unknown> = {
      query,
      agent_id: options?.agentId || "lifebench",
      limit: options?.limit || 20,
      scope: options?.scope,
    };

    const res = await fetch(`${this.apiUrl}/memories/recall`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`CI search failed (${res.status}): ${text}`);
    }

    const data = (await res.json()) as {
      memories: Array<{ id: string; content: string; score: number; created_at: string }>;
    };

    return data.memories.map((m) => ({
      id: m.id,
      content: m.content,
      score: m.score,
      createdAt: m.created_at,
    }));
  }

  async delete(id: string): Promise<boolean> {
    const res = await fetch(`${this.apiUrl}/memories/${id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${this.apiKey}` },
    });
    return res.ok;
  }

  async cleanup(): Promise<void> {
    // No-op for LifeBench — we keep the data for re-evaluation
  }
}
