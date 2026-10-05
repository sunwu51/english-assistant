import { expect, mock, test } from 'claude-code/testing';
import { DEFAULTS } from '../hooks/core.js';

const scroll = { offset: 0, bodyRows: 30, totalRows: 30 };
const bandProps = { hasSurvey: false, isWorking: false, maxRows: 30, bodyColumns: 100, scroll, view: {} };
const paneProps = { title: '中英对照', isFocused: false, bodyColumns: 100, placement: 'inline' as const, scroll, view: {} };

test('native diff switch runs after the command hook releases its turn', async ($, on) => {
  const clock = mock.clock(on);
  let calls = 0, closes = 0;
  on('session.start', (_, e) => ({ cwd: e.cwd }));
  on('command.register', (_, e) => ({ value: { command: e.name } }));
  on('command.list', () => ({ value: [{ name: 'diff', description: 'Native diff' }] }));
  on('command.run', { command: 'diff' }, () => { calls++; return { text: calls === 1 ? 'Diff panel hidden' : 'Diff panel shown' }; });
  on('ui.close', (_, e) => { expect(e.id).toBe('ea-bilingual'); closes++; return { value: undefined }; });
  on('ui.toast', () => ({ value: undefined }));
  on('ui.invalidate', () => ({ value: undefined }));
  on('fs.read', () => ({ value: JSON.stringify(DEFAULTS) }));
  await $.session.start({ cwd: '.', surface: 'terminal', isInteractive: true });
  const result = await $.command.run({ command: 'ea-diff' });
  expect(result.text?.includes('正在切换')).toBe(true);
  await clock.advance(1);
  await clock.settle();
  expect(calls).toBe(2); expect(closes).toBe(1);
});

test('native chat transport reads configured auth and exposes normalized token totals', { options: {
  protocol: 'chat/completions', endpoint: 'http://localhost:4444/v1/chat/completions', apiKey: 'native-fixture-token',
} }, async ($, on) => {
  const clock = mock.clock(on);
  on('session.start', (_, e) => ({ cwd: e.cwd }));
  on('command.register', (_, e) => ({ value: { command: e.name } }));
  on('ui.invalidate', () => ({ value: undefined }));
  on('ui.panes', () => ({ value: [] }));
  on('fs.read', () => ({ value: JSON.stringify(DEFAULTS) }));
  on('session.messages', () => ({ value: [] }));
  on('http.fetch', (_, e) => {
    expect(e.url).toBe('http://localhost:4444/v1/chat/completions');
    expect(e.init?.headers?.Authorization).toBe('Bearer native-fixture-token');
    const body = JSON.parse(e.init!.body!);
    expect(body.messages[0].role).toBe('system');
    return { value: { ok: true, status: 200, headers: {}, text: JSON.stringify({
      choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ sourceLanguage: 'en', translationLanguage: 'zh', translationText: '解释这个函数。', correctedEnglish: '', polishedEnglish: '', issues: [] }) } }],
      usage: { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 60 } },
    }) } };
  });
  await $.session.start({ cwd: '.', surface: 'terminal', isInteractive: true });
  await $.command.run({ command: 'ea-debug', args: 'Explain this function.' });
  await clock.settle();
  const result = await $.command.run({ command: 'ea-status' });
  expect(result.text?.includes('输入 100，输出 20，合计 120')).toBe(true);
  expect(result.text?.includes('native-fixture-token')).toBe(false);
});

