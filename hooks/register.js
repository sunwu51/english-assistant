import {
  DEFAULTS, parseConfig, eligibleDraft, contextFromMessages, draftRequest,
  responseJson, validateDraft, choicesFor, replySegments, replyRequest, restoreLiterals, hasComposerReferences, requestHeaders, normalizedUsage,
} from './core.js';
import { parseMarkdownTable, renderTerminalTable } from './table-layout.js';

const PANE = 'ea-bilingual';
const REFERENCE_NOTICE = '含粘贴或图片引用：仅展示建议，已禁用整框替换；未读取引用背后的内容。';
const tokenTotals = () => ({ input: 0, output: 0, cached: 0, cacheWrite: 0, reasoning: 0, reported: 0, unknown: 0 });

async function recordUsage($, s, id, lane, raw, late) {
  const usage = normalizedUsage(raw, s.cfg.protocol);
  for (const totals of [s.tokens, s.tokenLanes[lane]]) {
    if (!usage) totals.unknown++;
    else { totals.reported++; for (const field of ['input', 'output', 'cached', 'cacheWrite', 'reasoning']) totals[field] += usage[field]; }
  }
  s.usageRecords.push({ id, lane, usage, late });
  if (s.usageRecords.length > 20) s.usageRecords.shift();
  if (!s.usageFile) return;
  const snapshot = JSON.stringify({ version: 1, tokens: s.tokens, lanes: s.tokenLanes });
  // Each module load owns one file. Serialize draft/reply writes within it;
  // separate Claude processes never read-modify-write the same totals file.
  s.usageWrite = s.usageWrite.then(async () => {
    try { await $.fs.write(s.usageFile, snapshot); s.usageError = ''; }
    catch { s.usageError = '全局用量写入失败，本次加载统计仍可查看'; }
  });
  await s.usageWrite;
}

async function initUsage($, s) {
  try {
    const configured = await $.env.get('CLAUDE_CONFIG_DIR');
    const home = configured ? '' : await $.env.get('USERPROFILE') || await $.env.get('HOME');
    if (!configured && !home) throw new Error('无法确定用户配置目录');
    s.usageDir = (configured || home + '/.claude').replace(/[\\/]$/, '') + '/english-assistant/usage';
    const run = (await $.clock.now()) + '-' + Math.random().toString(36).slice(2) + '-' + Math.random().toString(36).slice(2);
    s.usageFile = s.usageDir + '/' + run + '.json';
  } catch { s.usageError = '无法初始化全局用量目录'; }
}

async function globalUsageText($, s) {
  await s.usageWrite;
  const totals = tokenTotals();
  let invalid = 0;
  if (!s.usageDir) return '全局 Token：不可用；' + s.usageError;
  try {
    let files;
    try { files = await $.fs.list(s.usageDir); }
    catch (error) { if (/ENOENT|not found|no such file|不存在|找不到/i.test(error.message || '')) files = []; else throw error; }
    for (const file of files) {
      if (!file.name.endsWith('.json')) continue;
      try {
        const entry = JSON.parse(await $.fs.read(s.usageDir + '/' + file.name));
        if (entry.version !== 1 || !entry.tokens || !Object.keys(totals).every(k => Number.isSafeInteger(entry.tokens[k]) && entry.tokens[k] >= 0)) throw new Error('invalid');
        for (const key of Object.keys(totals)) totals[key] += entry.tokens[key];
      } catch { invalid++; }
    }
    return `全局 Token 累计：输入 ${totals.input}，输出 ${totals.output}，合计 ${totals.input + totals.output}\n全局输入细分：普通 ${totals.input - totals.cached - totals.cacheWrite}，缓存读取 ${totals.cached}，缓存写入 ${totals.cacheWrite}；输出中推理 ${totals.reasoning}\n全局已记录用量 ${totals.reported} 次\n记录目录：${s.usageDir}${invalid ? '\n有 ' + invalid + ' 个记录暂时无法读取，汇总可能不完整' : ''}${s.usageError ? '\n' + s.usageError : ''}`;
  } catch { return '全局 Token：读取失败；本次加载统计仍可查看'; }
}

