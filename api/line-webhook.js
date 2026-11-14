// Vercel Serverless Function — LINE 官方帳號「群組查訂單」機器人
// 只做一件事：在「已綁定的內部群組」裡回覆訂單清單。客人私訊不會回應、也不會主動推播。
// 回覆（reply）不會消耗官方帳號每月的訊息額度。
//
// Vercel 環境變數：
//   LINE_CHANNEL_SECRET        Messaging API 的 Channel secret（驗證訊息真的來自 LINE）
//   LINE_CHANNEL_ACCESS_TOKEN  Messaging API 的 Channel access token（用來回覆）
//   LINE_BIND_CODE             綁定群組用的密碼（自己取，例如 fopai2026）
//   SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY（admin.js 已在用）
//   LINE_TENANT_ID             （選填）店家 tenant id，預設佛牌殿
//
// 群組指令：
//   綁定 密碼      讓這個群組可以查訂單（只需做一次）
//   解除綁定       取消這個群組的查詢權限
//   今日           今天建立的訂單（依狀態分組）
//   待處理         全部待寄出＋待選鍊子＋待自取
//   待寄出／待選鍊子／待自取   只看單一狀態
//   指令           顯示指令說明

const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const DEFAULT_TENANT = 'dbf9fcd3-110a-4dde-8ef9-40c2f89967a9';
const PENDING = ['待寄出', '待選鍊子', '待自取'];
const STATUS_ICON = { '待寄出': '📦', '待選鍊子': '📿', '待自取': '🏪', '已寄出': '✅', '取消': '✖️', '退貨': '↩️' };