test('native paste/image reference band shows details without adopt controls', async ($, on) => {
  const clock = mock.clock(on);
  const draft = 'Please explan this warning: [Pasted text #1 +6 lines] [Image #1]';
  let fills = 0;
  on('session.start', (_, e) => ({ cwd: e.cwd }));
  on('command.register', (_, e) => ({ value: { command: e.name } }));
  on('ui.invalidate', () => ({ value: undefined }));
  on('ui.render', ($, e) => $.ui.resolve(e).Box({ children: [] }));
  on('fs.read', () => ({ value: JSON.stringify(DEFAULTS) }));
  on('session.messages', () => ({ value: [] }));
  on('prompt.read', () => ({ value: { text: draft, cursor: draft.length } }));
  on('prompt.fill', () => { fills++; return { isFilled: true }; });
  on('http.fetch', (_, e) => {
    const source = JSON.parse(JSON.parse(e.init!.body!).input).source;
    expect(source.includes('[Pasted text')).toBe(false);
    expect(source.includes('[Image')).toBe(false);
    return { value: { ok: true, status: 200, headers: {}, text: JSON.stringify({ status: 'completed', output_text: JSON.stringify({
      sourceLanguage: 'en', translationLanguage: 'zh', translationText: '请解释警告：__EA_LITERAL_0__ __EA_LITERAL_1__',
      correctedEnglish: 'Please explain this warning: __EA_LITERAL_0__ __EA_LITERAL_1__', polishedEnglish: '', issues: [],
    }) }) } };
  });
  await $.session.start({ cwd: '.', surface: 'terminal', isInteractive: true });
  await $.command.run({ command: 'ea-check' });
  await clock.settle();
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'english-assistant', surface, component: 'AbovePrompt', props: bandProps });
    expect(await ui.find({ key: 'ea-apply-corrected' })).toBeUndefined();
    expect(await ui.find({ key: 'ea-apply-translation' })).toBeUndefined();
    expect(await ui.find({ key: 'ea-details' })).toBeDefined();
    await ui.press({ key: 'ea-details' });
    expect(fills).toBe(0);
    await ui.unmount();
  }
  await $.command.run({ command: 'ea-check', args: 'replacement' });
  expect(fills).toBe(0);
});

test('native band: adoption and undo fill the composer without a submission', async ($, on) => {
  const clock = mock.clock(on);
  let draft = '请检查这个函数。';
  const fills: string[] = [];
  let submits = 0;
  on('session.start', (_, e) => ({ cwd: e.cwd }));
  on('command.register', (_, e) => ({ value: { command: e.name } }));
  on('ui.invalidate', () => ({ value: undefined }));
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e);
    return Box({ children: [] });
  });
  on('fs.read', () => ({ value: JSON.stringify(DEFAULTS) }));
  on('session.messages', () => ({ value: [{ role: 'user', text: 'We are reviewing a function.', toolUses: [] }] }));
  on('prompt.read', () => ({ value: { text: draft, cursor: draft.length } }));
  on('prompt.fill', (_, e) => { draft = e.text; fills.push(e.text); return { isFilled: true }; });
  on('prompt.submit', () => { submits++; return { drop: 'unexpected submit' }; });
  on('http.fetch', (_, e) => {
    expect(e.url).toBe(DEFAULTS.endpoint);
    expect(e.init?.headers?.Authorization).toBeUndefined();
    const body = JSON.parse(e.init!.body!);
    expect(body.reasoning.effort).toBe('none');
    return { value: { ok: true, status: 200, headers: {}, text: JSON.stringify({ status: 'completed', output_text: JSON.stringify({
      sourceLanguage: 'zh', translationLanguage: 'en', translationText: 'Please inspect this function.',
      correctedEnglish: '', polishedEnglish: '', issues: [],
    }) }) } };
  });
  await $.session.start({ cwd: '.', surface: 'terminal', isInteractive: true });
  await $.command.run({ command: 'ea-check' });
  await clock.settle();
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'english-assistant', surface, component: 'AbovePrompt', props: bandProps });
    expect(await ui.find({ key: 'ea-apply-translation' })).toBeDefined();
    await ui.press({ key: 'ea-apply-translation' });
    expect(draft).toBe('Please inspect this function.');
    expect(submits).toBe(0);
    await ui.redraw();
    await ui.press({ key: 'ea-undo' });
    expect(draft).toBe('请检查这个函数。');
    await ui.unmount();
    await $.command.run({ command: 'ea-check' });
    await clock.settle();
  }
  expect(fills.length).toBe(4);
});

