import {
  FACILITIES,
  FACILITY_LABEL,
  facilityFrequency,
  type AirportBrief,
  type Briefing,
  type Facility,
  type FlightPlan,
  type LogbookEntry,
  type Transmission
} from "../shared";

// ---------------------------------------------------------------------------
// ATIS (used by the briefing workflow)

export function atisPrompt(a: AirportBrief, metar: string) {
  return [
    {
      role: "system" as const,
      content:
        "You write ATIS broadcasts for air traffic control. Output only the broadcast text, " +
        "no preamble. Follow the standard format: airport name, information letter, time (Zulu), " +
        "wind, visibility, sky condition, temperature/dewpoint, altimeter, runway in use, NOTAM-style " +
        "remarks if relevant, and end with 'Advise on initial contact you have information <letter>.' " +
        "Write numbers the way controllers speak them (e.g. 'one two thousand', 'niner'). " +
        "Keep it under 90 words."
    },
    {
      role: "user" as const,
      content: [
        `Airport: ${a.name} (${a.icao})`,
        `Information letter: ${a.atisLetter}`,
        `Raw METAR: ${metar}`,
        `Wind: ${a.wind}`,
        `Altimeter: ${a.altimeter}`,
        `Runway in use (landing and departing): ${a.activeRunway}`
      ].join("\n")
    }
  ];
}

// ---------------------------------------------------------------------------
// Live ATC

export interface AtcTurn {
  reply: string;
  readback: { evaluated: boolean; correct: boolean; note: string };
  handoff: boolean;
  flightComplete: boolean;
  assigned?: {
    altitude?: number;
    heading?: number;
    squawk?: string;
    runway?: string;
    taxiRoute?: string;
  };
}

export const ATC_SCHEMA = {
  type: "object",
  properties: {
    reply: {
      type: "string",
      description: "Exactly what the controller says on frequency."
    },
    readback: {
      type: "object",
      properties: {
        evaluated: { type: "boolean" },
        correct: { type: "boolean" },
        note: { type: "string" }
      },
      required: ["evaluated", "correct", "note"]
    },
    handoff: { type: "boolean" },
    flightComplete: { type: "boolean" },
    assigned: {
      type: "object",
      properties: {
        altitude: { type: "number" },
        heading: { type: "number" },
        squawk: { type: "string" },
        runway: { type: "string" },
        taxiRoute: { type: "string" }
      }
    }
  },
  required: ["reply", "readback", "handoff", "flightComplete"]
};

function nextFacility(f: Facility): Facility | null {
  const i = FACILITIES.indexOf(f);
  return i < FACILITIES.length - 1 ? FACILITIES[i + 1] : null;
}