let _sb = null;
function getSb() {
  if (_sb) return _sb;
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) throw new Error('缺少 SUPABASE_URL 或 SUPABASE_SERVICE_ROLE_KEY');
  _sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
  return _sb;
}
const tenantId = () => process.env.LINE_TENANT_ID || DEFAULT_TENANT;

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
function verifySignature(raw, signature, secret) {
  if (!signature || !secret) return false;
  const expected = crypto.createHmac('sha256', secret).update(raw).digest('base64');
  const a = Buffer.from(expected), b = Buffer.from(String(signature));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ---- 指令解析 ----
function parseCommand(text) {
  const t = String(text || '').normalize('NFKC').trim();
  const flat = t.replace(/\s+/g, '');
  const bind = t.match(/^綁定\s*(.+)$/);
  if (bind) return { cmd: 'bind', code: bind[1].trim() };
  if (flat === '解除綁定') return { cmd: 'unbind' };
  if (/^(今日|今天)(訂單)?$/.test(flat)) return { cmd: 'today' };
  if (/^(全部)?待處理(訂單)?$/.test(flat) || flat === '待辦') return { cmd: 'pending' };
  if (/^(待寄出|待選鍊子|待自取)(訂單)?$/.test(flat)) return { cmd: 'status', status: flat.replace(/訂單$/, '') };
  if (/^(指令|說明|help|\?|？)$/i.test(flat)) return { cmd: 'help' };
  return null;
}
const HELP = [
  '🤖 佛牌殿訂單查詢指令',
  '・今日：今天建立的訂單',
  '・待處理：全部待寄出／待選鍊子／待自取',
  '・待寄出、待選鍊子、待自取：只看單一狀態',
  '・解除綁定：取消這個群組的查詢權限',
].join('\n');

function todayTW(now = new Date()) {
  return now.toLocaleDateString('sv-SE', { timeZone: 'Asia/Taipei' }); // YYYY-MM-DD
}
function nowTW(now = new Date()) {
  return now.toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', hour12: false, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}
function shipText(o) {
  const t = o.shipping || '', d = String(o.shipping_detail || '').trim();
  if (t === '門市自取') return '門市自取';
  if (t === '711' || t === '全家' || t === '萊爾富' || t === 'OK') return `${t === '711' ? '7-11' : t} ${d}${d && !/門市$/.test(d) ? '門市' : ''}`.trim();
  if (t === '黑貓') return `宅配 ${d}`.trim();
  return `${t} ${d}`.trim() || '未填寄送方式';
}
function itemsText(o, pmap) {
  return (o.items || []).map(it => {
    const name = it.custom ? it.name : (pmap[it.productId] || it.productId || '商品');
    return `${name}×${it.qty || 1}`;
  }).join('、') || '（無商品）';
}
function mmdd(d) { const m = String(d || '').match(/^\d{4}-(\d{2})-(\d{2})/); return m ? `${+m[1]}/${+m[2]}` : (d || ''); }

// 依狀態分組排版；showDate=全部待處理時顯示下單日期
function formatOrders(title, orders, pmap, { showDate }) {
  const groups = {};
  orders.forEach(o => (groups[o.status || '未分類'] = groups[o.status || '未分類'] || []).push(o));
  const order = [...PENDING, '已寄出', '取消', '退貨'];
  const keys = Object.keys(groups).sort((a, b) => (order.indexOf(a) + 99 * (order.indexOf(a) < 0)) - (order.indexOf(b) + 99 * (order.indexOf(b) < 0)));
  const lines = [title];
  if (!orders.length) { lines.push('', '目前沒有訂單 🎉'); return lines; }
  keys.forEach(k => {
    lines.push('', `${STATUS_ICON[k] || '•'}【${k}】${groups[k].length} 筆`);
    groups[k].forEach((o, i) => {
      lines.push(`${i + 1}. ${o.customer || '(無名稱)'}｜${shipText(o)}`);
      lines.push(`   ${itemsText(o, pmap)}`);
      const meta = [showDate ? mmdd(o.order_date) : '', o.staff || '', o.total ? `$${Number(o.total).toLocaleString()}` : ''].filter(Boolean).join(' · ');
      if (meta) lines.push(`   ${meta}`);
    });
  });
  return lines;
}
// LINE 單則文字上限 5000 字、一次回覆最多 5 則
function chunkMessages(lines, max = 4800, maxMsgs = 5) {
  const msgs = []; let cur = '';
  for (const ln of lines) {
    if ((cur + '\n' + ln).length > max) { msgs.push(cur); cur = ln; } else cur = cur ? cur + '\n' + ln : ln;
  }
  if (cur) msgs.push(cur);
  if (msgs.length > maxMsgs) {
    const kept = msgs.slice(0, maxMsgs);
    kept[maxMsgs - 1] = kept[maxMsgs - 1].slice(0, max - 40) + '\n…訂單太多，其餘請到系統查看';
    return kept.map(text => ({ type: 'text', text }));
  }
  return msgs.map(text => ({ type: 'text', text }));
}

async function replyToLine(replyToken, messages) {
  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  if (!token) throw new Error('缺少 LINE_CHANNEL_ACCESS_TOKEN');
  const r = await fetch('https://api.line.me/v2/bot/message/reply', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ replyToken, messages: messages.slice(0, 5) }),
  });
  if (!r.ok) console.error('LINE reply 失敗', r.status, await r.text().catch(() => ''));
}

async function isBound(sb, groupId) {
  const { data, error } = await sb.from('line_groups').select('group_id').eq('tenant_id', tenantId()).eq('group_id', groupId).maybeSingle();
  if (error) throw error;
  return !!data;
}
async function loadOrders(sb, cmd, status) {
  let q = sb.from('orders').select('id,order_date,customer,shipping,shipping_detail,items,staff,status,total').eq('tenant_id', tenantId());
  if (cmd === 'today') q = q.eq('order_date', todayTW());
  else if (cmd === 'pending') q = q.in('status', PENDING);
  else q = q.eq('status', status);
  const { data, error } = await q.order('order_date', { ascending: true }).limit(500);
  if (error) throw error;
  const orders = data || [];
  const ids = [...new Set(orders.flatMap(o => (o.items || []).filter(it => !it.custom && it.productId).map(it => it.productId)))];
  const pmap = {};
  if (ids.length) {
    const { data: ps } = await sb.from('products').select('id,name').eq('tenant_id', tenantId()).in('id', ids);
    (ps || []).forEach(p => { pmap[p.id] = p.name; });
  }
  return { orders, pmap };
}

