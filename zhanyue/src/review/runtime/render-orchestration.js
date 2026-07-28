function renderTransferHubs(){
  transferLayer.innerHTML="";
  const sel=currentLine();
  const curOrig=sel?originalIndexFromDisplay():-1;
  const curName=sel&&curOrig>=0?sel.stations[curOrig]?.name:null;
  const nextOrig=(sel&&state.currentIndex+1<displayStations().length)?originalIndexFromDisplay(state.currentIndex+1):-1;
  const nextName=(sel&&nextOrig>=0)?sel.stations[nextOrig]?.name:null;
  const practice=!!sel&&(state.mode==="timed"||state.mode==="full");
  layoutObstacles=[];
  const hubBoxes=[];
  if(sel&&curOrig>=0){
    const tp=visualPoint(sel,curOrig);
    layoutObstacles.push({x:tp.x-13,y:tp.y-11,w:26,h:22});
  }
  const names=new Set();
  if(!sel){
    stationOccurrences.forEach((occ,name)=>{ if(occ.length>1)names.add(name); });
  } else {
    sel.stations.forEach(s=>{ if(s.transfer)names.add(s.name); });
  }
  const list=[];
  names.forEach(name=>{
    const occ=stationOccurrences.get(name)||[];
    if(occ.length<2)return;
    let cx,cy;
    const selOcc=sel?occ.find(o=>o.line.id===sel.id):null;
    if(selOcc){
      const p=visualPoint(selOcc.line,selOcc.index); cx=p.x; cy=p.y;
    } else {
      const p=pointAtProgress(occ[0].line,occ[0].station.progress); cx=p.x; cy=p.y;
    }
    const seen=new Set(),colors=[];
    occ.forEach(o=>{ if(!seen.has(o.line.id)){ seen.add(o.line.id); colors.push(o.line.color); } });
    const dotR=2.5,gap=1.3,padX=4,padY=3,textGap=5,charW=9.4;
    const dotsW=colors.length*(dotR*2)+(colors.length-1)*gap;
    const nameW=name.length*charW;
    const pillH=dotR*2+padY*2;
    const narrowW=dotsW+padX*2;
    const wideW=dotsW+textGap+nameW+padX*2;
    const isCur=name===curName;
    const isNext=name===nextName;
    const isAhead=practice&&!!selOcc&&displayIndexFromOriginal(selOcc.index)>state.currentIndex;
    list.push({name,occ,cx,cy,colors,dotR,gap,textGap,dotsW,nameW,pillH,narrowW,wideW,isCur,isNext,isAhead,priority:isCur?3:(isNext?2:1)});
  });
  if(sel){
    list.sort((a,b)=>b.priority-a.priority);
    list.forEach(h=>{
      const wideBox={x:h.cx-h.wideW/2,y:h.cy-h.pillH/2,w:h.wideW,h:h.pillH};
      h.useName=!hubBoxes.some(b=>boxesOverlap(wideBox,b,2));
      const box=h.useName?wideBox:{x:h.cx-h.narrowW/2,y:h.cy-h.pillH/2,w:h.narrowW,h:h.pillH};
      hubBoxes.push(box);
      layoutObstacles.push(box);
    });
  } else {
    list.forEach(h=>{h.useName=false;});
  }
  const fragment=document.createDocumentFragment();
  list.forEach(h=>{
    const w=h.useName?h.wideW:h.narrowW;
    const innerW=h.useName?(h.dotsW+h.textGap+h.nameW):h.dotsW;
    const cls="transfer-hub"+(h.isCur?" is-current":"")+(h.isAhead?" is-ahead":"");
    const g=svgEl("g",{class:cls,"data-name":h.name,"data-cx":h.cx,"data-cy":h.cy});
    g.appendChild(svgEl("rect",{x:h.cx-w/2,y:h.cy-h.pillH/2,width:w,height:h.pillH,rx:h.pillH/2,class:"hub-bg"}));
    let dx=h.cx-innerW/2+h.dotR;
    h.colors.forEach(c=>{ g.appendChild(svgEl("circle",{cx:dx,cy:h.cy,r:h.dotR,fill:c,class:"hub-dot"})); dx+=h.dotR*2+h.gap; });
    if(h.useName){
      const t=svgEl("text",{x:h.cx-innerW/2+h.dotsW+h.textGap,y:h.cy,"text-anchor":"start","dominant-baseline":"central",class:"hub-name"});
      t.textContent=h.name;
      g.appendChild(t);
    }
    g.addEventListener("click",e=>{
      if(state.dragMoved)return;
      e.stopPropagation();
      const pref=h.occ[0];
      selectLine(pref.line.id,true,pref.index);
    });
    fragment.appendChild(g);
  });
  transferLayer.appendChild(fragment);
}

function renderAll(){
  renderRoutes();
  renderStations();
  renderLineStrip();
  renderFocusCard();
  renderStationCard();
  renderPractice();
  renderModes();
  renderReviewPanel();
  renderReviewLayer();
  updateHeroFade();
  if(state.trainPositionRAF)cancelAnimationFrame(state.trainPositionRAF);
  state.trainPositionRAF=requestAnimationFrame(()=>{
    state.trainPositionRAF=0;
    positionTrain(state.trainProgress);
  });
}
function renderDynamic(){
  updateStationStates();
  renderTransferHubs();
  renderLabels();
  renderFocusCard();
  renderStationCard();
  renderPractice();
  renderModes();
  positionTrain(state.trainProgress);
  renderProgressPath();
  renderReviewPanel();
  renderReviewLayer();
}
function showToast(text){
  const toast=document.getElementById("toast");
  toast.textContent=text;
  toast.classList.add("show");
  clearTimeout(showToast.timer);
  showToast.timer=setTimeout(()=>toast.classList.remove("show"),1700);
}
