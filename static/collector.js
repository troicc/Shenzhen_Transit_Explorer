const $ = (selector) => document.querySelector(selector);
const state = {
  running:false, retry:false, processed:0, target:0, queueTotal:0,
  AMap:null, lineSearch:null, config:null, selectedReviewId:null
};

const els = {
  metricGrid:$('#metricGrid'), topStatus:$('#topStatus'), startBtn:$('#startBtn'), pauseBtn:$('#pauseBtn'),
  retryBtn:$('#retryBtn'), buildBtn:$('#buildBtn'), batchSize:$('#batchSize'), delayMs:$('#delayMs'),
  routeToken:$('#routeToken'), currentTitle:$('#currentTitle'), currentSubtitle:$('#currentSubtitle'),
  currentBadge:$('#currentBadge'), progressBar:$('#progressBar'), progressText:$('#progressText'),
  logBox:$('#logBox'), clearLogBtn:$('#clearLogBtn'), reviewList:$('#reviewList'), reviewDetail:$('#reviewDetail'),
  refreshReviewBtn:$('#refreshReviewBtn'), toast:$('#toast')
};

function showToast(message){ els.toast.textContent=message;els.toast.classList.add('show');setTimeout(()=>els.toast.classList.remove('show'),2200) }
function log(message, kind='info'){
  const time=new Date().toLocaleTimeString();
  const prefix=kind==='error'?'✕':kind==='ok'?'✓':kind==='warn'?'!':'·';
  els.logBox.textContent += `[${time}] ${prefix} ${message}\n`;
  els.logBox.scrollTop=els.logBox.scrollHeight;
}
function sleep(ms){ return new Promise(resolve=>setTimeout(resolve,ms)) }
function escapeHtml(value){return String(value??'').replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]))}
function badge(status){return `<span class="badge ${escapeHtml(status)}">${escapeHtml(status)}</span>`}

async function api(url, options={}){
  const response=await fetch(url,{headers:{'Content-Type':'application/json',...(options.headers||{})},...options});
  const data=await response.json().catch(()=>({}));
  if(!response.ok) throw new Error(data.detail||`HTTP ${response.status}`);
  return data;
}

function renderStats(stats){
  const rs=stats.route_status||{};
  const done=(rs.matched||0)+(rs.review||0)+(rs.failed||0)+(rs.no_data||0)+(rs.error||0);
  const metrics=[
    ['官方线路',stats.total_routes||0,''],['已完成查询',done,'ok'],['自动匹配',rs.matched||0,'ok'],
    ['待人工复核',rs.review||0,'warn'],['失败/无结果',(rs.failed||0)+(rs.no_data||0)+(rs.error||0),'bad']
  ];
  els.metricGrid.innerHTML=metrics.map(([label,value,cls])=>`<div class="metric ${cls}"><strong>${value}</strong><span>${label}</span></div>`).join('');
  els.topStatus.innerHTML=`数据：<b>${escapeHtml(stats.catalog?.source_date||'—')}</b> · 已查询 <b>${done}/${stats.total_routes||0}</b>${stats.network_exists?' · 全网已构建':''}`;
}

async function refreshStats(){const stats=await api('/api/status');renderStats(stats);return stats}

async function loadAmap(){
  if(state.AMap) return state.AMap;
  state.config=await api('/api/config');
  els.delayMs.value=state.config.default_delay_ms||1200;
  if(!state.config.ready){
    throw new Error('尚未配置 AMAP_JS_KEY 和 AMAP_SECURITY_CODE，请先编辑 .env 后重启。');
  }
  window._AMapSecurityConfig={securityJsCode:state.config.amap_security_code};
  state.AMap=await new Promise((resolve,reject)=>{
    const script=document.createElement('script');
    const timer=setTimeout(()=>reject(new Error('高德 JS API 加载超时。')),20000);
    script.src=`https://webapi.amap.com/maps?v=2.0&key=${encodeURIComponent(state.config.amap_js_key)}&plugin=AMap.LineSearch`;
    script.onload=()=>{clearTimeout(timer);window.AMap?resolve(window.AMap):reject(new Error('高德 JS API 未正确初始化。'))};
    script.onerror=()=>{clearTimeout(timer);reject(new Error('高德 JS API 加载失败，请检查 Key、域名白名单和网络。'))};
    document.head.appendChild(script);
  });
  state.lineSearch=new state.AMap.LineSearch({city:state.config.city||'深圳',pageIndex:1,pageSize:50,extensions:'all'});
  log('高德 LineSearch 插件已加载。','ok');
  return state.AMap;
}

