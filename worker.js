/**
 * 怒川自动注入 —— 卡密管理 + 使用统计服务端 (Cloudflare Workers)
 *
 * 接口：
 *   POST /report                 APP 上报一次启动
 *   GET  /gen?token=xxx          卡密生成器网页（手机可直接开）
 *   GET  /panel?token=xxx        统计面板网页
 *   GET  /stats?token=xxx        统计数据 JSON
 *
 * 部署说明见 DEPLOY.md
 */

const ADMIN_TOKEN = 'Ncacbh202688'; // ← 改成你自己的密码

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
};

function jres(obj, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), {
    status, headers: { ...cors, 'Content-Type': 'application/json; charset=utf-8' },
  });
}
function hres(html, status = 200) {
  return new Response(html, { status, headers: { ...cors, 'Content-Type': 'text/html; charset=utf-8' } });
}

/* ================= 卡密算法（与 APP 内 dex 完全一致） ================= */

function epochDay(ms) { return Math.floor(ms / 86400000); }

function calcD(A, B, C) {
  const v = (A * 7919 + B * 104729 + C * 1237 + 8675309) & 0x7FFFFFFF;
  return v % 10000;
}

function makeKey(expiryDay, uses, rand) {
  const D = calcD(expiryDay, uses, rand);
  const p = (n, w) => String(n).padStart(w, '0');
  const raw = p(expiryDay, 5) + p(uses, 3) + p(rand, 4) + p(D, 4);
  return {
    raw,
    pretty: `${raw.slice(0, 5)}-${raw.slice(5, 8)}-${raw.slice(8, 12)}-${raw.slice(12, 16)}`,
  };
}

function expiryDateOf(expiryDay) {
  return new Date(expiryDay * 86400000 + 8 * 3600000).toISOString().slice(0, 10);
}

/* ================= 上报 ================= */

async function handleReport(request, env) {
  let body;
  try { body = await request.json(); } catch (e) { return jres({ ok: false, msg: 'bad json' }, 400); }

  const id = String(body.id || '').slice(0, 64);
  const key = String(body.key || '').slice(0, 64);
  const ver = String(body.ver || '').slice(0, 32);
  if (!id) return jres({ ok: false, msg: 'no id' }, 400);

  const now = Date.now();
  const day = new Date(now + 8 * 3600000).toISOString().slice(0, 10);

  const dkey = 'd:' + id;
  const old = await env.KM.get(dkey, 'json');
  await env.KM.put(dkey, JSON.stringify({
    id, key, ver,
    first: old ? old.first : now,
    last: now,
    launches: (old ? old.launches : 0) + 1,
  }));

  const dayKey = 'day:' + day;
  const dayOld = (await env.KM.get(dayKey, 'json')) || { launches: 0, devs: [] };
  dayOld.launches += 1;
  if (!dayOld.devs.includes(id)) dayOld.devs.push(id);
  if (dayOld.devs.length > 5000) dayOld.devs = dayOld.devs.slice(-5000);
  await env.KM.put(dayKey, JSON.stringify(dayOld));

  if (key) {
    const kKey = 'k:' + key;
    const kOld = (await env.KM.get(kKey, 'json')) || { launches: 0, devs: [], first: now, last: now };
    kOld.launches += 1;
    kOld.last = now;
    if (!kOld.devs.includes(id)) kOld.devs.push(id);
    if (kOld.devs.length > 5000) kOld.devs = kOld.devs.slice(-5000);
    await env.KM.put(kKey, JSON.stringify(kOld));
  }

  return jres({ ok: true });
}

/* ================= 卡密生成器网页 ================= */

