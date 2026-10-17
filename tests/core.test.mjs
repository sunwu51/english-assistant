import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DEFAULTS, contextFromMessages, protectLiterals, restoreLiterals, normalizeReplyMarkdown, replySegments, replyRequest, responseJson, eligibleDraft, choicesFor, validateDraft, hasComposerReferences, parseConfig, draftRequest, requestHeaders, normalizedUsage } from '../hooks/core.js';
import { register } from '../hooks/register.js';
import { parseMarkdownTable, renderTerminalTable } from '../hooks/table-layout.js';

function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
function apiResponse(value, usage) { return { ok: true, status: 200, text: JSON.stringify({ status: 'completed', usage, output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(value) }] }] }) }; }
function zhAnalysis(text = 'Please inspect this function.') { return { sourceLanguage: 'zh', translationLanguage: 'en', translationText: text, correctedEnglish: '', polishedEnglish: '', issues: [] }; }

function harness(config = DEFAULTS, options = {}, disk = new Map()) {
  const hooks = [], timers = [], requests = [], fills = [], toasts = [];
  let text = '', now = 0, submits = 0;
  const elements = Object.fromEntries(['Box', 'Text', 'Button', 'Markdown'].map(type => [type, props => ({ type, ...props })]));
  register((name, filter, callback) => { if (typeof filter === 'function') { callback = filter; filter = null; } hooks.push({ name, filter, callback }); }, options);
  const $ = {
    plugin: { root: '/plugin' }, fs: {
      read: async path => { if (path === '/plugin/config.json') return JSON.stringify(config); if (!disk.has(path)) throw new Error('ENOENT'); return disk.get(path); },
      write: async (path, value) => { disk.set(path, value); },
      list: async path => [...disk.keys()].filter(key => key.startsWith(path + '/')).map(key => ({ name: key.slice(path.length + 1), kind: 'file' })),
    },
    env: { get: async name => name === 'EA_API_KEY' ? 'env-test-token' : name === 'USERPROFILE' ? '/user' : '' },
    command: { register: async () => {} }, session: { messages: async () => [] },
    clock: { now: async () => now, after: (ms, callback) => { const timer = { at: now + ms, callback, canceled: false, cancel() { this.canceled = true; } }; timers.push(timer); return timer; } },
    http: { fetch: (url, init) => { const item = deferred(); requests.push({ ...item, url, init }); return item.promise; } },
    prompt: {
      read: async () => ({ text, cursor: text.length }),
      fill: async input => dispatch('prompt.fill', input, async () => { fills.push(input); text = input.text; return { isFilled: true, text, cursor: text.length }; }),
      submit: async () => { submits++; },
    },
    ui: { invalidate: () => {}, resolve: () => elements, toast: message => toasts.push(message), open: async () => ({ isPlaced: true }), close: async () => {} },
  };
  async function dispatch(name, event, bottom = async () => ({})) {
    const matches = hooks.filter(h => h.name === name && (!h.filter || Object.entries(h.filter).every(([key, value]) => event[key] === value)));
    const run = i => i === matches.length ? bottom(event) : matches[i].callback($, event, () => run(i + 1));
    return run(0);
  }
  return {
    $, requests, fills, toasts, dispatch, get text() { return text; }, get submits() { return submits; },
    start: () => dispatch('session.start', {}),
    silentEdit: nextText => { text = nextText; },
    edit: async nextText => { const oldText = text; return dispatch('prompt.edit', { text: oldText }, async () => { text = nextText; return { text, cursor: text.length }; }); },
    advance: async ms => { now += ms; for (const timer of [...timers]) if (!timer.canceled && timer.at <= now) { timer.canceled = true; timer.callback(); } await flush(); },
    render: () => dispatch('ui.render', { component: 'AbovePrompt' }, async () => ({ type: 'engine', ref: 1 })),
    pane: () => dispatch('ui.render', { component: 'Pane', requestId: 'ea-bilingual' }),
  };
}
function nodes(tree) { return tree ? [tree, ...(tree.children || []).filter(v => typeof v === 'object').flatMap(nodes)] : []; }
function button(tree, key) { return nodes(tree).find(node => node.key === key); }
function visible(tree) { return nodes(tree).flatMap(n => (n.children || []).filter(v => typeof v === 'string')).join('\n'); }

test('reply to diff to reply switches on the first click and retains the existing translation', async () => {
  const h = harness(); await h.start();
  let diffOpen = false, shown = null;
  const operations = [];
  h.$.ui.close = async ({ id }) => { operations.push('close:' + id); if (id === 'diff') diffOpen = false; if (shown === id) shown = null; };
  h.$.ui.open = async ({ id }) => { operations.push('open:' + id); if (!diffOpen) shown = id; return { isPlaced: true }; };
  h.$.command.list = async () => [{ name: 'diff' }];
  h.$.command.run = async () => { diffOpen = !diffOpen; shown = diffOpen ? 'diff' : null; return { text: diffOpen ? 'Diff panel shown' : 'Diff panel hidden' }; };
  await h.dispatch('turn.complete', { turnId: 'switch', reason: 'answer', answer: 'Done.' }); await h.advance(1);
  h.requests[0].resolve(apiResponse({ translationZh: '完成。' })); await flush();
  await button(await h.render(), 'ea-open-reply').onPress(); assert.equal(shown, 'ea-bilingual');
  for (let i = 0; i < 3; i++) {
    await button(await h.render(), 'ea-show-diff').onPress(); await h.advance(1); assert.equal(shown, 'diff');
    operations.length = 0;
    await button(await h.render(), 'ea-open-reply').onPress();
    assert.deepEqual(operations, ['close:diff', 'open:ea-bilingual']);
    assert.equal(shown, 'ea-bilingual');
  }
  assert.equal(h.requests.length, 1); assert.equal(h.fills.length, 0); assert.equal(h.submits, 0);
  assert.ok(nodes(await h.pane()).some(n => n.type === 'Markdown' && n.text === '完成。'));
});

