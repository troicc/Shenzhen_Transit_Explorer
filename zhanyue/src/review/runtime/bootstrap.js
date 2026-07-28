document.querySelectorAll(".mode-btn").forEach(btn=>btn.addEventListener("click",()=>setMode(btn.dataset.mode)));
document.getElementById("focusToggle").addEventListener("click",()=>{
  state.focusMode=!state.focusMode;
  renderFocusCard();
  renderPractice();
}
);
function showStationTip(name,x,y){
  hoverLayer.innerHTML="";
  const charW=9.8,h=18,padX=7;
  const w=Math.max(name.length*charW+padX*2,30);
  const ty=y-h/2-9;
  const g=svgEl("g",{class:"station-tip"});
  g.appendChild(svgEl("rect",{x:x-w/2,y:ty-h/2,width:w,height:h,rx:h/2,class:"tip-bg"}));
  const t=svgEl("text",{x,y:ty,"text-anchor":"middle","dominant-baseline":"central",class:"tip-name"});
  t.textContent=name;
  g.appendChild(t);
  hoverLayer.appendChild(g);
}
function hideStationTip(){ hoverLayer.innerHTML=""; }
function bindStationHover(root){
  root.addEventListener("mouseover",e=>{
    const g=e.target.closest?.("g[data-name]");
    if(!g)return;
    if(g.querySelector(".hub-name"))return;
    const name=g.getAttribute("data-name");
    let x=parseFloat(g.getAttribute("data-cx")),y=parseFloat(g.getAttribute("data-cy"));
    const c=g.querySelector(".station-core");
    if(c){ x=+c.getAttribute("cx"); y=+c.getAttribute("cy"); }
    if(!isNaN(x))showStationTip(name,x,y);
  });
  root.addEventListener("mouseout",e=>{
    const rt=e.relatedTarget;
    if(!rt||!rt.closest||!rt.closest("g[data-name]"))hideStationTip();
  });
  root.addEventListener("pointerleave",hideStationTip);
}
bindStationHover(stationLayer);
bindStationHover(transferLayer);
document.getElementById("reviewBtn").addEventListener("click",()=>{
  state.reviewOpen=!state.reviewOpen;
  if(state.reviewOpen){
    setMapFlipped(false);
    if(state.balancedSpacing){
      state.balancedSpacing=false;
      document.getElementById("balancedToggle").checked=false;
    }
  }else if(!state.selectedLineId){
    setMapFlipped(true);
  }
  renderAll();
}
);
document.getElementById("reviewClose").addEventListener("click",()=>{
  state.reviewOpen=false;
  state.showVertices=false;
  if(!state.selectedLineId)setMapFlipped(true);
  renderAll();
}
);
document.getElementById("reviewLineSelect").addEventListener("change",e=>selectLine(e.target.value,true));
document.getElementById("verticesToggle").addEventListener("change",e=>{
  state.showVertices=e.target.checked;
  renderReviewLayer()
}
);
document.getElementById("reviewPrev").addEventListener("click",()=>{
  if(!currentLine())return;
  state.currentIndex=Math.max(0,state.currentIndex-1);
  state.trainProgress=currentStation().progress;
  renderDynamic()
}
);
document.getElementById("reviewNext").addEventListener("click",()=>{
  if(!currentLine())return;
  state.currentIndex=Math.min(displayStations().length-1,state.currentIndex+1);
  state.trainProgress=currentStation().progress;
  renderDynamic()
}
);
document.getElementById("reviewPinyin").addEventListener("input",e=>{
  if(currentStation()){
    currentStation().pinyin=e.target.value.toLowerCase();
    renderStationCard();
    renderPractice()
  }
}
);
document.getElementById("reviewProgress").addEventListener("pointerdown",()=>pushUndo(`调整 ${currentStation()?.name||"站点"} 位置`));
document.getElementById("reviewProgress").addEventListener("input",e=>updateStationProgress(Number(e.target.value)/10000));
document.querySelectorAll("[data-nudge]").forEach(btn=>btn.addEventListener("click",()=>{
  pushUndo(`微调 ${currentStation().name}`);
  updateStationProgress(currentStation().progress+Number(btn.dataset.nudge))
}
));
document.querySelectorAll("[data-status]").forEach(btn=>btn.addEventListener("click",()=>{
  currentStation().reviewStatus=btn.dataset.status;
  renderReviewPanel(false)
}
));
document.getElementById("reviewNote").addEventListener("input",e=>{
  if(currentStation())currentStation().reviewNote=e.target.value
}
);
document.getElementById("reviewAudioUrl").addEventListener("change",e=>{
  if(!currentStation())return;
  applyAudioUrlToName(currentStation().name,e.target.value.trim());
  saveLocalReview(true);
  refreshReviewAudioStatus(currentStation().name)
}
);
document.getElementById("reviewAudioChoose").addEventListener("click",()=>document.getElementById("reviewAudioFile").click());
document.getElementById("reviewAudioFile").addEventListener("change",async e=>{
  const file=e.target.files?.[0],name=currentStation()?.name;
  if(!file||!name)return;
  try{
    await putStationAudio(name,file);
    (stationOccurrences.get(name)||[]).forEach(item=>item.station.audioLocalFile=file.name);
    saveLocalReview(true);
    await refreshReviewAudioStatus(name);
    showToast(`已保存 ${name} 的自定义音频`)
  }
  catch(err){
    showToast("音频保存失败")
  }
  e.target.value="";
}
);
document.getElementById("reviewAudioPlay").addEventListener("click",()=>currentStation()&&playStationAudio(currentStation()));
document.getElementById("reviewAudioClear").addEventListener("click",async()=>{
  const name=currentStation()?.name;
  if(!name)return;
  await deleteStationAudio(name).catch(()=>{
  }
  );
  applyAudioUrlToName(name,"");
  (stationOccurrences.get(name)||[]).forEach(item=>delete item.station.audioLocalFile);
  document.getElementById("reviewAudioUrl").value="";
  saveLocalReview(true);
  refreshReviewAudioStatus(name);
  showToast("已移除该站自定义音频");
}
);
document.getElementById("snapLineStations").addEventListener("click",snapCurrentLine);
document.getElementById("balanceLineStations").addEventListener("click",evenlySpaceCurrentLine);
document.getElementById("undoReview").addEventListener("click",undoReview);
document.getElementById("saveReview").addEventListener("click",()=>saveLocalReview(false));
document.getElementById("exportReview").addEventListener("click",exportReviewData);
document.getElementById("importReview").addEventListener("click",()=>document.getElementById("importReviewFile").click());
document.getElementById("importReviewFile").addEventListener("change",async e=>{
  try{
    replaceImportedData(JSON.parse(await e.target.files[0].text()));
    showToast("已导入校核数据")
  }
  catch(err){
    showToast("JSON 格式不正确")
  }
}
);
document.getElementById("resetReview").addEventListener("click",()=>{
  localStorage.removeItem("zhanyue-review-v3-2026-07-27-144c9e115c");
  showToast("已清除 v3 本地改动；刷新页面恢复内置数据")
}
);
document.getElementById("homeBtn").addEventListener("click",clearSelection);
document.getElementById("forwardBtn").addEventListener("click",()=>{
  if(!state.reverse)return;
  const line=currentLine(),old=currentStation().name;
  state.reverse=false;
  state.currentIndex=line.stations.findIndex(s=>s.name===old);
  state.trainProgress=visualProgress(line,state.currentIndex);
  renderDynamic();
  renderLineStrip();
}
);
document.getElementById("reverseBtn").addEventListener("click",()=>{
  if(state.reverse)return;
  const line=currentLine(),old=currentStation().name;
  state.reverse=true;
  state.currentIndex=line.stations.length-1-line.stations.findIndex(s=>s.name===old);
  state.trainProgress=visualProgress(line,line.stations.findIndex(s=>s.name===old));
  renderDynamic();
  renderLineStrip();
}
);
document.getElementById("startBtn").addEventListener("click",()=>setMode("full"));
document.getElementById("broadcastBtn").addEventListener("click",()=>state.broadcasting?stopBroadcast():startBroadcast());
document.getElementById("allLabelsToggle").addEventListener("change",e=>{
  state.showAllLabels=e.target.checked;
  renderTransferHubs();renderLabels()
}
);
document.getElementById("balancedToggle").addEventListener("change",e=>{
  state.balancedSpacing=e.target.checked;
  balancedCache.clear();
  renderStations();
  state.trainProgress=currentVisualProgress();
  state.trainTargetProgress=state.trainProgress;
  state.typingFraction=0;
  stopTrainMotion();
  renderDynamic()
}
);
document.getElementById("speakBtn").addEventListener("click",()=>currentStation()&&playStationAudio(currentStation()));
document.getElementById("locateBtn").addEventListener("click",()=>{
  const line=currentLine();
  if(!line)return;
  const p=visualPoint(line,originalIndexFromDisplay());
  animateView({
    x:p.x-state.view.w/2,y:p.y-state.view.h/2,w:state.view.w,h:state.view.h
  }
  ,330);
}
);
spellingSchemeSelect.addEventListener("change",async e=>{
  const previous=state.spellingScheme;
  state.spellingScheme=e.target.value;
  typeInput.value="";
  state.lastValidInput="";
  state.typingFraction=0;
  const base=currentLine()?currentVisualProgress():state.trainProgress;
  setTrainTarget(base,{immediate:true});
  savePracticePrefs();
  if(state.spellingScheme==="jyutping"&&currentLine()){
    const fb=document.getElementById("feedback");
    fb.className="feedback";
    fb.textContent="正在加载并缓存本线粤拼……";
    if(!await prepareJyutpingForLine(currentLine())){
      state.spellingScheme=previous;
      spellingSchemeSelect.value=previous;
      savePracticePrefs();
    }
  }
  renderPractice();
  typeInput.focus();
});
inlineHintToggle.addEventListener("change",e=>{
  state.inlineHint=e.target.checked;
  savePracticePrefs();
  renderPractice();
  typeInput.focus();
});
typeInput.addEventListener("input",handleTypingInput);
typeInput.addEventListener("keydown",e=>{
  if(e.key==="Enter"&&!state.answerLocked){
    const expected=practiceTarget(currentStation()).normalized,typed=normalizePinyin(typeInput.value);
    if(typed===expected)completeTyping();
    else shakeInput("还没有完整匹配上方拼音。")
  }
}
);
document.addEventListener("keydown",e=>{
  if(e.key==="Escape"){
    if(state.broadcasting)stopBroadcast();
    else clearSelection()
  }
  if(e.code==="Space"&&!["INPUT","TEXTAREA","SELECT"].includes(document.activeElement.tagName)&&currentStation()){
    e.preventDefault();
    playStationAudio(currentStation())
  }
  if(state.reviewOpen&&!["INPUT","TEXTAREA","SELECT"].includes(document.activeElement.tagName)){
    if(e.key==="ArrowLeft")document.getElementById("reviewPrev").click();
    if(e.key==="ArrowRight")document.getElementById("reviewNext").click();
  }
}
);
const stationOptions=document.getElementById("stationOptions");
[...stationOccurrences.keys()].sort((a,b)=>a.localeCompare(b,"zh-CN")).forEach(name=>{
  const option=document.createElement("option");
  option.value=name;
  stationOptions.appendChild(option)
}
);
document.getElementById("searchInput").addEventListener("keydown",e=>{
  if(e.key!=="Enter")return;
  const name=e.target.value.trim(),occ=stationOccurrences.get(name);
  if(!occ){
    showToast("没有找到该站，请输入完整站名");
    return
  }
  const target=occ[0];
  selectLine(target.line.id,true,target.index);
  e.target.blur();
}
);
function wheelPixels(value,mode){
  if(mode===1)return value*32;
  if(mode===2)return value*Math.max(mapStage.clientHeight,600);
  return value;
}
function zoomedView(base,factor,ux,uy){
  const minFactor=Math.max(150/base.w,90/base.h);
  const maxFactor=Math.min(1500/base.w,850/base.h);
  const applied=clamp(factor,minFactor,maxFactor);
  const newW=base.w*applied,newH=base.h*applied;
  const worldX=base.x+ux*base.w,worldY=base.y+uy*base.h;
  return {
    x:worldX-ux*newW,
    y:worldY-uy*newH,
    w:newW,
    h:newH
  };
}
function queueWheelFrame(){
  if(state.wheelRAF)return;
  state.wheelRAF=requestAnimationFrame(()=>{
    state.wheelRAF=0;
    const panX=state.wheelPanX,panY=state.wheelPanY;
    const zoomDelta=state.wheelZoomDelta;
    const ux=state.wheelAnchorX,uy=state.wheelAnchorY;
    const zoomingOut=state.wheelZoomingOut;
    resetWheelAccumulator();

    if(panX||panY){
      state.view.x+=panX/mapStage.clientWidth*state.view.w;
      state.view.y+=(isOverviewFlipped()?-1:1)*panY/mapStage.clientHeight*state.view.h;
    }
    if(zoomDelta){
      // Chromium trackpad pinch deltas are tiny; use a stronger exponential curve.
      const factor=clamp(Math.exp(zoomDelta*.0085),.74,1.35);
      state.view=zoomedView(state.view,factor,ux,uy);
    }
    applyView();
  });
}
mapStage.addEventListener("pointerdown",e=>{
  if(state.dragStation||state.dragVertex!==null)return;
  state.mayPan=true;
  state.dragMoved=false;
  state.lastX=e.clientX;
  state.lastY=e.clientY;
  state.pointerId=e.pointerId;
});
mapStage.addEventListener("pointermove",e=>{
  if(state.dragStation||state.dragVertex!==null){
    const pt=mapSvg.createSVGPoint();
    pt.x=e.clientX;
    pt.y=e.clientY;
    const p=pt.matrixTransform((mapFlipStage.getScreenCTM()||mapSvg.getScreenCTM()).inverse());
    state.pendingDragPoint={x:p.x,y:p.y};
    if(!state.dragRAF)state.dragRAF=requestAnimationFrame(()=>{
      state.dragRAF=0;
      const point=state.pendingDragPoint;
      state.pendingDragPoint=null;
      if(state.dragStation)applyStationDrag(point);
      else applyVertexDrag(point);
    });
    return;
  }
  if(state.mayPan&&!state.draggingMap){
    const ddx=e.clientX-state.lastX,ddy=e.clientY-state.lastY;
    if(Math.abs(ddx)+Math.abs(ddy)<=3)return;
    state.mayPan=false;
    state.draggingMap=true;
    state.lastX=e.clientX;
    state.lastY=e.clientY;
    mapStage.setPointerCapture?.(e.pointerId);
    document.body.classList.add("is-panning");
    beginMapNavigation();
  }
  if(!state.draggingMap)return;
  state.pendingPan={x:e.clientX,y:e.clientY};
  if(!state.panRAF)state.panRAF=requestAnimationFrame(()=>{
    state.panRAF=0;
    const point=state.pendingPan;
    state.pendingPan=null;
    if(!point||!state.draggingMap)return;
    const dx=point.x-state.lastX,dy=point.y-state.lastY;
    if(Math.abs(dx)+Math.abs(dy)>2)state.dragMoved=true;
    state.view.x-=dx/mapStage.clientWidth*state.view.w;
    state.view.y+=(isOverviewFlipped()?1:-1)*dy/mapStage.clientHeight*state.view.h;
    state.lastX=point.x;
    state.lastY=point.y;
    applyView();
  });
});
function endPointerInteraction(){
  state.mayPan=false;
  state.draggingMap=false;
  document.body.classList.remove("is-panning","is-editing-geometry");
  scheduleMapNavigationEnd(80);
  if(state.dragStation||state.dragVertex!==null){
    state.dragStation=null;
    state.dragVertex=null;
    state.dragVertexPoints=null;
    saveLocalReview(true);
    renderAll();
  }
  setTimeout(()=>{state.dragMoved=false;},0);
}
mapStage.addEventListener("pointerup",endPointerInteraction);
mapStage.addEventListener("pointercancel",endPointerInteraction);