function lngLat(point){
  if(!point) return null;
  if(Array.isArray(point)) return [Number(point[0]),Number(point[1])];
  const lng=typeof point.getLng==='function'?point.getLng():(point.lng??point.longitude);
  const lat=typeof point.getLat==='function'?point.getLat():(point.lat??point.latitude);
  if(!Number.isFinite(Number(lng))||!Number.isFinite(Number(lat))) return null;
  return [Number(lng),Number(lat)];
}
function normalizeCandidate(line){
  const path=(line.path||[]).map(lngLat).filter(Boolean);
  const rawStops=line.via_stops||line.viaStops||line.stops||[];
  const via_stops=rawStops.map(stop=>({
    id:String(stop.id||''), name:String(stop.name||''), location:lngLat(stop.location||stop.position)
  })).filter(stop=>stop.location);
  const first=via_stops[0]?.name||'';
  const last=via_stops.at(-1)?.name||'';
  return {
    id:String(line.id||''), name:String(line.name||''),
    start_stop:String(line.start_stop?.name||line.start_stop||line.startStop?.name||line.startStop||first),
    end_stop:String(line.end_stop?.name||line.end_stop||line.endStop?.name||line.endStop||last),
    company:String(line.company||''),type:String(line.type||''),distance:line.distance??null,path,via_stops
  };
}
function searchOnce(keyword){
  return new Promise(resolve=>{
    let settled=false;
    const timeout=setTimeout(()=>{if(!settled){settled=true;resolve({status:'error',result:{info:'查询超时'}})}},25000);
    state.lineSearch.search(keyword,(status,result)=>{
      if(settled)return;settled=true;clearTimeout(timeout);resolve({status,result:result||{}})
    });
  });
}
function variants(routeNo){
  const list=[String(routeNo).trim()];
  if(/^\d+$/.test(String(routeNo).trim())) list.push(`${routeNo}路`);
  return [...new Set(list.filter(Boolean))];
}
async function collectItem(item){
  els.routeToken.textContent=item.route_no;
  els.currentTitle.textContent=`${item.route_no} · ${item.start_stop} → ${item.end_stop}`;
  els.currentSubtitle.textContent=`${item.operator} · 第 ${item.query_attempts+1} 次尝试`;
  els.currentBadge.className='badge';els.currentBadge.textContent='查询中';
  let final={status:'no_data',result:{info:'NO_DATA'}};
  for(const keyword of variants(item.route_no)){
    log(`查询 ${item.route_no}，关键词“${keyword}”`);
    final=await searchOnce(keyword);
    const lineInfo=final.result?.lineInfo||final.result?.lineinfo||[];
    if(final.status==='complete' && Array.isArray(lineInfo) && lineInfo.length) break;
    if(!state.running) break;
    await sleep(Math.max(500,Number(els.delayMs.value)||1200));
  }
  const raw=final.result?.lineInfo||final.result?.lineinfo||[];
  const candidates=Array.isArray(raw)?raw.map(normalizeCandidate).filter(x=>x.path.length>=2):[];
  const status=final.status==='complete'&&candidates.length?'complete':final.status==='no_data'||!candidates.length?'no_data':'error';
  const saved=await api('/api/collector/result',{method:'POST',body:JSON.stringify({
    route_id:item.id,status,info:String(final.result?.info||status),candidates,
    error:status==='error'?String(final.result?.info||'高德查询错误'):null
  })});
  const result=saved.result;
  els.currentBadge.className=`badge ${result.query_status}`;els.currentBadge.textContent=result.query_status;
  if(result.matches?.length){
    const summary=result.matches.map(x=>`${x.direction}:${x.state} ${(x.score*100).toFixed(0)}%`).join(' / ');
    log(`${item.route_no} 保存 ${candidates.length} 个候选；${summary}`,result.query_status==='matched'?'ok':'warn');
  }else log(`${item.route_no} ${result.query_status}，候选 ${candidates.length}`,result.query_status==='error'?'error':'warn');
  renderStats(saved.stats);
}

function updateRoundProgress(){
  const pct=state.target?Math.min(100,state.processed/state.target*100):0;
  els.progressBar.style.width=`${pct}%`;els.progressText.textContent=`本轮 ${state.processed} / ${state.target}`;
}
async function runCollector(retry=false){
  if(state.running)return;
  try{await loadAmap()}catch(error){showToast(error.message);log(error.message,'error');return}
  state.running=true;state.retry=retry;state.processed=0;state.target=Math.max(1,Math.min(1000,Number(els.batchSize.value)||100));updateRoundProgress();
  els.startBtn.disabled=true;els.retryBtn.disabled=true;els.pauseBtn.disabled=false;
  log(`开始本轮采集：最多 ${state.target} 条，间隔 ${els.delayMs.value} ms${retry?'，包含失败项':''}。`,'ok');
  try{
    while(state.running&&state.processed<state.target){
      const remain=state.target-state.processed;
      const data=await api(`/api/collector/queue?limit=${Math.min(100,remain)}&retry=${retry?'true':'false'}`);
      const items=data.items||[];
      if(!items.length){log('队列已空。','ok');break}
      for(const item of items){
        if(!state.running||state.processed>=state.target)break;
        try{await collectItem(item)}catch(error){log(`${item.route_no} 保存失败：${error.message}`,'error')}
        state.processed++;updateRoundProgress();
        if(state.running)await sleep(Math.max(500,Number(els.delayMs.value)||1200));
      }
    }
  }finally{
    state.running=false;els.startBtn.disabled=false;els.retryBtn.disabled=false;els.pauseBtn.disabled=true;
    els.currentTitle.textContent='本轮结束';els.currentSubtitle.textContent=`已处理 ${state.processed} 条，可继续运行；已完成的线路不会重复查询。`;
    els.currentBadge.className='badge';els.currentBadge.textContent='空闲';
    await refreshStats();await refreshReview();
  }
}