test('switch to native diff closes only EA and opens diff even when the command first toggles it off', async () => {
  const h = harness({ ...DEFAULTS, translateReplies: false }); await h.start();
  const closed = [], called = [];
  h.$.ui.close = async args => closed.push(args.id);
  h.$.command.list = async () => [{ name: 'diff' }];
  h.$.command.run = async args => { called.push(args.command); return { text: called.length === 1 ? 'Diff panel hidden' : 'Diff panel shown' }; };
  await h.dispatch('turn.complete', { turnId: 'diff-reply', reason: 'answer', answer: 'Done.' });
  await button(await h.render(), 'ea-show-diff').onPress();
  await h.advance(1);
  assert.deepEqual(closed, ['ea-bilingual']); assert.deepEqual(called, ['diff', 'diff']);
  assert.equal(h.requests.length, 0); assert.equal(h.submits, 0); assert.equal(h.fills.length, 0);
  called.length = 0;
  h.$.command.run = async args => { called.push(args.command); return { text: 'Diff panel shown' }; };
  await button(await h.pane(), 'ea-show-diff').onPress();
  await h.advance(1);
  assert.deepEqual(called, ['diff']);
  h.$.command.list = async () => [];
  await h.dispatch('command.run', { command: 'ea-diff' });
  await h.advance(1);
  assert.match(h.toasts.at(-1), /没有可用的 \/diff/);
  assert.equal(closed.length, 2);
});

test('global usage survives reload and combines separate concurrent loads without resetting', async () => {
  const disk = new Map();
  const a = harness(DEFAULTS, {}, disk), b = harness(DEFAULTS, {}, disk);
  await a.start(); await b.start();
  await a.edit('检查函数'); await b.edit('解释函数');
  await a.advance(1000); await b.advance(1000);
  a.requests[0].resolve(apiResponse(zhAnalysis(), { input_tokens: 100, output_tokens: 20 }));
  b.requests[0].resolve(apiResponse(zhAnalysis(), { input_tokens: 200, output_tokens: 40 }));
  await flush();
  assert.equal(disk.size, 2);
  const status = async h => (await h.dispatch('command.run', { command: 'ea-status' })).text;
  assert.match(await status(a), /全局 Token 累计：输入 300，输出 60，合计 360/);
  await a.dispatch('session.end', { reason: 'clear' });
  assert.match(await status(a), /本次插件加载）：输入 100，输出 20/);
  const reopened = harness(DEFAULTS, {}, disk); await reopened.start();
  assert.match(await status(reopened), /全局 Token 累计：输入 300，输出 60/);
  assert.match(await status(reopened), /本次插件加载）：输入 0，输出 0/);
  await reopened.edit('检查新函数'); await reopened.advance(1000);
  reopened.requests[0].resolve(apiResponse(zhAnalysis(), undefined)); await flush();
  assert.match(await status(a), /全局已记录用量 2 次/);
  assert.doesNotMatch(await status(a), /未获得 usage|未知 .* 次/);
  assert.equal([...disk.values()].map(text => JSON.parse(text).tokens.unknown).reduce((a, b) => a + b, 0), 1);
  disk.set('/user/.claude/english-assistant/usage/broken.json', '{');
  assert.match(await status(a), /1 个记录暂时无法读取/);
});

test('usage persistence failure does not prevent translation and is visible in status', async () => {
  const h = harness(); await h.start();
  h.$.fs.write = async () => { throw new Error('EACCES'); };
  await h.edit('检查函数'); await h.advance(1000);
  h.requests[0].resolve(apiResponse(zhAnalysis(), { input_tokens: 10, output_tokens: 2 })); await flush();
  assert.match(visible(await h.render()), /Please inspect/);
  const result = await h.dispatch('command.run', { command: 'ea-status' });
  assert.match(result.text, /全局用量写入失败/);
  assert.match(result.text, /本次插件加载）：输入 10，输出 2/);
});

test('protocol adapters use the appropriate request and response formats', () => {
  const value = zhAnalysis();
  const cases = [
    ['responses', { status: 'completed', output_text: JSON.stringify(value) }],
    ['chat/completions', { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(value) } }] }],
    ['messages', { stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: 'ignored' }, { type: 'text', text: JSON.stringify(value) }] }],
  ];
  for (const [protocol, raw] of cases) {
    const cfg = parseConfig({ protocol });
    const { body } = draftRequest('检查函数', [], cfg);
    assert.deepEqual(responseJson(raw, protocol), value);
    if (protocol === 'responses') assert.equal(body.text.format.type, 'json_schema');
    else {
      assert.equal(body.max_tokens, cfg.maxOutputTokens); assert.equal(body.input, undefined);
      if (protocol === 'messages') { assert.equal(body.messages[0].role, 'user'); assert.equal(body.response_format, undefined); assert.equal(body.thinking.type, 'disabled'); assert.equal(body.output_config.format.type, 'json_schema'); }
      else { assert.equal(body.messages[0].role, 'system'); assert.equal(body.response_format.type, 'json_schema'); }
    }
    const compatible = draftRequest('检查函数', [], { ...cfg, jsonMode: false, reasoningEffort: null }).body;
    assert.equal(compatible.text, undefined); assert.equal(compatible.response_format, undefined); assert.equal(compatible.output_config, undefined); assert.equal(compatible.reasoning, undefined);
  }
  assert.throws(() => responseJson({ choices: [{ finish_reason: 'length', message: { content: '{}' } }] }, 'chat/completions'), /未正常完成/);
  assert.throws(() => responseJson({ stop_reason: 'max_tokens', content: [] }, 'messages'), /未正常完成/);
});