/*
 * macOS 触控板：
 * - 普通 wheel（ctrlKey=false）是双指滚动，只平移；
 * - Chromium 的捏合会产生 ctrlKey=true 的 wheel，只缩放；
 * - Safari 使用 gesturestart/change/end，下面单独处理。
 */
mapStage.addEventListener("wheel",e=>{
  e.preventDefault();
  if(state.safariGesture)return;
  beginMapNavigation();
  const rect=mapStage.getBoundingClientRect();
  const rawUX=clamp((e.clientX-rect.left)/Math.max(1,rect.width),0,1);
  const rawUY=clamp((e.clientY-rect.top)/Math.max(1,rect.height),0,1);
  const dx=wheelPixels(e.deltaX,e.deltaMode);
  const dy=wheelPixels(e.deltaY,e.deltaMode);
  if(e.ctrlKey){
    state.wheelAnchorX=rawUX;
    state.wheelAnchorY=isOverviewFlipped()?1-rawUY:rawUY;
    const pinchDelta=clamp(dy,-46,46);
    state.wheelZoomDelta+=pinchDelta;
    if(pinchDelta!==0)state.pendingOverviewReturn=pinchDelta>0;
  }else{
    if(e.shiftKey&&Math.abs(dx)<Math.abs(dy)){
      state.wheelPanX+=dy;
    }else{
      state.wheelPanX+=dx;
      state.wheelPanY+=dy;
    }
  }
  queueWheelFrame();
  scheduleMapNavigationEnd(e.ctrlKey?82:72);
},{passive:false});