/** What this controller is responsible for and when to hand the pilot off. */
function duties(f: Facility, plan: FlightPlan, b: Briefing): string {
  const dep = b.departure;
  const arr = b.arrival;
  const c = b.clearance;
  const vfr = plan.rules === "VFR";
  switch (f) {
    case "CLEARANCE":
      return [
        `The pilot will request their IFR clearance. Issue it in CRAFT order exactly with these values:`,
        `"${plan.callsign}, cleared to ${arr.icao} airport, ${c.route}, climb via runway heading, ` +
          `climb and maintain ${c.initialAltitude}, expect ${c.expectCruise} one zero minutes after departure, ` +
          `departure frequency ${c.departureFreq}, squawk ${c.squawk}."`,
        `If the pilot did not report the current ATIS (${dep.atisLetter}), add "information ${dep.atisLetter} is current, altimeter ${dep.altimeter}".`,
        `After the pilot reads the clearance back CORRECTLY, say "readback correct, contact Ground ${dep.freqs.ground} when ready to taxi" and set handoff=true.`
      ].join("\n");
    case "GROUND":
      return [
        `The pilot will call ready to taxi. Issue taxi instructions to runway ${dep.activeRunway} with a plausible ` +
          `taxiway route (2-3 taxiway letters spoken phonetically) and a hold-short instruction if one is needed.`,
        vfr
          ? `This is a VFR departure: also issue "squawk ${c.squawk}, departure frequency ${c.departureFreq}" and the altimeter ${dep.altimeter}.`
          : `The IFR clearance was already issued; do not reissue it.`,
        `Hold-short instructions and runway assignments MUST be read back. After a correct readback, ` +
          `say "contact Tower ${dep.freqs.tower} when ready at runway ${dep.activeRunway}" (or similar) and set handoff=true.`
      ].join("\n");
    case "TOWER":
      return [
        `The pilot is holding short of runway ${dep.activeRunway} ready for departure.`,
        `Clear them for takeoff: "${plan.callsign}, wind ${dep.wind}, runway ${dep.activeRunway}, cleared for takeoff" ` +
          `(optionally with a departure heading).`,
        `After a correct readback of the takeoff clearance, say "contact Departure ${c.departureFreq}" (as if they are now airborne) and set handoff=true.`
      ].join("\n");
    case "DEPARTURE":
      return [
        `The pilot checks in climbing to ${c.initialAltitude}. Respond "radar contact" and then climb them to ${c.expectCruise}.`,
        `After a correct readback, say "contact ${arr.name.split(",")[0]} Approach ${arr.freqs.approach}" ` +
          `and set handoff=true. (The simulator skips the en-route portion.)`
      ].join("\n");
    case "APPROACH":
      return [
        `The pilot checks in descending toward ${arr.icao}. Ask if they have information ${arr.atisLetter} if they didn't say so.`,
        `Issue a descent to 3000, the altimeter ${arr.altimeter}, and "expect the ${vfr ? "visual" : "ILS"} approach runway ${arr.activeRunway}". ` +
          `Optionally give a vector heading.`,
        `Once the pilot reads back correctly (or reports the field/localizer), clear them for the approach and say ` +
          `"contact Tower ${arr.freqs.tower}" and set handoff=true.`
      ].join("\n");
    case "ARRIVAL_TOWER":
      return [
        `The pilot checks in on final for runway ${arr.activeRunway}. Say "${plan.callsign}, ${arr.icao} Tower, wind ${arr.wind}, runway ${arr.activeRunway}, cleared to land".`,
        `After a correct landing clearance readback, the pilot lands. On their NEXT call (e.g. reporting clear of the runway), or immediately ` +
          `if the readback already confirms, say "turn left/right next available taxiway, contact Ground ${arr.freqs.ground}" and set handoff=true.`
      ].join("\n");
    case "ARRIVAL_GROUND":
      return [
        `The pilot has landed and is clear of runway ${arr.activeRunway}. Give taxi instructions to parking/the ramp via plausible taxiways.`,
        `After a correct readback, set flightComplete=true and reply with a short sign-off (e.g. "${plan.callsign}, readback correct, good day").`
      ].join("\n");
  }
}

function formatLog(transcript: Transmission[]): string {
  const recent = transcript.filter((t) => t.from !== "system").slice(-14);
  if (recent.length === 0) return "(no transmissions yet)";
  return recent
    .map(
      (t) =>
        `[${FACILITY_LABEL[t.facility]}] ${t.from === "pilot" ? "PILOT" : "ATC"}: ${t.text}`
    )
    .join("\n");
}