test('draft and reply schemas constrain required fields and types in all three wire formats', () => {
  function format(body, protocol) {
    if (protocol === 'messages') {
      assert.equal(body.output_config.format.strict, undefined);
      assert.equal(body.output_config.format.name, undefined);
      return body.output_config.format;
    }
    const result = protocol === 'responses' ? body.text.format : body.response_format.json_schema;
    assert.equal(result.strict, true);
    assert.equal(result.name, result.schema.properties.issues ? 'draft_analysis' : 'reply_translation');
    return result;
  }
  function closedObject(schema, fields) {
    assert.equal(schema.type, 'object');
    assert.equal(schema.additionalProperties, false);
    assert.deepEqual(schema.required, fields);
    assert.deepEqual(Object.keys(schema.properties), fields);
  }
  let previousDraft, previousReply;
  for (const protocol of ['responses', 'chat/completions', 'messages']) {
    const cfg = parseConfig({ protocol });
    const draft = format(draftRequest('检查函数', [], cfg).body, protocol).schema;
    closedObject(draft, ['sourceLanguage', 'translationLanguage', 'translationText', 'correctedEnglish', 'polishedEnglish', 'issues']);
    assert.deepEqual(draft.properties.sourceLanguage, { type: 'string', enum: ['zh', 'en', 'mixed'] });
    assert.deepEqual(draft.properties.translationLanguage, { type: 'string', enum: ['zh', 'en'] });
    for (const field of ['translationText', 'correctedEnglish', 'polishedEnglish']) assert.deepEqual(draft.properties[field], { type: 'string' });
    assert.equal(draft.properties.issues.type, 'array');
    closedObject(draft.properties.issues.items, ['original', 'replacement', 'explanationZh']);
    for (const field of Object.values(draft.properties.issues.items.properties)) assert.deepEqual(field, { type: 'string' });
    const reply = format(replyRequest({ source: 'Done.' }, [], cfg).body, protocol).schema;
    closedObject(reply, ['translationZh']);
    assert.deepEqual(reply.properties.translationZh, { type: 'string' });
    if (previousDraft) { assert.deepEqual(draft, previousDraft); assert.deepEqual(reply, previousReply); }
    previousDraft = draft; previousReply = reply;
    const compatible = replyRequest({ source: 'Done.' }, [], { ...cfg, jsonMode: false }).body;
    assert.equal(compatible.text, undefined); assert.equal(compatible.response_format, undefined); assert.equal(compatible.output_config, undefined);
  }
});

test('usage normalizes cache accounting without double-counting reasoning or Anthropic cache tokens', () => {
  assert.deepEqual(normalizedUsage({ usage: { input_tokens: 100, output_tokens: 20, input_tokens_details: { cached_tokens: 60 }, output_tokens_details: { reasoning_tokens: 5 } } }, 'responses'), { input: 100, output: 20, cached: 60, cacheWrite: 0, reasoning: 5, total: 120 });
  assert.equal(normalizedUsage({ usage: { prompt_tokens: 100, completion_tokens: 20, prompt_cache_hit_tokens: 60 } }, 'chat/completions').cached, 60);
  assert.deepEqual(normalizedUsage({ usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 60, cache_creation_input_tokens: 30 } }, 'messages'), { input: 100, output: 20, cached: 60, cacheWrite: 30, reasoning: 0, total: 120 });
  assert.equal(normalizedUsage({}, 'responses'), null);
  assert.equal(normalizedUsage({ usage: { input_tokens: 10, output_tokens: 20, input_tokens_details: { cached_tokens: 60 } } }, 'responses'), null);
});

test('auth headers support no auth, bearer, x-api-key and reject header injection', () => {
  assert.equal(requestHeaders(parseConfig({})).Authorization, undefined);
  assert.equal(requestHeaders(parseConfig({ apiKey: 'fixture-token' })).Authorization, 'Bearer fixture-token');
  const headers = requestHeaders(parseConfig({ protocol: 'messages', apiKey: 'fixture-token' }));
  assert.equal(headers['x-api-key'], 'fixture-token'); assert.equal(headers['anthropic-version'], '2023-06-01');
  assert.equal(requestHeaders(parseConfig({ protocol: 'messages', authType: 'bearer', apiKey: 'fixture-token' })).Authorization, 'Bearer fixture-token');
  assert.equal(requestHeaders(parseConfig({ apiKey: 'fixture-token', authType: 'none' })).Authorization, undefined);
  assert.throws(() => requestHeaders(DEFAULTS, 'bad\r\nheader'), /格式无效/);
});

