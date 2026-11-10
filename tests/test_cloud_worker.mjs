import {test, beforeEach, afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import worker from '../cloud/worker/index.mjs';
import gateway from '../cloud/frontend/api/gateway.mjs';

const schema=await readFile(new URL('../cloud/worker/schema.sql',import.meta.url),'utf8');
class Binding {
  constructor(db,sql,params=[]) {this.db=db;this.sql=sql;this.params=params;}
  bind(...params){return new Binding(this.db,this.sql,params);}
  async first(){return this.db.prepare(this.sql).get(...this.params)||null;}
  async all(){return {results:this.db.prepare(this.sql).all(...this.params)};}
  async run(){const r=this.db.prepare(this.sql).run(...this.params);return {meta:{changes:Number(r.changes),last_row_id:Number(r.lastInsertRowid)}};}
}
class D1Adapter {
  constructor(db){this.db=db;}
  prepare(sql){return new Binding(this.db,sql);}
  async batch(statements){const results=[];this.db.exec('BEGIN');try{for(const statement of statements){if(/^\s*SELECT\b/i.test(statement.sql))results.push(await statement.all());else results.push(await statement.run());}this.db.exec('COMMIT');return results;}catch(e){this.db.exec('ROLLBACK');throw e;}}
}
let db,env;
const origin='https://equipment-calendar.example';
const tokenFor=name=>name.repeat(48).slice(0,48);
const hash=s=>createHash('sha256').update(s).digest('hex');
const session=name=>`__Host-calendar_session=${tokenFor(name)}`;
function request(path,{method='GET',cookie='',data,originHeader=origin}={}){
  const headers={};if(cookie)headers.Cookie=cookie;
  if(data!==undefined){headers.Origin=originHeader;headers['Content-Type']='application/json';}
  return worker.fetch(new Request('https://worker.example'+path,{method,headers,body:data===undefined?undefined:JSON.stringify(data)}),env);
}
function seedUser(name){
  const r=db.prepare('INSERT INTO users(provider_id,email,name,name_confirmed) VALUES(?,?,?,1)').run(name,`${name}@example.com`,name);
  db.prepare('INSERT INTO sessions(token_hash,user_id,expires) VALUES(?,?,?)').run(hash(tokenFor(name)),r.lastInsertRowid,Math.floor(Date.now()/1000)+30*86400);
  return Number(r.lastInsertRowid);
}
beforeEach(()=>{db=new DatabaseSync(':memory:');db.exec(schema);env={DB:new D1Adapter(db),PUBLIC_ORIGIN:origin,GOOGLE_CLIENT_ID:'test-id',GOOGLE_CLIENT_SECRET:'test-secret',ACCESS_POLICY:'all'};});
afterEach(()=>db.close());

test('every signed-in user sees all equipment reservations; anonymous sees none',async()=>{
  seedUser('alice');seedUser('bob');db.prepare('INSERT INTO equipment(name,color) VALUES(?,?)').run('공초점','#5e83d2');
  let response=await request('/api/bookings',{method:'POST',cookie:session('alice'),data:{equipment_id:1,start:'2026-11-09T22:00',end:'2026-11-10T09:00',note:'시험'}});
  assert.equal(response.status,200);
  response=await request('/api/state?start=2026-11-10&end=2026-11-11',{cookie:session('bob')});
  const data=await response.json();assert.equal(data.bookings.length,1);assert.equal(data.bookings[0].user_name,'alice');
  response=await request('/api/state?start=2026-11-10&end=2026-11-11');const anonymous=await response.json();
  assert.deepEqual(anonymous.bookings,[]);assert.deepEqual(anonymous.equipment,[]);
});

test('overlap is atomic, overnight conflicts fail, adjacent reservations succeed',async()=>{
  seedUser('alice');seedUser('bob');db.prepare('INSERT INTO equipment(name,color) VALUES(?,?)').run('장비','#5e83d2');
  const booking={equipment_id:1,start:'2026-11-09T22:00',end:'2026-11-10T09:00',note:''};
  const pair=await Promise.all([request('/api/bookings',{method:'POST',cookie:session('alice'),data:booking}),request('/api/bookings',{method:'POST',cookie:session('bob'),data:booking})]);
  assert.deepEqual(pair.map(r=>r.status).sort(),[200,409]);
  const conflict=await (pair.find(r=>r.status===409)).json();assert.equal(conflict.conflicting.end,'2026-11-10T09:00');
  const adjacent=await request('/api/bookings',{method:'POST',cookie:session('bob'),data:{...booking,start:'2026-11-10T09:00',end:'2026-11-10T10:00'}});
  assert.equal(adjacent.status,200);assert.equal(db.prepare('SELECT COUNT(*) AS n FROM bookings').get().n,2);
});

test('only owner may modify or delete a reservation and CSRF origin is checked',async()=>{
  seedUser('alice');seedUser('bob');db.prepare('INSERT INTO equipment(name,color) VALUES(?,?)').run('장비','#5e83d2');
  const booking={equipment_id:1,start:'2026-11-10T09:00',end:'2026-11-10T10:00',note:''};
  const create=await request('/api/bookings',{method:'POST',cookie:session('alice'),data:booking});const id=(await create.json()).booking.id;
  assert.equal((await request('/api/bookings',{method:'POST',cookie:session('bob'),data:{...booking,id}})).status,403);
  assert.equal((await request('/api/bookings/delete',{method:'POST',cookie:session('bob'),data:{id}})).status,403);
  assert.equal((await request('/api/equipment',{method:'POST',cookie:session('alice'),data:{name:'장비 2',color:'#ffffff'},originHeader:'https://evil.example'})).status,403);
  assert.equal((await request('/api/bookings/delete',{method:'POST',cookie:session('alice'),data:{id}})).status,200);
});

test('invalid dates, invalid colors and invalid intervals are rejected',async()=>{
  seedUser('alice');db.prepare('INSERT INTO equipment(name,color) VALUES(?,?)').run('장비','#5e83d2');
  assert.equal((await request('/api/equipment',{method:'POST',cookie:session('alice'),data:{name:'장비',color:'red'}})).status,400);
  for(const [start,end] of [['2026-02-30T09:00','2026-03-01T10:00'],['2026-11-10T10:00','2026-11-10T10:00'],['2026-11-10T11:00','2026-11-10T10:00']])
    assert.equal((await request('/api/bookings',{method:'POST',cookie:session('alice'),data:{equipment_id:1,start,end,note:''}})).status,400);
});

test('persistent device session is renewed near expiration and logout revokes it',async()=>{
  seedUser('alice');db.prepare('UPDATE sessions SET expires=? WHERE token_hash=?').run(Math.floor(Date.now()/1000)+3600,hash(tokenFor('alice')));
  const state=await request('/api/state?start=2026-11-10&end=2026-11-11',{cookie:session('alice')});
  assert.match(state.headers.get('set-cookie'),/__Host-calendar_session=.*Secure; SameSite=Lax; Max-Age=2592000/);
  assert.ok(db.prepare('SELECT expires FROM sessions').get().expires>Math.floor(Date.now()/1000)+29*86400);
  const logout=await request('/api/logout',{method:'POST',cookie:session('alice'),data:{}});assert.equal(logout.status,200);
  const after=await request('/api/state?start=2026-11-10&end=2026-11-11',{cookie:session('alice')});assert.equal((await after.json()).user,null);
});

test('Google PKCE callback creates a device session with explicitly confirmed name',async()=>{
  const original=globalThis.fetch;let tokenBody='';globalThis.fetch=async (url,options)=>{
    if(String(url).includes('/token')){tokenBody=String(options.body);return Response.json({access_token:'mock-access'});}
    if(String(url).includes('/userinfo'))return Response.json({sub:'google-sub-123',email:'person@example.com',email_verified:true,name:'프로필'});
    throw new Error('unexpected request');
  };
  try{
    const start=await request('/auth/google/start');assert.equal(start.status,303);const url=new URL(start.headers.get('location'));
    assert.equal(url.searchParams.get('code_challenge_method'),'S256');const state=url.searchParams.get('state'),stateCookie=start.headers.get('set-cookie').split(';')[0];
    const wrong=await request(`/auth/google/callback?state=${state}&code=sample`,{cookie:'__Host-calendar_oauth=bad'});assert.equal(wrong.headers.get('location'),'/?auth=state_error');
    const callback=await request(`/auth/google/callback?state=${state}&code=sample`,{cookie:stateCookie});
    assert.equal(callback.headers.get('location'),'/');assert.match(callback.headers.get('set-cookie'),/Max-Age=2592000/);assert.match(tokenBody,/code_verifier=/);
    const userCookie=callback.headers.get('set-cookie').split(';')[0];
    assert.equal((await request('/api/equipment',{method:'POST',cookie:userCookie,data:{name:'장비',color:'#5e83d2'}})).status,403);
    assert.equal((await request('/api/profile',{method:'POST',cookie:userCookie,data:{name:'이름 확인'}})).status,200);
    assert.equal((await request('/api/equipment',{method:'POST',cookie:userCookie,data:{name:'장비',color:'#5e83d2'}})).status,200);
    const replay=await request(`/auth/google/callback?state=${state}&code=sample`,{cookie:stateCookie});assert.equal(replay.headers.get('location'),'/?auth=cancelled');
  }finally{globalThis.fetch=original;}
});

test('deny-by-default policy and unverified Google email are rejected',async()=>{
  env.ACCESS_POLICY='restricted';env.ALLOWED_EMAILS='allowed@example.com';const original=globalThis.fetch;
  globalThis.fetch=async url=>String(url).includes('/token')?Response.json({access_token:'mock-access'}):Response.json({sub:'abc',email:'other@example.com',email_verified:true,name:'시험'});
  try{const start=await request('/auth/google/start'),state=new URL(start.headers.get('location')).searchParams.get('state'),stateCookie=start.headers.get('set-cookie').split(';')[0];
    const result=await request(`/auth/google/callback?state=${state}&code=sample`,{cookie:stateCookie});assert.equal(result.headers.get('location'),'/?auth=not_allowed');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM users').get().n,0);
    env.ACCESS_POLICY='all';
    globalThis.fetch=async url=>String(url).includes('/token')?Response.json({access_token:'mock-access'}):Response.json({sub:'abc',email:'other@example.com',email_verified:false,name:'시험'});
    const second=await request('/auth/google/start'),secondState=new URL(second.headers.get('location')).searchParams.get('state'),secondCookie=second.headers.get('set-cookie').split(';')[0];
    const unverified=await request(`/auth/google/callback?state=${secondState}&code=sample`,{cookie:secondCookie});
    assert.equal(unverified.headers.get('location'),'/?auth=failed');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM users').get().n,0);
  }finally{globalThis.fetch=original;}
});

test('Vercel gateway forwards sessions, reservations and Google login redirects',async()=>{
  seedUser('alice');db.prepare('INSERT INTO equipment(name,color) VALUES(?,?)').run('장비','#5e83d2');
  const originalFetch=globalThis.fetch, previousOrigin=process.env.WORKER_ORIGIN;
  process.env.WORKER_ORIGIN='https://gateway-test.workers.dev';
  globalThis.fetch=async (url,options)=>worker.fetch(new Request(url,options),env);
  try{
    const payload={equipment_id:1,start:'2026-11-10T09:00',end:'2026-11-10T10:00',note:'시험'};
    let result=await gateway.fetch(new Request(`${origin}/api/gateway?__calendar_route=booking`,{method:'POST',headers:{Origin:origin,Cookie:session('alice'),'Content-Type':'application/json'},body:JSON.stringify(payload)}));
    assert.equal(result.status,200);
    result=await gateway.fetch(new Request(`${origin}/api/gateway?__calendar_route=state&start=2026-11-10&end=2026-11-11`,{headers:{Cookie:session('alice')}}));
    assert.equal(result.status,200);assert.equal((await result.json()).bookings.length,1);assert.match(result.headers.get('cache-control'),/no-store/);
    result=await gateway.fetch(new Request(`${origin}/api/gateway?__calendar_route=login`));
    assert.equal(result.status,303);assert.match(result.headers.get('location'),/^https:\/\/accounts\.google\.com\//);assert.match(result.headers.get('set-cookie'),/__Host-calendar_oauth=/);
    assert.equal((await gateway.fetch(new Request(`${origin}/api/gateway?__calendar_route=unknown`))).status,404);
    assert.equal((await gateway.fetch(new Request(`${origin}/api/gateway?__calendar_route=logout`))).status,405);
    process.env.WORKER_ORIGIN='https://other.example';
    assert.equal((await gateway.fetch(new Request(`${origin}/api/gateway?__calendar_route=state`))).status,503);
  }finally{globalThis.fetch=originalFetch;if(previousOrigin===undefined)delete process.env.WORKER_ORIGIN;else process.env.WORKER_ORIGIN=previousOrigin;}
});
