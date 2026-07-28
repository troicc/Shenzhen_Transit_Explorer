function pushUndo(label="编辑"){
  const line=currentLine();
  if(!line)return;
  state.undoStack.push({
    label,lineId:line.id,d:line.d,bbox:[...line.bbox],stations:line.stations.map(s=>({
      progress:s.progress,x:s.x,y:s.y
    }
    ))
  }
  );
  if(state.undoStack.length>20)state.undoStack.shift();
}
function undoReview(){
  const item=state.undoStack.pop();
  if(!item){
    showToast("没有可撤销的改动");
    return
  }
  const line=lineMap.get(item.lineId);
  if(!line)return;
  line.d=item.d;
  line.bbox=item.bbox;
  line.stations.forEach((s,i)=>Object.assign(s,item.stations[i]));
  balancedCache.clear();
  if(state.selectedLineId!==line.id)state.selectedLineId=line.id;
  renderAll();
  saveLocalReview(true);
  showToast(`已撤销：${item.label}`);
}
function beginStationDrag(line,index,e){
  pushUndo(`移动 ${line.stations[index].name}`);
  setCurrentByOriginalIndex(index);
  state.dragStation={lineId:line.id,index};
  state.pointerId=e.pointerId;
  state.dragMoved=true;
  state.draggingMap=false;
  mapSvg.setPointerCapture?.(e.pointerId);
  document.body.classList.add("is-panning","is-editing-geometry");
}
function updateStationNodePosition(line,index,point){
  const node=stationNodeMap.get(`${line.id}:${index}`);
  if(!node)return false;
  node.querySelectorAll("circle").forEach(circle=>{
    circle.setAttribute("cx",point.x);
    circle.setAttribute("cy",point.y);
  });
  return true;
}
function updateAllSelectedStationPositions(line){
  line.stations.forEach((st,index)=>{
    if(st.transfer)return;
    updateStationNodePosition(line,index,{x:st.x,y:st.y});
  });
}
function updateReviewMarker(point){
  const marker=reviewLayer.querySelector(".review-selected-station");
  if(marker){
    marker.setAttribute("cx",point.x);
    marker.setAttribute("cy",point.y);
  }else renderReviewLayer();
}
function updateReviewLive(station){
  if(!state.reviewOpen||!station)return;
  document.getElementById("reviewCoords").textContent=`x ${station.x.toFixed(1)} · y ${station.y.toFixed(1)}`;
  document.getElementById("reviewProgress").value=Math.round(station.progress*10000);
  document.getElementById("reviewProgressValue").textContent=`${(station.progress*100).toFixed(2)}%`;
}
function applyStationDrag(point){
  const drag=state.dragStation;
  if(!drag)return;
  const line=lineMap.get(drag.lineId),st=line.stations[drag.index];
  const projected=projectToPolyline(line,point.x,point.y);
  const total=getPathGeometry(line)?.total||600;
  const minGap=Math.min(.015,6/Math.max(1,total));
  const prev=drag.index?line.stations[drag.index-1].progress+minGap:0;
  const next=drag.index<line.stations.length-1?line.stations[drag.index+1].progress-minGap:1;
  st.progress=clamp(projected.progress,prev,next);
  const p=pointAtProgress(line,st.progress);
  st.x=Number(p.x.toFixed(2));
  st.y=Number(p.y.toFixed(2));
  state.trainProgress=st.progress;
  balancedCache.clear();
  updateStationNodePosition(line,drag.index,p);
  renderProgressPath();
  positionTrain();
  updateReviewMarker(p);
  updateReviewLive(st);
}
function applyVertexDrag(point){
  if(state.dragVertex===null||!currentLine())return;
  const line=currentLine();
  const pts=state.dragVertexPoints||parsePathPoints(line.d);
  pts[state.dragVertex]={x:point.x,y:point.y};
  state.dragVertexPoints=pts;
  line.d=pointsToPath(pts);
  invalidateLineGeometry(line.id);
  const group=routeGroupMap.get(line.id)||routeLayer.querySelector(`[data-line="${line.id}"]`);
  group?.querySelectorAll("path").forEach(path=>path.setAttribute("d",line.d));
  const color=group?.querySelector(".route-color");
  if(color)pathMap.set(line.id,color);
  recomputeLineStations(line);
  balancedCache.clear();
  updateAllSelectedStationPositions(line);
  renderTransferHubs();
  renderProgressPath();
  positionTrain();
  const handle=reviewLayer.querySelector(`[data-index="${state.dragVertex}"]`);
  if(handle){
    handle.setAttribute("x",point.x-4);
    handle.setAttribute("y",point.y-4);
    const label=handle.parentElement?.querySelector("text");
    if(label){label.setAttribute("x",point.x+6);label.setAttribute("y",point.y-6);}
  }
  const original=originalIndexFromDisplay();
  const current=line.stations[original];
  updateReviewMarker({x:current.x,y:current.y});
  updateReviewLive(current);
}
function recomputeLineStations(line){
  line.stations.forEach(st=>{
    const p=pointAtProgress(line,st.progress);
    st.x=Number(p.x.toFixed(2));
    st.y=Number(p.y.toFixed(2))
  }
  );
  const pts=parsePathPoints(line.d);
  if(pts.length){
    const xs=pts.map(p=>p.x),ys=pts.map(p=>p.y);
    line.bbox=[Math.min(...xs),Math.min(...ys),Math.max(...xs),Math.max(...ys)]
  }
}
function snapCurrentLine(){
  const line=currentLine();
  if(!line)return;
  pushUndo("站点贴线");
  const total=getPathGeometry(line)?.total||600,minGap=Math.min(.014,7/total);
  let previous=0;
  line.stations.forEach((st,i)=>{
    const projected=projectToPolyline(line,st.x,st.y);
    const upper=i===line.stations.length-1?1:1-(line.stations.length-1-i)*minGap;
    st.progress=clamp(projected.progress,i?previous+minGap:0,upper);
    previous=st.progress;
    const p=pointAtProgress(line,st.progress);
    st.x=Number(p.x.toFixed(2));
    st.y=Number(p.y.toFixed(2));
  }
  );
  balancedCache.clear();
  renderAll();
  saveLocalReview(true);
  showToast("已将本线站点贴合到线路并保持顺序");
}
function evenlySpaceCurrentLine(){
  const line=currentLine();
  if(!line)return;
  pushUndo("均匀站距");
  const anchors=[0];
  line.stations.forEach((s,i)=>{
    if(i>0&&i<line.stations.length-1&&s.transfer)anchors.push(i)
  }
  );
  anchors.push(line.stations.length-1);
  for(let a=0;
  a<anchors.length-1;
  a++){
    const left=anchors[a],right=anchors[a+1],p0=line.stations[left].progress,p1=line.stations[right].progress;
    for(let i=left+1;
    i<right;
    i++)line.stations[i].progress=p0+(p1-p0)*(i-left)/(right-left);
  }
  recomputeLineStations(line);
  balancedCache.clear();
  renderAll();
  saveLocalReview(true);
  showToast("已按端点与换乘点分段均匀排布");
}
function updateStationProgress(value){
  const line=currentLine(),st=currentStation();
  if(!line||!st)return;
  const original=originalIndexFromDisplay();
  const total=getPathGeometry(line)?.total||600;
  const minGap=Math.min(.015,6/total);
  const prev=original?line.stations[original-1].progress+minGap:0;
  const next=original<line.stations.length-1?line.stations[original+1].progress-minGap:1;
  st.progress=clamp(value,prev,next);
  const p=pointAtProgress(line,st.progress);
  st.x=p.x;st.y=p.y;
  state.trainProgress=st.progress;
  balancedCache.clear();
  updateStationNodePosition(line,original,p);
  renderTransferHubs();
  renderLabels();
  updateStationStates();
  renderFocusCard();
  renderStationCard();
  renderPractice();
  renderModes();
  renderProgressPath();
  positionTrain();
  updateReviewMarker(p);
  renderReviewPanel(false);
}
function stationSpacingStats(line){
  const geometry=getPathGeometry(line);
  if(!geometry)return {min:0,max:0};
  const total=geometry.total,gaps=[];
  for(let i=1;
  i<line.stations.length;
  i++)gaps.push((line.stations[i].progress-line.stations[i-1].progress)*total);
  return {
    min:Math.min(...gaps),max:Math.max(...gaps)
  }
  ;
}
function renderReviewPanel(loadAudio=true){
  const drawer=document.getElementById("reviewDrawer");
  drawer.classList.toggle("visible",state.reviewOpen);
  if(!state.reviewOpen)return;
  const select=document.getElementById("reviewLineSelect");
  if(select.options.length!==LINES.length){
    select.innerHTML="";
    LINES.forEach(line=>{
      const o=document.createElement("option");
      o.value=line.id;
      o.textContent=line.name;
      select.appendChild(o)
    }
    )
  }
  if(!state.selectedLineId){
    document.getElementById("reviewStationName").textContent="先选择线路";
    return
  }
  const line=currentLine(),st=currentStation();
  select.value=line.id;
  document.getElementById("reviewStationName").textContent=st.name;
  document.getElementById("reviewStationNo").textContent=`第 ${state.currentIndex+1}/${displayStations().length} 站`;
  document.getElementById("reviewCoords").textContent=`x ${st.x.toFixed(1)} · y ${st.y.toFixed(1)}`;
  const pinyinInput=document.getElementById("reviewPinyin");
  if(document.activeElement!==pinyinInput)pinyinInput.value=st.pinyin||"";
  document.getElementById("reviewProgress").value=Math.round(st.progress*10000);
  document.getElementById("reviewProgressValue").textContent=`${(st.progress*100).toFixed(2)}%`;
  const note=document.getElementById("reviewNote");
  if(document.activeElement!==note)note.value=st.reviewNote||"";
  const urlInput=document.getElementById("reviewAudioUrl");
  if(document.activeElement!==urlInput)urlInput.value=st.audioUrl||"";
  document.getElementById("verticesToggle").checked=state.showVertices;
  document.querySelectorAll("[data-status]").forEach(btn=>btn.classList.toggle("active",btn.dataset.status===(st.reviewStatus||"unreviewed")));
  const confirmed=line.stations.filter(s=>s.reviewStatus==="confirmed").length,pct=line.stations.length?Math.round(confirmed/line.stations.length*100):0;
  document.getElementById("reviewCount").innerHTML=`<span>本线已确认 ${confirmed}/${line.stations.length}</span><span>${pct}%</span>`;
  document.getElementById("reviewProgressBar").style.width=`${pct}%`;
  const spacing=stationSpacingStats(line);
  document.getElementById("spacingStats").textContent=`站距：最小 ${spacing.min.toFixed(0)} px · 最大 ${spacing.max.toFixed(0)} px`;
  if(loadAudio)refreshReviewAudioStatus(st.name);
}
function renderReviewLayer(){
  reviewLayer.innerHTML="";
  if(!state.reviewOpen||!currentLine())return;
  const line=currentLine(),original=originalIndexFromDisplay(),p=pointAtProgress(line,line.stations[original].progress);
  reviewLayer.appendChild(svgEl("circle",{
    class:"review-selected-station",cx:p.x,cy:p.y,r:9
  }
  ));
  if(!state.showVertices)return;
  parsePathPoints(line.d).forEach((point,i)=>{
    const g=svgEl("g"),h=svgEl("rect",{
      class:"review-handle",x:point.x-4,y:point.y-4,width:8,height:8,rx:2,"data-index":i
    }
    );
    h.addEventListener("pointerdown",e=>{
      e.preventDefault();
      e.stopPropagation();
      pushUndo(`移动线路折点 ${i+1}`);
      state.dragVertex=i;
      state.dragVertexPoints=parsePathPoints(line.d);
      state.draggingMap=false;
      state.pointerId=e.pointerId;
      mapSvg.setPointerCapture?.(e.pointerId);
      document.body.classList.add("is-panning","is-editing-geometry");
    }
    );
    const t=svgEl("text",{
      class:"review-handle-index",x:point.x+6,y:point.y-6
    }
    );
    t.textContent=i+1;
    g.append(h,t);
    reviewLayer.appendChild(g);
  }
  );
}
function saveLocalReview(silent=false){
  try{
    localStorage.setItem("zhanyue-review-v3-2026-07-27-144c9e115c",JSON.stringify(DATA));
    if(!silent)showToast("校核数据已保存到本浏览器")
  }
  catch(e){
    if(!silent)showToast("本地保存失败，请使用导出 JSON")
  }
}
function loadLocalReview(){
  try{
    const raw=localStorage.getItem("zhanyue-review-v3-2026-07-27-144c9e115c");
    if(!raw)return;
    const parsed=JSON.parse(raw);
    if(parsed&&Array.isArray(parsed.lines)){
      DATA=parsed;
      LINES=DATA.lines;
      rebuildIndexes()
    }
  }
  catch(e){
  }
}
function exportReviewData(){
  DATA.reviewExportedAt=new Date().toISOString();
  DATA.version="3.0-interaction-review";
  const blob=new Blob([JSON.stringify(DATA,null,2)],{
    type:"application/json"
  }
  ),a=document.createElement("a");
  a.href=URL.createObjectURL(blob);
  a.download="zhanyue-reviewed-routes-v3.json";
  a.click();
  setTimeout(()=>URL.revokeObjectURL(a.href),1000);
  showToast("已导出校核 JSON");
}
function replaceImportedData(parsed){
  if(!parsed||!Array.isArray(parsed.lines))throw new Error("invalid");
  DATA=parsed;
  LINES=DATA.lines;
  rebuildIndexes();
  if(!lineMap.has(state.selectedLineId))state.selectedLineId=null;
  state.currentIndex=0;
  renderAll();
}
function openAudioDB(){
  return new Promise((resolve,reject)=>{
    const request=indexedDB.open("zhanyue-audio-v1",1);
    request.onupgradeneeded=()=>{
      const db=request.result;
      if(!db.objectStoreNames.contains("stationAudio"))db.createObjectStore("stationAudio",{
        keyPath:"name"
      }
      )
    }
    ;
    request.onsuccess=()=>resolve(request.result);
    request.onerror=()=>reject(request.error);
  }
  );
}
async function putStationAudio(name,file){
  const db=await openAudioDB();
  await new Promise((resolve,reject)=>{
    const tx=db.transaction("stationAudio","readwrite");
    tx.objectStore("stationAudio").put({
      name,blob:file,filename:file.name,type:file.type,size:file.size,updatedAt:new Date().toISOString()
    }
    );
    tx.oncomplete=resolve;
    tx.onerror=()=>reject(tx.error)
  }
  );
  db.close();
}
async function getStationAudio(name){
  const db=await openAudioDB();
  const result=await new Promise((resolve,reject)=>{
    const tx=db.transaction("stationAudio","readonly"),req=tx.objectStore("stationAudio").get(name);
    req.onsuccess=()=>resolve(req.result||null);
    req.onerror=()=>reject(req.error)
  }
  );
  db.close();
  return result;
}
async function deleteStationAudio(name){
  const db=await openAudioDB();
  await new Promise((resolve,reject)=>{
    const tx=db.transaction("stationAudio","readwrite");
    tx.objectStore("stationAudio").delete(name);
    tx.oncomplete=resolve;
    tx.onerror=()=>reject(tx.error)
  }
  );
  db.close();
}
function applyAudioUrlToName(name,url){
  (stationOccurrences.get(name)||[]).forEach(item=>{
    item.station.audioUrl=url
  }
  );
}
async function refreshReviewAudioStatus(name){
  const el=document.getElementById("reviewAudioStatus");
  el.textContent="正在读取本机音频…";
  try{
    const record=await getStationAudio(name);
    if(currentStation()?.name!==name)return;
    const url=currentStation()?.audioUrl;
    el.textContent=record?`本机音频：${record.filename}`:(url?"已设置在线音频 URL":"未设置自定义音频，将使用系统粤语语音");
  }
  catch(e){
    el.textContent="浏览器未开放音频存储，将使用系统语音"
  }
}
function stopCurrentPlayback(){
  if(currentAudio){
    currentAudio.pause();
    currentAudio.src="";
    currentAudio=null
  }
  if(currentAudioUrl){
    URL.revokeObjectURL(currentAudioUrl);
    currentAudioUrl=null
  }
  if("speechSynthesis" in window)speechSynthesis.cancel();
}
function playHtmlAudio(source){
  return new Promise((resolve,reject)=>{
    const audio=new Audio(source);
    currentAudio=audio;
    audio.onended=()=>{
      currentAudio=null;
      resolve()
    }
    ;
    audio.onerror=()=>{
      currentAudio=null;
      reject(new Error("audio"))
    }
    ;
    audio.play().catch(reject);
  }
  );
}
function speakWithSystem(name){
  return new Promise((resolve,reject)=>{
    if(!("speechSynthesis" in window)){
      reject(new Error("speech"));
      return
    }
    speechSynthesis.cancel();
    const utter=new SpeechSynthesisUtterance(name),voices=speechSynthesis.getVoices();
    utter.voice=voices.find(v=>/^(yue|zh-HK)/i.test(v.lang)||/Cantonese|Hong Kong|粤语|廣東話/i.test(v.name))||voices.find(v=>/^zh/i.test(v.lang))||voices[0]||null;
    utter.lang=utter.voice?.lang||"zh-HK";
    utter.rate=.82;
    utter.onend=resolve;
    utter.onerror=reject;
    speechSynthesis.speak(utter);
    setTimeout(resolve,7000);
  }
  );
}
async function playStationAudio(station,{
  silent=false
}
={
}
){
  stopCurrentPlayback();
  try{
    if(station.audioUrl){
      await playHtmlAudio(station.audioUrl)
    }
    else{
      const record=await getStationAudio(station.name);
      if(record?.blob){
        currentAudioUrl=URL.createObjectURL(record.blob);
        await playHtmlAudio(currentAudioUrl);
        URL.revokeObjectURL(currentAudioUrl);
        currentAudioUrl=null
      }
      else await speakWithSystem(station.name);
    }
    if(!silent)showToast(`正在播报：${station.name}`);
  }
  catch(e){
    if(station.audioUrl){
      try{
        await speakWithSystem(station.name)
      }
      catch(_){
      }
    }
    if(!silent)showToast("自定义音频无法播放，已尝试系统语音");
  }
}
function delay(ms){
  return new Promise(resolve=>setTimeout(resolve,ms))
}
async function startBroadcast(){
  if(!currentLine())return;
  stopTimer();
  state.broadcasting=true;
  const token=++state.broadcastToken;
  state.currentIndex=0;
  state.answerLocked=true;
  const firstOriginal=originalIndexFromDisplay(0);
  state.trainProgress=visualProgress(currentLine(),firstOriginal);
  renderDynamic();
  for(let i=0;
  i<displayStations().length;
  i++){
    if(token!==state.broadcastToken||!state.broadcasting)break;
    state.currentIndex=i;
    const original=originalIndexFromDisplay(i),target=visualProgress(currentLine(),original);
    if(i>0)await animateTrain(target,430);
    else state.trainProgress=target;
    renderDynamic();
    await playStationAudio(currentStation(),{
      silent:true
    }
    );
    await delay(260);
  }
  if(token===state.broadcastToken){
    state.broadcasting=false;
    state.answerLocked=false;
    renderFocusCard();
    showToast("全线播报完成")
  }
}
function stopBroadcast(silent=false){
  if(!state.broadcasting&&!currentAudio)return;
  state.broadcasting=false;
  state.broadcastToken+=1;
  state.answerLocked=false;
  stopCurrentPlayback();
  renderFocusCard();
  if(!silent)showToast("已停止全线播报");
}