async function refreshReview(){
  const data=await api('/api/collector/review?limit=300');const items=data.items||[];
  els.reviewList.innerHTML=items.length?items.map(item=>`<div class="list-item ${state.selectedReviewId===item.id?'active':''}" data-id="${item.id}"><strong>${escapeHtml(item.route_no)} ${badge(item.query_status)}</strong><p>${escapeHtml(item.start_stop)} → ${escapeHtml(item.end_stop)}</p></div>`).join(''):'<div class="empty">暂无待复核或失败项目。</div>';
  els.reviewList.querySelectorAll('[data-id]').forEach(node=>node.addEventListener('click',()=>openReview(Number(node.dataset.id))));
}
async function openReview(routeId){
  state.selectedReviewId=routeId;await refreshReview();
  els.reviewDetail.innerHTML='<div class="empty">正在读取候选…</div>';
  const item=await api(`/api/collector/item/${routeId}`);const route=item.route;
  if(!item.candidates?.length){
    els.reviewDetail.innerHTML=`<h3>${escapeHtml(route.route_no)}</h3><p style="color:var(--muted);font-size:12px">${escapeHtml(route.last_error||'没有高德候选')}</p><button id="resetOne" class="button warn">重新加入采集队列</button>`;
    $('#resetOne')?.addEventListener('click',async()=>{await api('/api/collector/reset',{method:'POST',body:JSON.stringify({statuses:[route.query_status]})});showToast('已重置同状态项目');await refreshReview()});
    return;
  }
  const directionBlocks=(route.directions||[]).map(direction=>{
    const scores=item.candidate_scores?.[direction.direction]||[];
    const cards=item.candidates.map((candidate,index)=>{
      const score=scores.find(x=>x.index===index)?.score||{};
      return `<div class="candidate"><h4>#${index+1} ${escapeHtml(candidate.name||'未命名')}</h4><p>${escapeHtml(candidate.start_stop)} → ${escapeHtml(candidate.end_stop)}</p><p>${candidate.via_stops?.length||0} 站 · ${candidate.path?.length||0} 个折线点</p><div class="score-row"><span class="badge">总分 ${Math.round((score.total||0)*100)}%</span><span class="badge">端点 ${Math.round((score.endpoint||0)*100)}%</span><span class="badge">站序 ${Math.round((score.stations||0)*100)}%</span></div><div class="candidate-actions"><button data-choose="${direction.direction}" data-index="${index}">设为${escapeHtml(direction.label)}</button></div></div>`
    }).join('');
    return `<section><h3 style="margin:12px 0 4px">${escapeHtml(direction.label)}：${escapeHtml(direction.start_stop)} → ${escapeHtml(direction.end_stop)}</h3>${cards}</section>`
  }).join('');
  els.reviewDetail.innerHTML=`<h2 style="margin:0">${escapeHtml(route.route_no)}</h2><p style="color:var(--muted);font-size:11px">${escapeHtml(route.operator)}</p>${directionBlocks}`;
  els.reviewDetail.querySelectorAll('[data-choose]').forEach(button=>button.addEventListener('click',async()=>{
    await api('/api/collector/choose',{method:'POST',body:JSON.stringify({route_id:routeId,direction:button.dataset.choose,candidate_index:Number(button.dataset.index)})});
    showToast('候选已指定');await refreshStats();await openReview(routeId);
  }));
}

els.startBtn.addEventListener('click',()=>runCollector(false));
els.retryBtn.addEventListener('click',()=>runCollector(true));
els.pauseBtn.addEventListener('click',()=>{state.running=false;log('已请求暂停，将在当前线路保存后停止。','warn')});
els.clearLogBtn.addEventListener('click',()=>els.logBox.textContent='');
els.refreshReviewBtn.addEventListener('click',refreshReview);
els.buildBtn.addEventListener('click',async()=>{
  els.buildBtn.disabled=true;log('开始编译固定坐标、三级 LOD 和站点聚合…');
  try{const data=await api('/api/build',{method:'POST'});log(`构建完成：${data.result.directions} 个方向，${data.result.station_clusters} 个站点簇，${(data.result.size_bytes/1024/1024).toFixed(1)} MB。`,'ok');showToast('全网构建完成');await refreshStats()}
  catch(error){log(`构建失败：${error.message}`,'error');showToast(error.message)}finally{els.buildBtn.disabled=false}
});

(async function init(){
  els.pauseBtn.disabled=true;
  try{const stats=await refreshStats();await refreshReview();const cfg=await api('/api/config');if(!cfg.ready)log('请先在 .env 配置高德 Web JS Key 和安全密钥。','warn');else log('配置已读取，点击“开始 / 继续”后加载高德 API。','ok')}
  catch(error){log(error.message,'error')}
})();