function newState() {
  return { cfg: { ...DEFAULTS }, enabled: true, epoch: 0, revision: 0,
    draftText: '', draftStatus: '', draftError: '', analysis: null, snapshot: null,
    draftTimer: null, draftBusy: false, draftPending: false,
    reply: null, replyBusy: false, replyPending: false, replyTimer: null,
    cache: new Map(), undo: null, lastPrompt: '', dismissed: false,
    applying: false, expanded: false, notice: '', configError: '', requests: 0, lastLatencyMs: null,
    lastDraftEvent: '未分析', lastRequestEvent: '未请求',
    lastMainTurn: '未收到主会话完成事件', lastPaneOpen: '尚未打开', replyRenders: 0,
    usageDir: '', usageFile: '', usageError: '', usageWrite: Promise.resolve(),
    authToken: '', tokens: tokenTotals(), tokenLanes: { draft: tokenTotals(), reply: tokenTotals(), debug: tokenTotals() }, usageRecords: [] };
}

function invalidateDraft(s) {
  s.revision++;
  s.draftTimer?.cancel(); s.draftTimer = null; s.draftPending = false;
  s.analysis = null; s.snapshot = null; s.draftStatus = ''; s.draftError = ''; s.dismissed = false;
  s.expanded = false;
}

function remember(s, key, value) {
  if (!s.cfg.cacheEntries) return;
  s.cache.delete(key); s.cache.set(key, value);
  while (s.cache.size > s.cfg.cacheEntries) s.cache.delete(s.cache.keys().next().value);
}

// The host API has no AbortSignal. Timeout the UI waiter, but keep the lane
// busy until the physical HTTP request settles to bound network concurrency.
async function responses($, s, body, released, lane = 'draft') {
  const requestId = ++s.requests;
  s.lastRequestEvent = `#${requestId} HTTP 请求中`;
  const started = await $.clock.now();
  let expired = false;
  const { response, raw } = await new Promise((resolve, reject) => {
    const deadline = $.clock.after(s.cfg.requestTimeoutMs, () => { expired = true; reject(new Error('语言服务超时；请求结束后可重试')); });
    $.http.fetch(s.cfg.endpoint, {
      method: 'POST', headers: requestHeaders(s.cfg, s.authToken), body: JSON.stringify(body),
    }).then(async response => {
      let raw;
      try { raw = JSON.parse(response.text); }
      catch { await recordUsage($, s, requestId, lane, null, expired); s.lastRequestEvent = `#${requestId} HTTP ${response.status} 已返回，但不是合法 JSON`; reject(new Error('语言服务响应不是合法 JSON')); return; }
      // Account physical completions even when stale, invalid or past the UI timeout.
      await recordUsage($, s, requestId, lane, raw, expired);
      s.lastRequestEvent = `#${requestId} HTTP ${response.status} 已返回${expired ? '（超时后的迟到结果）' : ''}`;
      resolve({ response, raw });
    }, async () => { await recordUsage($, s, requestId, lane, null, expired); s.lastRequestEvent = `#${requestId} HTTP 连接失败`; reject(new Error('语言服务 HTTP 连接失败')); })
      .finally(() => { deadline.cancel(); released(); });
  });
  if (!response.ok) throw new Error(`语言服务 HTTP ${response.status}`);
  const result = responseJson(raw, s.cfg.protocol);
  s.lastLatencyMs = (await $.clock.now()) - started;
  return result;
}

function reconcileDraft($, s, text) {
  invalidateDraft(s); s.draftText = text; s.undo = null; s.notice = '';
  s.lastDraftEvent = `发现未经过编辑 Hook 的草稿变化，已同步到版本 ${s.revision}`;
  if (s.enabled && eligibleDraft(text, s.cfg)) scheduleDraft($, s);
}

async function currentContext($, s, omitAnswer = '') {
  try { return contextFromMessages(await $.session.messages(), s.cfg, omitAnswer); }
  catch { return []; }
}

function scheduleDraft($, s, delay = s.cfg.debounceMs) {
  s.draftTimer?.cancel();
  s.draftTimer = $.clock.after(delay, () => {
    s.draftTimer = null;
    if (!s.enabled || !eligibleDraft(s.draftText, s.cfg)) return;
    if (s.draftBusy) {
      s.draftStatus = '等待上一输入请求结束…';
      s.lastDraftEvent = `版本 ${s.revision} 已排队，仅保留最新草稿`;
      $.ui.invalidate('ui.render');
    }
    s.draftPending = true; void analyzeDraft($, s);
  });
}

