import { NonRetryableError } from "cloudflare:workflows";
import { AgentWorkflow } from "agents/workflows";
import type { AgentWorkflowEvent, AgentWorkflowStep } from "agents/workflows";
import type { PilotAgent } from "../agent";
import {
  altimeter,
  atisLetter,
  fetchAirports,
  fetchMetars,
  makeClearance,
  parseFrequencies,
  selectRunway,
  spokenWind,
  type AirportInfo,
  type Metar
} from "../lib/aviation";
import { chatText } from "../lib/llm";
import { atisPrompt } from "../lib/prompts";
import type { AirportBrief, Briefing, FlightPlan } from "../shared";

export type BriefingParams = { flightId: string; plan: FlightPlan };

const RETRY = {
  retries: { limit: 3, delay: "2 seconds", backoff: "exponential" },
  timeout: "30 seconds"
} as const;

/**
 * Pre-flight briefing: pull live weather and airport data, work out the
 * active runways, generate the clearance, have the LLM write each ATIS, then
 * hand the finished briefing back to the pilot's agent.
 */
export class BriefingWorkflow extends AgentWorkflow<PilotAgent, BriefingParams> {
  async run(event: AgentWorkflowEvent<BriefingParams>, step: AgentWorkflowStep) {
    const { flightId, plan } = event.payload;
    const icaos = [plan.departure, plan.arrival];

    await this.reportProgress({ message: "Fetching METARs…" });
    const metars = await step.do("fetch-metars", RETRY, () => fetchMetars(icaos));

    await this.reportProgress({ message: "Looking up airports and runways…" });
    const airports = await step.do("fetch-airports", RETRY, async () => {
      const found = await fetchAirports(icaos);
      for (const icao of icaos) {
        if (!found.some((a) => a.icaoId === icao)) {
          throw new NonRetryableError(`Unknown airport ${icao}`);
        }
      }
      return found;
    });

    // Random values (squawk, cruise altitude) live inside a step so retries
    // and replays see the same clearance.
    const briefs = await step.do("build-briefing", async () => {
      const build = (icao: string) =>
        airportBrief(
          airports.find((a) => a.icaoId === icao)!,
          metars.find((m) => m.icaoId === icao)
        );
      const departure = build(plan.departure);
      const arrival = build(plan.arrival);
      return {
        departure,
        arrival,
        clearance: makeClearance(plan.rules, departure.freqs)
      } satisfies Briefing;
    });

    for (const key of ["departure", "arrival"] as const) {
      const a = briefs[key];
      await this.reportProgress({ message: `Recording ATIS ${a.atisLetter} at ${a.icao}…` });
      a.atisText = await step.do(`atis-${a.icao}-${key}`, RETRY, () =>
        chatText(this.env.AI, atisPrompt(a, a.metar))
      );
    }

    await step.do("deliver-briefing", () =>
      this.agent.applyBriefing(flightId, briefs)
    );
    await step.reportComplete();
    return briefs;
  }
}

function airportBrief(info: AirportInfo, metar?: Metar): AirportBrief {
  return {
    icao: info.icaoId,
    name: titleCase(metar?.name ?? info.name),
    metar: metar?.rawOb ?? "METAR unavailable",
    flightCategory: metar?.fltCat ?? "unknown",
    wind: spokenWind(metar),
    altimeter: altimeter(metar),
    activeRunway: selectRunway(info, metar),
    atisLetter: atisLetter(metar),
    atisText: "",
    freqs: parseFrequencies(info)
  };
}

function titleCase(s: string): string {
  const t = s.trim();
  return t === t.toUpperCase()
    ? t.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase())
    : t;
}
