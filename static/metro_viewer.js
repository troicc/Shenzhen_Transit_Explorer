const $=s=>document.querySelector(s);
const els={stage:$('#mapStage'),routeCanvas:$('#routeCanvas'),labelCanvas:$('#labelCanvas'),topStatus:$('#topStatus'),networkMeta:$('#networkMeta'),loading:$('#loadingOverlay'),loadingTitle:$('#loadingTitle'),loadingText:$('#loadingText'),search:$('#searchInput'),searchResults:$('#searchResults'),routeCard:$('#routeCard'),stopList:$('#stopList'),home:$('#homeBtn'),zoomIn:$('#zoomInBtn'),zoomOut:$('#zoomOutBtn'),toast:$('#toast')};
const state={overview:null,routeMap:new Map(),viewData:{routes:[],stations:[]},selected:null,view:null,homeView:null,drag:null,moved:false,pixelRatio:1,fetchTimer:null,fetchController:null,searchTimer:null};

function showToast(message){els.toast.textContent=message;els.toast.classList.add('show');setTimeout(()=>els.toast.classList.remove('show'),1900)}
function escapeHtml(value){return String(value??'').replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]))}
async function api(url){const r=await fetch(url);const data=await r.json().catch(()=>({}));if(!r.ok)throw new Error(data.detail||`HTTP ${r.status}`);return data}
function lineColor(route){return route.color||state.routeMap.get(route.id)?.color||'#5cc8ff'}

function resize(){
  const rect=els.stage.getBoundingClientRect();state.pixelRatio=Math.min(2,window.devicePixelRatio||1);
  for(const canvas of [els.routeCanvas,els.labelCanvas]){canvas.width=Math.round(rect.width*state.pixelRatio);canvas.height=Math.round(rect.height*state.pixelRatio);canvas.style.width=`${rect.width}px`;canvas.style.height=`${rect.height}px`}
  if(state.overview&&!state.view)fitHome();else render();
}
function fitRect(rect,pad=.08){
  const stage=els.stage.getBoundingClientRect(),aspect=stage.width/Math.max(1,stage.height);
  let x=rect[0],y=rect[1],w=Math.max(1,rect[2]-rect[0]),h=Math.max(1,rect[3]-rect[1]);x-=w*pad;y-=h*pad;w*=1+pad*2;h*=1+pad*2;
  if(w/h>aspect){const target=w/aspect;y-=(target-h)/2;h=target}else{const target=h*aspect;x-=(target-w)/2;w=target}
  state.view={x,y,w,h};scheduleViewFetch();render();
}
function fitHome(){const world=state.overview.world;fitRect([0,0,world.width,world.height],.045);state.homeView={...state.view}}
function currentZoom(){return state.homeView?state.homeView.w/state.view.w:1}
function transform(){
  const rect=els.stage.getBoundingClientRect(),scale=Math.min(rect.width/state.view.w,rect.height/state.view.h);
  const ox=(rect.width-state.view.w*scale)/2-state.view.x*scale,oy=(rect.height-state.view.h*scale)/2-state.view.y*scale;
  return {scale,ox,oy,width:rect.width,height:rect.height};
}
function worldToScreen(x,y,t=transform()){return [x*t.scale+t.ox,y*t.scale+t.oy]}
function screenToWorld(x,y,t=transform()){return [(x-t.ox)/t.scale,(y-t.oy)/t.scale]}
function setCtx(canvas){const ctx=canvas.getContext('2d');ctx.setTransform(state.pixelRatio,0,0,state.pixelRatio,0,0);ctx.clearRect(0,0,canvas.width/state.pixelRatio,canvas.height/state.pixelRatio);return ctx}
function drawPath(ctx,path,t){if(!path?.length)return;ctx.beginPath();let p=worldToScreen(path[0][0],path[0][1],t);ctx.moveTo(p[0],p[1]);for(let i=1;i<path.length;i++){p=worldToScreen(path[i][0],path[i][1],t);ctx.lineTo(p[0],p[1])}ctx.stroke()}
function routeSource(){return state.viewData.routes?.length?state.viewData.routes:state.overview.routes}
function drawLabel(ctx,text,x,y,size=10,color='#cbd8e8'){ctx.font=`600 ${size}px -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif`;ctx.textBaseline='middle';ctx.lineJoin='round';ctx.strokeStyle='#07101d';ctx.lineWidth=4;ctx.strokeText(text,x,y);ctx.fillStyle=color;ctx.fillText(text,x,y)}