test('native pane renders a translated completed reply and untouched code', async ($, on) => {
  const clock = mock.clock(on);
  on('session.start', (_, e) => ({ cwd: e.cwd }));
  on('command.register', (_, e) => ({ value: { command: e.name } }));
  on('ui.invalidate', () => ({ value: undefined }));
  on('turn.complete', (_, e) => ({ text: e.answer }));
  on('fs.read', () => ({ value: JSON.stringify(DEFAULTS) }));
  on('session.messages', () => ({ value: [] }));
  on('ui.open', () => ({ value: { isPlaced: true } }));
  on('http.fetch', () => ({ value: { ok: true, status: 200, headers: {}, text: JSON.stringify({ status: 'completed', output_text: '{"translationZh":"全部完成。"}' }) } }));
  await $.session.start({ cwd: '.', surface: 'terminal', isInteractive: true });
  await $.turn.complete({ answer: 'All done.\n```js\nfoo();\n```', reason: 'answer', durationMs: 100, isAborted: false, turnId: 'test-turn' });
  await clock.advance(1);
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'english-assistant', surface, component: 'Pane', requestId: 'ea-bilingual', props: paneProps });
    expect(await ui.find({ type: 'Markdown', text: '全部完成。' })).toBeDefined();
    expect(await ui.find({ type: 'Markdown', text: 'foo();' })).toBeDefined();
    await ui.unmount();
  }
});

test('native reply band and pane close diff before opening EA without regenerating translation', async ($, on) => {
  const clock = mock.clock(on);
  let requests = 0, opens = 0, closes = 0;
  on('session.start', (_, e) => ({ cwd: e.cwd }));
  on('command.register', (_, e) => ({ value: { command: e.name } }));
  on('ui.invalidate', () => ({ value: undefined }));
  on('ui.render', ($, e) => $.ui.resolve(e).Box({ children: [] }));
  on('turn.complete', (_, e) => ({ text: e.answer }));
  on('fs.read', () => ({ value: JSON.stringify(DEFAULTS) }));
  on('session.messages', () => ({ value: [] }));
  on('ui.open', (_, e) => { expect(e.id).toBe('ea-bilingual'); opens++; return { value: { isPlaced: true } }; });
  on('ui.close', (_, e) => { expect(['ea-bilingual', 'diff'].includes(e.id)).toBe(true); closes++; return { value: undefined }; });
  on('http.fetch', () => { requests++; return { value: { ok: true, status: 200, headers: {}, text: '{"status":"completed","output_text":"{\\"translationZh\\":\\"全部完成。\\"}"}' } }; });
  await $.session.start({ cwd: '.', surface: 'terminal', isInteractive: true });
  await $.turn.complete({ answer: 'All done.', reason: 'answer', durationMs: 1, isAborted: false, turnId: 'toggle-test' });
  await clock.advance(1); await clock.settle();
  expect(opens).toBe(0);
  for (const surface of ['terminal', 'desktop'] as const) {
    const band = await $.ui.mount({ plugin: 'english-assistant', surface, component: 'AbovePrompt', props: bandProps });
    await band.press({ key: 'ea-open-reply' });
    const pane = await $.ui.mount({ plugin: 'english-assistant', surface, component: 'Pane', requestId: 'ea-bilingual', props: paneProps });
    expect(await pane.find({ type: 'Markdown', text: '全部完成。' })).toBeDefined();
    await pane.press({ key: 'ea-back-panel' });
    await band.redraw(); await band.press({ key: 'ea-open-reply' });
    await band.press({ key: 'ea-back-panel' });
    await pane.unmount(); await band.unmount();
  }
  expect(opens).toBe(4); expect(closes).toBe(8); expect(requests).toBe(1);
});
