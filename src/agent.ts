import { Agent, callable } from "agents";
import { chatJson } from "./lib/llm";
import { ATC_SCHEMA, atcPrompt, type AtcTurn } from "./lib/prompts";
import {
  FACILITIES,
  FACILITY_LABEL,
  INITIAL_STATE,
  facilityFrequency,
  type Briefing,
  type Debrief,
  type Facility,
  type FlightPlan,
  type PilotState,
  type Transmission
} from "./shared";

const MAX_LOGBOOK = 20;
const MAX_TRANSCRIPT = 120;

/**
 * One instance per pilot (named by a random id the browser keeps). Holds the
 * active flight — current ATC facility, clearance, assignments, radio log —
 * and a logbook of past debriefs that feeds back into the ATC prompt.
 */
export class PilotAgent extends Agent<Env, PilotState> {
  initialState = INITIAL_STATE;

  // -------------------------------------------------------------------------
  // Client-callable

  @callable()
  async startFlight(input: FlightPlan) {
    if (this.state.status === "briefing" || this.state.status === "debriefing") {
      throw new Error("Busy — wait for the current briefing/debrief to finish");
    }
    const plan = normalizePlan(input);
    const flightId = crypto.randomUUID();
    this.setState({
      ...INITIAL_STATE,
      logbook: this.state.logbook,
      status: "briefing",
      flightId,
      plan,
      progress: "Filing flight plan…",
      facility: plan.rules === "IFR" ? "CLEARANCE" : "GROUND"
    });
    await this.runWorkflow("BRIEFING_WORKFLOW", { flightId, plan });
  }

  @callable()
  async transmit(raw: string) {
    const text = String(raw ?? "").trim().slice(0, 500);
    const s = this.state;
    if (!text) return;
    if (s.status !== "active" || !s.plan || !s.briefing) {
      throw new Error("No active flight");
    }
    if (s.atcBusy) throw new Error("Frequency busy — wait for ATC to finish");

    const facility = s.facility;
    const pilot: Transmission = {
      id: crypto.randomUUID(),
      from: "pilot",
      facility,
      text,
      ts: Date.now()
    };
    this.setState({
      ...s,
      atcBusy: true,
      transcript: [...s.transcript, pilot].slice(-MAX_TRANSCRIPT)
    });

    let turn: AtcTurn;
    try {
      turn = await chatJson<AtcTurn>(
        this.env.AI,
        atcPrompt({
          facility,
          plan: s.plan,
          briefing: s.briefing,
          transcript: s.transcript,
          pilotSaid: text,
          logbook: s.logbook
        }),
        ATC_SCHEMA
      );
    } catch (err) {
      console.error("ATC LLM error", err);
      this.appendSystem("(Frequency congested — no response. Try that call again.)");
      return;
    }

    // The flight may have been cancelled while we waited on the model.
    const now = this.state;
    if (now.flightId !== s.flightId || now.status !== "active") return;

    const readback = turn.readback?.evaluated
      ? { correct: !!turn.readback.correct, note: String(turn.readback.note ?? "") }
      : undefined;
    const atc: Transmission = {
      id: crypto.randomUUID(),
      from: "atc",
      facility,
      text: String(turn.reply ?? "").trim() || `${s.plan.callsign}, say again.`,
      ts: Date.now()
    };

    // Never let the model hand off past a failed readback.
    const advance = !!turn.handoff && readback?.correct !== false;
    const next = advance ? nextFacility(facility) : facility;
    const transcript = now.transcript.map((t) =>
      t.id === pilot.id ? { ...t, readback } : t
    );
    transcript.push(atc);
    if (advance && next) {
      const { freq } = facilityFrequency(next, s.briefing);
      transcript.push(systemMsg(next, `Tuned ${FACILITY_LABEL[next]} ${freq}`));
    }

    this.setState({
      ...now,
      atcBusy: false,
      facility: next ?? facility,
      assigned: { ...now.assigned, ...cleanAssigned(turn.assigned) },
      transcript: transcript.slice(-MAX_TRANSCRIPT)
    });

    const lastFacility = facility === FACILITIES[FACILITIES.length - 1];
    if ((turn.flightComplete && lastFacility) || (advance && !next)) {
      await this.finishFlight();
    }
  }

  /** End the flight early and get a debrief on what was flown so far. */
  @callable()
  async endFlight() {
    if (this.state.status !== "active") return;
    await this.finishFlight();
  }

  /** Abandon the current flight without a debrief. */
  @callable()
  cancelFlight() {
    this.setState({ ...INITIAL_STATE, logbook: this.state.logbook });
  }

  @callable()
  clearLogbook() {
    this.setState({ ...this.state, logbook: [] });
  }

