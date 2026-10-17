import { routeAgentRequest } from "agents";
import { STT_MODEL } from "./lib/llm";

export { PilotAgent } from "./agent";
export { BriefingWorkflow } from "./workflows/briefing";
export { DebriefWorkflow } from "./workflows/debrief";

const MAX_AUDIO_BYTES = 4 * 1024 * 1024;

/** Push-to-talk: WAV from the browser -> Whisper -> text. */
async function transcribe(request: Request, env: Env): Promise<Response> {
  const audio = await request.arrayBuffer();
  if (audio.byteLength === 0 || audio.byteLength > MAX_AUDIO_BYTES) {
    return Response.json({ error: "Audio must be 1 byte – 4 MB" }, { status: 413 });
  }
  // Bias Whisper toward aviation vocabulary and this flight's callsign/airports.
  const hint = new URL(request.url).searchParams.get("hint")?.slice(0, 300) ?? "";
  const result = (await env.AI.run(STT_MODEL, {
    audio: toBase64(new Uint8Array(audio)),
    language: "en",
    vad_filter: true,
    initial_prompt:
      `Pilot radio call to air traffic control. ${hint} ` +
      "Runway two eight left, squawk four two one five, altimeter two niner niner two, " +
      "climb and maintain five thousand, information Alpha, ready to taxi, hold short."
  })) as { text?: string };
  return Response.json({ text: (result.text ?? "").trim() });
}

function toBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

export default {
  async fetch(request: Request, env: Env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/transcribe" && request.method === "POST") {
      try {
        return await transcribe(request, env);
      } catch (err) {
        console.error("transcribe failed", err);
        return Response.json({ error: "Transcription failed" }, { status: 500 });
      }
    }
    return (
      (await routeAgentRequest(request, env)) ??
      new Response("Not found", { status: 404 })
    );
  }
} satisfies ExportedHandler<Env>;
