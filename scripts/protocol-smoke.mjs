import { readFile, writeFile } from 'node:fs/promises';
import { parseConfig, draftRequest, requestHeaders, responseJson, validateDraft, normalizedUsage } from '../hooks/core.js';
const base = JSON.parse(await readFile(new URL('../config.json', import.meta.url), 'utf8'));
let local = {};
try { local = JSON.parse(await readFile(new URL('../config.local.json', import.meta.url), 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw new Error('config.local.json 无效'); }
const cfg = parseConfig({ ...base, ...local });
const token = cfg.apiKeyEnv ? process.env.EA_API_KEY || '' : cfg.apiKey;
if (cfg.apiKeyEnv && !token) throw new Error('EA_API_KEY 未设置');
const results = [];
for (const protocol of ['responses', 'chat/completions', 'messages']) {
  const endpoint = cfg.endpoint.replace(/\/(?:responses|chat\/completions|messages)\/?$/, '/' + protocol);
  const current = { ...cfg, protocol, endpoint };
  const request = draftRequest('Please explan how this functon works.', [], current);
  const started = Date.now();
  try {
    const response = await fetch(endpoint, { method: 'POST', headers: requestHeaders(current, token), body: JSON.stringify(request.body), signal: AbortSignal.timeout(cfg.requestTimeoutMs) });
    if (!response.ok) throw new Error('HTTP ' + response.status);
    const raw = await response.json();
    const analysis = validateDraft(responseJson(raw, protocol), request.protectedSource);
    results.push({ protocol, endpoint, ok: true, elapsedMs: Date.now() - started, usage: normalizedUsage(raw, protocol), analysis });
  } catch (e) { results.push({ protocol, endpoint, ok: false, error: token ? e.message.replaceAll(token, '[redacted]') : e.message }); }
  console.log(JSON.stringify(results.at(-1)));
}
await writeFile(new URL('../debug-protocol-report.json', import.meta.url), JSON.stringify(results, null, 2));
if (results.some(r => !r.ok)) process.exitCode = 1;
