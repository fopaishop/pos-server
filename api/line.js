// Vercel Serverless Function — 用 LINE 官方帳號（Messaging API）把商品推播給指定客戶
// 需要的 Vercel 環境變數：
//   LINE_CHANNEL_ACCESS_TOKEN   LINE Developers → Messaging API → Channel access token (long-lived)
//   SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY   （帳號管理已經設定過的那兩個）
// 注意：推播（push）會計入官方帳號的訊息則數。

const { createClient } = require('@supabase/supabase-js');

let _sb = null;
function getSb(){
  if (_sb) return _sb;
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) throw new Error('伺服器缺少 SUPABASE_URL 或 SUPABASE_SERVICE_ROLE_KEY 環境變數');
  _sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
  return _sb;
}

const FIELD_LABELS = { master:'師傅／寺廟', effects:'功效', feature:'特色', material:'材料', year:'年份', code:'編號' };

function driveId(url){
  const m = String(url||'').match(/drive\.google\.com\/(?:thumbnail\?id=|uc\?(?:export=\w+&)?id=|file\/d\/|open\?id=)([\w-]+)/) || String(url||'').match(/googleusercontent\.com\/d\/([\w-]+)/);
  return m ? m[1] : null;
}
// LINE 只收公開的 https 圖片網址（單張 ≤10MB）；內嵌的 data: 圖片無法使用
function lineImageUrl(url){
  const id = driveId(url);
  if (id) return `https://lh3.googleusercontent.com/d/${id}=w2000`;
  return /^https:\/\//.test(String(url||'')) ? String(url) : null;
}
function photosOf(p){
  const imgs = (Array.isArray(p.images) && p.images.length) ? p.images : (p.image ? [p.image] : []);
  return imgs.map(lineImageUrl).filter(Boolean);
}

function productBubble(p, opt){
  const fields = Array.isArray(opt.fields) ? opt.fields : [];
  const photos = opt.photos === 'none' ? [] : photosOf(p);
  const body = [{ type:'text', text: String(p.name||'商品').slice(0,100), weight:'bold', size:'lg', wrap:true }];
  const info = [];
  if (fields.includes('code') && p.code) info.push(['編號', p.code]);
  if (fields.includes('master') && p.master) info.push([FIELD_LABELS.master, p.master]);
  if (fields.includes('year') && p.year) info.push([FIELD_LABELS.year, p.year + '年']);
  if (fields.includes('effects') && Array.isArray(p.effects) && p.effects.length) info.push([FIELD_LABELS.effects, p.effects.join('、')]);
  if (fields.includes('material') && p.material) info.push([FIELD_LABELS.material, p.material]);
  if (fields.includes('feature') && p.feature) info.push([FIELD_LABELS.feature, p.feature]);
  info.forEach(([k,v]) => body.push({ type:'box', layout:'baseline', spacing:'sm', margin:'sm', contents:[
    { type:'text', text:k, size:'xs', color:'#8a8a8a', flex:2 },
    { type:'text', text:String(v).slice(0,200), size:'sm', color:'#333333', wrap:true, flex:5 },
  ]}));
  if (fields.includes('price')) body.push({ type:'text', text:'NT$ ' + Number(p.price||0).toLocaleString('en-US'), weight:'bold', size:'xl', color:'#b8892b', margin:'md' });
  const bubble = { type:'bubble', size:'mega', body:{ type:'box', layout:'vertical', spacing:'xs', contents: body } };
  if (photos.length){
    bubble.hero = { type:'image', url:photos[0], size:'full', aspectRatio:'1:1', aspectMode:'cover', action:{ type:'uri', uri:photos[0] } };
  }
  if (photos.length > 1 && opt.photos !== 'first'){
    bubble.footer = { type:'box', layout:'vertical', spacing:'sm', contents: photos.slice(1,4).map((u,i)=>(
      { type:'button', style:'link', height:'sm', action:{ type:'uri', label: i===0 ? '看背面照片' : `看第 ${i+2} 張照片`, uri:u } }
    ))};
  }
  return bubble;
}

