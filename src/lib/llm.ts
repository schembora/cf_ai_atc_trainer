export const MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
export const STT_MODEL = "@cf/openai/whisper-large-v3-turbo";

type Message = { role: "system" | "user" | "assistant"; content: string };

function extractJson(raw: unknown): unknown {
  if (raw && typeof raw === "object") return raw; // JSON mode may pre-parse
  const text = String(raw ?? "");
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) throw new Error(`No JSON in: ${text}`);
  return JSON.parse(text.slice(start, end + 1));
}

/** Run Llama 3.3 in JSON mode and return the parsed object. */
export async function chatJson<T>(
  ai: Ai,
  messages: Message[],
  schema: object,
  maxTokens = 600
): Promise<T> {
  const out = (await ai.run(MODEL, {
    messages,
    max_tokens: maxTokens,
    temperature: 0.3,
    response_format: { type: "json_schema", json_schema: schema }
  })) as { response?: unknown };
  return extractJson(out.response) as T;
}

export async function chatText(
  ai: Ai,
  messages: Message[],
  maxTokens = 400
): Promise<string> {
  const out = (await ai.run(MODEL, {
    messages,
    max_tokens: maxTokens,
    temperature: 0.4
  })) as { response?: unknown };
  const text = String(out.response ?? "").trim();
  if (!text) throw new Error("Empty LLM response");
  return text;
}
