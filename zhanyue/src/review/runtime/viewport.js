const reducedMotionQuery=window.matchMedia("(prefers-reduced-motion: reduce)");
const FLIP_DURATION=760;
const OVERVIEW_TRANSITION_DURATION=780;
function isOverviewFlipped(){
  return document.body.classList.contains("map-overview-flipped");
}
function beginMapNavigation(){
  clearTimeout(state.navigationStopTimer);
  const body=document.body;
  if(!body.classList.contains("is-map-navigating")){
    if(state.viewAnimationRAF){
      state.viewAnimationToken++;
      cancelAnimationFrame(state.viewAnimationRAF);
      state.viewAnimationRAF=0;
      body.classList.remove("is-view-animating");
    }
    commitView();
    body.classList.add("is-map-navigating");
  }
}
function scheduleMapNavigationEnd(delay=90){
  clearTimeout(state.navigationStopTimer);
  state.navigationStopTimer=setTimeout(()=>{
    commitView();
    document.body.classList.remove("is-map-navigating");
    const shouldReturn=state.pendingOverviewReturn&&state.selectedLineId&&state.view.w>=state.overviewView.w*.955;
    state.pendingOverviewReturn=false;
    if(shouldReturn){
      clearSelection();
      showToast("已返回全网总览");
    }
  },delay);
}
function resetWheelAccumulator(){
  state.wheelPanX=0;
  state.wheelPanY=0;
  state.wheelZoomDelta=0;
  state.wheelZoomingOut=false;
}
function setMapFlipped(flipped,instant=false){
  clearTimeout(state.flipTimer);
  const body=document.body;
  const current=body.classList.contains("map-overview-flipped");
  if(current===flipped&&!body.classList.contains("map-flipping"))return;
  if(instant||reducedMotionQuery.matches){
    body.classList.add("map-flip-instant");
    body.classList.toggle("map-overview-flipped",flipped);
    body.classList.remove("map-flipping");
    requestAnimationFrame(()=>body.classList.remove("map-flip-instant"));
    return;
  }
  body.classList.add("map-flipping");
  requestAnimationFrame(()=>body.classList.toggle("map-overview-flipped",flipped));
  state.flipTimer=setTimeout(()=>body.classList.remove("map-flipping"),FLIP_DURATION+45);
}
function renderNavigationShell(){
  renderRoutes();
  renderLineStrip();
  renderFocusCard();
  renderStationCard();
  renderPractice();
  renderModes();
  renderReviewPanel();
  updateHeroFade();
}
function scheduleFullRender(delay=0){
  clearTimeout(state.deferredRenderTimer);
  if(delay<=0){
    renderAll();
    return;
  }
  state.deferredRenderTimer=setTimeout(()=>{
    state.deferredRenderTimer=0;
    renderAll();
  },delay);
}
function selectLine(lineId,focus=true,originalIndex=0){
  const enteringFromOverview=!state.selectedLineId;
  stopTimer();
  stopBroadcast(true);
  state.selectedLineId=lineId;
  state.reverse=false;
  state.currentIndex=clamp(originalIndex,0,lineMap.get(lineId).stations.length-1);
  state.selectedStationName=lineMap.get(lineId).stations[state.currentIndex].name;
  state.trainProgress=state.balancedSpacing?balancedProgresses(lineMap.get(lineId))[state.currentIndex]:lineMap.get(lineId).stations[state.currentIndex].progress;
  state.correct=0;
  state.attempts=0;
  state.seconds=30;
  state.lastValidInput="";
  state.answerLocked=false;
  hero.classList.add("hidden");
  if(enteringFromOverview){
    setMapFlipped(false);
    renderNavigationShell();
    if(focus)fitSelectedLine(OVERVIEW_TRANSITION_DURATION,()=>renderAll());
    else scheduleFullRender(FLIP_DURATION+30);
    return;
  }
  renderAll();
  if(focus)fitSelectedLine(520);
}
function clearSelection(){
  stopTimer();
  stopBroadcast(true);
  resetWheelAccumulator();
  state.pendingOverviewReturn=false;
  document.body.classList.remove("is-map-navigating");
  state.selectedLineId=null;
  state.currentIndex=0;
  state.selectedStationName=null;
  state.mode="overview";
  state.running=false;
  state.showVertices=false;
  document.body.classList.remove("practice-on");
  hero.classList.remove("hidden");
  if(!state.reviewOpen)setMapFlipped(true);
  renderNavigationShell();
  animateView(state.overviewView,OVERVIEW_TRANSITION_DURATION,()=>renderAll());
}
function fitSelectedLine(duration=430,onComplete=null){
  const line=currentLine();
  if(!line){
    if(onComplete)onComplete();
    return;
  }
  const [minX,minY,maxX,maxY]=line.bbox;
  const padX=Math.max(55,(maxX-minX)*.11),padY=Math.max(48,(maxY-minY)*.19);
  let x=minX-padX,y=minY-padY,w=maxX-minX+padX*2,h=maxY-minY+padY*2;
  const viewRatio=state.overviewView.w/state.overviewView.h,boxRatio=w/h;
  if(boxRatio>viewRatio){
    const targetH=w/viewRatio;
    y-=(targetH-h)/2;
    h=targetH;
  }else{
    const targetW=h*viewRatio;
    x-=(targetW-w)/2;
    w=targetW;
  }
  // Reserve visual room for the unified bottom dock without changing route geometry.
  const dockShiftPx=state.mode==="overview"?72:42;
  y+=h*dockShiftPx/Math.max(520,mapStage.clientHeight);
  animateView({x,y,w,h},duration,onComplete);
}
function easeInOutCubic(p){
  return p<.5?4*p*p*p:1-Math.pow(-2*p+2,3)/2;
}
function animateView(target,duration=430,onComplete=null){
  const token=++state.viewAnimationToken;
  if(state.viewAnimationRAF)cancelAnimationFrame(state.viewAnimationRAF);
  commitView();
  const start={...state.view};
  if(reducedMotionQuery.matches||duration<=0){
    state.view={...target};
    commitView();
    document.body.classList.remove("is-view-animating");
    if(onComplete)onComplete();
    return;
  }
  const t0=performance.now();
  document.body.classList.add("is-view-animating");
  function frame(now){
    if(token!==state.viewAnimationToken)return;
    const p=Math.min(1,(now-t0)/duration),e=easeInOutCubic(p);
    state.view={
      x:start.x+(target.x-start.x)*e,
      y:start.y+(target.y-start.y)*e,
      w:start.w+(target.w-start.w)*e,
      h:start.h+(target.h-start.h)*e
    };
    applyView();
    if(p<1)state.viewAnimationRAF=requestAnimationFrame(frame);
    else{
      state.viewAnimationRAF=0;
      commitView();
      document.body.classList.remove("is-view-animating");
      if(onComplete)onComplete();
    }
  }
  state.viewAnimationRAF=requestAnimationFrame(frame);
}
function applyView(){
  const base=committedView,v=state.view;
  const sx=base.w/Math.max(.0001,v.w),sy=base.h/Math.max(.0001,v.h);
  const tx=base.x-v.x*sx,ty=base.y-v.y*sy;
  if(Math.abs(sx-1)<1e-6&&Math.abs(sy-1)<1e-6&&Math.abs(tx)<1e-5&&Math.abs(ty)<1e-5){
    mapFlipStage.removeAttribute("transform");
  }else{
    mapFlipStage.setAttribute("transform",`matrix(${sx} 0 0 ${sy} ${tx} ${ty})`);
  }
  updateHeroFade();
}
function commitView(){
  const v=state.view;
  const changed=Math.abs(committedView.x-v.x)>1e-7||Math.abs(committedView.y-v.y)>1e-7||Math.abs(committedView.w-v.w)>1e-7||Math.abs(committedView.h-v.h)>1e-7;
  if(changed)mapSvg.setAttribute("viewBox",`${v.x} ${v.y} ${v.w} ${v.h}`);
  committedView={...v};
  if(mapFlipStage.hasAttribute("transform"))mapFlipStage.removeAttribute("transform");
  updateHeroFade();
}
function updateHeroFade(){
  if(hero.classList.contains("hidden")){
    if(hero.style.opacity||hero.style.transform){hero.style.opacity="";hero.style.transform="";}
    return;
  }
  const ov=state.overviewView;
  if(!ov)return;
  const zoom=ov.w/state.view.w;
  const t=clamp((zoom-1)/0.9,0,1);
  hero.style.opacity=String(1-0.94*t);
  hero.style.transform=`translate(-50%,-50%) scale(${(1+0.18*t).toFixed(3)})`;
}
function renderFocusCard(){
  const line=currentLine(),visible=!!line&&state.mode==="overview"&&!state.reviewOpen;
  focusCard.classList.toggle("visible",visible);
  stationCard.classList.toggle("visible",visible);
  lineInfoDock.classList.toggle("visible",visible);
  document.body.classList.toggle("line-detail-dock-on",visible);
  document.body.classList.toggle("has-line-selection",!!line);
  if(!line)return;
  const stations=displayStations();
  document.getElementById("lineBadge").textContent=codeFor(line);
  document.getElementById("lineBadge").style.background=line.color;
  document.getElementById("focusLineName").textContent=line.name;
  document.getElementById("focusTerminals").textContent=`${stations[0].name} → ${stations.at(-1).name}`;
  document.getElementById("lineMeta").textContent=`${stations.length} 站 · ${stations.filter(s=>s.transfer).length} 个换乘站`;
  document.getElementById("forwardBtn").classList.toggle("active",!state.reverse);
  document.getElementById("reverseBtn").classList.toggle("active",state.reverse);
  document.getElementById("allLabelsToggle").checked=state.showAllLabels;
  document.getElementById("balancedToggle").checked=state.balancedSpacing;
  const broadcastBtn=document.getElementById("broadcastBtn");
  broadcastBtn.textContent=state.broadcasting?"■ 停止播报":"▶ 全线播报";
  broadcastBtn.classList.toggle("active",state.broadcasting);
}
function renderStationCard(){
  const line=currentLine(),st=currentStation();
  if(!line||!st)return;
  state.selectedStationName=st.name;
  document.getElementById("stationName").textContent=st.name;
  document.getElementById("stationSubtitle").textContent=`${line.name}第 ${state.currentIndex+1} 站 · ${st.transfer?"换乘站":"普通站"}`;
  document.getElementById("stationPinyin").textContent=`拼音：${st.pinyin||"待校核"}`;
  const box=document.getElementById("stationLines");
  box.innerHTML="";
  (stationOccurrences.get(st.name)||[]).forEach(item=>{
    const chip=document.createElement("span");
    chip.className="mini-line";
    chip.style.background=item.line.color;
    chip.textContent=item.line.name;
    box.appendChild(chip);
  }
  );
}
function positionTrain(progress=state.trainProgress){
  const line=currentLine();
  if(!line){
    train.setAttribute("opacity","0");
    return;
  }
  const geometry=getPathGeometry(line);
  if(!geometry)return;
  const p=geometry.path.getPointAtLength(clamp(progress,0,1)*geometry.total);
  train.setAttribute("transform",`translate(${p.x} ${p.y})`);
  train.setAttribute("opacity","1");
  train.querySelector(".train-body").setAttribute("fill",line.color);
}
function updateProgressPathPosition(progress=state.trainProgress){
  const line=currentLine();
  if(!line||state.mode==="overview")return;
  const selectedGroup=routeGroupMap.get(line.id);
  const progressPath=selectedGroup&&selectedGroup.querySelector(".route-progress");
  if(!progressPath)return;
  const raw=clamp(progress,0,1),completed=state.reverse?1-raw:raw;
  progressPath.setAttribute("stroke-dasharray",`${Math.max(.0001,completed)} ${Math.max(.0001,1-completed)}`);
  progressPath.setAttribute("stroke-dashoffset",state.reverse?String(-raw):"0");
}
function stopTrainMotion(){
  if(state.trainMotionRAF)cancelAnimationFrame(state.trainMotionRAF);
  state.trainMotionRAF=0;
  state.trainMotionLast=0;
}
function setTrainTarget(target,{immediate=false}={}){
  target=clamp(target,0,1);
  state.trainTargetProgress=target;
  if(immediate||reducedMotionQuery.matches){
    stopTrainMotion();
    state.trainProgress=target;
    positionTrain(target);
    updateProgressPathPosition(target);
    return;
  }
  if(state.trainMotionRAF)return;
  function frame(now){
    const last=state.trainMotionLast||now;
    const dt=Math.min(34,Math.max(1,now-last));
    state.trainMotionLast=now;
    const diff=state.trainTargetProgress-state.trainProgress;
    const blend=1-Math.exp(-dt/58);
    state.trainProgress+=diff*blend;
    if(Math.abs(diff)<.000035){
      state.trainProgress=state.trainTargetProgress;
      positionTrain(state.trainProgress);
      updateProgressPathPosition(state.trainProgress);
      state.trainMotionRAF=0;
      state.trainMotionLast=0;
      return;
    }
    positionTrain(state.trainProgress);
    updateProgressPathPosition(state.trainProgress);
    state.trainMotionRAF=requestAnimationFrame(frame);
  }
  state.trainMotionRAF=requestAnimationFrame(frame);
}
function waitForTrainTarget(target,timeout=380){
  const started=performance.now();
  return new Promise(resolve=>{
    function check(now){
      if(Math.abs(state.trainProgress-target)<.00045||now-started>=timeout){
        state.trainProgress=target;
        state.trainTargetProgress=target;
        positionTrain(target);
        updateProgressPathPosition(target);
        resolve();
      }else requestAnimationFrame(check);
    }
    requestAnimationFrame(check);
  });
}
function animateTrain(target,duration=520){
  stopTrainMotion();
  state.trainTargetProgress=target;
  return new Promise(resolve=>{
    const from=state.trainProgress,start=performance.now();
    function frame(now){
      const p=Math.min(1,(now-start)/duration),e=p<.5?4*p*p*p:1-Math.pow(-2*p+2,3)/2;
      state.trainProgress=from+(target-from)*e;
      positionTrain(state.trainProgress);
      updateProgressPathPosition(state.trainProgress);
      if(p<1)requestAnimationFrame(frame);
      else{
        state.trainProgress=target;
        state.trainTargetProgress=target;
        renderProgressPath();
        resolve();
      }
    }
    requestAnimationFrame(frame);
  });
}