export function atcPrompt(opts: {
  facility: Facility;
  plan: FlightPlan;
  briefing: Briefing;
  transcript: Transmission[]; // excluding the new transmission
  pilotSaid: string;
  logbook: LogbookEntry[];
}) {
  const { facility, plan, briefing, transcript, pilotSaid, logbook } = opts;
  const { airport, freq } = facilityFrequency(facility, briefing);
  const next = nextFacility(facility);
  const weakSpots = logbook
    .slice(0, 3)
    .flatMap((l) => l.debrief.improvements)
    .slice(0, 5);

  const system = `You are a real-world air traffic controller working ${airport.name.split(",")[0]} ${FACILITY_LABEL[facility]} on ${freq}, inside a radio-phraseology training simulator. A student pilot is talking to you.

STAY IN CHARACTER in "reply": use concise, standard FAA/ICAO phraseology, start with the aircraft callsign, never explain the simulator, never use markdown. Speak numbers like a controller ("one two thousand", "niner", "two seven zero"). Keep replies to one or two short transmissions.

FLIGHT
- Callsign: ${plan.callsign} (${plan.aircraft}), ${plan.rules} from ${plan.departure} to ${plan.arrival}
- Departure ${briefing.departure.icao}: ATIS ${briefing.departure.atisLetter}, wind ${briefing.departure.wind}, altimeter ${briefing.departure.altimeter}, runway ${briefing.departure.activeRunway}
- Arrival ${briefing.arrival.icao}: ATIS ${briefing.arrival.atisLetter}, wind ${briefing.arrival.wind}, altimeter ${briefing.arrival.altimeter}, runway ${briefing.arrival.activeRunway}

YOUR JOB AS ${FACILITY_LABEL[facility].toUpperCase()}
${duties(facility, plan, briefing)}
${next ? "" : "This is the final facility of the flight."}

READBACK RULES
- If the pilot's transmission is a readback of your previous instruction, set readback.evaluated=true and check that it includes the callsign and every safety-critical item: altitudes, headings, runway assignments, hold-short / line-up-and-wait / takeoff / landing clearances, squawk codes, frequencies and altimeter settings.
- If anything is missing or wrong, set readback.correct=false, correct the pilot in "reply" (e.g. "negative, climb and maintain five thousand") and set handoff=false.
- If it is a request or check-in rather than a readback, set readback.evaluated=false.
- readback.note is a short, friendly instructor note to the student (outside the radio call). Empty string if nothing to say.
- If the pilot is unintelligible or off-topic, reply "${plan.callsign}, say again" or similar.
- Only set handoff=true when your duties above say to. Only set flightComplete=true as the Ground controller at the arrival airport.
${weakSpots.length ? `\nThis student has struggled with these before - watch for them and mention them in readback.note if they happen again:\n- ${weakSpots.join("\n- ")}` : ""}

In "assigned", include ONLY values you newly issued in this reply (altitude in feet, heading in degrees, squawk, runway, taxiRoute).
Respond with JSON only.`;

  const user = `Radio log so far:
${formatLog(transcript)}

New transmission from the pilot on ${freq}:
"${pilotSaid}"`;

  return [
    { role: "system" as const, content: system },
    { role: "user" as const, content: user }
  ];
}

// ---------------------------------------------------------------------------
// Debrief (used by the debrief workflow)

export const DEBRIEF_SCHEMA = {
  type: "object",
  properties: {
    score: { type: "number" },
    summary: { type: "string" },
    strengths: { type: "array", items: { type: "string" } },
    improvements: { type: "array", items: { type: "string" } }
  },
  required: ["score", "summary", "strengths", "improvements"]
};

export function debriefPrompt(plan: FlightPlan, transcript: Transmission[]) {
  const log = transcript
    .filter((t) => t.from !== "system")
    .map((t) => {
      const who = t.from === "pilot" ? "PILOT" : "ATC";
      const rb = t.readback
        ? ` (readback ${t.readback.correct ? "OK" : "INCORRECT"}${t.readback.note ? `: ${t.readback.note}` : ""})`
        : "";
      return `[${FACILITY_LABEL[t.facility]}] ${who}: ${t.text}${rb}`;
    })
    .join("\n");

  return [
    {
      role: "system" as const,
      content:
        "You are a flight instructor grading a student's radio communications from a simulator session. " +
        "Judge phraseology, brevity, correct callsign usage, complete readbacks of safety-critical items, " +
        "reporting ATIS on initial contact, and situational awareness. Score 0-100 (100 = airline-quality). " +
        "If the flight ended early, grade only what happened and mention that it was incomplete. " +
        "Give 1-3 strengths and 1-3 specific, actionable improvements (each under 20 words). " +
        "Summary is 2 sentences. Respond with JSON only."
    },
    {
      role: "user" as const,
      content: `Flight: ${plan.callsign} (${plan.aircraft}) ${plan.rules} ${plan.departure} -> ${plan.arrival}\n\nTranscript:\n${log || "(no transmissions)"}`
    }
  ];
}
