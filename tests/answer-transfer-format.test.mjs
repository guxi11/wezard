import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { withLinkedTagHeader } from '../shared/session-label.ts';
import { installResponseTracker, getLastResponse } from '../daemon/last-response.ts';
import { buildChatUrl } from '../daemon/detail.ts';

// Exercise the real takeover implementation through the real SDK formatting
// wrapper: a raw mirror assertion alone cannot prove the receiver owns the link.
const source = readFileSync('daemon/mirror-bridge.ts', 'utf8');
const start = source.indexOf('  const answerBubbles =');
const end = source.indexOf('  // 收口一条 loading 气泡', start);
assert.ok(start > 0 && end > start);
const code = ts.transpileModule(source.slice(start, end) +
  '\nreturn { answerContext, prepareAnswer, takeAnswer, updateAnswerProgress, deliverAnswer };',
{ compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
const drain = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
const url = (target, turn) => buildChatUrl('https://handoff.test', 'localhost', 17890, turn, target, target);

for (const live of [false, true]) {
  const frame = { headers: { req_id: 'source-request' }, body: { chattype: 'single', from: { userid: 'transfer-format' } } };
  const owner = 'user:transfer-format#owner', receiver = 'user:transfer-format#receiver';
  const ticket = 'original-human-ticket', id = 'receiver-task';
  const calls = [], timers = new Map();
  const client = {
    isConnected: true,
    replyStream: async (f, stream, content, finish) => { calls.push({ kind: 'stream', f, stream, content, finish }); return {}; },
    replyStreamWithCard: async () => { throw new Error('unexpected card'); },
    sendMessage: async (chat, body) => { calls.push({ kind: 'standalone', chat, content: body.markdown.content }); return {}; },
  };
  installResponseTracker(client, undefined, () => true, () => ({ topOnly: true, url: url(owner, ticket) }));
  const a = {
    target: owner, channel: 'user:transfer-format', turnFromChat: true,
    briefTurnId: live ? undefined : ticket,
    briefBubble: live ? undefined : { frame, streamId: 'original-bubble', done: false },
    liveStream: live ? { frame, streamId: 'original-bubble', turnId: ticket, acc: 'OLD SOURCE CALLS', closed: false, dead: false } : undefined,
    cotLastSent: 'OLD SOURCE CALLS',
  };
  let timer = 0;
  const env = {
    byTarget: new Map([[owner, a]]), client, withLinkedTagHeader, chatTurnUrl: url,
    isPrivate: x => x.channel === '', baseOfKey: x => x.split('#')[0], clearCot: () => {},
    setTimeout: fn => { timers.set(++timer, fn); return timer; }, clearTimeout: n => timers.delete(n),
    COT_FLUSH_MS: 1, cotLine: text => text, cotToolLabel: calls => calls.map(c => c.name).join(' / '),
    log: { warn() {} }, errText: String,
  };
  const api = new Function(...Object.keys(env), code)(...Object.values(env));
  assert.equal(api.prepareAnswer(id, owner, ticket, receiver, a.channel), true);
  assert.deepEqual(await api.takeAnswer(id, owner, ticket, receiver, a.channel), { taken: true, cleared: true });
  await drain();
  const footer = ` [✦](${url(receiver, ticket)})`;
  assert.equal(calls[0].content, `…${footer}`, 'clear frame contains only receiver placeholder and link');
  assert.equal(calls[0].finish, false);
  api.updateAnswerProgress({ target: receiver, activePeerTurn: id }, { kind: 'thinking', body: 'RECEIVER PROGRESS' });
  for (const fn of timers.values()) fn();
  timers.clear();
  await drain();
  assert.equal(calls[1].content, `\`RECEIVER PROGRESS\`${footer}`);
  assert.equal(calls[1].finish, false);
  await api.deliverAnswer(id, receiver, ticket, 'user:transfer-format', 'LEGACY SAVED SOURCE', 'FINAL ONLY', false);
  assert.equal(calls[2].content, `FINAL ONLY${footer}`);
  assert.equal(calls[2].finish, true);
  assert.equal(calls.length, 3);
  for (const c of calls) {
    assert.equal(c.kind, 'stream');
    assert.equal(c.f, frame);
    assert.equal(c.stream, 'original-bubble');
    assert.doesNotMatch(c.content, /OLD SOURCE|LEGACY SAVED|\[\.owner\]|✨|\n/);
  }
  assert.equal(getLastResponse('user:transfer-format'), `FINAL ONLY${footer}`);
  // A daemon reload loses the stream frame, but retained legacy rows must not
  // restore source text through the standalone formatting path either.
  await api.deliverAnswer('recovered-task', receiver, ticket, 'user:transfer-format', 'LEGACY SAVED SOURCE', 'RECOVERED FINAL', false);
  assert.deepEqual(calls[3], { kind: 'standalone', chat: 'transfer-format', content: `RECOVERED FINAL${footer}` });
  assert.equal(getLastResponse('user:transfer-format'), `RECOVERED FINAL${footer}`);
}
console.log('answer transfer formatted SDK output: brief/nonbrief clear → receiver progress → final, same bubble and receiver inline footer passed');