async function analyzeDraft($, s) {
  if (s.draftBusy || !s.draftPending || !s.enabled) return;
  s.draftPending = false;
  const revision = s.revision, epoch = s.epoch, source = s.draftText;
  const valid = () => s.enabled && epoch === s.epoch && revision === s.revision;
  s.draftBusy = true;
  s.lastDraftEvent = `开始分析版本 ${revision}，会话版本 ${epoch}`;
  let physicalStarted = false;
  const release = () => {
    s.draftBusy = false;
    if (s.draftPending && s.enabled) scheduleDraft($, s, 1);
  };
  try {
    const context = await currentContext($, s);
    if (!valid()) return;
    const box = await $.prompt.read();
    if (!valid()) return;
    if (box.text !== source) { reconcileDraft($, s, box.text); return; }
    const request = draftRequest(source, context, s.cfg);
    const key = JSON.stringify(request.body);
    s.draftStatus = '翻译与表达分析中…'; s.draftError = '';
    $.ui.invalidate('ui.render');
    let analysis = s.cache.get(key);
    if (!analysis) {
      physicalStarted = true;
      analysis = validateDraft(await responses($, s, request.body, release), request.protectedSource);
      if (valid()) remember(s, key, analysis);
    }
    const latestBox = await $.prompt.read();
    if (!valid()) { s.lastDraftEvent = `丢弃旧版本 ${revision}，当前版本 ${s.revision}`; return; }
    if (latestBox.text !== source) { reconcileDraft($, s, latestBox.text); return; }
    s.analysis = analysis; s.snapshot = { revision, epoch, source }; s.draftStatus = '';
    s.lastDraftEvent = `版本 ${revision} 已生成建议并请求刷新 UI`;
  } catch (error) {
    if (valid()) {
      // A paste can change the real composer without a prompt.edit event.
      let latestBox;
      try { latestBox = await $.prompt.read(); } catch { /* Keep the original error. */ }
      if (valid() && latestBox && latestBox.text !== source) reconcileDraft($, s, latestBox.text);
      else if (valid()) {
        s.draftError = error.message || '语言服务请求失败'; s.draftStatus = '';
        s.lastDraftEvent = `版本 ${revision} 分析失败：${s.draftError}`;
      }
    }
  } finally {
    if (!physicalStarted) release();
    $.ui.invalidate('ui.render');
  }
}

async function applyChoice($, s, snapshot, text) {
  if (!snapshot || snapshot.revision !== s.revision || snapshot.epoch !== s.epoch) return;
  const box = await $.prompt.read();
  if (hasComposerReferences(box.text)) { $.ui.toast(REFERENCE_NOTICE); return; }
  if (snapshot.revision !== s.revision || snapshot.epoch !== s.epoch || box.text !== snapshot.source) {
    $.ui.toast('输入已变化，请使用最新建议'); return;
  }
  s.applying = true;
  try {
    // fill changes only the draft. This plugin never calls prompt.submit.
    const result = await $.prompt.fill({ text, mode: 'replace' });
    if (!result.isFilled) { $.ui.toast('暂时无法替换输入框，请关闭当前对话框后重试'); return; }
    invalidateDraft(s); s.draftText = result.text;
    s.undo = { before: box.text, after: result.text, epoch: s.epoch };
    s.notice = '已替换输入框，尚未发送';
  } finally { s.applying = false; $.ui.invalidate('ui.render'); }
}

async function undoChoice($, s) {
  const undo = s.undo;
  if (!undo || undo.epoch !== s.epoch) return;
  const box = await $.prompt.read();
  if (hasComposerReferences(box.text)) { s.undo = null; $.ui.toast(REFERENCE_NOTICE); $.ui.invalidate('ui.render'); return; }
  if (box.text !== undo.after || s.undo !== undo) { s.undo = null; $.ui.toast('输入已变化，不能撤销旧替换'); return; }
  s.applying = true;
  try {
    const result = await $.prompt.fill({ text: undo.before, mode: 'replace' });
    if (result.isFilled) { invalidateDraft(s); s.draftText = result.text; s.undo = null; s.notice = '已恢复原文，尚未发送'; }
  } finally { s.applying = false; $.ui.invalidate('ui.render'); }
}

function scheduleReply($, s) {
  s.replyTimer?.cancel();
  s.replyTimer = $.clock.after(1, () => { s.replyTimer = null; void translateReply($, s); });
}

