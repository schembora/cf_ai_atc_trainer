// Real-world aviation data from aviationweather.gov plus the deterministic
// bits of ATC (runway selection, squawk codes, ATIS letters) that we don't
// want an LLM to make up.

import type { Clearance, FlightRules, Frequencies } from "../shared";

const AWC = "https://aviationweather.gov/api/data";
const HEADERS = { "User-Agent": "cf_ai_atc_trainer (Cloudflare Workers)" };

export interface Metar {
  icaoId: string;
  name?: string;
  rawOb: string;
  wdir: number | "VRB" | null;
  wspd: number | null;
  wgst?: number | null;
  visib: string | number;
  altim: number; // hPa
  temp: number;
  dewp: number;
  clouds: { cover: string; base: number | null }[];
  fltCat?: string;
  obsTime: number;
}

export interface AirportInfo {
  icaoId: string;
  name: string;
  freqs?: string;
  runways?: { id: string; dimension?: string; alignment?: number | string }[];
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  const text = await res.text();
  if (!text.trim()) return [] as T; // AWC returns an empty body for unknown ids
  return JSON.parse(text) as T;
}

export async function fetchMetars(icaos: string[]): Promise<Metar[]> {
  return getJson<Metar[]>(
    `${AWC}/metar?ids=${icaos.join(",")}&format=json`
  );
}

export async function fetchAirports(icaos: string[]): Promise<AirportInfo[]> {
  return getJson<AirportInfo[]>(
    `${AWC}/airport?ids=${icaos.join(",")}&format=json`
  );
}

// ---------------------------------------------------------------------------
// Runway selection

interface RunwayEnd {
  id: string;
  heading: number; // true
  length: number;
}

function runwayEnds(airport: AirportInfo): RunwayEnd[] {
  const ends: RunwayEnd[] = [];
  for (const rwy of airport.runways ?? []) {
    const m = /^(\d{2}[LRC]?)\/(\d{2}[LRC]?)$/.exec(rwy.id);
    if (!m) continue; // helipads, water lanes, etc.
    const length = Number(rwy.dimension?.split("x")[0]) || 0;
    const align = Number(rwy.alignment);
    const base = Number.isFinite(align) ? align : Number(m[1].slice(0, 2)) * 10;
    ends.push({ id: m[1], heading: base % 360, length });
    ends.push({ id: m[2], heading: (base + 180) % 360, length });
  }
  return ends;
}

/** Pick the runway end with the most headwind; fall back to the longest. */
export function selectRunway(airport: AirportInfo, metar?: Metar): string {
  const ends = runwayEnds(airport);
  if (ends.length === 0) return "unknown";
  const wdir = typeof metar?.wdir === "number" ? metar.wdir : null;
  const wspd = metar?.wspd ?? 0;
  const score = (e: RunwayEnd) =>
    wdir === null || wspd < 3
      ? e.length
      : wspd * Math.cos(((wdir - e.heading) * Math.PI) / 180) * 1e5 + e.length;
  return ends.reduce((best, e) => (score(e) > score(best) ? e : best)).id;
}

// ---------------------------------------------------------------------------
// Formatting

export function spokenWind(m?: Metar): string {
  if (!m || !m.wspd) return "calm";
  const dir = m.wdir === "VRB" ? "variable" : String(m.wdir).padStart(3, "0");
  const gust = m.wgst ? ` gusting ${m.wgst}` : "";
  return `${dir} at ${m.wspd}${gust}`;
}

/** US-style inHg when the METAR reports "A2992", otherwise QNH in hPa. */
export function altimeter(m?: Metar): string {
  if (!m) return "unknown";
  const a = / A(\d{4})\b/.exec(m.rawOb);
  if (a) return `${a[1].slice(0, 2)}.${a[1].slice(2)}`;
  return `Q${Math.round(m.altim)}`;
}

const PHONETIC = [
  "Alpha", "Bravo", "Charlie", "Delta", "Echo", "Foxtrot", "Golf", "Hotel",
  "India", "Juliet", "Kilo", "Lima", "Mike", "November", "Oscar", "Papa",
  "Quebec", "Romeo", "Sierra", "Tango", "Uniform", "Victor", "Whiskey",
  "X-ray", "Yankee", "Zulu"
];

/** ATIS letters advance hourly, so derive one from the observation time. */
export function atisLetter(m?: Metar): string {
  const hours = Math.floor((m?.obsTime ?? Date.now() / 1000) / 3600);
  return PHONETIC[hours % PHONETIC.length];
}

// ---------------------------------------------------------------------------
// Frequencies

const DEFAULT_FREQS: Frequencies = {
  atis: "127.85",
  clearance: "118.20",
  ground: "121.70",
  tower: "118.70",
  departure: "124.35",
  approach: "125.35"
};

/** 120.5 -> "120.50", 124.725 -> "124.725" */
function fmtFreq(f: number): string {
  return Math.abs(f * 100 - Math.round(f * 100)) < 1e-6
    ? f.toFixed(2)
    : f.toFixed(3);
}

/**
 * The AWC airport feed only lists a few frequencies (usually ATIS and tower).
 * Use real ones where available and plausible defaults for the rest.
 */
export function parseFrequencies(airport?: AirportInfo): Frequencies {
  const freqs = { ...DEFAULT_FREQS };
  if (!airport?.freqs) return freqs;
  const vhf = (types: string[]) =>
    airport
      .freqs!.split(";")
      .map((p) => p.split(","))
      .filter(([t, f]) => types.includes(t) && +f >= 118 && +f < 137)
      .map(([, f]) => fmtFreq(+f))[0];
  freqs.atis = vhf(["D-ATIS", "ATIS"]) ?? freqs.atis;
  freqs.tower = vhf(["LCL/P", "TWR"]) ?? freqs.tower;
  freqs.ground = vhf(["GND/P", "GND"]) ?? freqs.ground;
  freqs.clearance = vhf(["CD/P", "CD", "CLNC DEL"]) ?? freqs.clearance;
  freqs.departure = vhf(["DEP/P", "DEP"]) ?? freqs.departure;
  freqs.approach = vhf(["APCH/P", "APP", "APCH"]) ?? freqs.approach;
  return freqs;
}

// ---------------------------------------------------------------------------
// Clearance

/** Random discrete transponder code: octal digits, avoiding special codes. */
function squawk(): string {
  const reserved = new Set(["1200", "7000", "7500", "7600", "7700", "2000"]);
  for (;;) {
    const code = Array.from({ length: 4 }, () =>
      Math.floor(Math.random() * 8)
    ).join("");
    if (!reserved.has(code) && code[0] !== "0") return code;
  }
}

export function makeClearance(
  rules: FlightRules,
  freqs: Frequencies
): Clearance {
  const ifr = rules === "IFR";
  return {
    squawk: squawk(),
    initialAltitude: ifr ? 5000 : 3500,
    expectCruise: ifr ? [7000, 9000, 11000][Math.floor(Math.random() * 3)] : 5500,
    route: ifr ? "as filed" : "VFR flight following",
    departureFreq: freqs.departure
  };
}
