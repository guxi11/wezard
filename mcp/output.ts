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

// 派活回包的 `said`: 模型转述「已交给谁」时唯一该原样抄的一句。起因 (2026-11-25): 在 CodeBuddy
// 的 REPL 里 `await mcp.wezard.delegate(...)` 拿到的是**字符串** (实录: d = "{\"ok\":true,\"name\":\"TessDavis\",…}"),
// 模型写 `已经交给 .${d.name}` 就成 .undefined。名字在回包里一直是落定的 (claimSlot 出生前就分配),
// 问题只在读法 —— 所以回包自带一句现成的人话; 名字真缺时也给一句人话, 不再是 undefined / null 拼的句子。
const DISPATCH_TOOLS = new Set(["delegate", "chat_ask", "spawn_wizard", "clone_wizard"]);

const namelessSaid = (tool: string): string =>
  tool === "spawn_wizard" || tool === "clone_wizard"
    ? "已起了一个新的执行者 (名字稍后出现在名册里)"
    : "已交给一个刚起的执行者 (名字稍后出现在名册里)";

const dispatchSaid = (tool: string, source: Row): string => {
  const raw = [source.name, ...(Array.isArray(source.names) ? source.names : [])];
  const names = [...new Set(raw.filter((x): x is string => typeof x === "string" && x.trim() !== ""))];
  if (!names.length) return namelessSaid(tool);
  const who = names.map((n) => (n.startsWith("human:") ? `人 ${n.slice(6)}` : `.${n}`)).join(", ");
  return tool === "spawn_wizard" || tool === "clone_wizard" ? `已起了 ${who}` : `已交给 ${who}`;
};

/** 派活回包补上 `said`; 其余工具原样返回。`source` 是 daemon 的原始回包 (名字没被 pick 掉之前)。 */
const withSaid = (tool: string, picked: Row, source: Row): Row =>
  DISPATCH_TOOLS.has(tool) ? { ...picked, said: dispatchSaid(tool, source) } : picked;

const planBrief = (value: unknown): unknown => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const plan = { ...(value as Row) };
  delete plan.reminder;
  return plan;
};

export const present = (tool: string, raw: unknown, input?: Row): unknown => {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const row = raw as Row;
  if (tool === "delegate") {
    if (row.dryRun === true) return {
      ...pick(row, ["ok", "dryRun", "decision", "name", "tier"]),
      reason: dryRunReason(row),
    };
    const result = pick(row, ["ok", "name", "event", "eventId", "queued", "parked", "after", "decision", "tier", "model", "effort", "planId", "public", "transfer", "warnings", "warning", "modelWarning", "urgentDowngraded", "reUnknown", "gated"]);
    const fallback = row.diagnostics && typeof row.diagnostics === "object"
      ? (row.diagnostics as Row).deliveryFallback
      : undefined;
    if (typeof fallback === "string" && fallback) result.warnings = [...(Array.isArray(result.warnings) ? result.warnings : []), fallback];
    return withSaid("delegate", result, row);
  }
  // room 口子: 回包只留调用方接下来要用的 (哪一行、落在哪个 room、有没有降级)。
  // chat_ask 的 `name` / `names` 是 daemon 早已给回来的落定收件人名 (2026-11-25 发现这里一直把它们
  // pick 掉 —— 工具描述说有名字, 回包其实没有, 模型只能自己拼, 于是拼出 .undefined)。
  if (tool === "chat_ask")
    return withSaid("chat_ask", pick(row, ["ok", "room", "id", "seq", "name", "names", "duplicate", "degraded", "woke", "reason"]), row);
  if (tool === "chat_say" || tool === "chat_reply" || tool === "room_watch")
    return pick(row, ["ok", "room", "id", "seq", "status", "re", "duplicate", "degraded", "woke", "reason"]);
  if (tool === "room_open" || tool === "room_invite" || tool === "room_join" || tool === "room_approve" || tool === "room_leave" || tool === "room_activate" || tool === "notify" || tool === "send_file")
    return pick(row, ["ok", "room", "id", "msg", "to", "who", "members", "sent", "held", "bytes", "visible", "reason"]);
  if (tool === "spawn_wizard" || tool === "clone_wizard") return withSaid(tool, pick(row, ["ok", "name", "cwd", "inherited", "model", "effort", "tier", "modelWarning", "dispatched", "queued", "event", "eventId", "planId", "warnings", "warning"]), row);
  if (tool === "wizard_identity") {
    const result: Row = { ...pick(row, ["ok", "name", "renamed", "class", "note"]) };
    if (input?.description !== undefined && String(input.description).trim()) result.description = row.description;
    if (input?.expertise !== undefined && String(input.expertise).trim())
      result.expertise = String(input.expertise).trim() === "-" ? "" : row.expertise;
    return result;
  }
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