async function showReplyPane($, s) {
  // The native diff pane holds the foreground; opening EA with focus alone
  // does not reliably switch away from it. Closing via plugin origin lets
  // the native diff hook clear its open state without saving a user dismissal.
  await $.ui.close({ id: 'diff' });
  const opened = await $.ui.open({ id: PANE, title: '最后回复 · 中英对照', focus: true, closeOnEscape: true });
  s.lastPaneOpen = opened.isPlaced ? '手动打开已放置并请求焦点' : '手动打开未放置：' + opened.reason;
  $.ui.invalidate('ui.render');
}

async function recoverLastReply($, s) {
  if (s.reply) return;
  if (!s.enabled) { $.ui.toast(s.configError || '英语辅助已关闭，请先开启'); return; }
  const epoch = s.epoch;
  try {
    const messages = await $.session.messages();
    // A newer completed turn or session switch owns the state if it arrived
    // while history was being read. Ignore tool-call commentary in history.
    if (epoch !== s.epoch || s.reply || !s.enabled) return;
    const message = messages.slice().reverse().find(m => m.role === 'assistant' && m.text?.trim() && !m.toolUses?.length);
    if (!message) { $.ui.toast('当前会话没有可翻译的助手回复，请先恢复已有会话或完成一轮对话'); return; }
    s.reply = { turnId: null, source: message.text, status: '等待翻译', error: '', segments: replySegments(message.text, s.cfg.replySegmentChars) };
    s.replyPending = true;
    scheduleReply($, s);
    $.ui.invalidate('ui.render');
  } catch (error) { $.ui.toast('读取最后回复失败：' + error.message); }
}

async function openLastReply($, s) {
  await recoverLastReply($, s);
  await showReplyPane($, s);
}

async function hideReplyPane($, s) {
  // Only close our own pane. The host owns native diff/view selection.
  await $.ui.close({ id: PANE });
  s.lastPaneOpen = '译文面板已收起；译文结果保留（不自动恢复 diff）';
  $.ui.invalidate('ui.render');
}

async function showDiffPane($, s) {
  try {
    const commands = await $.command.list();
    if (!commands.some(command => command.name === 'diff')) throw new Error('当前 Claude 没有可用的 /diff 命令');
    await hideReplyPane($, s);
    let result = await $.command.run({ command: 'diff', args: '' });
    // /diff toggles its own state, which ui.panes() cannot inspect. If it
    // explicitly reports closing an existing diff, invoke it once more to open.
    if (/Diff panel hidden|Diff dialog dismissed/i.test(result.text || '')) {
      result = await $.command.run({ command: 'diff', args: '' });
    }
    s.lastPaneOpen = '已调用原生 /diff' + (result.text ? '：' + result.text : '');
    if (result.text) $.ui.toast(result.text);
  } catch (error) {
    s.lastPaneOpen = '查看 diff 失败：' + error.message;
    $.ui.toast(s.lastPaneOpen);
  }
  $.ui.invalidate('ui.render');
}

function requestDiffPane($, s) {
  // command.run cannot recursively run another command while holding its
  // dispatch. Let the current event finish before asking the host to run diff.
  $.clock.after(1, () => { void showDiffPane($, s); });
}

async function translateReply($, s) {
  if (s.replyBusy || !s.replyPending || !s.reply || !s.enabled) return;
  s.replyPending = false; s.replyBusy = true;
  const reply = s.reply, epoch = s.epoch;
  const valid = () => s.enabled && epoch === s.epoch && s.reply === reply;
  let waitingForPhysical = false, expired = false;
  try {
    const context = await currentContext($, s, reply.source);
    if (!valid()) return;
    if (s.lastPrompt && !context.some(m => m.role === 'user' && m.text === s.lastPrompt)) context.push({ role: 'user', text: s.lastPrompt.slice(-2000) });
    reply.status = '翻译中'; reply.error = '';
    for (const segment of reply.segments) {
      if (!valid()) return;
      if (segment.kind !== 'text' || segment.translation) continue;
      const request = replyRequest(segment, context, s.cfg), key = JSON.stringify(request.body);
      let translation = s.cache.get(key);
      if (!translation) {
        waitingForPhysical = true;
        const value = await responses($, s, request.body, () => {
          waitingForPhysical = false;
          if (expired) { s.replyBusy = false; if (s.replyPending) scheduleReply($, s); }
        }, 'reply');
        translation = restoreLiterals(value.translationZh, request.protectedSource.literals);
        if (!translation.trim() || translation.length > 40000) throw new Error('回复译文无效');
        if (valid()) remember(s, key, translation);
      }
      if (!valid()) return;
      segment.translation = translation; $.ui.invalidate('ui.render');
    }
    if (valid()) reply.status = '已完成';
  } catch (error) {
    expired = waitingForPhysical;
    if (valid()) { reply.status = '翻译失败'; reply.error = error.message || '语言服务请求失败'; }
  } finally {
    if (!waitingForPhysical) { s.replyBusy = false; if (s.replyPending) scheduleReply($, s); }
    $.ui.invalidate('ui.render');
  }
}

