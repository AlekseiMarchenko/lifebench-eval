import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface CheckpointData {
  lastIndex: number;
  storedIds: string[];
  updatedAt: string;
}

export function loadCheckpoint(path: string): CheckpointData | null {
  try {
    const raw = readFileSync(path, "utf-8");
    return JSON.parse(raw) as CheckpointData;
  } catch {
    return null;
  }
}

export function saveCheckpoint(path: string, data: CheckpointData): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2));
}
