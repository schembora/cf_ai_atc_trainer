// Types shared between the Worker (agent + workflows) and the React client.

export type FlightRules = "IFR" | "VFR";

export const FACILITIES = [
  "CLEARANCE",
  "GROUND",
  "TOWER",
  "DEPARTURE",
  "APPROACH",
  "ARRIVAL_TOWER",
  "ARRIVAL_GROUND"
] as const;
export type Facility = (typeof FACILITIES)[number];

export interface FlightPlan {
  callsign: string; // e.g. "N172SP" or "Speedbird 12"
  aircraft: string; // e.g. "C172"
  departure: string; // ICAO
  arrival: string; // ICAO
  rules: FlightRules;
}

export interface Frequencies {
  atis: string;
  clearance: string;
  ground: string;
  tower: string;
  departure: string;
  approach: string;
}

export interface AirportBrief {
  icao: string;
  name: string;
  metar: string;
  flightCategory: string;
  wind: string; // spoken, e.g. "060 at 4"
  altimeter: string; // "30.00" or "Q1033"
  activeRunway: string;
  atisLetter: string; // phonetic, e.g. "Alpha"
  atisText: string;
  freqs: Frequencies;
}

export interface Clearance {
  squawk: string;
  initialAltitude: number;
  expectCruise: number;
  route: string; // e.g. "as filed"
  departureFreq: string;
}

export interface Briefing {
  departure: AirportBrief;
  arrival: AirportBrief;
  clearance: Clearance;
}

export interface Readback {
  correct: boolean;
  note: string;
}

export interface Transmission {
  id: string;
  from: "pilot" | "atc" | "system";
  facility: Facility;
  text: string;
  ts: number;
  readback?: Readback;
}

export interface Assignments {
  altitude?: number;
  heading?: number;
  squawk?: string;
  runway?: string;
  taxiRoute?: string;
}

export interface Debrief {
  score: number; // 0-100
  summary: string;
  strengths: string[];
  improvements: string[];
}

export interface LogbookEntry {
  flightId: string;
  date: number;
  plan: FlightPlan;
  transmissions: number;
  readbackErrors: number;
  debrief: Debrief;
}

export type SessionStatus =
  | "idle"
  | "briefing"
  | "active"
  | "debriefing"
  | "complete";

export interface PilotState {
  status: SessionStatus;
  flightId: string | null;
  plan: FlightPlan | null;
  briefing: Briefing | null;
  progress: string | null; // human-readable workflow progress
  error: string | null;
  facility: Facility;
  assigned: Assignments;
  transcript: Transmission[];
  atcBusy: boolean;
  debrief: Debrief | null;
  logbook: LogbookEntry[]; // long-term memory across flights, newest first
}

export const INITIAL_STATE: PilotState = {
  status: "idle",
  flightId: null,
  plan: null,
  briefing: null,
  progress: null,
  error: null,
  facility: "CLEARANCE",
  assigned: {},
  transcript: [],
  atcBusy: false,
  debrief: null,
  logbook: []
};

export const FACILITY_LABEL: Record<Facility, string> = {
  CLEARANCE: "Clearance Delivery",
  GROUND: "Ground",
  TOWER: "Tower",
  DEPARTURE: "Departure",
  APPROACH: "Approach",
  ARRIVAL_TOWER: "Tower",
  ARRIVAL_GROUND: "Ground"
};

/** Which airport and frequency a facility belongs to. */
export function facilityFrequency(
  facility: Facility,
  b: Briefing
): { airport: AirportBrief; freq: string } {
  switch (facility) {
    case "CLEARANCE":
      return { airport: b.departure, freq: b.departure.freqs.clearance };
    case "GROUND":
      return { airport: b.departure, freq: b.departure.freqs.ground };
    case "TOWER":
      return { airport: b.departure, freq: b.departure.freqs.tower };
    case "DEPARTURE":
      return { airport: b.departure, freq: b.clearance.departureFreq };
    case "APPROACH":
      return { airport: b.arrival, freq: b.arrival.freqs.approach };
    case "ARRIVAL_TOWER":
      return { airport: b.arrival, freq: b.arrival.freqs.tower };
    case "ARRIVAL_GROUND":
      return { airport: b.arrival, freq: b.arrival.freqs.ground };
  }
}
