import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { LifeBenchMemory, LifeBenchQuestion, SourceType } from "../types.js";
import { getUserDataPath } from "./download.js";

// ---- Raw data shapes (discovered from LifeBench repo) ----

interface RawEvent {
  event_id?: string;
  id?: string;
  name?: string;
  title?: string;
  date?: string;
  start_time?: string;
  end_time?: string;
  type?: string;
  description?: string;
  participant?: string[] | string;
  participants?: string[] | string;
  location?: string;
  [key: string]: unknown;
}

interface RawSMS {
  datetime?: string;
  date?: string;
  time?: string;
  contact_name?: string;
  contact?: string;
  from?: string;
  to?: string;
  message_type?: string;
  type?: string;
  content?: string;
  message?: string;
  message_content?: string;
  [key: string]: unknown;
}

interface RawCalendar {
  datetime?: string;
  date?: string;
  start_time?: string;
  end_time?: string;
  title?: string;
  name?: string;
  description?: string;
  location?: string;
  [key: string]: unknown;
}

interface RawCall {
  datetime?: string;
  date?: string;
  time?: string;
  contact_name?: string;
  contact?: string;
  direction?: string | number;
  type?: string;
  duration?: string | number;
  [key: string]: unknown;
}

interface RawContact {
  name?: string;
  phone?: string;
  email?: string;
  relationship?: string;
  [key: string]: unknown;
}

interface RawFitness {
  date?: string;
  datetime?: string;
  [key: string]: unknown;
}

interface RawNote {
  datetime?: string;
  date?: string;
  title?: string;
  content?: string;
  [key: string]: unknown;
}

interface RawPhoto {
  datetime?: string;
  date?: string;
  description?: string;
  location?: string;
  [key: string]: unknown;
}

interface RawPush {
  datetime?: string;
  date?: string;
  app?: string;
  content?: string;
  title?: string;
  [key: string]: unknown;
}

interface RawChat {
  datetime?: string;
  date?: string;
  speaker?: string;
  role?: string;
  message?: string;
  content?: string;
  [key: string]: unknown;
}

// ---- Preprocessing functions ----

function safeReadJSON<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8"));
    return Array.isArray(raw) ? raw : [];
  } catch {
    console.warn(`Warning: could not parse ${path}`);
    return [];
  }
}

function participants(p: string[] | string | undefined): string {
  if (!p) return "";
  return Array.isArray(p) ? p.join(", ") : p;
}

function preprocessEvents(items: RawEvent[], userId: string): LifeBenchMemory[] {
  return items.map((e, i) => {
    const id = e.event_id || e.id || `event-${i}`;
    const date = e.date || "";
    const name = e.name || e.title || "Unnamed event";
    const parts = participants(e.participant || e.participants);
    const loc = e.location ? ` Location: ${e.location}.` : "";
    const desc = e.description ? ` ${e.description}` : "";
    const type = e.type ? ` Type: ${e.type}.` : "";
    const time = e.start_time
      ? e.end_time
        ? ` (${e.start_time}–${e.end_time})`
        : ` (${e.start_time})`
      : "";

    const content = `[${date}${time}] ${name}.${type}${desc}${parts ? ` Participants: ${parts}.` : ""}${loc}`;
    return { userId, sourceType: "event" as SourceType, sourceId: String(id), content, timestamp: date };
  });
}

function preprocessSMS(items: RawSMS[], userId: string): LifeBenchMemory[] {
  return items.map((s, i) => {
    const dt = s.datetime || s.date || "";
    const contact = s.contact_name || s.contact || s.from || s.to || "Unknown";
    const type = s.message_type || s.type || "";
    const msg = s.content || s.message || s.message_content || "";
    const content = `[SMS ${dt}] ${type ? type + " " : ""}${contact}: ${msg}`;
    return { userId, sourceType: "sms" as SourceType, sourceId: `sms-${i}`, content, timestamp: dt };
  });
}

function preprocessCalendar(items: RawCalendar[], userId: string): LifeBenchMemory[] {
  return items.map((c, i) => {
    // start_time/end_time are full datetime strings like "2025-11-18 09:00:00"
    const startTime = c.start_time || "";
    const endTime = c.end_time || "";
    const dt = startTime.split(" ")[0] || c.datetime || c.date || "";
    const timeRange = startTime && endTime ? ` ${startTime} to ${endTime}` : startTime ? ` ${startTime}` : "";
    const title = c.title || c.name || "Untitled";
    const desc = c.description ? ` ${c.description}` : "";
    const loc = c.location ? ` Location: ${formatLocation(c.location)}.` : "";
    const content = `[Calendar${timeRange}] ${title}.${desc}${loc}`;
    return { userId, sourceType: "calendar" as SourceType, sourceId: `cal-${i}`, content, timestamp: dt };
  });
}