function statusText(s) {
  const reply = s.reply;
  const segments = reply?.segments || [];
  const texts = segments.filter(segment => segment.kind === 'text');
  const replyStatus = reply ? `${reply.status}；文字段 ${texts.filter(segment => segment.translation).length}/${texts.length}；代码段 ${segments.filter(segment => segment.kind === 'code').length}${reply.error ? '；错误：' + reply.error : ''}` : '无回复记录';
  const t = s.tokens;
  const usageText = `Token 累计（本次插件加载）：输入 ${t.input}，输出 ${t.output}，合计 ${t.input + t.output}\n输入细分：普通 ${t.input - t.cached - t.cacheWrite}，缓存读取 ${t.cached}，缓存写入 ${t.cacheWrite}；输出中推理 ${t.reasoning}\n已记录用量 ${t.reported} 次\n` +
    Object.entries(s.tokenLanes).map(([name, u]) => `${name}：输入 ${u.input}，输出 ${u.output}，缓存读取 ${u.cached}`).join('\n') + '\n最近请求 Token：\n' +
    s.usageRecords.slice(-5).map(r => `#${r.id} ${r.lane} ${r.usage ? `输入 ${r.usage.input} / 输出 ${r.usage.output} / 缓存读取 ${r.usage.cached} / 缓存写入 ${r.usage.cacheWrite}` : 'usage 未提供'}${r.late ? '（迟到）' : ''}`).join('\n');
  return `英语辅助：${s.enabled ? '开启' : '关闭'}\n模型：${s.cfg.model}\n接口：${s.cfg.endpoint}\n协议：${s.cfg.protocol}；鉴权：${s.authToken && s.cfg.authType !== 'none' ? '已配置' : '无'}\n请求次数：${s.requests}\n${usageText}\n最近耗时：${s.lastLatencyMs === null ? '未测量' : s.lastLatencyMs + ' ms'}\n输入请求槽位：${s.draftBusy ? '占用' : '空闲'}；待处理：${s.draftPending ? '是' : '否'}\n草稿版本：${s.revision}；会话版本：${s.epoch}\n最近 HTTP：${s.lastRequestEvent}\n最近分析：${s.lastDraftEvent}\n最近主会话：${s.lastMainTurn}\n回复翻译：${replyStatus}\n回复请求槽位：${s.replyBusy ? '占用' : '空闲'}；待处理：${s.replyPending ? '是' : '否'}\n最近面板打开：${s.lastPaneOpen}；双语渲染次数：${s.replyRenders}\n${s.configError ? '配置错误：' + s.configError : '采用建议只替换草稿，不发送。'}`;
}

function markdownChunks(Markdown, Text, text, tableUI) {
  const nodes = [];
  // Use the same row boundaries for translated tables and the host's 10k
  // Markdown limit. Continuations must carry their own header and separator.
  for (const { source } of replySegments(text, 9500)) {
    const table = tableUI && parseMarkdownTable(source);
    if (table && source.length <= 9500) nodes.push(renderTerminalTable(table, tableUI.columns, tableUI));
    else if (source.length <= 9500) nodes.push(Markdown({ text: source }));
    else {
      // A single huge row (or code block) cannot fit one Markdown element.
      // Preserve it as literal text rather than hand the host broken markup.
      for (let i = 0; i < source.length; i += 9500) nodes.push(Text({ children: [source.slice(i, i + 9500)] }));
    }
  }
  return nodes;
}

