import OpenAI from "openai";

let client: OpenAI | null = null;

function getClient(): OpenAI {
  if (!client) {
    client = new OpenAI(); // Uses OPENAI_API_KEY env var
  }
  return client;
}

export interface LLMResponse {
  content: string;
  latencyMs: number;
}

export async function callLLM(
  model: string,
  systemPrompt: string,
  userPrompt: string
): Promise<LLMResponse> {
  const start = Date.now();
  const res = await getClient().chat.completions.create({
    model,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    temperature: 0,
    max_tokens: 1024,
  });
  const content = res.choices[0]?.message?.content?.trim() || "";
  return { content, latencyMs: Date.now() - start };
}
