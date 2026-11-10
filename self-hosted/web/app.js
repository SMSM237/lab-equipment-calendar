'use strict';

const $ = selector => document.querySelector(selector);
const state = {
  selected: todayKst(), view: 'month', equipment: [], bookings: [], user: null,
  demoMode: true, googleEnabled: false, hidden: new Set(), loaded: false, online: false, loading: true,
  event: null, request: 0, signature: '', timeScroll: null, sidebarOpen: window.innerWidth > 560,
  pendingBooking: null, calendarAnimation: null, returnFocusToCalendar: false,
  travelFrame: null
};
const dayNames = ['일요일','월요일','화요일','수요일','목요일','금요일','토요일'];
const colors = ['#dc6461','#e39a4e','#e0b54e','#67a971','#4e9bad','#5e83d2','#9b70c5','#c56d9c','#8b8b92'];
const pendingBookingKey = 'equipment-calendar-pending-booking';
try {const day=sessionStorage.getItem(pendingBookingKey);if(/^\d{4}-\d{2}-\d{2}$/.test(day||''))state.pendingBooking=day;} catch {}

function todayKst() {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {timeZone:'Asia/Seoul',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date()).map(x => [x.type,x.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}
function asDate(value) { const [y,m,d] = value.split('-').map(Number); return new Date(Date.UTC(y,m-1,d)); }
function formatDate(date) { return `${date.getUTCFullYear()}-${String(date.getUTCMonth()+1).padStart(2,'0')}-${String(date.getUTCDate()).padStart(2,'0')}`; }
function addDays(value, n) { const date=asDate(value); date.setUTCDate(date.getUTCDate()+n); return formatDate(date); }
function addMonths(value,n) { const d=asDate(value), day=d.getUTCDate(); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth()+n); const last=new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth()+1,0)).getUTCDate();d.setUTCDate(Math.min(day,last));return formatDate(d); }
function oneHourLater(value) {
  if(!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value))return '';
  const date=new Date(value+':00.000Z');
  if(!Number.isFinite(date.valueOf())||date.toISOString().slice(0,16)!==value)return '';
  date.setUTCHours(date.getUTCHours()+1);
  const result=date.toISOString();return /^\d{4}-/.test(result)?result.slice(0,16):'';
}
function updateBookingWeekdays() {
  for(const part of ['start','end']){
    const value=$(`#booking-${part}`).value;
    $(`#booking-${part}-weekday`).textContent=value?dayNames[asDate(value.slice(0,10)).getUTCDay()]:'요일';
  }
}
function monthStart(value) { return value.slice(0,7)+'-01'; }
function gridStart(value) { const first=monthStart(value); return addDays(first,-asDate(first).getUTCDay()); }
function prettyDate(value, showYear=true) { const d=asDate(value); return `${showYear?d.getUTCFullYear()+'년 ':''}${d.getUTCMonth()+1}월 ${d.getUTCDate()}일`; }
function textNode(tag,text,className) { const node=document.createElement(tag); if(className) node.className=className; node.textContent=text;return node; }
function icon(name) { const s=document.createElementNS('http://www.w3.org/2000/svg','svg');const u=document.createElementNS('http://www.w3.org/2000/svg','use');u.setAttribute('href','#icon-'+name);s.appendChild(u);return s; }
function showToast(message) { const t=$('#toast');t.textContent=message;t.classList.add('visible');clearTimeout(showToast.timer);showToast.timer=setTimeout(()=>t.classList.remove('visible'),3000); }
function currentEquipment(id) { return state.equipment.find(x=>x.id===id); }
function enabledEquipment() { return state.equipment.filter(x=>!state.hidden.has(x.id)); }
function selectedEvents(day) { const end=addDays(day,1)+'T00:00',start=day+'T00:00';return state.bookings.filter(x=>x.start<end&&x.end>start&&!state.hidden.has(x.equipment_id)); }
function eventSummary(event) { const eq=currentEquipment(event.equipment_id);return `${eq?eq.name:'장비'} · ${event.user_name}\n${prettyDate(event.start.slice(0,10))} ${event.start.slice(11,16)} ~ ${prettyDate(event.end.slice(0,10))} ${event.end.slice(11,16)}`; }
function setConnected(ok) { state.online=ok;const label=$('#connection-status');label.textContent=ok?(state.demoMode?'내부망 시험 모드':'서버에 연결됨'):'연결 안 됨 · 재시도 중';$('.status-dot').classList.toggle('offline',!ok);$('#connection-banner').hidden=ok; }