function genPage(token) {
  return `<!doctype html><meta name=viewport content="width=device-width,initial-scale=1">
<title>卡密生成器</title>
<style>
*{box-sizing:border-box}
body{font-family:-apple-system,system-ui,"PingFang SC",sans-serif;margin:0;padding:14px;background:#f5f5f7;color:#222}
h2{margin:0 0 14px;font-size:19px}
.card{background:#fff;border-radius:12px;padding:14px;margin-bottom:12px}
label{font-size:13px;color:#666;display:block;margin-bottom:7px}
.chips{display:flex;flex-wrap:wrap;gap:7px;margin-bottom:9px}
.chip{padding:7px 13px;border:1px solid #ddd;border-radius:8px;font-size:14px;background:#fff;cursor:pointer;user-select:none}
.chip.on{background:#ff6b00;color:#fff;border-color:#ff6b00}
input[type=number]{width:100%;padding:9px;border:1px solid #ddd;border-radius:8px;font-size:15px}
input[type=text]{width:100%;padding:9px;border:1px solid #ddd;border-radius:8px;font-size:15px}
button.go{width:100%;padding:13px;background:#ff6b00;color:#fff;border:0;border-radius:10px;font-size:16px;font-weight:600;margin-top:6px}
.out{margin-top:12px}
.key{background:#fff;border:1px solid #e8e8e8;border-left:3px solid #ff6b00;border-radius:8px;padding:11px;margin-bottom:8px;font-size:15px;font-family:ui-monospace,Menlo,monospace;letter-spacing:.5px}
.meta{font-size:12px;color:#888;margin-top:4px;font-family:inherit;letter-spacing:0}
.err{color:#d00;font-size:14px}
</style>
<h2>卡密生成器</h2>
<div class=card>
  <label>有效期</label>
  <div class=chips id=c1>
    <div class=chip data-v=7>7天</div><div class=chip data-v=30>30天</div>
    <div class=chip data-v=90>90天</div><div class=chip data-v=365>365天</div>
    <div class=chip data-v=0>自定义</div>
  </div>
  <input type=number id=days placeholder="天数（如 30）" value="">
</div>
<div class=card>
  <label>可用次数</label>
  <div class=chips id=c2>
    <div class=chip data-v=999>不限次</div><div class=chip data-v=50>50次</div>
    <div class=chip data-v=20>20次</div><div class=chip data-v=1>1次</div>
    <div class=chip data-v=0>自定义</div>
  </div>
  <input type=number id=uses placeholder="次数（1-999）" value="">
</div>
<div class=card>
  <label>生成数量</label>
  <input type=number id=count value="1" min="1" max="50">
  <label style="margin-top:11px">备注（可选，方便你自己认）</label>
  <input type=text id=note placeholder="例：给张三 / 试用">
</div>
<button class=go onclick="go()">生成卡密</button>
<div class=out id=out></div>
<script>
const TOKEN=${JSON.stringify(token)};
function bind(id,inp){
  document.getElementById(id).onclick=e=>{
    const c=e.target; if(!c.classList.contains('chip'))return;
    [...document.getElementById(id).children].forEach(x=>x.classList.remove('on'));
    c.classList.add('on');
    const v=+c.dataset.v;
    const box=document.getElementById(inp);
    if(v===0){box.value='';box.focus();} else {box.value=v;}
  };
}
bind('c1','days'); bind('c2','uses');
document.querySelector('#c1 .chip[data-v="30"]').classList.add('on');
document.querySelector('#c2 .chip[data-v="999"]').classList.add('on');
document.getElementById('days').value=30;
document.getElementById('uses').value=999;

async function go(){
  const days=+document.getElementById('days').value;
  const uses=+document.getElementById('uses').value;
  const count=+document.getElementById('count').value||1;
  const note=document.getElementById('note').value||'';
  const out=document.getElementById('out');
  if(!days||days<1){out.innerHTML='<p class=err>请填有效期天数</p>';return;}
  if(!uses||uses<1||uses>999){out.innerHTML='<p class=err>次数要在 1-999</p>';return;}
  out.innerHTML='<p>生成中…</p>';
  try{
    const r=await fetch('/api/gen?token='+encodeURIComponent(TOKEN),{
      method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({days,uses,count,note})
    });
    const j=await r.json();
    if(!j.ok){out.innerHTML='<p class=err>'+(j.msg||'失败')+'</p>';return;}
    out.innerHTML=j.keys.map(k=>
      '<div class=key>'+k.key+
      '<div class=meta>'+k.days+'天 · '+(k.uses>=999?'不限次':k.uses+'次')+' · 到期 '+k.expiry+(k.note?' · '+k.note:'')+'</div></div>'
    ).join('')+'<p style="font-size:12px;color:#888">共 '+j.keys.length+' 张，已保存到服务器</p>';
  }catch(e){out.innerHTML='<p class=err>'+e+'</p>';}
}
</script>`;
}

