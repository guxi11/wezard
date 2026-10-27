import assert from "node:assert/strict";
import { carriesMsg, parseEnvelope, parseReminders, reminderLabel, renderReminder } from "../shared/reminder.js";

const envelope = '<system-reminder wezard="envelope" kind="peer" from=".b" scope="private" event="e7" receipt="1" status="done">\n</system-reminder>';
const delivery = (event: string): string => `\n<system-reminder wezard="receipt-delivery" event="${event}">\n</system-reminder>`;
const oldTranscript = `${envelope}${delivery("rcpt:e7:r1")}`;

assert.equal(parseEnvelope(oldTranscript)?.eventId, "rcpt:e7:r1", "legacy receipt-delivery supplies the event id");
assert.equal(parseEnvelope(`${envelope}${delivery("rcpt:earlier")}${delivery("rcpt:last")}`)?.eventId, "rcpt:last");
const oldDelivery = parseReminders(oldTranscript).find((r) => r.attrs.wezard === "receipt-delivery");
assert.equal(oldDelivery?.attrs.event, "rcpt:e7:r1", "unknown raw block remains visible to parseReminders");
assert.deepEqual(reminderLabel(oldDelivery!), { label: "msg", machine: true });
assert.equal(parseEnvelope(`${envelope.replace('scope="private"', 'scope="private" msg="route:new"')}${delivery("rcpt:e7:r1")}`)?.eventId, "route:new");

const currentEnvelope = renderReminder({ wezard: "envelope", kind: "peer", from: ".b", scope: "private", msg: "route:current" }, []);
assert.equal(parseEnvelope(currentEnvelope)?.eventId, "route:current", "current envelope msg supplies the event id");

const messageEvent = renderReminder({ wezard: "message-event", event: "route:old" }, []);
assert.equal(parseEnvelope(messageEvent), undefined, "message-event alone is not an envelope");
assert.equal(carriesMsg(messageEvent, "route:old"), true, "message-event identity is read by carriesMsg");
assert.deepEqual(reminderLabel(parseReminders(messageEvent)[0]!), { label: "msg", machine: true });
assert.equal(parseEnvelope(`${envelope}${messageEvent}`)?.eventId, undefined, "message-event does not supply Envelope.eventId");
assert.equal(parseEnvelope(`${currentEnvelope}${messageEvent}`)?.eventId, "route:current", "envelope.msg wins");

const legacy = "<system-reminder>legacy prose from `.b`</system-reminder>";
assert.equal(parseEnvelope(legacy), undefined, "prose does not supply envelope identity");
assert.deepEqual(reminderLabel(parseReminders(legacy)[0]!), { label: "reminder" });
