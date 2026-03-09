import {
  callGatewayTool,
  extractDeliveryInfo,
  parseAgentSessionKey,
} from "openclaw/plugin-sdk/core";
import type { OpenClawPluginToolContext } from 'openclaw/plugin-sdk/lobster';
import { Type } from "@sinclair/typebox";

const SCHEDULE_ACTIONS = ["list", "add", "remove", "run"] as const;

const ScheduleKindSchema = Type.Unsafe<"at" | "every" | "cron">({
  type: "string",
  enum: ["at", "every", "cron"],
});

const ScheduleParamsSchema = Type.Object(
  {
    kind: Type.Optional(ScheduleKindSchema),
    at: Type.Optional(Type.String()),
    every: Type.Optional(Type.Number()),
    cron: Type.Optional(Type.String()),
    tz: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

const ScheduleToolSchema = Type.Object({
  action: Type.Union([
    Type.Literal("list"),
    Type.Literal("add"),
    Type.Literal("remove"),
    Type.Literal("run"),
  ]),
  job: Type.Optional(
    Type.Object({
      name: Type.String(),
      schedule: ScheduleParamsSchema,
      message: Type.String(),
    }),
  ),
  jobId: Type.Optional(Type.String()),
  includeDisabled: Type.Optional(Type.Boolean()),
});

type CronJob = { id: string; agentId?: string | null; [key: string]: unknown };
type CronListPage = { jobs: CronJob[]; total: number; offset: number; limit: number };
type CronDelivery = { mode: "announce"; channel?: string; to?: string; bestEffort?: boolean };

/** Strip only :thread: (Slack-style); keep :topic: so Telegram topic stays in the key for delivery.to. */
function stripThreadSuffixOnly(sessionKey: string): string {
  const normalized = sessionKey.toLowerCase();
  const idx = normalized.lastIndexOf(":thread:");
  if (idx <= 0) return sessionKey;
  const parent = sessionKey.slice(0, idx).trim();
  return parent || sessionKey;
}

/**
 * Infers cron announce delivery (channel + to) from an agent session key.
 */
function inferDeliveryFromSessionKey(sessionKey: string | undefined): CronDelivery | null {
  const raw = sessionKey?.trim();
  if (!raw) return null;

  const parsed = parseAgentSessionKey(raw);
  const parts = (parsed?.rest ?? "").split(":").filter(Boolean);
  if (parts.length === 0) {
    return null;
  };

  const head = parts[0]?.trim().toLowerCase();
  if (!head || head === "main" || head === "cron" || head === "subagent" || head === "acp") {
    return null;
  };

  const markerIndex = parts.findIndex(
    (p) => p === "direct" || p === "dm" || p === "group" || p === "channel",
  );
  if (markerIndex === -1) {
    return null
  };

  const { deliveryContext, threadId } = extractDeliveryInfo(raw);
  const channel = deliveryContext.channel?.trim().toLowerCase();
  let to = deliveryContext.to?.trim();
  if (channel === "telegram" && threadId && to && !to.includes(":topic:")) {
    const baseTo = to.replace(/^telegram:/, "").trim();
    to = `${baseTo}:${threadId}`;
  }

  if (!channel && !to) {
    return null;
  }

  const delivery: CronDelivery = { mode: "announce" };
  if (channel) delivery.channel = channel;
  if (to) delivery.to = to;
  return delivery;
}

function isJobForAgent(job: CronJob, agentId: string): boolean {
  return job.agentId && job.agentId === agentId;
}

async function listJobsForAgent(
  listParams: { includeDisabled?: boolean },
  gatewayOpts: { timeoutMs: number },
  agentId: string,
): Promise<CronJob[]> {
  const page = (await callGatewayTool("cron.list", gatewayOpts, listParams)) as CronListPage;
  return (page?.jobs ?? []).filter((job) => isJobForAgent(job, agentId));
}

export function createScheduleTool(ctx: OpenClawPluginToolContext) {
  const tool = {
    name: "agent-cron",
    label: "Agent cron",
    description: `Manage one-off and scheduled tasks (tasks, reminders, jobs, cron) for this agent. Use this for general reminders and tasks when the 'cron' tool is not available.

ACTIONS:
- list: List jobs for this agent. Use includeDisabled: true to include disabled jobs.
- add: Create a one-off or recurring job. Requires job with name, schedule, and message. Delivery target is inferred from the current chat (channel/to) when available; otherwise announce with no target.
- remove: Delete a job by jobId. Only jobs belonging to this agent can be removed.
- run: Run a job immediately by jobId (for testing). Only jobs belonging to this agent can be run.

JOB (for add action):
{
  "name": "<string, required>",
  "schedule": { ... },   // Required, see below
  "message": "<string, required>"   // Instruction to this agent when the job runs
}

Write "message" as instructions to yourself (the agent). For reminders, clearly ask yourself to reply to the end-user with the reminder text so it can be announced, not to explain scheduling details. Any output from the task will be delivered to the end-user.
Examples:
- "Respond to the user with: Reminder: time to stand up and stretch."
- "Tell the user: Reminder: join the daily standup meeting now."

SCHEDULE (job.schedule):
- "at": Run once at a specific time
  { "kind": "at", "at": "<ISO-8601 timestamp>" }
- "every": Run on an interval (milliseconds)
  { "kind": "every", "every": <interval-ms> }
- "cron": Run on a cron expression
  { "kind": "cron", "cron": "<cron-expression>", "tz": "<optional-timezone>" }`,
    parameters: ScheduleToolSchema,
    execute: async (_toolCallId: string, args: Record<string, unknown>) => {
      if (!ctx.agentId?.trim()) {
        throw new Error("agent-cron tool requires agentId in context");
      }
      if (!ctx.sessionKey?.trim()) {
        throw new Error("agent-cron tool requires sessionKey in context");
      }
      const agentId = ctx.agentId.trim();
      const sessionKey = ctx.sessionKey.trim();
      const gatewayOpts = { timeoutMs: 60_000 };
      const action = typeof args.action === "string" ? args.action.trim().toLowerCase() : "";
      if (!SCHEDULE_ACTIONS.includes(action as (typeof SCHEDULE_ACTIONS)[number])) {
        throw new Error(`action required: one of ${SCHEDULE_ACTIONS.join(", ")}`);
      }

      if (action === "list") {
        const includeDisabled = args.includeDisabled === true;
        const jobs = await listJobsForAgent(
          includeDisabled ? { includeDisabled: true } : {},
          gatewayOpts,
          agentId,
        );
        return {
          content: [{ type: "text", text: JSON.stringify({ jobs, total: jobs.length }, null, 2) }],
          details: { status: "ok" },
        };
      }

      if (action === "add") {
        const rawJob = args.job;
        if (!rawJob || typeof rawJob !== "object" || rawJob === null) {
          throw new Error("job required for add (name, schedule, message)");
        }
        const job = rawJob as Record<string, unknown>;
        const name =
          typeof job.name === "string" && job.name.trim()
            ? (job.name as string).trim()
            : "";
        if (!name) {
          throw new Error("job.name required");
        }
        const message =
          typeof job.message === "string" && job.message.trim()
            ? (job.message as string).trim()
            : "";
        if (!message) {
          throw new Error("job.message required");
        }

        const delivery: CronDelivery =
          inferDeliveryFromSessionKey(sessionKey) ?? { mode: "announce" };
        delivery.bestEffort = true;

        const rawSchedule = (rawJob as Record<string, unknown>).schedule;
        if (!rawSchedule || typeof rawSchedule !== "object" || rawSchedule === null) {
          throw new Error("job.schedule required");
        }
        const schedule =
          (() => {
            const s = rawSchedule as Record<string, unknown>;
            const out: Record<string, unknown> = { ...s };
            if (s.every !== undefined) {
              out.everyMs = s.every;
              delete out.every;
            }
            if (s.cron !== undefined) {
              out.expr = s.cron;
              delete out.cron;
            }
            return out;
          })();

        const jobCreate = {
          name,
          schedule,
          sessionTarget: "isolated" as const,
          payload: {
            kind: "agentTurn" as const,
            message,
          },
          agentId,
          sessionKey,
          delivery,
        };

        const added = (await callGatewayTool("cron.add", gatewayOpts, jobCreate)) as CronJob;
        return {
          content: [{ type: "text", text: JSON.stringify(added, null, 2) }],
          details: { status: "ok" },
        };
      }

      const jobId = args.jobId;
      const id = typeof jobId === "string" ? jobId.trim() : "";
      if (!id) {
        throw new Error("jobId required for remove and run");
      }

      const jobs = await listJobsForAgent(
        { includeDisabled: true },
        gatewayOpts,
        agentId,
      );
      const found = jobs.some((j) => j.id === id);
      if (!found) {
        throw new Error(`Job not found or not owned by this agent: ${id}`);
      }

      if (action === "remove") {
        await callGatewayTool("cron.remove", gatewayOpts, { id });
        return {
          content: [{ type: "text", text: JSON.stringify({ removed: id }, null, 2) }],
          details: { status: "ok" },
        };
      }

      if (action === "run") {
        const result = await callGatewayTool("cron.run", gatewayOpts, { id, mode: "force" });
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          details: { status: "ok" },
        };
      }

      throw new Error(`Unknown action: ${action}`);
    },
  };
  return tool;
}