/* Safari 原生触控板捏合。scale 是相对 gesturestart 的累计比例。 */
mapStage.addEventListener("gesturestart",e=>{
  e.preventDefault();
  resetWheelAccumulator();
  if(state.wheelRAF){cancelAnimationFrame(state.wheelRAF);state.wheelRAF=0;}
  const rect=mapStage.getBoundingClientRect();
  const cx=Number.isFinite(e.clientX)&&e.clientX?e.clientX:rect.left+rect.width/2;
  const cy=Number.isFinite(e.clientY)&&e.clientY?e.clientY:rect.top+rect.height/2;
  const rawUX=clamp((cx-rect.left)/Math.max(1,rect.width),0,1);
  const rawUY=clamp((cy-rect.top)/Math.max(1,rect.height),0,1);
  state.safariGesture={
    view:{...state.view},
    ux:rawUX,
    uy:isOverviewFlipped()?1-rawUY:rawUY,
    scale:1
  };
  state.pendingGestureScale=1;
  beginMapNavigation();
},{passive:false});
mapStage.addEventListener("gesturechange",e=>{
  if(!state.safariGesture)return;
  e.preventDefault();
  state.pendingGestureScale=Math.max(.08,Number(e.scale)||1);
  if(state.gestureRAF)return;
  state.gestureRAF=requestAnimationFrame(()=>{
    state.gestureRAF=0;
    const gesture=state.safariGesture;
    if(!gesture)return;
    gesture.scale=state.pendingGestureScale;
    const effectiveScale=Math.pow(gesture.scale,1.32);
    state.view=zoomedView(gesture.view,1/effectiveScale,gesture.ux,gesture.uy);
    applyView();
  });
},{passive:false});
mapStage.addEventListener("gestureend",e=>{
  if(!state.safariGesture)return;
  e.preventDefault();
  const gesture=state.safariGesture;
  state.safariGesture=null;
  if(state.gestureRAF){cancelAnimationFrame(state.gestureRAF);state.gestureRAF=0;}
  state.pendingOverviewReturn=gesture.scale<1;
  scheduleMapNavigationEnd(78);
},{passive:false});
mapSvg.addEventListener("dblclick",e=>{
  if(e.target.closest&&e.target.closest(".route-group,.station,.transfer-hub"))return;
  if(state.selectedLineId)clearSelection()
}
);
window.addEventListener("resize",()=>{
  clearTimeout(window.__zhanyueResizeTimer);
  window.__zhanyueResizeTimer=setTimeout(()=>{
    if(state.selectedLineId)fitSelectedLine(0);
    else{
      state.view={...state.overviewView};
      commitView();
    }
  },100);
},{passive:true});
loadLocalReview();
setMapFlipped(!state.selectedLineId&&!state.reviewOpen,true);
renderAll();
commitView();