function render(){
  if(!state.overview||!state.view)return;
  const t=transform(),zoom=currentZoom(),routeCtx=setCtx(els.routeCanvas),labelCtx=setCtx(els.labelCanvas);
  routeCtx.lineCap='round';routeCtx.lineJoin='round';
  const selectedId=state.selected?.id;
  const routes=routeSource();
  for(const route of routes){
    if(route.id===selectedId)continue;
    const meta=state.routeMap.get(route.id)||route;
    routeCtx.strokeStyle='rgba(3,8,16,.82)';routeCtx.lineWidth=zoom<2?3.6:4.4;drawPath(routeCtx,route.path,t);
    routeCtx.strokeStyle=lineColor(meta);const sameLine=state.selected&&state.selected.official_id===meta.official_id;routeCtx.globalAlpha=sameLine ? 0.7 : 0.48;routeCtx.lineWidth=zoom<2?1.8:2.4;drawPath(routeCtx,route.path,t);routeCtx.globalAlpha=1;
  }
  if(state.selected){
    const route=state.selected,path=route.paths?.detail||route.path;
    routeCtx.strokeStyle='rgba(3,8,16,.95)';routeCtx.lineWidth=10;drawPath(routeCtx,path,t);
    routeCtx.strokeStyle=lineColor(route);routeCtx.lineWidth=6;drawPath(routeCtx,path,t);
  }
  if(zoom>=1.7){
    for(const st of state.viewData.stations||[]){
      const [x,y]=worldToScreen(st.x,st.y,t);if(x<-10||y<-10||x>t.width+10||y>t.height+10)continue;
      const transfer=(st.route_nos||[]).length>1;
      labelCtx.beginPath();labelCtx.arc(x,y,transfer?4.2:2.5,0,Math.PI*2);labelCtx.fillStyle=st.estimated?'#ffd06f':'#f5f8ff';labelCtx.fill();labelCtx.strokeStyle='#07101d';labelCtx.lineWidth=1.5;labelCtx.stroke();
      if(zoom>=5||transfer)drawLabel(labelCtx,st.name,x+6,y-5,10,st.estimated?'#ffd98b':'#eaf2fc');
    }
  }
  if(state.selected){
    const stops=state.selected.stops||[];
    for(const [index,st] of stops.entries()){
      const [x,y]=worldToScreen(st.x,st.y,t);labelCtx.beginPath();labelCtx.arc(x,y,index===0||index===stops.length-1?5:3.5,0,Math.PI*2);labelCtx.fillStyle=st.estimated?'#ffd06f':'#fff';labelCtx.fill();labelCtx.strokeStyle='#07101d';labelCtx.lineWidth=1.8;labelCtx.stroke();
      if(zoom>=2.5||index===0||index===stops.length-1)drawLabel(labelCtx,st.name,x+7,y-5,11,st.estimated?'#ffd98b':'#eaf2fc');
    }
  }
}

function scheduleViewFetch(){clearTimeout(state.fetchTimer);state.fetchTimer=setTimeout(fetchView,100)}
async function fetchView(){
  if(!state.overview||!state.view)return;if(state.fetchController)state.fetchController.abort();state.fetchController=new AbortController();
  const v=state.view,z=currentZoom(),url=`/api/metro/network/view?minx=${v.x}&miny=${v.y}&maxx=${v.x+v.w}&maxy=${v.y+v.h}&zoom=${z}`;
  try{const r=await fetch(url,{signal:state.fetchController.signal});if(!r.ok)throw new Error();state.viewData=await r.json();render()}catch(error){if(error.name!=='AbortError')console.warn('metro view fetch failed')}
}
function zoomAt(screenX,screenY,factor){
  const t=transform(),[wx,wy]=screenToWorld(screenX,screenY,t),nextW=Math.max(state.homeView.w/35,Math.min(state.homeView.w*1.15,state.view.w/factor)),ratio=nextW/state.view.w,nextH=state.view.h*ratio;
  const rx=(wx-state.view.x)/state.view.w,ry=(wy-state.view.y)/state.view.h;state.view={x:wx-rx*nextW,y:wy-ry*nextH,w:nextW,h:nextH};scheduleViewFetch();render();
}
function distanceSegment(px,py,ax,ay,bx,by){const vx=bx-ax,vy=by-ay,den=vx*vx+vy*vy;if(!den)return Math.hypot(px-ax,py-ay);let t=((px-ax)*vx+(py-ay)*vy)/den;t=Math.max(0,Math.min(1,t));return Math.hypot(px-(ax+t*vx),py-(ay+t*vy))}
function hitRoute(screenX,screenY){
  const t=transform();let best=null,bestD=10;for(const route of routeSource()){
    const path=route.path;if(!path||path.length<2)continue;for(let i=0;i<path.length-1;i++){const a=worldToScreen(path[i][0],path[i][1],t),b=worldToScreen(path[i+1][0],path[i+1][1],t),d=distanceSegment(screenX,screenY,a[0],a[1],b[0],b[1]);if(d<bestD){bestD=d;best=route.id}}
  }return best;
}
async function selectRoute(id,fit=true){
  try{const route=await api(`/api/metro/network/route/${encodeURIComponent(id)}`);state.selected=route;renderRoutePanel(route);if(fit)fitRect(route.bbox,.2);else render();showToast(`${route.route_no} · ${route.direction_label}`)}catch(error){showToast(error.message)}
}
function renderRoutePanel(route){
  const score=Number(route.score||0);
  els.routeCard.innerHTML=`<h3><span style="display:inline-block;width:12px;height:12px;border-radius:50%;background:${escapeHtml(lineColor(route))};margin-right:7px"></span>${escapeHtml(route.route_no)} · ${escapeHtml(route.direction_label)}</h3><p>${escapeHtml(route.start_stop)} → ${escapeHtml(route.end_stop)}</p><p>${escapeHtml(route.operator||'深圳地铁')}</p><div><span class="badge ${escapeHtml(route.match_state||'matched')}">${escapeHtml(route.match_state||'matched')}</span> <span class="badge">匹配 ${Math.round(score*100)}%</span> <span class="badge">${route.stops.length} 站</span></div><p style="margin-top:12px"><a class="button primary" href="/metro/learn?route=${encodeURIComponent(route.id)}">进入拼音与粤语学习</a></p>`;
  els.stopList.innerHTML=route.stops.map((st,i)=>`<div class="stop-row" data-index="${i}"><span>${i+1}</span><strong>${escapeHtml(st.name)}</strong>${st.estimated?'<span class="estimated">近似</span>':'<span></span>'}</div>`).join('');
  els.stopList.querySelectorAll('[data-index]').forEach(node=>node.addEventListener('click',()=>{const st=route.stops[Number(node.dataset.index)];const width=state.homeView.w/14;fitRect([st.x-width/2,st.y-width/2,st.x+width/2,st.y+width/2],0);render()}));
}
function renderSearch(results){
  els.searchResults.innerHTML=results.length?results.map((r,i)=>`<div class="list-item" data-result="${i}"><strong>${escapeHtml(r.title)}</strong><p>${escapeHtml(r.subtitle)}</p></div>`).join(''):els.search.value?'<div class="empty">没有结果</div>':'';
  els.searchResults.querySelectorAll('[data-result]').forEach(node=>node.addEventListener('click',()=>{const r=results[Number(node.dataset.result)];els.searchResults.innerHTML='';if(r.type==='route')selectRoute(r.id,true);else if(r.route_ids?.length)selectRoute(r.route_ids[0],true)}));
}
els.search.addEventListener('input',()=>{clearTimeout(state.searchTimer);const q=els.search.value.trim();if(!q){els.searchResults.innerHTML='';return}state.searchTimer=setTimeout(async()=>{try{const data=await api(`/api/metro/search?q=${encodeURIComponent(q)}&limit=40`);renderSearch(data.results||[])}catch{}},180)});