async function api(path,body) {
  let response;try{response=await fetch(path,body===undefined?{cache:'no-store'}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});}catch{throw new Error('서버에 연결할 수 없습니다. 네트워크와 서버 상태를 확인해 주세요.');}
  let data;try{data=await response.json();}catch{throw new Error('서버 응답을 읽지 못했습니다.');}
  if(!response.ok){const error=new Error(data.error||'요청을 처리하지 못했습니다.');error.conflicting=data.conflicting;error.status=response.status;throw error;}
  return data;
}
async function loadState() {
  const request=++state.request; const start=gridStart(state.selected),end=addDays(start,49);
  try {
    const data=await api(`/api/state?start=${start}&end=${end}`);if(request!==state.request)return;
    const wasWaiting=state.loading||!state.online;state.loading=false;const signature=JSON.stringify(data);if(signature===state.signature){setConnected(true);if(wasWaiting)renderAvailability();resumePendingBooking();return;}state.signature=signature;
    state.equipment=data.equipment;state.bookings=data.bookings;state.user=data.user;state.demoMode=data.demo_mode;state.googleEnabled=data.google_enabled;state.loaded=true;
    const existing=new Set(state.equipment.map(x=>x.id));state.hidden.forEach(x=>{if(!existing.has(x))state.hidden.delete(x);});
    setConnected(true);render();
    if(state.user && !state.user.name_confirmed && !document.querySelector('dialog[open]'))openProfile();
    resumePendingBooking();
  } catch(error) {if(request!==state.request)return;state.loading=false;setConnected(false);renderAvailability();if(state.pendingBooking)clearPendingBooking();if(!state.loaded)showToast('서버에 연결할 수 없습니다.');}
}
function render() {
  const previousScroll=document.querySelector('#calendar .time-scroll');if(previousScroll)state.timeScroll=previousScroll.scrollTop;
  $('#account-label').textContent=state.user?state.user.name:'로그인';$('#account-button').setAttribute('aria-label',state.user?`${state.user.name} 계정`:'로그인');
  $('#app').classList.toggle('sidebar-hidden',!state.sidebarOpen);
  $('#sidebar-toggle').setAttribute('aria-expanded',String(state.sidebarOpen));
  document.querySelectorAll('[data-view]').forEach(button=>{const active=button.dataset.view===state.view;button.classList.toggle('active',active);button.setAttribute('aria-pressed',String(active));});
  const viewIndex={day:0,week:1,month:2}[state.view];$('.view-switch').style.setProperty('--view-position',`calc(${viewIndex*100}% + ${viewIndex}px)`);
  renderMini();renderEquipment();renderCalendar();renderAvailability();
}
function cancelTimeTravel(){if(state.travelFrame!==null)cancelAnimationFrame(state.travelFrame);state.travelFrame=null;$('#app').classList.remove('is-traveling');}
function selectDay(day, reload=true) {cancelTimeTravel();if(state.selected!==day)$('#availability-list').scrollTop=0;if(reload)state.loading=true;state.selected=day;render();if(reload)loadState(); }
function clearPendingBooking(){state.pendingBooking=null;try{sessionStorage.removeItem(pendingBookingKey);}catch{}}
function resumePendingBooking(){
  const day=state.pendingBooking;
  if(!day||!state.loaded||!state.online||state.loading||document.querySelector('dialog[open]'))return;
  if(!state.user){openLogin();return;}
  if(!state.user.name_confirmed){openProfile();return;}
  if(!state.equipment.length){openEquipment();showToast('먼저 장비를 추가해 주세요.');return;}
  clearPendingBooking();selectDay(day,false);state.returnFocusToCalendar=true;openBooking(null,`${day}T09:00`);
}
function selectDate(day) {
  if(window.innerWidth<=560){
    state.sidebarOpen=false;selectDay(day,false);state.pendingBooking=day;resumePendingBooking();loadState();
  }else{state.sidebarOpen=true;selectDay(day);}
}
function animateCalendar(direction=0){
  if(window.matchMedia('(prefers-reduced-motion: reduce)').matches||!$('#calendar').animate)return;
  if(state.calendarAnimation)state.calendarAnimation.cancel();
  state.calendarAnimation=$('#calendar').animate([{opacity:.82,transform:`translateX(${direction*8}px)`},{opacity:1,transform:'translateX(0)'}],{duration:190,easing:'cubic-bezier(.2,0,0,1)'});
}
function paintTravelDay(day){
  const actual=state.selected,month=day.slice(0,7);
  state.selected=day;
  try{
    if($('#mini-grid').dataset.month!==month)renderMini();
    else {
      const old=$('#mini-grid button.selected'),next=document.querySelector(`#mini-grid button[data-day="${day}"]`);
      if(old){old.classList.remove('selected');old.removeAttribute('aria-current');}
      if(next){next.classList.add('selected');next.setAttribute('aria-current','date');}
    }
    const monthGrid=$('#calendar .month-grid');
    if((state.view==='month'&&(!monthGrid||monthGrid.dataset.month!==month))||state.view==='day'||(state.view==='week'&&!document.querySelector(`#calendar .time-day-header[data-day="${day}"]`)))renderCalendar();
    if(state.view==='month'){
      const old=$('#calendar .month-cell.selected'),next=document.querySelector(`#calendar .month-cell[data-day="${day}"]`);
      if(old)old.classList.remove('selected','travel-current');
      if(next)next.classList.add('selected','travel-current');
    }else{
      const old=$('#calendar .time-day-column.selected'),next=document.querySelector(`#calendar .time-day-column[data-day="${day}"]`);
      if(old)old.classList.remove('selected');if(next)next.classList.add('selected');
      document.querySelectorAll('#calendar .time-day-header.travel-current').forEach(button=>button.classList.remove('travel-current'));
      const header=document.querySelector(`#calendar .time-day-header[data-day="${day}"]`);if(header)header.classList.add('travel-current');
    }
  }finally{state.selected=actual;}
}
function travelToToday(){
  const target=todayKst(),before=state.selected,wasTraveling=state.travelFrame!==null;cancelTimeTravel();
  if(state.calendarAnimation)state.calendarAnimation.cancel();
  const distance=Math.abs((asDate(target)-asDate(before))/86400000),direction=before<target?1:-1;
  if(wasTraveling||before===target||distance>45||document.hidden||window.matchMedia('(prefers-reduced-motion: reduce)').matches){selectDay(target);return;}
  const duration=Math.min(800,Math.max(100,distance*Math.max(18,42-distance)));
  const stepInterval=duration/distance,started=performance.now();let lastStep=0;
  $('#app').classList.add('is-traveling');paintTravelDay(before);
  const tick=now=>{
    const elapsed=Math.max(0,now-started),step=Math.min(distance,lastStep+1,Math.floor(elapsed/stepInterval));
    if(step>lastStep){const day=addDays(before,step*direction);paintTravelDay(day);lastStep=step;}
    if(lastStep===distance||elapsed>=1500){state.travelFrame=null;selectDay(target);}else state.travelFrame=requestAnimationFrame(tick);
  };
  state.travelFrame=requestAnimationFrame(tick);
}
function renderMini() {
  const d=asDate(state.selected), grid=$('#mini-grid'),first=gridStart(state.selected);
  $('#mini-title').textContent=`${d.getUTCFullYear()}년 ${d.getUTCMonth()+1}월`;grid.dataset.month=state.selected.slice(0,7);grid.replaceChildren();
  for(let i=0;i<42;i++){
    const day=addDays(first,i),date=asDate(day),button=textNode('button',String(date.getUTCDate()));button.type='button';button.dataset.day=day;
    button.setAttribute('aria-label',prettyDate(day));button.classList.toggle('outside',day.slice(0,7)!==state.selected.slice(0,7));button.classList.toggle('today',day===todayKst());button.classList.toggle('selected',day===state.selected);
    if(day===state.selected)button.setAttribute('aria-current','date');button.addEventListener('click',()=>selectDate(day));grid.appendChild(button);
  }
}
function renderEquipment() {
  const list=$('#equipment-list'),scrollTop=list.scrollTop;list.replaceChildren();
  if(!state.equipment.length){const message=state.user?'장비를 추가해 예약을 시작하세요.':(!state.demoMode?'로그인하면 장비가 표시됩니다.':'등록된 장비가 없습니다.');list.appendChild(textNode('p',message,'equipment-empty'));return;}
  state.equipment.forEach(eq=>{
    const row=textNode('div','','equipment-row'),button=textNode('button','','equipment-filter'),dot=textNode('span','','dot'),label=textNode('span',eq.name);
    button.type='button';button.style.setProperty('--equipment-color',eq.color);button.setAttribute('aria-pressed',String(!state.hidden.has(eq.id)));button.setAttribute('aria-label',`${eq.name} 표시 ${state.hidden.has(eq.id)?'켜기':'끄기'}`);button.append(dot,label);
    button.addEventListener('click',()=>{state.hidden.has(eq.id)?state.hidden.delete(eq.id):state.hidden.add(eq.id);render();});
    const edit=textNode('button','','equipment-edit');edit.type='button';edit.setAttribute('aria-label',eq.name+' 수정');edit.appendChild(icon('edit'));edit.addEventListener('click',()=>openEquipment(eq));row.append(button,edit);list.appendChild(row);
  });list.scrollTop=scrollTop;
}
function calendarTitle() {
  const d=asDate(state.selected);if(state.view==='month')return `${d.getUTCFullYear()}년 ${d.getUTCMonth()+1}월`;
  if(state.view==='day')return prettyDate(state.selected);
  const start=addDays(state.selected,-d.getUTCDay()),end=addDays(start,6),a=asDate(start),b=asDate(end);
  return a.getUTCMonth()===b.getUTCMonth()?`${a.getUTCFullYear()}년 ${a.getUTCMonth()+1}월 ${a.getUTCDate()}일–${b.getUTCDate()}일`:`${prettyDate(start,false)} – ${prettyDate(end,false)}`;
}
function renderCalendar() {
  $('#calendar-title').textContent=calendarTitle();const calendar=$('#calendar');calendar.replaceChildren();calendar.className='calendar';
  if(state.view==='month')renderMonth(calendar);else renderTimeGrid(calendar);
}
function renderMonth(calendar) {
  const headings=textNode('div','','weekday-row');['일','월','화','수','목','금','토'].forEach(x=>headings.appendChild(textNode('span',x)));calendar.appendChild(headings);
  const grid=textNode('div','','month-grid'),first=gridStart(state.selected),month=state.selected.slice(0,7),last=new Date(Date.UTC(asDate(state.selected).getUTCFullYear(),asDate(state.selected).getUTCMonth()+1,0)).getUTCDate();
  const weeks=Math.max(5,Math.ceil((asDate(monthStart(state.selected)).getUTCDay()+last)/7));grid.dataset.month=month;grid.style.setProperty('--weeks',weeks);
  for(let i=0;i<weeks*7;i++){
    const day=addDays(first,i),date=asDate(day),cell=textNode('div','','month-cell');cell.dataset.day=day;cell.classList.toggle('selected',day===state.selected);cell.classList.toggle('outside',day.slice(0,7)!==month);
    const holder=textNode('div','','day-number'),button=textNode('button',String(date.getUTCDate()));button.type='button';button.setAttribute('aria-label',prettyDate(day));if(day===todayKst())button.classList.add('today');button.addEventListener('click',()=>selectDate(day));holder.appendChild(button);cell.appendChild(holder);
    cell.addEventListener('click',event=>{if(!event.target.closest('button'))selectDate(day);});
    const events=textNode('div','','month-events'),allEvents=selectedEvents(day);let visible=allEvents;
    if(window.innerWidth<=560){const rowHeight=Math.max(0,(calendar.clientHeight-30)/weeks),nominal=Math.max(0,Math.floor((rowHeight-29)/34));const capacity=allEvents.length>nominal?Math.max(0,Math.floor((rowHeight-44)/34)):nominal;visible=allEvents.slice(0,capacity);}
    visible.forEach(event=>{
      const eq=currentEquipment(event.equipment_id);if(!eq)return;const item=textNode('button','','month-event');item.type='button';item.style.setProperty('--event-color',eq.color);
      const carriedIn=event.start<day+'T00:00',carriedOut=event.end>addDays(day,1)+'T00:00';item.classList.toggle('multiday',carriedIn||carriedOut);item.title=eventSummary(event);item.setAttribute('aria-label',eventSummary(event).replace('\n',' '));
      const start=event.start.slice(11,16),end=event.end===addDays(day,1)+'T00:00'?'24:00':event.end.slice(11,16);
      const time=carriedIn&&carriedOut?'↔ 계속':carriedIn?`← ${end} 종료`:carriedOut?`${start} →`:`${start}–${end}`;
      const timeLine=textNode('span',time,'event-time-label'),person=textNode('span','','event-person');person.append(textNode('span','','event-dot'),document.createTextNode(event.user_name));item.append(timeLine,person);item.addEventListener('click',()=>openEvent(event));events.appendChild(item);
    });if(visible.length<allEvents.length){const more=textNode('button',`+${allEvents.length-visible.length}개`,'more-events');more.type='button';more.setAttribute('aria-label',`${prettyDate(day)} 예약 ${allEvents.length}개와 사용 현황 보기`);more.addEventListener('click',()=>{state.sidebarOpen=true;selectDay(day);});events.appendChild(more);}cell.appendChild(events);grid.appendChild(cell);
  }
  calendar.appendChild(grid);
}
function minutes(iso,day,ending=false) {const date=iso.slice(0,10);if(date<day)return 0;if(date>day)return 1440;return Number(iso.slice(11,13))*60+Number(iso.slice(14,16));}
function timeLabel(min) {if(min===1440)return '24:00';return `${String(Math.floor(min/60)).padStart(2,'0')}:${String(min%60).padStart(2,'0')}`;}
function assignLanes(events,day) {
  const groups=[];let group=null;
  const segments=events.map(event=>({event,start:minutes(event.start,day),end:minutes(event.end,day,true)})).sort((a,b)=>a.start-b.start||a.end-b.end);
  segments.forEach(segment=>{
    if(!group||segment.start>=group.end){group={end:segment.end,segments:[],lanes:[]};groups.push(group);}else group.end=Math.max(group.end,segment.end);
    let lane=group.lanes.findIndex(end=>end<=segment.start);if(lane<0){lane=group.lanes.length;group.lanes.push(segment.end);}else group.lanes[lane]=segment.end;
    segment.lane=lane;group.segments.push(segment);
  });
  groups.forEach(group=>group.segments.forEach(segment=>segment.lanes=group.lanes.length));return segments;
}
function renderTimeGrid(calendar) {
  const count=state.view==='day'?1:7,first=count===1?state.selected:addDays(state.selected,-asDate(state.selected).getUTCDay());calendar.classList.add('time-calendar');
  const headings=textNode('div','','time-days-header');headings.style.setProperty('--columns',count);headings.appendChild(document.createElement('div'));
  for(let i=0;i<count;i++){const day=addDays(first,i),date=asDate(day),button=textNode('button','','time-day-header');button.type='button';button.dataset.day=day;button.append(document.createTextNode(dayNames[date.getUTCDay()].slice(0,1)));button.appendChild(textNode('strong',String(date.getUTCDate())));button.classList.toggle('today',day===todayKst());button.setAttribute('aria-label',prettyDate(day));button.addEventListener('click',()=>selectDate(day));headings.appendChild(button);}
  calendar.appendChild(headings);const scroll=textNode('div','','time-scroll'),grid=textNode('div','','time-grid');grid.style.setProperty('--columns',count);
  const labels=textNode('div','','time-labels');for(let h=1;h<24;h++){const label=textNode('span',`${String(h).padStart(2,'0')}:00`,'time-label');label.style.top=`${h*48}px`;labels.appendChild(label);}grid.appendChild(labels);
  for(let i=0;i<count;i++){
    const day=addDays(first,i),column=textNode('div','','time-day-column');column.dataset.day=day;column.classList.toggle('selected',day===state.selected);
    column.addEventListener('dblclick',event=>{const rect=column.getBoundingClientRect(),halfHour=Math.min(47,Math.max(0,Math.floor((event.clientY-rect.top)/24)));selectDay(day,false);openBooking(null,`${day}T${timeLabel(halfHour*30)}`);});
    assignLanes(selectedEvents(day),day).forEach(segment=>{const {event,start,end}=segment,eq=currentEquipment(event.equipment_id);if(!eq)return;const item=textNode('button','','timed-event');item.type='button';item.style.setProperty('--event-color',eq.color);item.style.top=`${start/60*48}px`;item.style.height=`${Math.max(19,(end-start)/60*48)}px`;item.style.left=`calc(${segment.lane/segment.lanes*100}% + 3px)`;item.style.width=`calc(${100/segment.lanes}% - 6px)`;item.title=eventSummary(event);item.setAttribute('aria-label',eventSummary(event).replace('\n',' '));
      item.appendChild(textNode('strong',`${event.user_name} · ${eq.name}`));item.appendChild(textNode('span',`${event.start.slice(0,10)<day?'← ':''}${timeLabel(start)}–${timeLabel(end)}${event.end>addDays(day,1)+'T00:00'?' →':''}`));item.addEventListener('click',()=>openEvent(event));item.addEventListener('dblclick',e=>e.stopPropagation());column.appendChild(item);});grid.appendChild(column);
  }
  scroll.appendChild(grid);calendar.appendChild(scroll);scroll.scrollTop=state.timeScroll===null?7*48:state.timeScroll;scroll.addEventListener('scroll',()=>{state.timeScroll=scroll.scrollTop;});
}
function renderAvailability() {
  const day=state.selected,date=asDate(day);$('#details-date').textContent=prettyDate(day,false);$('#details-weekday').textContent=dayNames[date.getUTCDay()];const list=$('#availability-list'),scrollTop=list.scrollTop;list.replaceChildren();
  if(state.loading||!state.loaded){list.appendChild(textNode('p',state.online?'사용 현황을 불러오는 중입니다.':'서버에 연결하고 있습니다.','availability-empty'));return;}
  if(!state.online){list.appendChild(textNode('p','서버 연결이 복구되면 사용 가능 시간을 확인할 수 있습니다.','availability-empty'));return;}
  const eqs=enabledEquipment();if(!eqs.length){list.appendChild(textNode('p',state.equipment.length?'왼쪽 목록에서 장비 표시를 켜 주세요.':'장비를 추가하면 시간대별 사용 현황을 볼 수 있습니다.','availability-empty'));return;}
  eqs.forEach(eq=>{
    const item=textNode('section','','availability-item');item.style.setProperty('--equipment-color',eq.color);const heading=textNode('div','','availability-heading');heading.append(textNode('span','','dot'),textNode('span',eq.name));item.appendChild(heading);
    const track=textNode('div','','availability-track');track.setAttribute('aria-label',`${eq.name} 24시간 사용 현황`);const events=selectedEvents(day).filter(x=>x.equipment_id===eq.id).sort((a,b)=>a.start.localeCompare(b.start));
    const copy=textNode('div','','availability-copy');let cursor=0;
    for(const event of events){const start=minutes(event.start,day),end=minutes(event.end,day,true);
      if(start>cursor)copy.appendChild(textNode('div',`${timeLabel(cursor)}–${timeLabel(start)} 예약 가능`));
      const segment=textNode('span','','availability-segment');segment.style.left=`${start/1440*100}%`;segment.style.width=`${(end-start)/1440*100}%`;segment.classList.toggle('continued-start',event.start.slice(0,10)<day);segment.classList.toggle('continued-end',event.end>addDays(day,1)+'T00:00');segment.title=eventSummary(event);track.appendChild(segment);
      const startText=event.start.slice(0,10)<day?'전날부터':timeLabel(start);const endText=event.end>addDays(day,1)+'T00:00'?`${prettyDate(event.end.slice(0,10),false)} ${event.end.slice(11,16)} 종료`:`${timeLabel(end)} 종료`;
      const bookingButton=textNode('button',`${startText}–${endText} · ${event.user_name}`,'availability-booking');bookingButton.type='button';bookingButton.setAttribute('aria-label',eventSummary(event).replace('\n',' ')+' 예약 정보');bookingButton.addEventListener('click',()=>openEvent(event));copy.appendChild(bookingButton);cursor=Math.max(cursor,end);
    }
    if(!events.length)copy.appendChild(textNode('strong','하루 종일 예약 가능'));else if(cursor<1440)copy.appendChild(textNode('strong',`${timeLabel(cursor)}부터 24:00까지 예약 가능`));
    item.append(track,copy);list.appendChild(item);
  });list.scrollTop=scrollTop;
}
function requireLogin() {if(!state.online||state.loading){showToast(state.loading?'사용 현황을 불러오는 중입니다.':'서버 연결을 확인해 주세요.');return false;}if(!state.user){openLogin();return false;}if(!state.user.name_confirmed){openProfile();return false;}return true;}
function openLogin() {$('#login-error').textContent='';$('#google-login').classList.toggle('disabled',!state.googleEnabled);$('#google-login').setAttribute('aria-disabled',String(!state.googleEnabled));$('#google-note').hidden=state.googleEnabled;$('#demo-login-form').hidden=!state.demoMode;$('#login-dialog').showModal();}
function openEquipment(eq=null) {
  if(!requireLogin())return;$('#equipment-id').value=eq?eq.id:'';$('#equipment-title').textContent=eq?'장비 수정':'장비 추가';$('#equipment-name').value=eq?eq.name:'';$('#equipment-error').textContent='';const container=$('#colors');container.replaceChildren();
  colors.forEach((color,index)=>{const label=textNode('label','','color-choice');label.style.setProperty('--swatch',color);const input=document.createElement('input');input.type='radio';input.name='color';input.value=color;input.setAttribute('aria-label',`색상 ${index+1}`);input.checked=color===(eq?eq.color:colors[0]);label.append(input,textNode('span',''));container.appendChild(label);});
  $('#equipment-dialog').showModal();
}
function openBooking(event=null,defaultStart=null) {
  if(!requireLogin())return;if(!state.equipment.length){showToast('먼저 장비를 추가해 주세요.');openEquipment();return;}
  $('#booking-id').value=event?event.id:'';$('#booking-title').textContent=event?'예약 수정':'새 예약';$('#booking-error').textContent='';const select=$('#booking-equipment');select.replaceChildren();
  state.equipment.forEach(eq=>{const option=textNode('option',eq.name);option.value=eq.id;select.appendChild(option);});
  if(event){select.value=event.equipment_id;$('#booking-start').value=event.start;$('#booking-end').value=event.end;$('#booking-note').value=event.note;}
  else {const first=enabledEquipment()[0];if(first)select.value=first.id;const start=defaultStart||state.selected+'T09:00';$('#booking-start').value=start;$('#booking-end').value=oneHourLater(start);$('#booking-note').value='';}
  updateBookingWeekdays();$('#delete-booking').hidden=!event;$('#booking-dialog').showModal();
}
function openEvent(event) {
  const eq=currentEquipment(event.equipment_id);if(!eq)return;state.event=event;$('#event-color').style.background=eq.color;$('#event-equipment').textContent=eq.name;$('#event-user').textContent=event.user_name;$('#event-when').textContent=`${prettyDate(event.start.slice(0,10))} ${event.start.slice(11,16)}\n${prettyDate(event.end.slice(0,10))} ${event.end.slice(11,16)} 종료`;$('#event-when').style.whiteSpace='pre-line';$('#event-note').textContent=event.note;$('#edit-booking').hidden=!(state.user&&state.user.id===event.user_id);$('#event-dialog').showModal();
}
function openProfile(){if(!state.user){openLogin();return;}$('#profile-name').value=state.user.name;$('#profile-email').textContent=state.user.provider==='demo'?'내부망 시험 계정':state.user.email+(state.user.name_confirmed?'':' · 예약에 표시할 실명을 입력해 주세요.');$('#profile-error').textContent='';$('#profile-dialog').showModal();}
function errorText(error){if(!error.conflicting)return error.message;const b=error.conflicting;return `${error.message}\n${b.user_name} · ${prettyDate(b.start.slice(0,10),false)} ${b.start.slice(11,16)} – ${prettyDate(b.end.slice(0,10),false)} ${b.end.slice(11,16)}`;}
function submitForm(form,handler,errorSelector){form.addEventListener('submit',async event=>{event.preventDefault();const submit=form.querySelector('[type="submit"]');submit.disabled=true;$(errorSelector).textContent='';try{await handler();}catch(error){$(errorSelector).textContent=errorText(error);}finally{submit.disabled=false;}});}