test('runtime counts stale and late completions, but not reuse from the in-memory cache', async () => {
  const h = harness(); await h.start(); await h.edit('旧草稿'); await h.advance(1000);
  await h.edit('新草稿'); await h.advance(1000);
  h.requests[0].resolve(apiResponse(zhAnalysis(), { input_tokens: 100, output_tokens: 20, input_tokens_details: { cached_tokens: 60 } })); await flush();
  await h.advance(1); await h.advance(15000);
  h.requests[1].resolve(apiResponse(zhAnalysis(), { input_tokens: 200, output_tokens: 40 })); await flush();
  let status = await h.dispatch('command.run', { command: 'ea-status' });
  assert.match(status.text, /输入 300，输出 60，合计 360/); assert.match(status.text, /迟到/);
  await h.edit('可缓存草稿'); await h.advance(1000);
  h.requests[2].resolve(apiResponse(zhAnalysis(), { input_tokens: 50, output_tokens: 10 })); await flush();
  await h.edit(''); await h.edit('可缓存草稿'); await h.advance(1000);
  assert.equal(h.requests.length, 3);
  status = await h.dispatch('command.run', { command: 'ea-status' });
  assert.match(status.text, /输入 350，输出 70，合计 420/);
});

test('configured auth is used on the transport and never shown by status', async () => {
  const h = harness({ ...DEFAULTS, apiKey: 'fixture-secret' }); await h.start(); await h.edit('检查函数'); await h.advance(1000);
  assert.equal(h.requests[0].init.headers.Authorization, 'Bearer fixture-secret');
  const status = await h.dispatch('command.run', { command: 'ea-status' });
  assert.match(status.text, /鉴权：已配置/); assert.doesNotMatch(status.text, /fixture-secret/);
  const env = harness({ ...DEFAULTS, apiKeyEnv: 'EA_API_KEY' }); await env.start(); await env.edit('检查函数'); await env.advance(1000);
  assert.equal(env.requests[0].init.headers.Authorization, 'Bearer env-test-token');
  const configured = harness(DEFAULTS, { protocol: 'messages', apiKey: 'secure-store-token' }); await configured.start(); await configured.edit('检查函数'); await configured.advance(1000);
  assert.equal(configured.requests[0].init.headers['x-api-key'], 'secure-store-token');
});

test('missing and null issues are compatible while other non-array values remain invalid', () => {
  const value = { sourceLanguage: 'en', translationLanguage: 'zh', translationText: '好的，把它连同测试一起实现。', correctedEnglish: '', polishedEnglish: 'Yes, implement it with tests.' };
  const source = protectLiterals('Yes implement it with tests.');
  for (const candidate of [value, { ...value, issues: null }, { ...value, issues: [] }]) {
    const result = validateDraft(candidate, source);
    assert.deepEqual(result.issues, []);
    assert.equal(result.translationText, value.translationText);
    assert.equal(result.polishedEnglish, value.polishedEnglish);
  }
  for (const issues of ['', 'no issues', {}, false, 0]) {
    assert.throws(() => validateDraft({ ...value, issues }, source), /issues 必须是数组/);
  }
});