export function register(on, options = {}) {
  const s = newState();
  on('session.start', async ($, e, next) => {
    if (!s.usageFile) await initUsage($, s);
    try {
      const base = JSON.parse(await $.fs.read($.plugin.root + '/config.json'));
      let localText;
      try { localText = await $.fs.read($.plugin.root + '/config.local.json'); } catch (error) {
        if (!/ENOENT|not found|no such file|不存在|找不到/i.test(error.message || '')) throw new Error('无法读取 config.local.json');
      }
      const local = localText === undefined ? {} : JSON.parse(localText);
      const supplied = Object.fromEntries(Object.entries(options).filter(([, value]) => value !== undefined && value !== null && value !== ''));
      s.cfg = parseConfig({ ...base, ...local, ...supplied });
      s.authToken = s.cfg.apiKeyEnv ? await $.env.get('EA_API_KEY') || '' : s.cfg.apiKey;
      if (s.cfg.apiKeyEnv && !s.authToken) throw new Error('EA_API_KEY 未设置');
      requestHeaders(s.cfg, s.authToken);
      s.enabled = s.cfg.enabled; s.configError = '';
    } catch (error) { s.enabled = false; s.configError = error instanceof SyntaxError ? '配置 JSON 无效，请检查配置文件格式' : error.message; }
    await $.command.register({ name: 'ea-status', description: '查看翻译服务状态', immediate: true });
    await $.command.register({ name: 'ea-toggle', description: '开关英语辅助', immediate: true });
    await $.command.register({ name: 'ea-reply', description: '打开最后回复的中英对照', immediate: true });
    await $.command.register({ name: 'ea-back', description: '收起译文面板，归还原面板显示区域', immediate: true });
    await $.command.register({ name: 'ea-diff', description: '关闭 EA 面板并调用原生 /diff 查看代码修改', immediate: true });
    await $.command.register({ name: 'ea-check', description: '分析草稿或将指定文本填入草稿后分析', argumentHint: '[text]', immediate: true });
    await $.command.register({ name: 'ea-debug', description: '用一段示例文本测试翻译接口', argumentHint: '[text]', immediate: true });
    return next(e);
  });
  on('prompt.edit', async ($, e, next) => {
    const box = await next(e);
    if (box.text === s.draftText) return box;
    invalidateDraft(s); s.draftText = box.text; s.undo = null; s.notice = '';
    if (s.enabled && eligibleDraft(box.text, s.cfg)) scheduleDraft($, s);
    $.ui.invalidate('ui.render'); return box;
  });
  on('prompt.fill', async ($, e, next) => {
    invalidateDraft(s);
    if (!s.applying) { s.undo = null; s.notice = ''; }
    const result = await next(e);
    if (result.isFilled) s.draftText = (await $.prompt.read()).text;
    $.ui.invalidate('ui.render'); return result;
  });
  on('prompt.submit', async ($, e, next) => {
    invalidateDraft(s); s.undo = null; s.notice = ''; s.draftText = '';
    if (e.origin?.kind === 'composer' && !e.text.startsWith('/')) s.lastPrompt = e.text;
    $.ui.invalidate('ui.render'); return next(e);
  });
  on('turn.complete', async ($, e, next) => {
    const result = await next(e);
    if (!e.agentId) s.lastMainTurn = `${e.turnId}，${e.reason}，回答长度 ${e.answer?.length || 0}`;
    if (e.agentId || e.reason !== 'answer' || !e.answer?.trim()) return result;
    s.reply = { turnId: e.turnId, source: e.answer, status: '原文', error: '', segments: replySegments(e.answer, s.cfg.replySegmentChars) };
    s.replyPending = s.enabled && s.cfg.translateReplies;
    if (s.replyPending) { s.reply.status = '等待翻译'; scheduleReply($, s); }
    // Automatic opening leaves keyboard focus in the original prompt.
    if (s.enabled && s.cfg.autoOpenReplyPane) {
      const opened = await $.ui.open({ id: PANE, title: '最后回复 · 中英对照' });
      s.lastPaneOpen = opened.isPlaced ? '自动打开已放置（不请求焦点）' : '自动打开未放置：' + opened.reason;
      if (!opened.isPlaced) s.notice = '回复译文可通过 /ea-reply 查看';
    }
    $.ui.invalidate('ui.render'); return result;
  });
  on('session.end', async ($, e, next) => {
    s.epoch++; invalidateDraft(s);
    s.replyTimer?.cancel(); s.replyTimer = null; s.replyPending = false;
    s.reply = null; s.undo = null; s.draftText = ''; s.lastPrompt = ''; s.notice = ''; s.cache.clear();
    s.lastMainTurn = '会话已重置'; s.lastPaneOpen = '尚未打开'; s.replyRenders = 0;
    $.ui.invalidate('ui.render'); return next(e);
  });
  on('command.run', { command: 'ea-status' }, async ($) => {
    let paneStatus;
    try {
      const pane = (await $.ui.panes()).find(p => p.id === PANE);
      paneStatus = pane ? `已放置=${pane.isPlaced}，当前显示=${pane.isShown}，焦点=${pane.isFocused}` : '未打开';
    } catch { paneStatus = '读取失败'; }
    return { text: await globalUsageText($, s) + '\n\n' + statusText(s) + '\n双语面板实时状态：' + paneStatus };
  });
  on('command.run', { command: 'ea-toggle' }, async ($) => {
    if (s.configError) return { text: '请修复 config.json 后运行 /reload-plugins：' + s.configError };
    s.enabled = !s.enabled; s.epoch++; invalidateDraft(s);
    s.undo = null; s.notice = '';
    if (s.reply) { s.reply.status = '原文'; s.reply.error = ''; }
    s.replyTimer?.cancel(); s.replyPending = false; $.ui.invalidate('ui.render');
    return { text: s.enabled ? '英语辅助已开启' : '英语辅助已关闭' };
  });
  on('command.run', { command: 'ea-reply' }, async ($) => {
    await openLastReply($, s);
    return {};
  });
  on('command.run', { command: 'ea-back' }, async ($) => { await hideReplyPane($, s); return {}; });
  on('command.run', { command: 'ea-diff' }, async ($) => { requestDiffPane($, s); return { text: '正在切换到原生 diff…' }; });
  on('command.run', { command: 'ea-check' }, async ($, e) => {
    if (e.args?.trim()) {
      if (hasComposerReferences((await $.prompt.read()).text)) return { text: REFERENCE_NOTICE + ' 请使用不带参数的 /ea-check 分析当前草稿。' };
      const filled = await $.prompt.fill({ text: e.args, mode: 'replace' });
      if (!filled.isFilled) return { text: '当前会话没有可填入的输入框' };
    }
    const box = await $.prompt.read();
    invalidateDraft(s); s.draftText = box.text; s.undo = null; s.notice = '';
    if (!s.enabled) return { text: '英语辅助已关闭' };
    if (!eligibleDraft(box.text, s.cfg)) return { text: '当前草稿为空、过长或没有可分析的自然语言' };
    s.draftPending = true; void analyzeDraft($, s); return {};
  });
  on('command.run', { command: 'ea-debug' }, async ($, e) => {
    if (s.configError) return { text: s.configError };
    if (s.draftBusy) return { text: '输入分析请求仍在进行，请稍后重试。' };
    s.draftBusy = true;
    let physicalStarted = false;
    try {
      const source = e.args.trim() || '帮我检查这个函数有没有内存泄漏。';
      const request = draftRequest(source, await currentContext($, s), s.cfg);
      physicalStarted = true;
      const value = await responses($, s, request.body, () => {
        s.draftBusy = false;
        if (s.draftPending) scheduleDraft($, s, 1);
      }, 'debug');
      const analysis = validateDraft(value, request.protectedSource);
      return { text: `接口调试成功 · ${s.lastLatencyMs} ms\n` + JSON.stringify(analysis, null, 2) };
    } catch (error) { return { text: '接口调试失败：' + error.message }; }
    finally { if (!physicalStarted) s.draftBusy = false; }
  });
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const theirs = await next(e);
    if ((!s.enabled || s.dismissed) && !s.notice && !s.configError && !(s.enabled && s.reply)) return theirs;
    const { Box, Text, Button } = $.ui.resolve(e), nodes = [];
    if (s.configError) nodes.push(Text({ color: 'red', children: ['英语辅助配置错误：' + s.configError] }));
    if (s.notice) nodes.push(Text({ dimColor: true, children: [s.notice] }));
    if (s.draftStatus) nodes.push(Text({ dimColor: true, children: [s.draftStatus] }));
    if (s.draftError) nodes.push(Text({ color: 'red', children: [s.draftError] }));
    if (hasComposerReferences(s.draftText)) nodes.push(Text({ dimColor: true, children: [REFERENCE_NOTICE] }));
    const analysis = s.analysis, snapshot = s.snapshot;
    if (analysis && !s.dismissed) {
      const preview = (label, text) => {
        const content = s.expanded ? text : text.slice(0, 350) + (text.length > 350 ? '…' : '');
        for (let i = 0; i < content.length; i += 9500) nodes.push(Text({ children: [(i === 0 ? label : '') + content.slice(i, i + 9500)] }));
      };
      preview(analysis.translationLanguage === 'en' ? '英文：' : '中文：', analysis.translationText);
      if (analysis.issues.length) nodes.push(Text({ children: ['纠错：' + analysis.issues.map(i => `${i.original} → ${i.replacement}`).join('；').slice(0, 220)] }));
      if (s.expanded && analysis.correctedEnglish) preview('纠错版：', analysis.correctedEnglish);
      if (analysis.polishedEnglish && analysis.polishedEnglish !== snapshot.source) preview('润色：', analysis.polishedEnglish);
      if (s.expanded) for (const issue of analysis.issues) preview('说明：', issue.explanationZh);
      const buttons = choicesFor(analysis, snapshot.source).map(choice => Button({ key: 'ea-apply-' + choice.key, label: choice.label,
        onPress: () => applyChoice($, s, snapshot, choice.text) }));
      buttons.push(Button({ key: 'ea-details', label: s.expanded ? '折叠详情' : '展开详情', onPress: () => { s.expanded = !s.expanded; $.ui.invalidate('ui.render'); } }));
      buttons.push(Button({ key: 'ea-dismiss', label: '收起', onPress: () => { s.dismissed = true; $.ui.invalidate('ui.render'); } }));
      nodes.push(Box({ flexDirection: 'row', columnGap: 2, children: buttons }));
    }
    if (s.undo) nodes.push(Button({ key: 'ea-undo', label: '撤销替换', onPress: () => undoChoice($, s) }));
    if (s.draftError) nodes.push(Button({ key: 'ea-retry-draft', label: '重试', onPress: () => { s.draftError = ''; s.draftPending = true; void analyzeDraft($, s); } }));
    if (s.enabled && !s.reply) nodes.push(Button({ key: 'ea-recover-reply', label: '翻译当前最后回复', onPress: () => openLastReply($, s) }));
    if (s.enabled && s.reply) nodes.push(Box({ flexDirection: 'row', columnGap: 2, children: [
      Button({ key: 'ea-open-reply', label: '查看最后回复译文 · ' + s.reply.status, onPress: () => showReplyPane($, s) }),
      Button({ key: 'ea-back-panel', label: '收起译文', onPress: () => hideReplyPane($, s) }),
      Button({ key: 'ea-show-diff', label: '查看代码 diff', onPress: () => requestDiffPane($, s) }),
    ] }));
    return nodes.length ? Box({ flexDirection: 'column', children: [theirs, ...nodes] }) : theirs;
  });
  on('ui.render', { component: 'Pane' }, async ($, e, next) => {
    if (e.requestId !== PANE) return next(e);
    s.replyRenders++;
    const { Box, Text, Markdown, Button } = $.ui.resolve(e);
    const tableUI = e.surface === 'terminal' && e.props?.bodyColumns > 0 ? { Box, Text, Markdown, columns: e.props.bodyColumns } : null;
    if (!s.reply) return Box({ flexDirection: 'column', children: [
      Text({ children: ['恢复已有会话后，可手动读取最后回复并翻译。'] }),
      Button({ key: 'ea-recover-reply', label: '翻译当前最后回复', onPress: () => openLastReply($, s) }),
    ] });
    const reply = s.reply, nodes = [Text({ bold: true, children: [reply.status] })];
    nodes.push(Box({ flexDirection: 'row', columnGap: 2, children: [
      Button({ key: 'ea-back-panel', label: '收起译文', onPress: () => hideReplyPane($, s) }),
      Button({ key: 'ea-show-diff', label: '查看代码 diff', onPress: () => requestDiffPane($, s) }),
    ] }));
    if (reply.error) nodes.push(Text({ color: 'red', children: [reply.error] }));
    if (reply.status === '翻译失败' || reply.status === '原文') nodes.push(Button({ key: 'ea-retry-reply', label: '翻译 / 重试', onPress: () => {
      if (!s.enabled || s.reply !== reply) return;
      s.replyPending = true; scheduleReply($, s);
    } }));
    for (const segment of reply.segments) {
      if (segment.kind === 'code' || segment.kind === 'unchanged') nodes.push(...markdownChunks(Markdown, Text, segment.source, tableUI));
      else {
        nodes.push(Text({ dimColor: true, children: ['EN'] }), ...markdownChunks(Markdown, Text, segment.source, tableUI));
        nodes.push(Text({ dimColor: true, children: ['中文'] }), ...markdownChunks(Markdown, Text, segment.translation || '等待翻译…', tableUI));
      }
    }
    return Box({ flexDirection: 'column', rowGap: 1, children: nodes });
  });
}
