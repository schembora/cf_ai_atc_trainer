import { AgentWorkflow } from "agents/workflows";
import type { AgentWorkflowEvent, AgentWorkflowStep } from "agents/workflows";
import type { PilotAgent } from "../agent";
import { chatJson } from "../lib/llm";
import { DEBRIEF_SCHEMA, debriefPrompt } from "../lib/prompts";
import type { Debrief, FlightPlan, Transmission } from "../shared";

export type DebriefParams = {
  flightId: string;
  plan: FlightPlan;
  transcript: Transmission[];
};

/** Post-flight: grade the radio work and file it in the pilot's logbook. */
export class DebriefWorkflow extends AgentWorkflow<PilotAgent, DebriefParams> {
  async run(event: AgentWorkflowEvent<DebriefParams>, step: AgentWorkflowStep) {
    const { flightId, plan, transcript } = event.payload;

    await this.reportProgress({ message: "Instructor is reviewing your radio calls…" });
    const debrief = await step.do(
      "grade",
      { retries: { limit: 3, delay: "2 seconds", backoff: "exponential" } },
      async () => {
        const d = await chatJson<Debrief>(
          this.env.AI,
          debriefPrompt(plan, transcript),
          DEBRIEF_SCHEMA,
          700
        );
        return {
          score: Math.max(0, Math.min(100, Math.round(Number(d.score) || 0))),
          summary: String(d.summary ?? ""),
          strengths: (d.strengths ?? []).map(String).slice(0, 3),
          improvements: (d.improvements ?? []).map(String).slice(0, 3)
        } satisfies Debrief;
      }
    );

    await step.do("file-logbook", () => this.agent.saveDebrief(flightId, debrief));
    await step.reportComplete();
    return debrief;
  }
}
