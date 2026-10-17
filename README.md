# cf_ai_atc_trainer — AI Air Traffic Control trainer

Practice pilot radio phraseology against an AI controller that uses **live, real-world weather**. File a flight plan, listen to the ATIS, then work your way from Clearance Delivery to Ground, Tower, Departure, Approach and back to Ground at your destination. You can type or use push-to-talk. The controller checks every readback, corrects mistakes the way a real controller would, and won't hand you off until you get it right. At the end, an instructor debrief grades your radio work and files it in your logbook. The controller then watches for the mistakes you've made before.

Built entirely on Cloudflare: Workers, Agents SDK (Durable Objects), Workflows, Workers AI (Llama 3.3 + Whisper) and static assets.

## How it maps to the assignment

| Requirement | Implementation |
| --- | --- |
| **LLM** | `@cf/meta/llama-3.3-70b-instruct-fp8-fast` on Workers AI. It plays each ATC facility in JSON mode, returning the radio reply, a readback evaluation, the handoff decision and any newly assigned values. It also writes the ATIS broadcasts and grades the post-flight debrief. |
| **Workflow / coordination** | **`PilotAgent`** (Agents SDK → Durable Object) runs the live session and the facility state machine. **`BriefingWorkflow`** (Cloudflare Workflows) fetches METARs and airport data from aviationweather.gov, picks the active runway from the wind, generates the clearance, has the LLM record each ATIS and delivers the briefing to the agent over RPC. **`DebriefWorkflow`** grades the flight and writes it to the logbook. Each step retries on its own and reports progress back to the UI. |
| **User input (chat / voice)** | React chat UI served as Workers static assets. Push-to-talk (button or Space bar) records audio, re-encodes it as 16 kHz WAV and sends it to `/api/transcribe`, which runs **Whisper large-v3-turbo** with an aviation-vocabulary prompt. ATC replies are spoken with browser speech synthesis. |
| **Memory / state** | Agent state, persisted in the Durable Object's SQLite and synced live over WebSocket: current facility, frequency, assigned squawk/altitude/heading/runway/taxi route, and the radio log. A **logbook** of past debriefs survives across flights, and its "work on" items are fed back into the ATC prompt. |

## Architecture

```
Browser (React)                          Cloudflare
───────────────                          ──────────────────────────────────────────────
Flight plan form ──callable RPC (WS)──▶  PilotAgent (Durable Object, one per pilot)
Radio log  ◀──── state sync (WS) ──────    • state: facility, assignments, transcript, logbook
Push-to-talk ─WAV─▶ /api/transcribe        • transmit() → Llama 3.3 (JSON mode) as ATC
                     └─ Whisper            • runWorkflow() ─┬─▶ BriefingWorkflow
Speech synthesis ◀── ATC text                               │     METAR/airport (aviationweather.gov)
                                                            │     → runway, clearance, ATIS (LLM)
                                                            │     → agent.applyBriefing()
                                                            └─▶ DebriefWorkflow
                                                                  grade (LLM) → agent.saveDebrief()
```

The model decides *what to say* and *whether a readback was correct*. Anything that must not be invented, such as the runway in use, squawk code, frequencies, altimeter and facility order, is computed in code (`src/lib/aviation.ts`) and handed to the model as ground truth. The agent also refuses to hand off after a failed readback, even if the model asks to.

### Code map

- `src/server.ts`: Worker entry. Agent routing and the Whisper endpoint.
- `src/agent.ts`: `PilotAgent`. Callable methods, the facility state machine, workflow callbacks.
- `src/workflows/briefing.ts`, `src/workflows/debrief.ts`: the Workflows.
- `src/lib/prompts.ts`: every LLM prompt and JSON schema.
- `src/lib/aviation.ts`: METAR/airport fetching, runway selection, frequencies, squawk codes.
- `src/client/`: React UI, push-to-talk capture and WAV encoding.

## Running it

Requirements: Node 20+ and a Cloudflare account. Workers AI runs remotely even in local dev, so you need to be logged in.

```bash
npm install
npx wrangler login
npm run dev          # http://localhost:5173
```

Deploy:

```bash
npm run deploy
```

### Try it

1. Keep the defaults (**Cessna 172SP, KPAO → KSJC, VFR**), or pick IFR and something like **KSFO → KOAK** to start with a full IFR clearance.
2. Click **Get briefing** and watch the workflow progress. Read or listen to the ATIS.
3. Make your first call, for example: *"Palo Alto Ground, Cessna 172SP at the main ramp with information Foxtrot, VFR to San Jose, ready to taxi."*
4. Read back the instructions. Leave out the hold-short or the squawk to see the controller catch it.
5. Keep going until you're parked at the destination, or click **End flight & debrief** at any time.

Any ICAO airport in the aviationweather.gov database works. The ATIS and tower frequencies come from the real data feed. Other frequencies fall back to plausible defaults when the feed doesn't list them. The en-route portion is skipped: Departure hands you straight to Approach.
