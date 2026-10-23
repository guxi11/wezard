type Row = Record<string, unknown>;

const pick = (row: Row, keys: string[]): Row => Object.fromEntries(keys
  .filter((key) => row[key] !== undefined)
  .map((key) => [key, row[key]]));

const dryRunReason = (row: Row): string => {
  const reason = typeof row.reason === "string" ? row.reason : "";
  const name = typeof row.name === "string" && row.name ? ` ${row.name}` : "";
  if (row.decision === "existing") return reason.startsWith("你点名了")
    ? `按指定目标${name}派发`
    : `复用有相关上下文的 wizard${name}`;
  if (reason.startsWith("你要了新的")) return "按要求启动新的 wizard";
  if (reason.startsWith("复杂活:")) return "为复杂任务启动 lead";
  return reason.includes("没有哪个已有 wizard")
    ? "没有找到相关的已有 wizard，采用白板 spawn"
    : "现有 wizard 均不满足复用条件，采用白板 spawn";
};

const wizardBriefs = (value: unknown): unknown => Array.isArray(value)
  ? value.map((item) => item && typeof item === "object" && !Array.isArray(item)
    ? pick(item as Row, ["name", "description", "expertise", "cwd"])
    : item)
  : value;

const planBrief = (value: unknown): unknown => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const plan = { ...(value as Row) };
  delete plan.reminder;
  return plan;
};

export const present = (tool: string, raw: unknown, input?: Row): unknown => {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const row = raw as Row;
  if (tool === "dispatch") {
    if (row.dryRun === true) return {
      ...pick(row, ["ok", "dryRun", "decision", "name", "tier"]),
      reason: dryRunReason(row),
    };
    const result = pick(row, ["ok", "name", "event", "eventId", "queued", "parked", "after", "decision", "tier", "model", "effort", "planId", "public", "transfer", "warnings", "warning", "modelWarning", "tierNote", "urgentDowngraded", "reUnknown", "gated"]);
    const fallback = row.diagnostics && typeof row.diagnostics === "object"
      ? (row.diagnostics as Row).deliveryFallback
      : undefined;
    if (typeof fallback === "string" && fallback) result.warnings = [...(Array.isArray(result.warnings) ? result.warnings : []), fallback];
    return result;
  }
  if (tool === "tell_peer" || tool === "send_peer") return pick(row, ["ok", "name", "event", "eventId", "queued", "priority", "wasBusy", "planId", "public", "transfer", "after", "parked", "warnings", "warning", "gated", "reason", "urgentDowngraded", "reUnknown"]);
  if (tool === "spawn_wizard" || tool === "clone_wizard") return pick(row, ["ok", "name", "cwd", "inherited", "model", "effort", "tier", "modelWarning", "tierNote", "dispatched", "queued", "event", "eventId", "planId", "warnings", "warning"]);
  if (tool === "wizard_identity") {
    const result: Row = { ...pick(row, ["ok", "name", "renamed"]) };
    if (input?.description !== undefined && String(input.description).trim()) result.description = row.description;
    if (input?.expertise !== undefined && String(input.expertise).trim())
      result.expertise = String(input.expertise).trim() === "-" ? "" : row.expertise;
    return result;
  }
  if (tool === "name_chat") return pick(row, ["ok", "name", "previous", "wizardRenamed"]);
  if (tool === "wizard_whoami") return {
    ...pick(row, ["ok", "name", "cwd", "pendingCwd", "model", "cli", "effort", "contextTokens", "handoffSuggested", "peers"]),
    ...(row.clones === undefined ? {} : { clones: wizardBriefs(row.clones) }),
  };
  if (tool === "route_candidates") return typeof row.text === "string"
    ? { text: row.text.replace("; diagnostics 保留全量。", "。") }
    : {};
  if (tool === "plan_create" || tool === "plan_get" || tool === "plan_update") return {
    ...pick(row, ["ok"]), ...(row.plan === undefined ? {} : { plan: planBrief(row.plan) }),
  };
  if (tool === "plan_list") return {
    ...pick(row, ["ok"]), ...(Array.isArray(row.plans) ? { plans: row.plans.map(planBrief) } : {}),
  };
  if (tool === "schedule_task") return {
    ...pick(row, ["ok", "id", "when", "next", "runIn", "quiet", "file", "error"]),
    ...((row.address ?? row.target) === undefined ? {} : { target: row.address ?? row.target }),
  };
  if (tool === "cancel_task") {
    const removed = row.removed && typeof row.removed === "object"
      ? pick(row.removed as Row, ["id", "when", "next", "lastFired", "note", "runIn", "quiet", "target", "owner", "file", "gate", "lastError", "pending", "loadError"])
      : row.removed;
    return { ...pick(row, ["ok", "id", "file", "error"]), ...(removed === undefined ? {} : { removed }) };
  }
  if (tool === "list_tasks") {
    const tasks = Array.isArray(row.tasks) ? row.tasks.map((item) => {
      if (!item || typeof item !== "object") return item;
      const task = { ...(item as Row) };
      delete task.self;
      delete task.target;
      return task;
    }) : row.tasks;
    return { ...pick(row, ["ok", "dir"]), ...(tasks === undefined ? {} : { tasks }) };
  }
  return raw;
};

export const recovery = (raw: Row): Row => {
  const internal = new Set(["ok", "reason", "error", "diagnostics", "hint", "receipt", "receipts", "target", "sessionId", "tmuxPane", "via", "body"]);
  const result = Object.fromEntries(Object.entries(raw).filter(([key]) => !internal.has(key)));
  if (Array.isArray(raw.candidates)) {
    result.candidates = raw.candidates.slice(0, 5);
    result.candidateTotal = raw.candidates.length;
    result.candidatesTruncated = raw.candidates.length > 5;
  }
  return result;
};
