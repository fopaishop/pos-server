// Vercel Serverless Function — 帳號管理後端
// 這支程式碼「跑在伺服器上」，不會被瀏覽器看到，所以才能安全地使用 service_role key。
// 前端只能透過這個 API 呼叫，不能直接操作帳號，達到「只有管理員能新增帳號」的要求。
//
// 需要在 Vercel 專案的 Settings → Environment Variables 設定兩個變數：
//   SUPABASE_URL              你的 Supabase 專案網址
//   SUPABASE_SERVICE_ROLE_KEY 你的 service_role key（絕對不要放進前端檔案）

const { createClient } = require('@supabase/supabase-js');

let supabaseAdmin = null;
function getSupabaseAdmin(){
  if (supabaseAdmin) return supabaseAdmin;
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('伺服器缺少 SUPABASE_URL 或 SUPABASE_SERVICE_ROLE_KEY 環境變數，請檢查 Vercel 專案設定並重新部署');
  }
  supabaseAdmin = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { autoRefreshToken: false, persistSession: false } }
  );
  return supabaseAdmin;
}

module.exports = async function handler(req, res) {
  try {
    return await handleRequest(req, res);
  } catch (e) {
    console.error('未預期的錯誤:', e);
    return res.status(500).json({ error: e.message || '伺服器發生未預期的錯誤' });
  }
};

async function handleRequest(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: '只接受 POST 請求' });
  }

  const supabaseAdmin = getSupabaseAdmin();
  const { action, payload, accessToken } = req.body || {};
  if (!accessToken) return res.status(401).json({ error: '未登入' });

  // 驗證這個請求是誰打來的
  const { data: userData, error: userErr } = await supabaseAdmin.auth.getUser(accessToken);
  if (userErr || !userData?.user) {
    return res.status(401).json({ error: '登入已失效，請重新登入' });
  }

  // 確認打這支 API 的人是管理員，而且只能管理自己租戶內的帳號
  const { data: callerProfile, error: profileErr } = await supabaseAdmin
    .from('profiles')
    .select('role, tenant_id')
    .eq('id', userData.user.id)
    .single();

  if (profileErr || !callerProfile || callerProfile.role !== 'admin') {
    return res.status(403).json({ error: '只有管理員能執行這個操作' });
  }

  const tenantId = callerProfile.tenant_id;

  try {
    if (action === 'create_user') {
      const { email, password, name, role } = payload || {};
      if (!email || !password || !name) {
        return res.status(400).json({ error: '請填寫 email、密碼、姓名' });
      }
      if (password.length < 6) {
        return res.status(400).json({ error: '密碼至少需要 6 個字元' });
      }

      const { data: created, error: createErr } = await supabaseAdmin.auth.admin.createUser({
        email, password, email_confirm: true,
      });
      if (createErr) throw createErr;

      const { error: insertErr } = await supabaseAdmin.from('profiles').insert({
        id: created.user.id,
        tenant_id: tenantId,
        email,
        name,
        role: role === 'admin' ? 'admin' : 'staff',
        active: true,
      });
      if (insertErr) throw insertErr;

      await supabaseAdmin.from('activity_log').insert({
        tenant_id: tenantId, user_id: userData.user.id, user_name: name,
        action: '建立帳號', detail: `新增帳號 ${email}（${role === 'admin' ? '管理員' : '客服/門市人員'}）`,
      });

      return res.status(200).json({ ok: true });
    }

    if (action === 'update_account') {
      const { userId, role, active } = payload || {};
      if (!userId) return res.status(400).json({ error: '缺少 userId' });

      // 不能停用/降級自己，避免管理員把自己鎖在系統外面
      if (userId === userData.user.id) {
        return res.status(400).json({ error: '不能修改自己的帳號權限，請請另一位管理員協助操作' });
      }

      const updates = {};
      if (role !== undefined) updates.role = role === 'admin' ? 'admin' : 'staff';
      if (active !== undefined) updates.active = !!active;

      const { error } = await supabaseAdmin
        .from('profiles')
        .update(updates)
        .eq('id', userId)
        .eq('tenant_id', tenantId);
      if (error) throw error;

      await supabaseAdmin.from('activity_log').insert({
        tenant_id: tenantId, user_id: userData.user.id,
        action: '修改帳號', detail: `更新帳號權限：${JSON.stringify(updates)}`,
      });

      return res.status(200).json({ ok: true });
    }

    if (action === 'reset_password') {
      const { userId, newPassword } = payload || {};
      if (!userId || !newPassword || newPassword.length < 6) {
        return res.status(400).json({ error: '請提供帳號與至少 6 碼的新密碼' });
      }
      const { error } = await supabaseAdmin.auth.admin.updateUserById(userId, { password: newPassword });
      if (error) throw error;

      await supabaseAdmin.from('activity_log').insert({
        tenant_id: tenantId, user_id: userData.user.id,
        action: '重設密碼', detail: `重設了某帳號的密碼`,
      });

      return res.status(200).json({ ok: true });
    }

    if (action === 'migrate_images_batch') {
      const batchSize = Math.min(payload?.batchSize || 5, 10); // 每次處理不要太多，避免超過伺服器執行時間限制
      const { data: products, error: fetchErr } = await supabaseAdmin
        .from('products')
        .select('id, code, image')
        .eq('tenant_id', tenantId)
        .ilike('image', '%drive.google.com%')
        .limit(batchSize);
      if (fetchErr) throw fetchErr;

      const { count: remainingCount } = await supabaseAdmin
        .from('products')
        .select('id', { count: 'exact', head: true })
        .eq('tenant_id', tenantId)
        .ilike('image', '%drive.google.com%');

      const results = [];
      for (const p of products || []) {
        try {
          const imgRes = await fetch(p.image);
          if (!imgRes.ok) throw new Error(`下載圖片失敗（${imgRes.status}）`);
          const arrayBuffer = await imgRes.arrayBuffer();
          const contentType = imgRes.headers.get('content-type') || 'image/jpeg';
          const ext = contentType.includes('png') ? 'png' : 'jpg';
          const path = `${tenantId}/${p.id}.${ext}`;

          const { error: uploadErr } = await supabaseAdmin.storage
            .from('product-images')
            .upload(path, Buffer.from(arrayBuffer), { contentType, upsert: true });
          if (uploadErr) throw uploadErr;

          const { data: publicUrlData } = supabaseAdmin.storage.from('product-images').getPublicUrl(path);
          const newUrl = publicUrlData.publicUrl;

          const { data: currentProduct } = await supabaseAdmin.from('products').select('images').eq('id', p.id).single();
          const newImages = (currentProduct?.images || []).map(img => img === p.image ? newUrl : img);
          if (!newImages.length) newImages.push(newUrl);

          const { error: updateErr } = await supabaseAdmin
            .from('products').update({ image: newUrl, images: newImages }).eq('id', p.id).eq('tenant_id', tenantId);
          if (updateErr) throw updateErr;

          results.push({ id: p.id, code: p.code, ok: true });
        } catch (e) {
          results.push({ id: p.id, code: p.code, ok: false, error: e.message });
        }
      }

      const remaining = Math.max(0, (remainingCount || 0) - results.filter(r=>r.ok).length);
      return res.status(200).json({ ok: true, processed: results.length, results, remaining });
    }

    return res.status(400).json({ error: '不支援的操作：' + action });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: e.message || '伺服器發生錯誤' });
  }
};