test('successful response reconciles a composer change without prompt.edit instead of leaving analysis stuck', async () => {
  const h = harness(); await h.start(); await h.edit('Please explan this.'); await h.advance(1000);
  assert.match(visible(await h.render()), /分析中/);
  h.silentEdit('Please explan this: [Pasted text #1 +6 lines]');
  h.requests[0].resolve(apiResponse({ sourceLanguage: 'en', translationLanguage: 'zh', translationText: '请解释。', correctedEnglish: 'Please explain this.', polishedEnglish: '', issues: [] }));
  await flush();
  assert.doesNotMatch(visible(await h.render()), /分析中/);
  await h.advance(1000); assert.equal(h.requests.length, 2);
  h.requests[1].resolve(apiResponse({ sourceLanguage: 'en', translationLanguage: 'zh', translationText: '请解释：__EA_LITERAL_0__', correctedEnglish: 'Please explain this: __EA_LITERAL_0__', polishedEnglish: '', issues: [] }));
  await flush();
  assert.match(visible(await h.render()), /请解释：\[Pasted text #1 \+6 lines\]/);
  assert.doesNotMatch(visible(await h.render()), /分析中/);
  assert.equal(h.fills.length, 0);
});

test('unobserved clear and malformed successful HTTP response both leave a terminal UI state', async () => {
  const h = harness(); await h.start(); await h.edit('Please explain.'); await h.advance(1000);
  h.silentEdit(''); h.requests[0].resolve(apiResponse(zhAnalysis())); await flush();
  assert.doesNotMatch(visible(await h.render()), /分析中/);
  await h.advance(1000); assert.equal(h.requests.length, 1);
  await h.edit('Please explain again.'); await h.advance(1000);
  h.requests[1].resolve({ ok: true, status: 200, text: '{broken JSON' }); await flush();
  assert.doesNotMatch(visible(await h.render()), /分析中/);
  assert.ok(button(await h.render(), 'ea-retry-draft'));
  const status = await h.dispatch('command.run', { command: 'ea-status' });
  assert.match(status.text, /HTTP 200 已返回/);
  assert.match(status.text, /分析失败/);
});

test('composer references survive translation exactly and cannot generate replacement choices', () => {
  for (const marker of ['[Pasted text #1 +6 lines]', '[Pasted text #2]', '[Image #1]', '[Pasted image #3]', '[图片 #1]']) {
    const source = 'Please explan this warning: ' + marker;
    assert.equal(hasComposerReferences(source), true);
    const protectedSource = protectLiterals(source);
    assert.equal(protectedSource.text.includes(marker), false);
    assert.equal(restoreLiterals(protectedSource.text, protectedSource.literals), source);
    assert.throws(() => restoreLiterals('Please explain this warning.', protectedSource.literals));
    assert.throws(() => restoreLiterals(protectedSource.text + protectedSource.literals[0].token, protectedSource.literals));
    assert.deepEqual(choicesFor(zhAnalysis(), source), []);
  }
  assert.equal(hasComposerReferences('Please explain [a normal bracket].'), false);
});

test('paste reference draft is analyzed with protected tokens and stays display-only', async () => {
  const h = harness(); await h.start();
  const source = 'An unrelative question:when i use curl in windows pwsh, there always a alert :[Pasted text #1 +6 lines]';
  await h.edit(source); await h.advance(1000);
  const payload = JSON.parse(JSON.parse(h.requests[0].init.body).input);
  assert.equal(payload.source.includes('[Pasted text'), false);
  h.requests[0].resolve(apiResponse({ sourceLanguage: 'en', translationLanguage: 'zh',
    translationText: '使用 curl 时有警告：__EA_LITERAL_0__',
    correctedEnglish: 'An unrelated question: when I use curl in Windows PowerShell, I always get a warning: __EA_LITERAL_0__',
    polishedEnglish: '', issues: [] }));
  await flush();
  const tree = await h.render();
  assert.match(visible(tree), /使用 curl 时有警告：\[Pasted text #1 \+6 lines\]/);
  assert.match(visible(tree), /已禁用整框替换/);
  assert.equal(nodes(tree).some(n => n.key?.startsWith('ea-apply-')), false);
  await h.dispatch('command.run', { command: 'ea-check', args: 'replacement' });
  assert.equal(h.text, source); assert.equal(h.fills.length, 0); assert.equal(h.submits, 0);
});

test('attachment marker detected at click time blocks a stale adoption or undo', async () => {
  const h = harness(); await h.start(); await h.edit('请检查函数。'); await h.advance(1000);
  h.requests[0].resolve(apiResponse(zhAnalysis())); await flush();
  const apply = button(await h.render(), 'ea-apply-translation');
  // Model the composer changing outside prompt.edit: click handlers must reread.
  h.$.prompt.read = async () => ({ text: '请检查函数。[Image #1]', cursor: 0 });
  await apply.onPress(); assert.equal(h.fills.length, 0);
  h.$.prompt.read = async () => ({ text: h.text, cursor: h.text.length });
  await apply.onPress(); assert.equal(h.fills.length, 1);
  const undo = button(await h.render(), 'ea-undo');
  h.$.prompt.read = async () => ({ text: h.text + '[Image #1]', cursor: 0 });
  await undo.onPress(); assert.equal(h.fills.length, 1); assert.equal(h.submits, 0);
});

test('code blocks, inline code and URLs are protected and missing placeholders rejected', () => {
  const source = '检查 `foo()` 和 https://example.com/a\n```js\nfoo();\n```';
  const protectedSource = protectLiterals(source);
  assert.equal(restoreLiterals(protectedSource.text, protectedSource.literals), source);
  assert.throws(() => restoreLiterals('missing', protectedSource.literals));
  assert.equal(eligibleDraft('检查取消逻辑', DEFAULTS), true);
  assert.equal(eligibleDraft('```js\nfoo();\n```', DEFAULTS), false);
});
test('reply segmentation preserves every character and leaves fenced code unchanged', () => {
  for (const source of ['First paragraph.\n\nSecond paragraph.\n```js\nfoo();\n```\nLast answer.', 'Before\n~~~js\nfoo()\n~~~\nAfter', 'Before\n```js\nunfinished', 'x'.repeat(5100)]) {
    const segments = replySegments(source, 500);
    assert.equal(segments.map(s => s.source).join(''), source);
    if (source.includes('foo')) assert.ok(segments.some(s => s.kind === 'code' && s.source.includes('foo')));
  }
});

const boxedReply = readFileSync(new URL('./fixtures/boxed-reply.txt', import.meta.url), 'utf8').trimEnd();

test('the reported padded table becomes a compact table with logical rows and intact content', () => {
  const markdown = normalizeReplyMarkdown(boxedReply);
  const lines = markdown.split('\n');
  assert.equal(lines.length, 5);
  assert.equal(lines[0], '| Setup | Changes on the phone |');
  assert.equal(lines[1], '| --- | --- |');
  assert.match(lines[2], /DHCP \(recommended end state\) \| None\./);
  assert.match(lines[4], /ignore it, and UDP traffic/);
  assert.ok(markdown.length < boxedReply.length / 2);
  assert.doesNotMatch(markdown, /[┌┐└┘│─]| {3}/);
  // Padding and physical line wraps are the only content removed.
  const physicalRows = boxedReply.split(/\r?\n/).filter(line => line.startsWith('│')).map(line => line.slice(1, -1).split('│'));
  for (const row of physicalRows) for (const cell of row) if (cell.trim()) assert.ok(markdown.includes(cell.trim()));
  assert.equal(normalizeReplyMarkdown(markdown), markdown);
});

test('box conversion merges four-column continuations, escapes pipes, and handles CRLF beside prose', () => {
  const box = ['┌────┬────┬────┬────┐', '│ Name │ Empty │ Command │ Note │', '├────┼────┼────┼────┤',
    '│ first │  │ a | b │ 中文 │', '│ continued │  │  │ 续行 │', '└────┴────┴────┴────┘'].join('\r\n');
  assert.equal(normalizeReplyMarkdown('Before\r\n' + box + '\r\nAfter'),
    'Before\r\n\r\n| Name | Empty | Command | Note |\r\n| --- | --- | --- | --- |\r\n| first continued |  | a \\| b | 中文 续行 |\r\n\r\nAfter');
});

test('incomplete tables, diagrams, and fenced box examples remain unchanged', () => {
  for (const input of [boxedReply.slice(0, boxedReply.lastIndexOf('\n')), boxedReply.replace('│ C, proxy port only', '│ extra │ C, proxy port only'),
    '┌────┬────┐\n│ A │ B │\n└────┴────┘', '┌────┐\n│ diagram │\n└────┘',
    '```text\n' + boxedReply + '\n```', '~~~~text\n```\n' + boxedReply + '\n~~~~', '```text\n' + boxedReply]) {
    assert.equal(normalizeReplyMarkdown(input), input);
  }
});

test('long Markdown tables split only between complete rows and repeat their headers', () => {
  const header = '| Name | Description |\r\n| :--- | ---: |\r\n';
  const rows = Array.from({ length: 80 }, (_, i) => `| item-${i} | ${'Detailed description '.repeat(5)}|\r\n`);
  const segments = replySegments('Before\r\n\r\n' + header + rows.join('') + '\r\nAfter', 500);
  const tables = segments.filter(s => s.source.startsWith(header));
  assert.ok(tables.length > 1);
  assert.equal(tables.map(s => s.source.slice(header.length)).join(''), rows.join(''));
  assert.ok(tables.every(s => s.source.length <= 500 && s.source.endsWith('|\r\n')));
  assert.equal(segments[0].source, 'Before\r\n\r\n');
  assert.equal(segments.at(-1).source, '\r\nAfter');
});

test('the pane and translation requests receive the converted reported table', async () => {
  const h = harness(); await h.start();
  await h.dispatch('turn.complete', { reason: 'answer', turnId: 'box', answer: boxedReply });
  await h.advance(1);
  assert.equal(h.requests.length, 1);
  assert.match(JSON.stringify(h.requests[0].init), /\| Setup \| Changes on the phone \|/);
  assert.doesNotMatch(JSON.stringify(h.requests[0].init), /┌─/);
  const sources = nodes(await h.pane()).filter(n => n.type === 'Markdown').map(n => n.text);
  assert.equal(sources[0], normalizeReplyMarkdown(boxedReply));
});

test('a long translated table also respects native Markdown limits without splitting cells', async () => {
  const h = harness(); await h.start();
  await h.dispatch('turn.complete', { reason: 'answer', turnId: 'long-table', answer: 'Translate this response.' });
  await h.advance(1);
  const header = '| 项目 | 说明 |\n| --- | --- |\n';
  const rows = Array.from({ length: 300 }, (_, i) => `| 项目${i} | ${'完整单元格内容'.repeat(6)} |\n`);
  h.requests[0].resolve(apiResponse({ translationZh: header + rows.join('') })); await flush();
  const tables = nodes(await h.pane()).filter(n => n.type === 'Markdown' && n.text.startsWith(header));
  assert.ok(tables.length > 1);
  assert.ok(tables.every(n => n.text.length <= 9500));
  assert.equal(tables.map(n => n.text.slice(header.length)).join(''), rows.join(''));
});

test('one oversized table row falls back to literal text without losing its content', async () => {
  const h = harness({ ...DEFAULTS, translateReplies: false }); await h.start();
  const table = '| Name | Description |\n| --- | --- |\n| example | ' + '单元格'.repeat(4000) + ' |';
  await h.dispatch('turn.complete', { reason: 'answer', turnId: 'huge-row', answer: table });
  const tree = await h.pane();
  assert.ok(!nodes(tree).some(n => n.type === 'Markdown' && n.text.includes('| example')));
  const chunks = nodes(tree).filter(n => n.type === 'Text' && n.children?.some(c => typeof c === 'string' && (c.includes('单元格') || c.startsWith('| Name'))));
  assert.equal(chunks.flatMap(n => n.children).join(''), table);
  assert.ok(chunks.every(n => n.children[0].length <= 9500));
});

test('terminal tables use pane width, preserve escaped pipes, and fall back in narrow panes', async () => {
  const table = '| 项目 | Status | Command | 结果 |\n| --- | --- | --- | --- |\n| 中文😀 | OK | a \\| b | ' + '说明'.repeat(30) + ' |';
  const parsed = parseMarkdownTable(table);
  assert.equal(parsed.rows[0][2], 'a | b');
  const ui = Object.fromEntries(['Box', 'Text', 'Markdown'].map(type => [type, props => ({ type, ...props })]));
  for (const columns of [40, 80, 144]) {
    const tree = renderTerminalTable(parsed, columns, ui);
    assert.ok(tree.width <= columns);
    for (const row of tree.children.filter(n => n.type === 'Box')) {
      assert.ok(row.children.reduce((sum, n) => sum + n.width, 0) + 2 * (row.children.length - 1) <= tree.width - 4);
    }
    assert.ok(nodes(tree).some(n => n.type === 'Markdown' && n.text === 'a | b'));
    assert.ok(!nodes(tree).some(n => n.type === 'Markdown' && n.text.startsWith('| 项目')));
  }
  const narrow = renderTerminalTable(parsed, 12, ui);
  assert.equal(narrow.width, 12);
  assert.ok(nodes(narrow).some(n => n.type === 'Text' && n.children[0] === 'Command'));
  assert.ok(nodes(narrow).some(n => n.type === 'Markdown' && n.text === 'a | b'));

  const h = harness({ ...DEFAULTS, translateReplies: false }); await h.start();
  await h.dispatch('turn.complete', { reason: 'answer', turnId: 'terminal', answer: table });
  const tree = await h.dispatch('ui.render', { component: 'Pane', requestId: 'ea-bilingual', surface: 'terminal', props: { bodyColumns: 80 } });
  assert.ok(nodes(tree).some(n => n.type === 'Markdown' && n.text === 'a | b'));
  assert.ok(!nodes(tree).some(n => n.type === 'Markdown' && n.text.startsWith('| 项目')));
});
test('context honors count and size bounds and excludes the current reply', () => {
  const messages = [{ role: 'user', text: 'old' }, { role: 'assistant', text: 'a'.repeat(3000) }, { role: 'user', text: 'question' }, { role: 'assistant', text: 'answer' }];
  const context = contextFromMessages(messages, { ...DEFAULTS, contextMessages: 2, contextMaxChars: 100 }, 'answer');
  assert.deepEqual(context.map(c => c.role), ['assistant', 'user']);
  assert.ok(context.reduce((sum, c) => sum + c.text.length, 0) <= 100);
  assert.ok(!context.some(c => c.text === 'answer'));
});
test('incomplete API results and wrong-language JSON fail before display', () => {
  assert.throws(() => responseJson({ status: 'incomplete', output_text: '{}' }));
  assert.throws(() => validateDraft({ ...zhAnalysis(), translationLanguage: 'zh' }, { literals: [] }));
  assert.equal(choicesFor(zhAnalysis(), '中文')[0].key, 'translation');
  const source = protectLiterals('Please explan how this functon works.');
  const value = validateDraft({ ...zhAnalysis(), issues: [
    { original: 'expla', replacement: 'explain', explanationZh: '模型缩短了原词' },
    { original: 'functon', replacement: 'function', explanationZh: '修正拼写' },
  ] }, source);
  assert.deepEqual(value.issues.map(i => i.original), ['functon']);
});
test('Chinese is analyzed after debounce; adopting and undoing replace without sending', async () => {
  const h = harness(); await h.start(); await h.edit('请检查这个函数。');
  await h.advance(999); assert.equal(h.requests.length, 0);
  await h.advance(1); assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0].init.headers.Authorization, undefined);
  h.requests[0].resolve(apiResponse(zhAnalysis())); await flush();
  await button(await h.render(), 'ea-apply-translation').onPress();
  assert.equal(h.text, 'Please inspect this function.');
  assert.equal(h.fills[0].mode, 'replace'); assert.equal(h.submits, 0);
  await h.advance(1000); assert.equal(h.requests.length, 1);
  await button(await h.render(), 'ea-undo').onPress();
  assert.equal(h.text, '请检查这个函数。'); assert.equal(h.submits, 0);
});
test('only the latest queued draft is requested; stale response and stale button cannot overwrite', async () => {
  const h = harness(); await h.start(); await h.edit('旧草稿'); await h.advance(1000);
  await h.edit('新草稿'); await h.advance(1000); assert.equal(h.requests.length, 1);
  h.requests[0].resolve(apiResponse(zhAnalysis('Old draft.'))); await flush();
  assert.equal(button(await h.render(), 'ea-apply-translation'), undefined);
  await h.advance(1); assert.equal(h.requests.length, 2);
  h.requests[1].resolve(apiResponse(zhAnalysis('New draft.'))); await flush();
  const staleButton = button(await h.render(), 'ea-apply-translation');
  await h.edit('更新的草稿'); await staleButton.onPress();
  assert.equal(h.text, '更新的草稿'); assert.equal(h.fills.length, 0);
});
test('submission and session reset invalidate in-flight analysis', async () => {
  const h = harness(); await h.start(); await h.edit('请检查'); await h.advance(1000);
  await h.dispatch('prompt.submit', { text: h.text, origin: { kind: 'composer' } });
  h.requests[0].resolve(apiResponse(zhAnalysis())); await flush();
  assert.equal(button(await h.render(), 'ea-apply-translation'), undefined);
  await h.edit('下一条'); await h.advance(1000);
  await h.dispatch('session.end', { reason: 'clear' });
  h.requests[1].resolve(apiResponse(zhAnalysis())); await flush();
  assert.equal(button(await h.render(), 'ea-apply-translation'), undefined);
});
test('UI timeout does not release the physical request slot or display late results', async () => {
  const h = harness(); await h.start(); await h.edit('旧草稿'); await h.advance(1000);
  await h.advance(15000); assert.match(visible(await h.render()), /超时/);
  await h.edit('新草稿'); await h.advance(1000); assert.equal(h.requests.length, 1);
  h.requests[0].resolve(apiResponse(zhAnalysis('Late.'))); await flush();
  assert.equal(button(await h.render(), 'ea-apply-translation'), undefined);
  await h.advance(1); assert.equal(h.requests.length, 2);
});
test('subagent/error turns do not translate; completed main reply preserves code', async () => {
  const h = harness(); await h.start();
  await h.dispatch('turn.complete', { agentId: 'sub', reason: 'answer', answer: 'Subagent answer' });
  await h.advance(1); assert.equal(h.requests.length, 0);
  await h.dispatch('turn.complete', { reason: 'error', answer: 'API error' });
  await h.advance(1); assert.equal(h.requests.length, 0);
  await h.dispatch('turn.complete', { reason: 'answer', turnId: 't1', answer: 'All done.\n```js\nfoo();\n```' });
  await h.advance(1); assert.equal(h.requests.length, 1);
  h.requests[0].resolve(apiResponse({ translationZh: '全部完成。' })); await flush();
  const tree = await h.pane();
  assert.ok(nodes(tree).some(n => n.type === 'Markdown' && n.text === '全部完成。'));
  assert.ok(nodes(tree).some(n => n.type === 'Markdown' && n.text.includes('foo();')));
});
test('a newer main reply replaces the old pane and ignores its late translation', async () => {
  const h = harness(); await h.start();
  await h.dispatch('turn.complete', { reason: 'answer', turnId: 'old', answer: 'Old answer.' }); await h.advance(1);
  await h.dispatch('turn.complete', { reason: 'answer', turnId: 'new', answer: 'New answer.' }); await h.advance(1);
  assert.equal(h.requests.length, 1);
  h.requests[0].resolve(apiResponse({ translationZh: '旧译文' })); await flush(); await h.advance(1);
  assert.equal(h.requests.length, 2);
  h.requests[1].resolve(apiResponse({ translationZh: '新译文' })); await flush();
  const translations = nodes(await h.pane()).filter(n => n.type === 'Markdown').map(n => n.text);
  assert.ok(translations.includes('新译文')); assert.ok(!translations.includes('旧译文'));
});

test('a translated reply behind a diff remains inspectable and manual opening does not regenerate it', async () => {
  const h = harness(); await h.start();
  let isShown = false;
  const opened = [];
  h.$.ui.open = async input => { opened.push(input); if (input.focus) isShown = true; return { isPlaced: true }; };
  h.$.ui.panes = async () => [{ id: 'ea-bilingual', isPlaced: true, isShown, isFocused: isShown }];
  await h.dispatch('turn.complete', { reason: 'answer', turnId: 'latest-turn', answer: 'The final change is complete.' });
  await h.advance(1);
  h.requests[0].resolve(apiResponse({ translationZh: '最后的修改已完成。' })); await flush();
  const diff = { type: 'engine-diff', text: 'previous code diff' };
  assert.equal(await h.dispatch('ui.render', { component: 'Pane', requestId: 'diff' }, async () => diff), diff);
  let status = await h.dispatch('command.run', { command: 'ea-status' });
  assert.match(status.text, /已完成；文字段 1\/1/);
  assert.match(status.text, /当前显示=false/);
  const openButton = button(await h.render(), 'ea-open-reply');
  assert.ok(openButton); await openButton.onPress();
  assert.equal(opened.at(-1).id, 'ea-bilingual'); assert.equal(opened.at(-1).focus, true);
  assert.equal(h.requests.length, 1); assert.equal(h.fills.length, 0); assert.equal(h.submits, 0);
  const tree = await h.pane();
  assert.ok(nodes(tree).some(n => n.type === 'Markdown' && n.text === '最后的修改已完成。'));
  assert.ok(!nodes(tree).some(n => n.text === 'previous code diff'));
  status = await h.dispatch('command.run', { command: 'ea-status' });
  assert.match(status.text, /当前显示=true/);
  assert.match(status.text, /双语渲染次数：1/);
});

test('reply translation never auto-opens by default and closing/reopening retains results without extra requests', async () => {
  const h = harness(); await h.start();
  const opens = [], closes = [];
  h.$.ui.open = async args => { opens.push(args); return { isPlaced: true }; };
  h.$.ui.close = async args => { closes.push(args); };
  await h.dispatch('turn.complete', { reason: 'answer', turnId: 'turn1', answer: 'All done.' });
  await h.advance(1);
  h.requests[0].resolve(apiResponse({ translationZh: '全部完成。' })); await flush();
  assert.equal(opens.length, 0);
  await button(await h.render(), 'ea-open-reply').onPress();
  assert.equal(opens.length, 1);
  await button(await h.pane(), 'ea-back-panel').onPress();
  assert.deepEqual(closes, [{ id: 'diff' }, { id: 'ea-bilingual' }]);
  assert.ok(button(await h.render(), 'ea-open-reply'));
  await button(await h.render(), 'ea-open-reply').onPress();
  assert.ok(nodes(await h.pane()).some(n => n.type === 'Markdown' && n.text === '全部完成。'));
  assert.equal(h.requests.length, 1);
  await h.dispatch('command.run', { command: 'ea-back' });
  assert.equal(closes.filter(p => p.id === 'ea-bilingual').length, 2);
  await h.dispatch('turn.complete', { reason: 'answer', turnId: 'turn2', answer: 'Next reply.' }); await h.advance(1);
  h.requests[1].resolve(apiResponse({ translationZh: '下一条回复。' })); await flush();
  assert.equal(opens.length, 2); // only the two explicit user opens
  assert.equal(h.fills.length, 0); assert.equal(h.submits, 0);
});

test('automatic reply opening is explicitly opt-in', async () => {
  const h = harness({ ...DEFAULTS, autoOpenReplyPane: true }); await h.start();
  const opens = []; h.$.ui.open = async args => { opens.push(args); return { isPlaced: true }; };
  await h.dispatch('turn.complete', { reason: 'answer', turnId: 'turn', answer: 'All done.' });
  assert.equal(opens.length, 1); assert.equal(opens[0].focus, undefined);
});