function preprocessCalls(items: RawCall[], userId: string): LifeBenchMemory[] {
  return items.map((c, i) => {
    const dt = c.datetime || c.date || "";
    const dtEnd = (c as Record<string, unknown>).datetime_end as string || "";
    const contact = (c as Record<string, unknown>).contactName as string || c.contact_name || c.contact || "Unknown";
    // direction: 0 = outgoing, 1 = incoming (LifeBench convention)
    const dirRaw = c.direction;
    const dir = dirRaw === 0 || dirRaw === "0" ? "Outgoing" : dirRaw === 1 || dirRaw === "1" ? "Incoming" : String(dirRaw || "");
    const result = (c as Record<string, unknown>).call_result as string || "";
    const durStr = dtEnd && dt ? ` (${dt} to ${dtEnd})` : "";
    const content = `[Call ${dt}] ${dir} call with ${contact}${result ? `, ${result}` : ""}${durStr}`;
    return { userId, sourceType: "call" as SourceType, sourceId: `call-${i}`, content, timestamp: dt };
  });
}

function preprocessContacts(items: RawContact[], userId: string): LifeBenchMemory[] {
  return items.map((c, i) => {
    const parts = [c.name || "Unknown"];
    if (c.phone) parts.push(c.phone);
    if (c.email) parts.push(c.email);
    if (c.relationship) parts.push(`Relationship: ${c.relationship}`);
    const content = `[Contact] ${parts.join(". ")}`;
    return { userId, sourceType: "contact" as SourceType, sourceId: `contact-${i}`, content, timestamp: "" };
  });
}

function flattenObject(obj: unknown, prefix = ""): string[] {
  if (obj === null || obj === undefined) return [];
  if (typeof obj !== "object") return [prefix ? `${prefix}: ${obj}` : String(obj)];
  const parts: string[] = [];
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if (typeof v === "object" && v !== null && !Array.isArray(v)) {
      parts.push(...flattenObject(v, k));
    } else {
      parts.push(`${k}: ${v}`);
    }
  }
  return parts;
}

function preprocessFitness(items: RawFitness[], userId: string): LifeBenchMemory[] {
  return items.map((f, i) => {
    const dt = (f as Record<string, unknown>)["日期"] as string || f.date || f.datetime || "";
    const city = (f as Record<string, unknown>)["城市"] as string || "";
    // Deep-flatten nested objects (running, cycling, sleep, etc.)
    const metrics = Object.entries(f)
      .filter(([k]) => !["date", "datetime", "日期", "城市"].includes(k))
      .flatMap(([k, v]) => {
        if (typeof v === "object" && v !== null) {
          return flattenObject(v, k);
        }
        return [`${k}: ${v}`];
      })
      .join("; ");
    const content = `[Health ${dt}${city ? ` ${city}` : ""}] ${metrics}`;
    return { userId, sourceType: "fitness" as SourceType, sourceId: `fitness-${i}`, content, timestamp: dt };
  });
}

function preprocessNotes(items: RawNote[], userId: string): LifeBenchMemory[] {
  return items.map((n, i) => {
    const dt = n.datetime || n.date || "";
    const title = n.title ? `${n.title}: ` : "";
    const body = n.content || "";
    const content = `[Note ${dt}] ${title}${body}`;
    return { userId, sourceType: "note" as SourceType, sourceId: `note-${i}`, content, timestamp: dt };
  });
}

function formatLocation(loc: unknown): string {
  if (!loc) return "";
  if (typeof loc === "string") return loc;
  if (typeof loc === "object") {
    const l = loc as Record<string, unknown>;
    const parts = [l.poi, l.streetName, l.district, l.city, l.province].filter(Boolean);
    return parts.length > 0 ? parts.join(", ") : "";
  }
  return String(loc);
}

function preprocessPhotos(items: RawPhoto[], userId: string): LifeBenchMemory[] {
  return items.map((p, i) => {
    const dt = p.datetime || p.date || "";
    const desc = (p as Record<string, unknown>).caption as string || p.description || "No description";
    const loc = formatLocation(p.location);
    const content = `[Photo ${dt}] ${desc}.${loc ? ` Location: ${loc}.` : ""}`;
    return { userId, sourceType: "photo" as SourceType, sourceId: `photo-${i}`, content, timestamp: dt };
  });
}

function preprocessPush(items: RawPush[], userId: string): LifeBenchMemory[] {
  return items.map((p, i) => {
    const dt = p.datetime || p.date || "";
    const app = p.app || "App";
    const body = p.content || p.title || "";
    const content = `[Notification ${dt}] ${app}: ${body}`;
    return { userId, sourceType: "push" as SourceType, sourceId: `push-${i}`, content, timestamp: dt };
  });
}