async function handleGen(request, env, url) {
  if (url.searchParams.get('token') !== ADMIN_TOKEN) return jres({ ok: false, msg: 'token 错误' }, 403);
  let b;
  try { b = await request.json(); } catch (e) { return jres({ ok: false, msg: 'bad json' }, 400); }
  const days = Math.max(1, Math.min(3650, parseInt(b.days) || 30));
  const uses = Math.max(1, Math.min(999, parseInt(b.uses) || 999));
  const count = Math.max(1, Math.min(50, parseInt(b.count) || 1));
  const note = String(b.note || '').slice(0, 60);

  const out = [];
  for (let i = 0; i < count; i++) {
    const expiryDay = epochDay(Date.now() + days * 86400000);
    const rand = 1000 + Math.floor(Math.random() * 9000);
    const k = makeKey(expiryDay, uses, rand);
    await env.KM.put('g:' + k.raw, JSON.stringify({
      key: k.pretty, days, uses, note, created: Date.now(), expiry: expiryDateOf(expiryDay),
    }));
    out.push({ key: k.pretty, days, uses, expiry: expiryDateOf(expiryDay), note });
  }
  return jres({ ok: true, keys: out });
}

/* ================= 统计 ================= */

async function listAll(env, prefix) {
  let out = [], cursor;
  for (let i = 0; i < 20; i++) {
    const r = await env.KM.list({ prefix, cursor });
    out = out.concat(r.keys.map((k) => k.name));
    if (r.list_complete) break;
    cursor = r.cursor;
  }
  return out;
}

function tbl(arr, cols) {
  return '<table border=1 cellspacing=0 cellpadding=6 style="border-collapse:collapse;font-size:13px;width:100%">' +
    '<tr>' + cols.map((c) => `<th style="background:#eee">${c}</th>`).join('') + '</tr>' +
    arr.map((o) => '<tr>' + cols.map((c) => `<td>${o[c] ?? ''}</td>`).join('') + '</tr>').join('') +
    '</table>';
}

// 批量读取：Cloudflare KV 在只传 1 个 key 时返回单个值而非数组，这里统一成数组
async function bulk(env, names) {
  if (!names || names.length === 0) return [];
  const r = await env.KM.get(names, 'json');
  return Array.isArray(r) ? r : [r];
}

async function handleStats(url, env) {
  if (url.searchParams.get('token') !== ADMIN_TOKEN) return jres({ ok: false, msg: 'token 错误' }, 403);

  const dnames = await listAll(env, 'd:');
  const dvals = await bulk(env, dnames);
  const devs = dvals.filter(Boolean);

  const byVer = {};
  for (const d of devs) byVer[d.ver] = (byVer[d.ver] || 0) + 1;

  const d7 = [];
  for (let i = 0; i < 7; i++) {
    const dt = new Date(Date.now() + 8 * 3600000 - i * 86400000).toISOString().slice(0, 10);
    const v = (await env.KM.get('day:' + dt, 'json')) || { launches: 0, devs: [] };
    d7.push({ date: dt, users: v.devs.length, launches: v.launches });
  }

  const knames = await listAll(env, 'k:');
  const kvals = await bulk(env, knames);
  const knorm = kvals.map((v) => v || { launches: 0, devs: [] });

  const gnames = await listAll(env, 'g:');
  const gvals = await bulk(env, gnames);
  const gmap = {};
  gnames.forEach((n, i) => { const v = gvals[i]; if (v) gmap[n.slice(2)] = v; });

  const seen = new Set();
  const rows = [];
  knames.forEach((n, i) => {
    const raw = n.slice(2), v = knorm[i];
    seen.add(raw);
    const g = gmap[raw];
    rows.push({
      卡密: (g && g.key) || raw.replace(/^(\d{5})(\d{3})(\d{4})(\d{4})$/, '$1-$2-$3-$4'),
      规格: g ? `${g.days}天/${g.uses >= 999 ? '不限次' : g.uses + '次'}` : '—',
      备注: (g && g.note) || '',
      设备数: (v.devs || []).length,
      启动次数: v.launches || 0,
      首次: v.first ? new Date(v.first + 8 * 3600000).toISOString().slice(0, 16).replace('T', ' ') : '',
      最后: v.last ? new Date(v.last + 8 * 3600000).toISOString().slice(0, 16).replace('T', ' ') : '',
    });
  });
  Object.keys(gmap).forEach((raw) => {
    if (seen.has(raw)) return;
    const g = gmap[raw];
    rows.push({ 卡密: g.key, 规格: `${g.days}天/${g.uses >= 999 ? '不限次' : g.uses + '次'}`, 备注: g.note || '',
      设备数: 0, 启动次数: 0, 首次: '未使用', 最后: '未使用' });
  });
  rows.sort((a, b) => b.启动次数 - a.启动次数);

  const now = Date.now();
  return jres({
    ok: true,
    summary: {
      总设备数: devs.length,
      今日活跃: (d7[0] && d7[0].users) || 0,
      今日启动次数: (d7[0] && d7[0].launches) || 0,
      '24小时活跃': devs.filter((d) => now - d.last < 86400000).length,
      '7日活跃': devs.filter((d) => now - d.last < 7 * 86400000).length,
      累计启动次数: devs.reduce((s, d) => s + (d.launches || 0), 0),
      已生成卡密数: Object.keys(gmap).length,
    },
    版本分布: byVer, 近7日: d7, 卡密: rows,
  });
}