$('#sidebar-toggle').addEventListener('click',()=>{state.sidebarOpen=!state.sidebarOpen;render();});
$('#today-button').addEventListener('click',travelToToday);
document.addEventListener('visibilitychange',()=>{if(document.hidden&&state.travelFrame!==null)selectDay(todayKst());});
$('#previous-button').addEventListener('click',()=>{selectDay(state.view==='month'?addMonths(state.selected,-1):addDays(state.selected,state.view==='week'?-7:-1));animateCalendar(-1);});
$('#next-button').addEventListener('click',()=>{selectDay(state.view==='month'?addMonths(state.selected,1):addDays(state.selected,state.view==='week'?7:1));animateCalendar(1);});
$('#mini-prev').addEventListener('click',()=>{selectDay(addMonths(state.selected,-1));animateCalendar(-1);});$('#mini-next').addEventListener('click',()=>{selectDay(addMonths(state.selected,1));animateCalendar(1);});
document.querySelectorAll('[data-view]').forEach(button=>button.addEventListener('click',()=>{if(state.view!==button.dataset.view){cancelTimeTravel();state.view=button.dataset.view;render();animateCalendar();}}));
$('#account-button').addEventListener('click',openProfile);$('#add-equipment').addEventListener('click',()=>openEquipment());$('#new-booking').addEventListener('click',()=>openBooking());$('#details-add').addEventListener('click',()=>openBooking());
$('#mobile-details').addEventListener('click',()=>{state.sidebarOpen=true;render();});$('#details-close').addEventListener('click',()=>{state.sidebarOpen=false;render();$('#sidebar-toggle').focus();});
document.querySelectorAll('[data-close]').forEach(button=>button.addEventListener('click',()=>{const dialog=button.closest('dialog');if(['login-dialog','profile-dialog','equipment-dialog'].includes(dialog.id))clearPendingBooking();dialog.close();}));
document.querySelectorAll('dialog').forEach(dialog=>dialog.addEventListener('cancel',()=>clearPendingBooking()));
$('#booking-dialog').addEventListener('close',()=>{if(!state.returnFocusToCalendar)return;state.returnFocusToCalendar=false;const label=prettyDate(state.selected);const button=[...document.querySelectorAll('#calendar button')].find(item=>item.getAttribute('aria-label')===label);if(button)button.focus({preventScroll:true});});
$('#google-login').addEventListener('click',()=>{if(state.pendingBooking)try{sessionStorage.setItem(pendingBookingKey,state.pendingBooking);}catch{}});
$('#booking-start').addEventListener('input',()=>{const end=oneHourLater($('#booking-start').value);if(end)$('#booking-end').value=end;updateBookingWeekdays();});
$('#booking-end').addEventListener('input',updateBookingWeekdays);
$('#edit-booking').addEventListener('click',()=>{const event=state.event;$('#event-dialog').close();openBooking(event);});
submitForm($('#demo-login-form'),async()=>{await api('/api/demo/login',{name:$('#demo-name').value});$('#login-dialog').close();await loadState();showToast('시험 모드로 로그인했습니다.');},'#login-error');
submitForm($('#profile-form'),async()=>{await api('/api/profile',{name:$('#profile-name').value});$('#profile-dialog').close();await loadState();showToast('이름을 저장했습니다.');},'#profile-error');
$('#logout').addEventListener('click',async()=>{try{await api('/api/logout',{});$('#profile-dialog').close();await loadState();showToast('로그아웃했습니다.');}catch(error){$('#profile-error').textContent=error.message;}});
submitForm($('#equipment-form'),async()=>{const checked=document.querySelector('input[name="color"]:checked');await api('/api/equipment',{id:$('#equipment-id').value?Number($('#equipment-id').value):null,name:$('#equipment-name').value,color:checked?checked.value:''});$('#equipment-dialog').close();await loadState();showToast('장비를 저장했습니다.');},'#equipment-error');
submitForm($('#booking-form'),async()=>{const id=$('#booking-id').value;await api('/api/bookings',{id:id?Number(id):null,equipment_id:Number($('#booking-equipment').value),start:$('#booking-start').value,end:$('#booking-end').value,note:$('#booking-note').value});$('#booking-dialog').close();state.selected=$('#booking-start').value.slice(0,10);await loadState();showToast('예약을 저장했습니다.');},'#booking-error');
$('#delete-booking').addEventListener('click',async()=>{if(!window.confirm('이 예약을 삭제하시겠습니까?'))return;try{await api('/api/bookings/delete',{id:Number($('#booking-id').value)});$('#booking-dialog').close();await loadState();showToast('예약을 삭제했습니다.');}catch(error){$('#booking-error').textContent=error.message;}});
const authError=new URLSearchParams(location.search).get('auth');if(authError){clearPendingBooking();const messages={unconfigured:'Google 로그인 설정이 필요합니다.',state_error:'로그인 요청이 만료되었습니다. 다시 시도해 주세요.',cancelled:'Google 로그인이 취소되었거나 만료되었습니다.',failed:'Google 로그인을 완료하지 못했습니다.',not_allowed:'허용된 계정이 아닙니다.'};showToast(messages[authError]||'로그인할 수 없습니다.');history.replaceState(null,'',location.pathname);}
let compactWindow=window.innerWidth<=560,resizeTimer;window.addEventListener('resize',()=>{clearTimeout(resizeTimer);resizeTimer=setTimeout(()=>{const compact=window.innerWidth<=560;if(compact!==compactWindow){compactWindow=compact;state.sidebarOpen=!compact;}render();},100);});
render();loadState();
setInterval(loadState,15000);
