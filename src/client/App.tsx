import { useAgent } from "agents/react";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import type { PilotAgent } from "../agent";
import {
  FACILITY_LABEL,
  facilityFrequency,
  type AirportBrief,
  type FlightPlan,
  type PilotState,
  type Transmission
} from "../shared";
import { PushToTalk, speak } from "./audio";

function pilotId(): string {
  try {
    let id = localStorage.getItem("atc-pilot-id");
    if (!id) {
      id = crypto.randomUUID();
      localStorage.setItem("atc-pilot-id", id);
    }
    return id;
  } catch {
    return "guest";
  }
}

export default function App() {
  const name = useMemo(pilotId, []);
  const agent = useAgent<PilotAgent, PilotState>({ agent: "PilotAgent", name });
  const state = agent.state;
  const [error, setError] = useState<string | null>(null);

  const run = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  if (!state) return <div className="loading">Connecting to the tower…</div>;

  const shownError = error ?? state.error;
  return (
    <div className="app">
      <header>
        <h1>
          <span className="logo">✈</span> ATC Trainer
        </h1>
        <span className="sub">Practice radio calls against an AI controller with live weather</span>
      </header>

      {shownError && <div className="error">{shownError}</div>}

      {(state.status === "idle" || state.status === "complete") && (
        <div className="grid">
          <div className="col">
            {state.status === "complete" && state.debrief && <DebriefCard state={state} />}
            <FlightForm
              initial={state.plan}
              onSubmit={(plan) => run(() => agent.stub.startFlight(plan))}
            />
          </div>
          <Logbook state={state} onClear={() => run(() => agent.stub.clearLogbook())} />
        </div>
      )}

      {(state.status === "briefing" || state.status === "debriefing") && (
        <div className="panel progress">
          <div className="spinner" />
          <p>{state.progress ?? "Working…"}</p>
          <small>
            {state.status === "briefing"
              ? "Briefing workflow: live METARs → runway selection → clearance → ATIS"
              : "Debrief workflow: grading your radio work → filing it in your logbook"}
          </small>
        </div>
      )}

      {state.status === "active" && state.briefing && state.plan && (
        <Cockpit
          state={state}
          onTransmit={(text) => run(() => agent.stub.transmit(text))}
          onEnd={() => run(() => agent.stub.endFlight())}
          onCancel={() => run(() => agent.stub.cancelFlight())}
          onError={setError}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

function FlightForm({
  initial,
  onSubmit
}: {
  initial: FlightPlan | null;
  onSubmit: (p: FlightPlan) => void;
}) {
  const [plan, setPlan] = useState<FlightPlan>(
    initial ?? {
      callsign: "Cessna 172SP",
      aircraft: "C172",
      departure: "KPAO",
      arrival: "KSJC",
      rules: "VFR"
    }
  );
  const set = (k: keyof FlightPlan) => (e: { target: { value: string } }) =>
    setPlan({ ...plan, [k]: e.target.value });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    onSubmit(plan);
  };
  return (
    <form className="panel form" onSubmit={submit}>
      <h2>File a flight plan</h2>
      <label>
        Callsign
        <input value={plan.callsign} onChange={set("callsign")} placeholder="N172SP" />
      </label>
      <label>
        Aircraft
        <input value={plan.aircraft} onChange={set("aircraft")} placeholder="C172" />
      </label>
      <div className="row">
        <label>
          From
          <input value={plan.departure} onChange={set("departure")} maxLength={4} placeholder="KPAO" />
        </label>
        <label>
          To
          <input value={plan.arrival} onChange={set("arrival")} maxLength={4} placeholder="KSJC" />
        </label>
      </div>
      <div className="seg">
        {(["VFR", "IFR"] as const).map((r) => (
          <button
            type="button"
            key={r}
            className={plan.rules === r ? "on" : ""}
            onClick={() => setPlan({ ...plan, rules: r })}
          >
            {r}
          </button>
        ))}
      </div>
      <small className="muted">
        {plan.rules === "IFR"
          ? "Starts with Clearance Delivery: you'll copy and read back a full IFR clearance."
          : "Starts with Ground: you'll get a squawk code and taxi instructions."}
      </small>
      <button className="primary" type="submit">
        Get briefing
      </button>
    </form>
  );
}

function Logbook({ state, onClear }: { state: PilotState; onClear: () => void }) {
  const entries = state.logbook;
  return (
    <div className="panel">
      <div className="panel-head">
        <h2>Logbook</h2>
        {entries.length > 0 && (
          <button className="link" onClick={onClear}>
            Clear
          </button>
        )}
      </div>
      {entries.length === 0 ? (
        <p className="muted">
          No flights yet. Your debriefs are saved here, and the controller uses them to
          watch for mistakes you've made before.
        </p>
      ) : (
        <ul className="logbook">
          {entries.map((e) => (
            <li key={e.flightId}>
              <span className={`score s${Math.floor(e.debrief.score / 25)}`}>{e.debrief.score}</span>
              <div>
                <strong>
                  {e.plan.departure} → {e.plan.arrival}
                </strong>{" "}
                <span className="muted">
                  {e.plan.rules} · {e.plan.callsign} · {new Date(e.date).toLocaleDateString()}
                </span>
                <div className="muted small">
                  {e.transmissions} calls, {e.readbackErrors} readback error
                  {e.readbackErrors === 1 ? "" : "s"}
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function DebriefCard({ state }: { state: PilotState }) {
  const d = state.debrief!;
  return (
    <div className="panel debrief">
      <div className="panel-head">
        <h2>Debrief</h2>
        <span className={`score big s${Math.floor(d.score / 25)}`}>{d.score}</span>
      </div>
      <p>{d.summary}</p>
      <div className="row top">
        <div>
          <h3>Strengths</h3>
          <ul>{d.strengths.map((s, i) => <li key={i}>{s}</li>)}</ul>
        </div>
        <div>
          <h3>Work on</h3>
          <ul>{d.improvements.map((s, i) => <li key={i}>{s}</li>)}</ul>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

function Cockpit({
  state,
  onTransmit,
  onEnd,
  onCancel,
  onError
}: {
  state: PilotState;
  onTransmit: (text: string) => Promise<void>;
  onEnd: () => void;
  onCancel: () => void;
  onError: (e: string) => void;
}) {
  const b = state.briefing!;
  const plan = state.plan!;
  const { airport, freq } = facilityFrequency(state.facility, b);
  const [text, setText] = useState("");
  const [voice, setVoice] = useState(true);
  const [recording, setRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const ptt = useRef<PushToTalk | null>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const spoken = useRef<string | null>(null);

  // Speak each new ATC transmission once.
  const lastAtc = [...state.transcript].reverse().find((t) => t.from === "atc");
  useEffect(() => {
    if (!lastAtc) return;
    if (spoken.current === null) {
      spoken.current = lastAtc.id; // don't replay history on reconnect
      return;
    }
    if (spoken.current !== lastAtc.id) {
      spoken.current = lastAtc.id;
      if (voice) speak(lastAtc.text);
    }
  }, [lastAtc?.id, voice]);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight, behavior: "smooth" });
  }, [state.transcript.length, state.atcBusy]);

  useEffect(() => () => ptt.current?.release(), []);

  const send = async (msg: string) => {
    if (!msg.trim() || state.atcBusy) return;
    setText("");
    await onTransmit(msg);
  };

  const startPtt = async () => {
    if (recording || transcribing || state.atcBusy) return;
    try {
      ptt.current ??= new PushToTalk();
      await ptt.current.start();
      speechSynthesis?.cancel();
      setRecording(true);
    } catch {
      onError("Microphone unavailable — check browser permissions, or type instead.");
    }
  };

  const stopPtt = async () => {
    if (!recording || !ptt.current) return;
    setRecording(false);
    setTranscribing(true);
    try {
      const wav = await ptt.current.stop();
      if (!wav) return;
      const hint = `Callsign ${plan.callsign}. ${airport.name}. Runway ${airport.activeRunway}. Information ${airport.atisLetter}.`;
      const res = await fetch(`/api/transcribe?hint=${encodeURIComponent(hint)}`, {
        method: "POST",
        headers: { "Content-Type": "audio/wav" },
        body: wav
      });
      const data = (await res.json()) as { text?: string; error?: string };
      if (!res.ok) throw new Error(data.error ?? "Transcription failed");
      if (data.text) await send(data.text);
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setTranscribing(false);
    }
  };

  // Hold Space to talk (when not typing).
  useEffect(() => {
    const isTyping = () => document.activeElement?.tagName === "INPUT";
    const down = (e: KeyboardEvent) => {
      if (e.code === "Space" && !e.repeat && !isTyping()) {
        e.preventDefault();
        void startPtt();
      }
    };
    const up = (e: KeyboardEvent) => {
      if (e.code === "Space" && !isTyping()) {
        e.preventDefault();
        void stopPtt();
      }
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
  });

  const a = state.assigned;
  return (
    <div className="grid cockpit">
      <div className="col">
        <div className="panel radio">
          <div className="com">
            <span className="label">COM1</span>
            <span className="freq">{freq}</span>
            <span className="facility">
              {airport.icao} {FACILITY_LABEL[state.facility]}
            </span>
          </div>
          <div className="xpdr">
            <Readout label="SQUAWK" value={a.squawk} />
            <Readout label="ALT" value={a.altitude?.toLocaleString()} />
            <Readout label="HDG" value={a.heading ? String(a.heading).padStart(3, "0") : undefined} />
            <Readout label="RWY" value={a.runway} />
          </div>
          {a.taxiRoute && (
            <div className="taxi">
              <span className="label">TAXI</span> {a.taxiRoute}
            </div>
          )}
        </div>

        <AtisCard title="Departure" a={b.departure} voice={voice} />
        <AtisCard title="Arrival" a={b.arrival} voice={voice} />

        <div className="row">
          <button onClick={onEnd}>End flight &amp; debrief</button>
          <button className="ghost" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </div>

      <div className="panel comms">
        <div className="panel-head">
          <h2>
            {plan.callsign} · {plan.departure} → {plan.arrival} {plan.rules}
          </h2>
          <label className="toggle">
            <input type="checkbox" checked={voice} onChange={(e) => setVoice(e.target.checked)} />
            ATC voice
          </label>
        </div>
        <div className="log" ref={logRef}>
          {state.transcript.map((t) => (
            <Bubble key={t.id} t={t} />
          ))}
          {state.atcBusy && <div className="bubble atc typing">…</div>}
        </div>
        <form
          className="composer"
          onSubmit={(e) => {
            e.preventDefault();
            void send(text);
          }}
        >
          <button
            type="button"
            className={`ptt ${recording ? "rec" : ""}`}
            onPointerDown={startPtt}
            onPointerUp={stopPtt}
            onPointerLeave={stopPtt}
            disabled={transcribing || state.atcBusy}
            title="Hold to talk (or hold Space)"
          >
            {recording ? "● TX" : transcribing ? "…" : "🎙 PTT"}
          </button>
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={`e.g. "${airport.name.split(" ")[0]} ${FACILITY_LABEL[state.facility]}, ${plan.callsign}, …"`}
            disabled={state.atcBusy}
          />
          <button className="primary" type="submit" disabled={state.atcBusy || !text.trim()}>
            Transmit
          </button>
        </form>
        <small className="muted hint">Hold the PTT button or the Space bar to talk; release to transmit.</small>
      </div>
    </div>
  );
}

function Readout({ label, value }: { label: string; value?: string }) {
  return (
    <div className="readout">
      <span className="label">{label}</span>
      <span className="value">{value ?? "----"}</span>
    </div>
  );
}

function AtisCard({ title, a, voice }: { title: string; a: AirportBrief; voice: boolean }) {
  const [open, setOpen] = useState(title === "Departure");
  return (
    <div className="panel atis">
      <div className="panel-head" onClick={() => setOpen(!open)}>
        <h3>
          {title}: {a.icao} <span className="muted">· {a.name}</span>
        </h3>
        <span className={`cat ${a.flightCategory}`}>{a.flightCategory}</span>
      </div>
      {open && (
        <>
          <div className="facts">
            <span>ATIS <b>{a.atisLetter}</b> {a.freqs.atis}</span>
            <span>RWY <b>{a.activeRunway}</b></span>
            <span>Wind <b>{a.wind}</b></span>
            <span>Alt <b>{a.altimeter}</b></span>
          </div>
          <p className="atis-text">{a.atisText}</p>
          <code className="metar">{a.metar}</code>
          <button className="link" onClick={() => (voice ? speak(a.atisText) : null)} disabled={!voice}>
            ▶ Listen to ATIS
          </button>
        </>
      )}
    </div>
  );
}

function Bubble({ t }: { t: Transmission }) {
  if (t.from === "system") return <div className="sys">{t.text}</div>;
  return (
    <div className={`bubble ${t.from}`}>
      <div className="who">{t.from === "pilot" ? "You" : FACILITY_LABEL[t.facility]}</div>
      <div>{t.text}</div>
      {t.from === "pilot" && t.readback && (
        <div className={`rb ${t.readback.correct ? "ok" : "bad"}`}>
          {t.readback.correct ? "✓ Readback correct" : "✗ Readback incorrect"}
          {t.readback.note && <span> — {t.readback.note}</span>}
        </div>
      )}
    </div>
  );
}