async function handlePanel(url, env) {
  if (url.searchParams.get('token') !== ADMIN_TOKEN) return hres('<h3>token 错误</h3>', 403);
  const data = JSON.parse(await (await handleStats(url, env)).text());
  const s = data.summary;
  const html = `<!doctype html><meta name=viewport content="width=device-width,initial-scale=1">
<title>使用统计</title>
<style>body{font-family:-apple-system,system-ui,"PingFang SC",sans-serif;padding:14px;font-size:14px}
h2{font-size:19px}h3{font-size:15px;margin:18px 0 8px;color:#555}
a.btn{display:block;text-align:center;background:#ff6b00;color:#fff;padding:11px;border-radius:9px;text-decoration:none;font-weight:600;margin-bottom:14px}</style>
<h2>怒川 · 使用统计</h2>
<a class=btn href="/gen?token=${encodeURIComponent(ADMIN_TOKEN)}">打开卡密生成器</a>
<h3>总览</h3>
${tbl(Object.entries(s).map(([k, v]) => ({ 指标: k, 数值: v })), ['指标', '数值'])}
<h3>近 7 日</h3>
${tbl(data.近7日, ['date', 'users', 'launches'])}
<h3>卡密明细</h3>
${tbl(data.卡密, ['卡密', '规格', '备注', '设备数', '启动次数', '首次', '最后'])}
<p style="color:#aaa;font-size:11px;margin-top:16px">${new Date(Date.now() + 28800000).toISOString().slice(0, 19).replace('T', ' ')}</p>`;
  return hres(html);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });
    try {
      if (url.pathname === '/report' && request.method === 'POST') return await handleReport(request, env);
      if (url.pathname === '/t') {
        if (url.searchParams.get('token') !== ADMIN_TOKEN) return jres({ ok: false, msg: 'token 错误' }, 403);
        const fake = { id: '手机浏览器自测', key: url.searchParams.get('k') || 'TEST', ver: 'selftest' };
        const r = await handleReport(new Request(request.url, { method: 'POST', body: JSON.stringify(fake) }), env);
        const after = await env.KM.get('d:手机浏览器自测', 'json');
        return jres({ ok: true, 已写入: after, 说明: '刷新 /panel 看是否出现这条' });
      }
      if (url.pathname === '/gen') return hres(genPage(url.searchParams.get('token') || ''));
      if (url.pathname === '/api/gen' && request.method === 'POST') return await handleGen(request, env, url);
      if (url.pathname === '/stats') return await handleStats(url, env);
      if (url.pathname === '/panel') return await handlePanel(url, env);
    } catch (e) {
      return jres({ ok: false, msg: String(e) }, 500);
    }
    return jres({ ok: false, msg: 'not found' }, 404);
  },
};