  // -------------------------------------------------------------------------
  // Called by workflows over RPC

  async applyBriefing(flightId: string, briefing: Briefing) {
    const s = this.state;
    if (s.flightId !== flightId || s.status !== "briefing") return;
    const { freq } = facilityFrequency(s.facility, briefing);
    this.setState({
      ...s,
      status: "active",
      briefing,
      progress: null,
      transcript: [
        systemMsg(
          s.facility,
          `Briefing ready. Listen to ATIS ${briefing.departure.atisLetter}, then call ${FACILITY_LABEL[s.facility]} on ${freq}.`
        )
      ]
    });
  }

  async saveDebrief(flightId: string, debrief: Debrief) {
    const s = this.state;
    if (s.flightId !== flightId || !s.plan) return;
    const pilotCalls = s.transcript.filter((t) => t.from === "pilot");
    this.setState({
      ...s,
      status: "complete",
      progress: null,
      debrief,
      logbook: [
        {
          flightId,
          date: Date.now(),
          plan: s.plan,
          transmissions: pilotCalls.length,
          readbackErrors: pilotCalls.filter((t) => t.readback?.correct === false).length,
          debrief
        },
        ...s.logbook.filter((l) => l.flightId !== flightId)
      ].slice(0, MAX_LOGBOOK)
    });
  }

  // -------------------------------------------------------------------------
  // Workflow lifecycle hooks

  async onWorkflowProgress(_name: string, _id: string, progress: unknown) {
    const message = (progress as { message?: string })?.message;
    if (message) this.setState({ ...this.state, progress: message });
  }

  async onWorkflowComplete(_name: string, instanceId: string) {
    this.deleteWorkflow(instanceId);
  }

  async onWorkflowError(name: string, _id: string, error: string) {
    console.error(`${name} failed:`, error);
    const s = this.state;
    if (name === "BRIEFING_WORKFLOW" && s.status === "briefing") {
      this.setState({ ...s, status: "idle", progress: null, error: `Briefing failed: ${error}` });
    } else if (name === "DEBRIEF_WORKFLOW" && s.status === "debriefing") {
      this.setState({ ...s, status: "complete", progress: null, error: `Debrief failed: ${error}` });
    }
  }

  // -------------------------------------------------------------------------

  private async finishFlight() {
    const s = this.state;
    if (!s.plan || !s.flightId) return;
    this.setState({ ...s, status: "debriefing", progress: "Shutting down…" });
    await this.runWorkflow("DEBRIEF_WORKFLOW", {
      flightId: s.flightId,
      plan: s.plan,
      transcript: s.transcript
    });
  }

  private appendSystem(text: string) {
    const s = this.state;
    this.setState({
      ...s,
      atcBusy: false,
      transcript: [...s.transcript, systemMsg(s.facility, text)].slice(-MAX_TRANSCRIPT)
    });
  }
}

function systemMsg(facility: Facility, text: string): Transmission {
  return { id: crypto.randomUUID(), from: "system", facility, text, ts: Date.now() };
}

function nextFacility(f: Facility): Facility | null {
  const i = FACILITIES.indexOf(f);
  return i < FACILITIES.length - 1 ? FACILITIES[i + 1] : null;
}

function normalizePlan(p: FlightPlan): FlightPlan {
  const icao = (v: unknown) => {
    const s = String(v ?? "").trim().toUpperCase();
    if (!/^[A-Z0-9]{3,4}$/.test(s)) throw new Error(`Invalid airport code "${s}"`);
    return s;
  };
  const callsign = String(p?.callsign ?? "").trim().slice(0, 24);
  if (!callsign) throw new Error("Callsign required");
  const departure = icao(p.departure);
  const arrival = icao(p.arrival);
  if (departure === arrival) throw new Error("Departure and arrival must differ");
  return {
    callsign,
    aircraft: String(p.aircraft ?? "").trim().slice(0, 16) || "C172",
    departure,
    arrival,
    rules: p.rules === "VFR" ? "VFR" : "IFR"
  };
}

function cleanAssigned(a: AtcTurn["assigned"]): PilotState["assigned"] {
  if (!a || typeof a !== "object") return {};
  const out: PilotState["assigned"] = {};
  if (Number.isFinite(a.altitude) && a.altitude! > 0) out.altitude = Math.round(a.altitude!);
  if (Number.isFinite(a.heading) && a.heading! > 0) out.heading = Math.round(a.heading!) % 360 || 360;
  if (a.squawk && /^[0-7]{4}$/.test(String(a.squawk))) out.squawk = String(a.squawk);
  if (a.runway) out.runway = String(a.runway).slice(0, 8);
  if (a.taxiRoute) out.taxiRoute = String(a.taxiRoute).slice(0, 80);
  return out;
}
