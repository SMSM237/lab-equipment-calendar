// Equipment calendar API for Cloudflare Workers + D1. No client credentials are bundled.
const SESSION = '__Host-calendar_session';
const OAUTH = '__Host-calendar_oauth';
const MAX_BODY = 32768;
const SESSION_TTL = 30*86400;
const SESSION_RENEW_WINDOW = 7*86400;
const securityHeaders = {
  'Cache-Control': 'no-store, private',
  'CDN-Cache-Control': 'no-store',
  'Vercel-CDN-Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
};

class AppError extends Error {
  constructor(status, message, detail) { super(message); this.status = status; this.detail = detail; }
}
const bad = message => { throw new AppError(400, message); };
const forbidden = message => { throw new AppError(403, message); };
const json = (data, status=200, extras={}) => new Response(JSON.stringify(data), {
  status, headers: {...securityHeaders, 'Content-Type':'application/json; charset=utf-8', ...extras}
});
const redirect = (path, cookie='') => new Response(null, {status:303, headers:{
  ...securityHeaders, 'Location':path, ...(cookie ? {'Set-Cookie':cookie} : {})
}});
const cookie = (name, value, age) => `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${age}`;
function cookieValue(request, name) {
  const values = (request.headers.get('Cookie') || '').split(';');
  for (const value of values) { const i=value.indexOf('='); if(i>=0 && value.slice(0,i).trim()===name) return value.slice(i+1).trim(); }
  return '';
}
function text(value, label, max, required=true) {
  if (typeof value !== 'string') bad(`${label}을(를) 확인해 주세요.`);
  value=value.trim();
  if ((required && !value) || [...value].length>max || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value)) bad(`${label}은(는) ${max}자 이내로 입력해 주세요.`);
  return value;
}
function identifier(value) {
  if (!Number.isSafeInteger(value) || value<=0) bad('잘못된 항목입니다.');
  return value;
}
function checkedDate(value) {
  if(typeof value!=='string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) bad('날짜를 확인해 주세요.');
  const date=new Date(value+'T00:00:00.000Z');
  if(!Number.isFinite(date.valueOf()) || date.toISOString().slice(0,10)!==value) bad('날짜를 확인해 주세요.');
  return date.valueOf();
}
function checkedDateTime(value) {
  if(typeof value!=='string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) bad('날짜와 시간을 확인해 주세요.');
  const date=new Date(value+':00.000Z');
  if(!Number.isFinite(date.valueOf()) || date.toISOString().slice(0,16)!==value) bad('날짜와 시간을 확인해 주세요.');
  return date.valueOf();
}
function validOrigin(env) {
  try { const url=new URL(env.PUBLIC_ORIGIN); if(url.protocol!=='https:'||url.origin!==env.PUBLIC_ORIGIN) throw new Error(); return url.origin; }
  catch { throw new AppError(503, '서버 연결 설정이 완료되지 않았습니다.'); }
}
function checkOrigin(request, env) {
  const origin=request.headers.get('Origin');
  if(!origin || origin!==validOrigin(env)) forbidden('허용되지 않은 요청입니다.');
}
async function parseBody(request,env) {
  checkOrigin(request,env);
  if(!/^application\/json(?:\s*;|$)/i.test(request.headers.get('Content-Type')||'')) bad('요청 형식이 올바르지 않습니다.');
  const length=Number(request.headers.get('Content-Length')||0); if(length>MAX_BODY)bad('요청 내용이 너무 큽니다.');
  const raw=await request.text(); if(!raw || new TextEncoder().encode(raw).length>MAX_BODY)bad('요청 내용을 확인해 주세요.');
  try { const body=JSON.parse(raw); if(!body || Array.isArray(body) || typeof body!=='object') throw new Error(); return body; }
  catch { bad('요청 내용을 확인해 주세요.'); }
}
const nowSeconds = () => Math.floor(Date.now()/1000);
function randomToken(bytes=32) {const data=new Uint8Array(bytes);crypto.getRandomValues(data);return base64url(data);}
function base64url(bytes) {let value='';for(const b of bytes)value+=String.fromCharCode(b);return btoa(value).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');}
async function digestBytes(value) {return new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value)));}
async function digestHex(value) {return Array.from(await digestBytes(value),x=>x.toString(16).padStart(2,'0')).join('');}
function sameToken(a,b) {if(!a||a.length!==b.length)return false;let mismatch=0;for(let i=0;i<a.length;i++)mismatch|=a.charCodeAt(i)^b.charCodeAt(i);return mismatch===0;}
function authConfigured(env) {try{return !!(validOrigin(env)&&env.GOOGLE_CLIENT_ID&&env.GOOGLE_CLIENT_SECRET);}catch{return false;}}
function allowedGoogle(info,env) {
  if(env.ACCESS_POLICY==='all') return true;
  const emails=(env.ALLOWED_EMAILS||'').split(/[\s,;]+/).map(x=>x.trim().toLowerCase()).filter(Boolean);
  const domains=(env.ALLOWED_GOOGLE_DOMAINS||'').split(/[\s,;]+/).map(x=>x.trim().toLowerCase()).filter(Boolean);
  return emails.includes(info.email.toLowerCase()) || (!!info.hd && domains.includes(String(info.hd).toLowerCase()));
}
async function currentUser(request,env) {
  const token=cookieValue(request,SESSION);
  if(!/^[A-Za-z0-9_-]{30,128}$/.test(token))return null;
  return await env.DB.prepare('SELECT u.id, u.email, u.name, u.name_confirmed, s.expires AS session_expires FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires>?')
    .bind(await digestHex(token),nowSeconds()).first();
}
async function requireUser(request,env,confirmed=true) {
  const user=await currentUser(request,env);
  if(!user)throw new AppError(401,'로그인 후 이용해 주세요.');
  if(confirmed&&!user.name_confirmed)forbidden('예약에 표시할 실명을 먼저 등록해 주세요.');
  return user;
}
async function makeSession(env,userId) {
  const token=randomToken();
  await env.DB.prepare('INSERT INTO sessions(token_hash,user_id,expires) VALUES(?,?,?)').bind(await digestHex(token),userId,nowSeconds()+SESSION_TTL).run();
  return cookie(SESSION,token,SESSION_TTL);
}
async function authStart(env) {
  if(!authConfigured(env))return redirect('/?auth=unconfigured');
  const state=randomToken(), verifier=randomToken(64), challenge=base64url(await digestBytes(verifier));
  await env.DB.batch([
    env.DB.prepare('DELETE FROM oauth_states WHERE expires<?').bind(nowSeconds()),
    env.DB.prepare('INSERT INTO oauth_states(state_hash,verifier,expires) VALUES(?,?,?)').bind(await digestHex(state),verifier,nowSeconds()+600),
  ]);
  const params=new URLSearchParams({client_id:env.GOOGLE_CLIENT_ID,redirect_uri:validOrigin(env)+'/auth/google/callback',
    response_type:'code',scope:'openid email profile',state,code_challenge:challenge,code_challenge_method:'S256',prompt:'select_account'});
  return redirect('https://accounts.google.com/o/oauth2/v2/auth?'+params,cookie(OAUTH,state,600));
}
async function authCallback(request,env) {
  if(!authConfigured(env))return redirect('/?auth=unconfigured');
  const query=new URL(request.url).searchParams,state=query.get('state')||'',stored=cookieValue(request,OAUTH);
  if(!/^[A-Za-z0-9_-]{30,128}$/.test(state)||!sameToken(state,stored))return redirect('/?auth=state_error');
  const pending=await env.DB.prepare('DELETE FROM oauth_states WHERE state_hash=? AND expires>? RETURNING verifier').bind(await digestHex(state),nowSeconds()).first();
  if(!pending || !query.get('code'))return redirect('/?auth=cancelled');
  try {
    const body=new URLSearchParams({code:query.get('code'),client_id:env.GOOGLE_CLIENT_ID,client_secret:env.GOOGLE_CLIENT_SECRET,
      code_verifier:pending.verifier,redirect_uri:validOrigin(env)+'/auth/google/callback',grant_type:'authorization_code'});
    const tokenResponse=await fetch('https://oauth2.googleapis.com/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body});
    if(!tokenResponse.ok)throw new Error('token_exchange');
    const token=await tokenResponse.json();if(typeof token.access_token!=='string')throw new Error('missing_token');
    const infoResponse=await fetch('https://openidconnect.googleapis.com/v1/userinfo',{headers:{Authorization:'Bearer '+token.access_token}});
    if(!infoResponse.ok)throw new Error('userinfo');const info=await infoResponse.json();
    if(typeof info.sub!=='string'||!info.sub||typeof info.email!=='string'||info.email_verified!==true)throw new Error('identity');
    if(!allowedGoogle(info,env))return redirect('/?auth=not_allowed');
    const email=info.email.toLowerCase(),name=String(info.name||email.split('@')[0]).trim().slice(0,40)||'이름 입력';
    await env.DB.prepare('INSERT INTO users(provider_id,email,name) VALUES(?,?,?) ON CONFLICT(provider_id) DO UPDATE SET email=excluded.email')
      .bind(info.sub,email,name).run();
    const user=await env.DB.prepare('SELECT id FROM users WHERE provider_id=?').bind(info.sub).first();
    return redirect('/',await makeSession(env,user.id));
  } catch {return redirect('/?auth=failed');}
}
async function stateResponse(request,env) {
  const params=new URL(request.url).searchParams,start=params.get('start'),end=params.get('end');
  const startMs=checkedDate(start),endMs=checkedDate(end);
  if(endMs<=startMs || endMs-startMs>100*86400000)bad('조회 기간을 확인해 주세요.');
  const user=await currentUser(request,env);let equipment=[],bookings=[],extra={};
  if(user){
    const items=await env.DB.batch([
      env.DB.prepare('SELECT id,name,color FROM equipment ORDER BY id'),
      env.DB.prepare('SELECT b.id,b.equipment_id,b.user_id,b.start,b.end,b.note,u.name AS user_name FROM bookings b JOIN users u ON u.id=b.user_id WHERE b.start<? AND b.end>? ORDER BY b.start,b.id').bind(end+'T00:00',start+'T00:00')
    ]);
    equipment=items[0].results;bookings=items[1].results;
    if(user.session_expires-nowSeconds()<SESSION_RENEW_WINDOW){
      const token=cookieValue(request,SESSION),renewed=await env.DB.prepare('UPDATE sessions SET expires=? WHERE token_hash=? AND expires>?')
        .bind(nowSeconds()+SESSION_TTL,await digestHex(token),nowSeconds()).run();
      if(renewed.meta.changes)extra={'Set-Cookie':cookie(SESSION,token,SESSION_TTL)};
    }
  }
  const visibleUser=user?{id:user.id,email:user.email,name:user.name,name_confirmed:user.name_confirmed,provider:'google'}:null;
  return json({equipment,bookings,user:visibleUser,demo_mode:false,google_enabled:authConfigured(env),timezone:'Asia/Seoul'},200,extra);
}
async function saveEquipment(body,env) {
  const name=text(body.name,'장비명',60),color=String(body.color||'').toLowerCase();
  if(!/^#[0-9a-f]{6}$/.test(color))bad('장비 색상을 선택해 주세요.');
  let id;
  if(body.id===null||body.id===undefined){
    const result=await env.DB.prepare('INSERT INTO equipment(name,color) VALUES(?,?)').bind(name,color).run();id=result.meta.last_row_id;
  }else{
    id=identifier(body.id);const result=await env.DB.prepare('UPDATE equipment SET name=?,color=? WHERE id=?').bind(name,color,id).run();
    if(!result.meta.changes)throw new AppError(404,'장비를 찾을 수 없습니다.');
  }
  return json({equipment:await env.DB.prepare('SELECT id,name,color FROM equipment WHERE id=?').bind(id).first()});
}
async function conflicting(env,equipmentId,start,end,id=0) {
  return await env.DB.prepare('SELECT b.id,b.start,b.end,u.name AS user_name FROM bookings b JOIN users u ON u.id=b.user_id WHERE b.equipment_id=? AND b.start<? AND b.end>? AND b.id!=? ORDER BY b.start LIMIT 1')
    .bind(equipmentId,end,start,id).first();
}
async function saveBooking(body,user,env) {
  const equipmentId=identifier(body.equipment_id),start=body.start,end=body.end,note=text(body.note??'','메모',160,false);
  const startMs=checkedDateTime(start),endMs=checkedDateTime(end);
  if(endMs<=startMs)bad('종료 시간은 시작 시간보다 늦어야 합니다.');
  if(endMs-startMs>365*86400000)bad('한 번에 최대 365일까지 예약할 수 있습니다.');
  if(!await env.DB.prepare('SELECT id FROM equipment WHERE id=?').bind(equipmentId).first())throw new AppError(404,'장비를 찾을 수 없습니다.');
  let id=body.id===null||body.id===undefined?null:identifier(body.id),result;
  if(id!==null){
    const old=await env.DB.prepare('SELECT user_id FROM bookings WHERE id=?').bind(id).first();
    if(!old)throw new AppError(404,'예약을 찾을 수 없습니다.');
    if(old.user_id!==user.id)forbidden('본인의 예약만 변경할 수 있습니다.');
    result=await env.DB.prepare('UPDATE bookings SET equipment_id=?,start=?,end=?,note=? WHERE id=? AND user_id=? AND NOT EXISTS (SELECT 1 FROM bookings WHERE equipment_id=? AND start<? AND end>? AND id!=?)')
      .bind(equipmentId,start,end,note,id,user.id,equipmentId,end,start,id).run();
  }else{
    // A single D1 statement atomically checks and inserts, even for simultaneous requests.
    result=await env.DB.prepare('INSERT INTO bookings(equipment_id,user_id,start,end,note) SELECT ?,?,?,?,? WHERE NOT EXISTS (SELECT 1 FROM bookings WHERE equipment_id=? AND start<? AND end>?)')
      .bind(equipmentId,user.id,start,end,note,equipmentId,end,start).run();
    id=result.meta.changes?result.meta.last_row_id:null;
  }
  if(!result.meta.changes){const overlap=await conflicting(env,equipmentId,start,end,id||0);if(overlap)throw new AppError(409,'이미 예약된 시간과 겹칩니다. 다른 시간을 선택해 주세요.',overlap);throw new AppError(409,'예약이 변경되었습니다. 새로고침 후 다시 시도해 주세요.');}
  return json({booking:await env.DB.prepare('SELECT * FROM bookings WHERE id=?').bind(id).first()});
}
async function handle(request,env) {
  if(!env.DB)throw new AppError(503,'데이터베이스 연결이 완료되지 않았습니다.');
  const path=new URL(request.url).pathname;
  if(request.method==='GET'){
    if(path==='/api/state')return stateResponse(request,env);
    if(path==='/auth/google/start')return authStart(env);
    if(path==='/auth/google/callback')return authCallback(request,env);
    throw new AppError(404,'요청한 항목을 찾을 수 없습니다.');
  }
  if(request.method!=='POST')throw new AppError(405,'허용되지 않은 요청입니다.');
  const body=await parseBody(request,env);
  if(path==='/api/logout'){
    const token=cookieValue(request,SESSION);if(token)await env.DB.prepare('DELETE FROM sessions WHERE token_hash=?').bind(await digestHex(token)).run();
    return json({ok:true},200,{'Set-Cookie':cookie(SESSION,'',0)});
  }
  if(path==='/api/profile'){
    const user=await requireUser(request,env,false),name=text(body.name,'이름',40);
    await env.DB.prepare('UPDATE users SET name=?,name_confirmed=1 WHERE id=?').bind(name,user.id).run();return json({ok:true});
  }
  const user=await requireUser(request,env);
  if(path==='/api/equipment')return saveEquipment(body,env);
  if(path==='/api/bookings')return saveBooking(body,user,env);
  if(path==='/api/bookings/delete'){
    const id=identifier(body.id),old=await env.DB.prepare('SELECT user_id FROM bookings WHERE id=?').bind(id).first();
    if(!old)throw new AppError(404,'예약을 찾을 수 없습니다.');if(old.user_id!==user.id)forbidden('본인의 예약만 삭제할 수 있습니다.');
    const result=await env.DB.prepare('DELETE FROM bookings WHERE id=? AND user_id=?').bind(id,user.id).run();
    if(!result.meta.changes)throw new AppError(409,'예약이 변경되었습니다. 새로고침 후 다시 시도해 주세요.');return json({ok:true});
  }
  throw new AppError(404,'요청한 항목을 찾을 수 없습니다.');
}
export default {async fetch(request,env){try{return await handle(request,env);}catch(error){
  if(error instanceof AppError)return json({error:error.message,...(error.detail?{conflicting:error.detail}:{})},error.status);
  console.error('Calendar backend failure');return json({error:'서버 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.'},500);
}}};