async function handleEvent(ev, sb) {
  const src = ev.source || {};
  const chatId = src.groupId || src.roomId || null;
  // 被拉進群組：提示綁定方式
  if (ev.type === 'join' && chatId) {
    return replyToLine(ev.replyToken, [{ type: 'text', text: '👋 我是佛牌殿訂單小幫手。\n請管理員在群組輸入「綁定 密碼」開通查詢，之後輸入「指令」看可以查什麼。' }]);
  }
  if (ev.type !== 'message' || !ev.message || ev.message.type !== 'text') return;
  if (!chatId) return; // 客人私訊：完全不回應，留給真人客服
  const c = parseCommand(ev.message.text);
  if (!c) return;

  if (c.cmd === 'bind') {
    const code = process.env.LINE_BIND_CODE;
    if (!code) return replyToLine(ev.replyToken, [{ type: 'text', text: '⚠ 系統尚未設定綁定密碼（LINE_BIND_CODE）' }]);
    if (c.code !== code) return replyToLine(ev.replyToken, [{ type: 'text', text: '❌ 密碼錯誤' }]);
    const { error } = await sb.from('line_groups').upsert({ tenant_id: tenantId(), group_id: chatId, bound_by: src.userId || null }, { onConflict: 'tenant_id,group_id' });
    if (error) throw error;
    return replyToLine(ev.replyToken, [{ type: 'text', text: '✅ 已綁定，這個群組可以查訂單了。\n\n' + HELP }]);
  }
  const bound = await isBound(sb, chatId);
  if (!bound) return; // 未綁定群組不洩漏任何資料，也不回應
  if (c.cmd === 'unbind') {
    await sb.from('line_groups').delete().eq('tenant_id', tenantId()).eq('group_id', chatId);
    return replyToLine(ev.replyToken, [{ type: 'text', text: '已解除綁定，這個群組不能再查訂單。' }]);
  }
  if (c.cmd === 'help') return replyToLine(ev.replyToken, [{ type: 'text', text: HELP }]);

  const { orders, pmap } = await loadOrders(sb, c.cmd, c.status);
  const title = c.cmd === 'today' ? `📅 今日訂單 ${todayTW().replace(/-/g, '/')}（共 ${orders.length} 筆）`
    : c.cmd === 'pending' ? `📋 全部待處理（共 ${orders.length} 筆）· ${nowTW()}`
    : `${STATUS_ICON[c.status] || ''} ${c.status}（共 ${orders.length} 筆）· ${nowTW()}`;
  const lines = formatOrders(title, orders, pmap, { showDate: c.cmd !== 'today' });
  return replyToLine(ev.replyToken, chunkMessages(lines));
}

async function handler(req, res) {
  if (req.method !== 'POST') return res.status(200).send('ok');
  const raw = await readRawBody(req);
  if (!verifySignature(raw, req.headers['x-line-signature'], process.env.LINE_CHANNEL_SECRET)) {
    return res.status(401).send('bad signature');
  }
  let body = {};
  try { body = JSON.parse(raw.toString('utf8') || '{}'); } catch (e) { return res.status(200).send('ok'); }
  const events = body.events || [];
  if (events.length) {
    let sb = null;
    try { sb = getSb(); } catch (e) { console.error(e.message); return res.status(200).send('ok'); }
    for (const ev of events) {
      try { await handleEvent(ev, sb); } catch (e) { console.error('處理 LINE 事件失敗', e); }
    }
  }
  return res.status(200).send('ok');
}

module.exports = handler;
module.exports.config = { api: { bodyParser: false } };
module.exports._test = { parseCommand, formatOrders, chunkMessages, shipText, todayTW, verifySignature, handleEvent };
