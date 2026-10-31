// Vercel Serverless Function — LINE Webhook：有人加官方帳號好友或傳訊息時，記下他的 LINE 使用者 ID 與名稱
// 之後在系統的客戶資料裡「綁定 LINE」，就能直接把商品推播給他。
// 需要的 Vercel 環境變數：LINE_CHANNEL_SECRET、LINE_CHANNEL_ACCESS_TOKEN、SUPABASE_URL、SUPABASE_SERVICE_ROLE_KEY
//   （選填）LINE_TENANT_ID：預設使用佛牌殿的租戶 ID
// LINE Developers → Messaging API → Webhook URL 填：https://你的網址/api/line-webhook ，並開啟「Use webhook」

const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

module.exports.config = { api: { bodyParser: false } };   // 簽章要用原始內容驗證，所以不要自動解析

function readRaw(req){
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
function verifySignature(raw, signature, secret){
  if (!signature || !secret) return false;
  const expected = crypto.createHmac('sha256', secret).update(raw).digest('base64');
  const a = Buffer.from(expected), b = Buffer.from(String(signature));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
async function getProfile(userId){
  try{
    const r = await fetch('https://api.line.me/v2/bot/profile/' + encodeURIComponent(userId), { headers:{ Authorization:'Bearer ' + process.env.LINE_CHANNEL_ACCESS_TOKEN } });
    if (!r.ok) return {};
    return await r.json();
  }catch(e){ return {}; }
}

module.exports = async function handler(req, res){
  if (req.method !== 'POST') return res.status(200).send('ok');   // LINE 的「Verify」按鈕會先打一次
  try{
    const raw = await readRaw(req);
    if (!verifySignature(raw, req.headers['x-line-signature'], process.env.LINE_CHANNEL_SECRET)) return res.status(401).json({ error:'簽章驗證失敗' });
    const body = JSON.parse(raw.toString('utf8') || '{}');
    const events = Array.isArray(body.events) ? body.events : [];
    if (!events.length) return res.status(200).json({ ok:true });
    const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth:{ autoRefreshToken:false, persistSession:false } });
    const tenantId = process.env.LINE_TENANT_ID || 'dbf9fcd3-110a-4dde-8ef9-40c2f89967a9';
    const seen = new Map();
    for (const ev of events){
      const uid = ev?.source?.userId; if (!uid) continue;
      seen.set(uid, ev.type === 'unfollow' ? 'unfollow' : 'follow');
    }
    for (const [uid, status] of seen){
      const prof = status === 'follow' ? await getProfile(uid) : {};
      const row = { user_id:uid, tenant_id:tenantId, status, last_seen:new Date().toISOString() };
      if (prof.displayName) row.display_name = prof.displayName;
      if (prof.pictureUrl) row.picture_url = prof.pictureUrl;
      await sb.from('line_users').upsert(row, { onConflict:'user_id' });
    }
    return res.status(200).json({ ok:true });
  }catch(e){
    console.error('line webhook error', e);
    return res.status(200).json({ ok:false });   // 回 200，避免 LINE 一直重送
  }
};
module.exports._test = { verifySignature };
