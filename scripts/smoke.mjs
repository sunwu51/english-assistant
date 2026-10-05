import { readFile, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { parseConfig, draftRequest, responseJson, validateDraft, replyRequest, restoreLiterals, requestHeaders } from '../hooks/core.js';

const base = JSON.parse(await readFile(new URL('../config.json', import.meta.url), 'utf8'));
let local = {};
try { local = JSON.parse(await readFile(new URL('../config.local.json', import.meta.url), 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw new Error('config.local.json 无效或不可读取'); }
const cfg = parseConfig({ ...base, ...local });
const token = cfg.apiKeyEnv ? process.env.EA_API_KEY || '' : cfg.apiKey;
if (cfg.apiKeyEnv && !token) throw new Error('EA_API_KEY 未设置');
const cases = [
  { name: '中文转英文', source: '帮我检查这个函数有没有内存泄漏。', context: [], language: 'zh' },
  { name: '英文纠错与润色', source: 'Please explan how this functon works.', context: [], language: 'en' },
  { name: '混合输入与代码保护', source: '请检查 `AbortController`，不要修改 https://example.com/cancel 的地址。', context: [], language: 'mixed' },
  { name: '上下文与否定意图', source: '再看看取消的时候有没有问题，先不要改代码。',
    context: [{ role: 'user', text: 'We are reviewing cancellation of an asynchronous download function.' }, { role: 'assistant', text: 'I will inspect how cancellation releases resources.' }], language: 'zh' },
];
const report = { endpoint: cfg.endpoint, model: cfg.model, protocol: cfg.protocol, authentication: token && cfg.authType !== 'none' ? 'configured' : 'none', reasoningEffort: cfg.reasoningEffort, results: [] };
async function call(body) {
  const start = performance.now();
  const response = await fetch(cfg.endpoint, { method: 'POST', headers: requestHeaders(cfg, token), body: JSON.stringify(body), signal: AbortSignal.timeout(cfg.requestTimeoutMs) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const raw = await response.json();
  return { value: responseJson(raw, cfg.protocol), elapsedMs: Math.round(performance.now() - start), usage: raw.usage };
}
for (const testCase of cases) {
  const request = draftRequest(testCase.source, testCase.context, cfg);
  const result = await call(request.body);
  const analysis = validateDraft(result.value, request.protectedSource);
  // Mixing technical names into Chinese can legitimately be classified zh or mixed.
  if (testCase.language !== 'mixed' && analysis.sourceLanguage !== testCase.language) throw new Error(`${testCase.name}: wrong source language`);
  report.results.push({ name: testCase.name, source: testCase.source, context: testCase.context, ...result, analysis });
  process.stdout.write(`${testCase.name}: ${result.elapsedMs} ms\n${JSON.stringify(analysis, null, 2)}\n`);
}
const segment = { source: 'Cancellation aborts the download through `AbortController`. No code changes were made.' };
const request = replyRequest(segment, cases[3].context, cfg);
const result = await call(request.body);
const translationZh = restoreLiterals(result.value.translationZh, request.protectedSource.literals);
report.results.push({ name: '最终回复翻译', source: segment.source, ...result, translationZh });
process.stdout.write(`最终回复翻译: ${result.elapsedMs} ms\n${translationZh}\n`);
await writeFile(new URL('../debug-report.json', import.meta.url), JSON.stringify(report, null, 2) + '\n');