els.stage.addEventListener('pointerdown',e=>{els.stage.setPointerCapture(e.pointerId);state.drag={x:e.clientX,y:e.clientY,view:{...state.view}};state.moved=false});
els.stage.addEventListener('pointermove',e=>{if(!state.drag)return;const dx=e.clientX-state.drag.x,dy=e.clientY-state.drag.y;if(Math.abs(dx)+Math.abs(dy)>3)state.moved=true;const t=transform();state.view={...state.drag.view,x:state.drag.view.x-dx/t.scale,y:state.drag.view.y-dy/t.scale};render()});
els.stage.addEventListener('pointerup',e=>{if(!state.drag)return;const moved=state.moved;state.drag=null;if(moved)scheduleViewFetch();else{const rect=els.stage.getBoundingClientRect(),id=hitRoute(e.clientX-rect.left,e.clientY-rect.top);if(id)selectRoute(id,false)}});
els.stage.addEventListener('pointercancel',()=>state.drag=null);
els.stage.addEventListener('wheel',e=>{e.preventDefault();const rect=els.stage.getBoundingClientRect();zoomAt(e.clientX-rect.left,e.clientY-rect.top,e.deltaY<0?1.22:1/1.22)},{passive:false});
els.home.addEventListener('click',()=>{state.selected=null;els.routeCard.innerHTML='<div class="empty">点击线路，或在上方搜索。</div>';els.stopList.innerHTML='';state.view={...state.homeView};scheduleViewFetch();render()});
els.zoomIn.addEventListener('click',()=>{const r=els.stage.getBoundingClientRect();zoomAt(r.width/2,r.height/2,1.35)});els.zoomOut.addEventListener('click',()=>{const r=els.stage.getBoundingClientRect();zoomAt(r.width/2,r.height/2,1/1.35)});
window.addEventListener('resize',resize);

(async function init(){
  try{
    const overview=await api('/api/metro/network/overview');state.overview=overview;state.routeMap=new Map(overview.routes.map(r=>[r.id,r]));
    els.networkMeta.textContent=`${overview.stats.lines} 条线路 · ${overview.stats.directions} 个方向 · ${overview.stats.station_clusters} 个站点簇 · 构建于 ${new Date(overview.built_at).toLocaleString()}`;
    els.topStatus.innerHTML=`线路 <b>${overview.stats.lines}</b> · 方向 <b>${overview.stats.directions}</b> · 站点簇 <b>${overview.stats.station_clusters}</b>`;
    resize();state.viewData={routes:overview.routes,stations:[]};fitHome();els.loading.classList.add('hidden');scheduleViewFetch();
  }catch(error){
    els.loadingTitle.textContent='尚未生成地铁线网';els.loadingText.innerHTML=`${escapeHtml(error.message)}<br><br><a class="button primary" href="/metro/collector">进入地铁采集与构建</a>`;els.networkMeta.textContent='需要先采集、复核并构建。';
  }
})();