function preprocessChat(items: RawChat[], userId: string): LifeBenchMemory[] {
  return items.map((c, i) => {
    const dt = c.datetime || c.date || "";
    // Agent chats may have nested conversation turns
    const conv = (c as Record<string, unknown>).conversation;
    let chatContent = "";
    if (conv && typeof conv === "object") {
      const turns = Object.entries(conv as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([_turnKey, turnData]) => {
          const turn = turnData as Record<string, unknown>;
          const parts: string[] = [];
          if (turn.user && typeof turn.user === "object") {
            const u = turn.user as Record<string, unknown>;
            parts.push(`User: ${u.content || ""}`);
          }
          if (turn.agent && typeof turn.agent === "object") {
            const a = turn.agent as Record<string, unknown>;
            parts.push(`Agent: ${a.content || ""}`);
          }
          return parts.join("\n");
        });
      chatContent = turns.join("\n");
    } else {
      const speaker = c.speaker || c.role || "User";
      const msg = c.message || c.content || "";
      chatContent = `${speaker}: ${msg}`;
    }
    // Truncate very long conversations to avoid memory bloat
    if (chatContent.length > 2000) {
      chatContent = chatContent.substring(0, 2000) + "...";
    }
    const content = `[Chat ${dt}] ${chatContent}`;
    return { userId, sourceType: "agent_chat" as SourceType, sourceId: `chat-${i}`, content, timestamp: dt };
  });
}

// ---- Main preprocessing ----

export interface PreprocessResult {
  memories: LifeBenchMemory[];
  questions: LifeBenchQuestion[];
  stats: Record<SourceType | "total", number>;
}

export function preprocessUser(dataDir: string, userId: string): PreprocessResult {
  const userPath = getUserDataPath(dataDir, userId);
  const cachePath = join(dataDir, `${userId}-preprocessed.json`);

  // Check cache
  if (existsSync(cachePath)) {
    console.log(`  Loading cached preprocessed data for ${userId}`);
    const cached = JSON.parse(readFileSync(cachePath, "utf-8")) as PreprocessResult;
    return cached;
  }

  console.log(`  Preprocessing data for ${userId}...`);

  const phonePath = join(userPath, "phone_data");

  // Process all source types
  const memories: LifeBenchMemory[] = [
    ...preprocessEvents(safeReadJSON(join(userPath, "daily_event.json")), userId),
    ...preprocessSMS(safeReadJSON(join(phonePath, "sms.json")), userId),
    ...preprocessCalendar(safeReadJSON(join(phonePath, "calendar.json")), userId),
    ...preprocessCalls(safeReadJSON(join(phonePath, "call.json")), userId),
    ...preprocessContacts(safeReadJSON(join(phonePath, "contact.json")), userId),
    ...preprocessFitness(safeReadJSON(join(phonePath, "fitness_health.json")), userId),
    ...preprocessNotes(safeReadJSON(join(phonePath, "note.json")), userId),
    ...preprocessPhotos(safeReadJSON(join(phonePath, "photo.json")), userId),
    ...preprocessPush(safeReadJSON(join(phonePath, "push.json")), userId),
    ...preprocessChat(safeReadJSON(join(phonePath, "agent_chat.json")), userId),
  ];

  // Load questions
  const qaPath = join(userPath, "QA", "QA_clean.json");
  const rawQuestions = safeReadJSON<Record<string, unknown>>(qaPath);
  const questions: LifeBenchQuestion[] = rawQuestions.map((q, i) => ({
    userId,
    index: i,
    question: String(q.question || q.Q || ""),
    answer: String(q.answer || q.A || ""),
    category: (q.questionType || q.question_type || q.category || q.type || "Information Extraction") as LifeBenchQuestion["category"],
    askTime: String(q.askTime || q.ask_time || ""),
    requiredEventsId: (q.requiredEventsId || q.required_events_id) as string[] | undefined,
    evidence: q.evidence as LifeBenchQuestion["evidence"],
  }));

  // Compute stats
  const stats: Record<string, number> = { total: memories.length };
  for (const m of memories) {
    stats[m.sourceType] = (stats[m.sourceType] || 0) + 1;
  }

  const result: PreprocessResult = {
    memories,
    questions,
    stats: stats as PreprocessResult["stats"],
  };

  // Cache
  mkdirSync(join(dataDir), { recursive: true });
  writeFileSync(cachePath, JSON.stringify(result));
  console.log(`  Preprocessed ${memories.length} memories, ${questions.length} questions for ${userId}`);

  return result;
}