// 組出要推播的訊息（最多 5 則；這裡用 1 則文字 + 1 則商品輪播）
function buildMessages({ text, products, opt }){
  const messages = [];
  if (text && String(text).trim()) messages.push({ type:'text', text:String(text).slice(0,4900) });
  const bubbles = products.slice(0,12).map(p => productBubble(p, opt));
  if (bubbles.length){
    messages.push({ type:'flex', altText: ('商品推薦：' + products.map(p=>p.name).join('、')).slice(0,380), contents: bubbles.length === 1 ? bubbles[0] : { type:'carousel', contents: bubbles } });
  }
  return messages;
}

async function pushToLine(userId, messages){
  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  if (!token) throw new Error('伺服器缺少 LINE_CHANNEL_ACCESS_TOKEN 環境變數，請到 Vercel 設定並重新部署');
  const res = await fetch('https://api.line.me/v2/bot/message/push', {
    method:'POST',
    headers:{ 'Content-Type':'application/json', Authorization:'Bearer ' + token },
    body: JSON.stringify({ to:userId, messages }),
  });
  const text = await res.text();
  if (!res.ok){
    let detail = text; try{ const j = JSON.parse(text); detail = (j.message || '') + (j.details ? ' ' + JSON.stringify(j.details) : ''); }catch(e){}
    const hint = res.status === 429 ? '（本月訊息則數可能已用完）' : res.status === 400 && /user/i.test(detail) ? '（這位客人可能已封鎖或刪除官方帳號）' : '';
    const err = new Error(`LINE 回應 ${res.status}：${detail}${hint}`); err.status = res.status; throw err;
  }
  return true;
}

module.exports = async function handler(req, res){
  try{
    if (req.method !== 'POST') return res.status(405).json({ error:'只接受 POST 請求' });
    const sb = getSb();
    const { action, payload, accessToken } = req.body || {};
    if (!accessToken) return res.status(401).json({ error:'未登入' });
    const { data:ud, error:ue } = await sb.auth.getUser(accessToken);
    if (ue || !ud?.user) return res.status(401).json({ error:'登入已失效，請重新登入' });
    const { data:me } = await sb.from('profiles').select('role, tenant_id, active, name').eq('id', ud.user.id).single();
    if (!me || me.active === false) return res.status(403).json({ error:'帳號無法使用' });
    const tenantId = me.tenant_id;

    if (action === 'push_products'){
      const { lineUserId, text, productIds, fields, photos } = payload || {};
      if (!lineUserId) return res.status(400).json({ error:'缺少 LINE 使用者' });
      if (!Array.isArray(productIds) || !productIds.length) return res.status(400).json({ error:'沒有選擇商品' });
      if (productIds.length > 12) return res.status(400).json({ error:'一次最多推播 12 款商品' });
      // 只能推給「加過官方帳號、已記錄在系統」的人
      const { data:lu } = await sb.from('line_users').select('user_id').eq('tenant_id', tenantId).eq('user_id', lineUserId).maybeSingle();
      if (!lu) return res.status(400).json({ error:'找不到這位 LINE 使用者，請確認他已加官方帳號好友' });
      const { data:prods, error:pe } = await sb.from('products').select('id, code, name, price, master, year, effects, material, feature, image, images').eq('tenant_id', tenantId).in('id', productIds);
      if (pe) throw pe;
      const ordered = productIds.map(id => (prods||[]).find(p => p.id === id)).filter(Boolean);
      if (!ordered.length) return res.status(400).json({ error:'找不到所選商品' });
      const messages = buildMessages({ text, products:ordered, opt:{ fields, photos } });
      await pushToLine(lineUserId, messages);
      await sb.from('activity_log').insert({ tenant_id:tenantId, user_id:ud.user.id, user_name:me.name||'', action:'LINE 推播商品', detail:`${ordered.map(p=>p.name).join('、')} → ${lineUserId.slice(0,8)}…` });
      return res.status(200).json({ ok:true, sent:ordered.length, messages:messages.length });
    }

    return res.status(400).json({ error:'未知的操作：' + action });
  }catch(e){
    console.error('line push error', e);
    return res.status(e.status && e.status >= 400 && e.status < 500 ? 400 : 500).json({ error: e.message || '伺服器發生未預期的錯誤' });
  }
};
module.exports._test = { buildMessages, productBubble, lineImageUrl };
