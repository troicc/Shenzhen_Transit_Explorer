function renderRoutes(){
  const selectedId=state.selectedLineId;
  const signature=currentRouteGeometrySignature();
  const canReuse=signature===routeGeometrySignature&&routeGroupMap.size===LINES.length;
  if(!canReuse){
    routeLayer.innerHTML="";
    pathMap.clear();
    pathGeometryCache.clear();
    routeGroupMap.clear();
    const fragment=document.createDocumentFragment();
    LINES.forEach((line,idx)=>{
      const group=svgEl("g",{class:"route-group","data-line":line.id});
      const casing=svgEl("path",{d:line.d,class:"route-casing",pathLength:"1"});
      const color=svgEl("path",{d:line.d,class:"route-color",pathLength:"1",stroke:line.color});
      if(!selectedId&&!state.initialDrawn&&!window.matchMedia("(prefers-reduced-motion: reduce)").matches){
        color.classList.add("route-draw");
        color.style.animationDelay=`${Math.min(idx*24+35,315)}ms`;
      }
      const hit=svgEl("path",{d:line.d,class:"route-hit"});
      hit.addEventListener("click",e=>{
        if(state.dragMoved||state.dragVertex!==null||state.dragStation)return;
        e.stopPropagation();
        selectLine(line.id,true);
      });
      group.append(casing,color,hit);
      fragment.appendChild(group);
      routeGroupMap.set(line.id,group);
      pathMap.set(line.id,color);
    });
    routeLayer.appendChild(fragment);
    routeGeometrySignature=signature;
  }
  LINES.forEach(line=>{
    const group=routeGroupMap.get(line.id);
    if(!group)return;
    const selected=selectedId===line.id;
    group.classList.toggle("is-muted",!!selectedId&&!selected);
    group.classList.toggle("is-selected",selected);
    const colorPath=group.querySelector(".route-color");
    if(colorPath){
      if(selected){
        colorPath.classList.remove("route-draw");
        colorPath.style.animation="none";
        colorPath.style.strokeDasharray="none";
        colorPath.style.strokeDashoffset="0";
        colorPath.setAttribute("stroke",selectedRouteColor(line.color));
      }else{
        colorPath.style.strokeDasharray="";
        colorPath.style.strokeDashoffset="";
        colorPath.setAttribute("stroke",line.color);
      }
    }
    routeLayer.appendChild(group);
  });
  if(selectedId&&routeGroupMap.has(selectedId))routeLayer.appendChild(routeGroupMap.get(selectedId));
  if(!selectedId)state.initialDrawn=true;
  renderProgressPath();
}
function renderProgressPath(){
  const line=currentLine();
  if(!line||state.mode==="overview"){
    routeLayer.querySelectorAll(".route-progress").forEach(el=>el.remove());
    return;
  }
  const selectedGroup=routeGroupMap.get(line.id)||routeLayer.querySelector(`[data-line="${line.id}"]`);
  if(!selectedGroup)return;
  routeLayer.querySelectorAll(".route-progress").forEach(el=>{
    if(el.parentElement!==selectedGroup)el.remove();
  });
  let progressPath=selectedGroup.querySelector(".route-progress");
  if(!progressPath){
    progressPath=svgEl("path",{class:"route-progress",pathLength:"1"});
    selectedGroup.appendChild(progressPath);
  }
  progressPath.setAttribute("d",line.d);
  progressPath.setAttribute("stroke",line.color);
  const raw=clamp(state.trainProgress,0,1);
  const completed=state.reverse?1-raw:raw;
  progressPath.setAttribute("stroke-dasharray",`${Math.max(.0001,completed)} ${Math.max(.0001,1-completed)}`);
  progressPath.setAttribute("stroke-dashoffset",state.reverse?String(-raw):"0");
}
function uniqueOverviewStations(){
  return overviewStationsCache;
}
function renderStations(){
  stationLayer.innerHTML="";
  stationNodeMap.clear();
  const selected=currentLine();
  const fragment=document.createDocumentFragment();
  renderTransferHubs();
  if(!selected){
    uniqueOverviewStations().forEach(({line,st,index})=>{
      const occ=stationOccurrences.get(st.name)||[];
      if(occ.length>1)return;
      const p=pointAtProgress(line,state.balancedSpacing?balancedProgresses(line)[index]:st.progress);
      const g=svgEl("g",{class:"station","data-name":st.name});
      g.appendChild(svgEl("circle",{class:"station-core",cx:p.x,cy:p.y,r:2.55}));
      g.addEventListener("click",e=>{
        if(state.dragMoved)return;
        e.stopPropagation();
        const preferred=occ[0];
        selectLine(preferred.line.id,true,preferred.index);
      });
      fragment.appendChild(g);
    });
    stationLayer.appendChild(fragment);
    renderLabels();
    return;
  }
  const currentOriginal=originalIndexFromDisplay();
  const nextDisplay=state.currentIndex+1;
  const nextOriginal=nextDisplay<displayStations().length?originalIndexFromDisplay(nextDisplay):-1;
  const practice=state.mode==="timed"||state.mode==="full";
  selected.stations.forEach((st,index)=>{
    if(st.transfer)return;
    const p=visualPoint(selected,index);
    const g=svgEl("g",{class:"station","data-line":selected.id,"data-index":index,"data-name":st.name});
    if(index===currentOriginal)g.classList.add("is-current");
    if(index===nextOriginal)g.classList.add("is-next");
    if(state.reviewOpen)g.classList.add("is-review-draggable");
    if(practice&&displayIndexFromOriginal(index)>state.currentIndex)g.classList.add("is-ahead");
    g.appendChild(svgEl("circle",{class:"station-core",cx:p.x,cy:p.y,r:3.6}));
    if(index===currentOriginal)g.appendChild(svgEl("circle",{class:"pulse-ring",cx:p.x,cy:p.y,r:7}));
    g.addEventListener("click",e=>{
      if(state.dragMoved)return;
      e.stopPropagation();
      setCurrentByOriginalIndex(index);
    });
    g.addEventListener("pointerdown",e=>{
      if(!state.reviewOpen)return;
      e.preventDefault();
      e.stopPropagation();
      beginStationDrag(selected,index,e);
    });
    fragment.appendChild(g);
    stationNodeMap.set(`${selected.id}:${index}`,g);
  });
  stationLayer.appendChild(fragment);
  renderLabels();
}
function boxesOverlap(a,b,pad=3){
  return !(a.x+a.w+pad<b.x||b.x+b.w+pad<a.x||a.y+a.h+pad<b.y||b.y+b.h+pad<a.y);
}
function labelCandidates(point,tangent,name){
  const width=Math.max(25,name.length*11.2+8),height=16;
  const n={
    x:-tangent.y,y:tangent.x
  }
  ;
  const dirs=[n,{
    x:-n.x,y:-n.y
  }
  ,{
    x:1,y:0
  }
  ,{
    x:-1,y:0
  }
  ,{
    x:0,y:-1
  }
  ,{
    x:0,y:1
  }
  ];
  const candidates=[];
  [13,22,31].forEach(distance=>dirs.forEach(dir=>{
    const x=point.x+dir.x*distance,y=point.y+dir.y*distance;
    let anchor="middle",boxX=x-width/2;
    if(dir.x>.38){
      anchor="start";
      boxX=x
    }
    if(dir.x<-.38){
      anchor="end";
      boxX=x-width
    }
    candidates.push({
      x,y,anchor,box:{
        x:boxX,y:y-height+3,w:width,h:height
      }
      ,distance
    }
    );
  }
  ));
  return candidates;
}
function renderLabels(){
  labelLayer.innerHTML="";
  const fragment=document.createDocumentFragment();
  const selected=currentLine();
  if(!selected){
    uniqueOverviewStations().forEach(({line,st,index})=>{
      if(!KEY_STATIONS.has(st.name))return;
      const occ=stationOccurrences.get(st.name)||[];
      if(occ.length>1)return;
      const p=pointAtProgress(line,state.balancedSpacing?balancedProgresses(line)[index]:st.progress);
      const label=svgEl("text",{class:"station-label secondary",x:p.x+7,y:p.y-8});
      label.textContent=st.name;
      fragment.appendChild(label);
    });
    labelLayer.appendChild(fragment);
    return;
  }
  const placed=layoutObstacles.slice();
  const currentOriginal=originalIndexFromDisplay();
  const visibleIndexes=[];
  selected.stations.forEach((st,index)=>{
    const displayIndex=displayIndexFromOriginal(index);
    if(!st.transfer&&(state.showAllLabels||index===0||index===selected.stations.length-1||Math.abs(displayIndex-state.currentIndex)<=1)){
      visibleIndexes.push(index);
    }
  });
  visibleIndexes.sort((a,b)=>(b===currentOriginal?100:0)-(a===currentOriginal?100:0));
  visibleIndexes.forEach(index=>{
    const st=selected.stations[index],progress=visualProgress(selected,index);
    const p=pointAtProgress(selected,progress),t=tangentAtProgress(selected,progress);
    const candidates=labelCandidates(p,t,st.name);
    let best=candidates[0],bestScore=Infinity;
    candidates.forEach(candidate=>{
      let overlaps=0;
      placed.forEach(box=>{if(boxesOverlap(candidate.box,box))overlaps++;});
      const score=overlaps*10000+candidate.distance+(candidate.anchor==="middle"?5:0);
      if(score<bestScore){bestScore=score;best=candidate;}
    });
    placed.push(best.box);
    const label=svgEl("text",{
      class:`station-label${index===currentOriginal?" current-label":""}`,
      x:best.x,y:best.y,"text-anchor":best.anchor
    });
    label.textContent=st.name;
    fragment.appendChild(label);
  });
  labelLayer.appendChild(fragment);
}
function updateStationStates(){
  const line=currentLine();
  if(!line)return;
  const practice=(state.mode==="timed"||state.mode==="full");
  const currentOriginal=originalIndexFromDisplay();
  const nextOriginal=state.currentIndex+1<displayStations().length?originalIndexFromDisplay(state.currentIndex+1):-1;
  line.stations.forEach((st,index)=>{
    const node=stationNodeMap.get(`${line.id}:${index}`);
    if(!node)return;
    node.classList.toggle("is-current",index===currentOriginal);
    node.classList.toggle("is-next",index===nextOriginal);
    node.classList.toggle("is-ahead",practice&&displayIndexFromOriginal(index)>state.currentIndex);
  }
  );
}
function renderLineStrip(){
  const signature=LINES.map(line=>`${line.id}:${line.name}:${line.color}`).join("|");
  if(lineStrip.dataset.signature!==signature){
    lineStrip.innerHTML="";
    const fragment=document.createDocumentFragment();
    LINES.forEach(line=>{
      const btn=document.createElement("button");
      btn.className="line-chip";
      btn.dataset.line=line.id;
      btn.innerHTML=`<span class="line-chip-dot" style="background:${line.color}"></span>${codeFor(line)}`;
      btn.addEventListener("click",()=>selectLine(line.id,true));
      fragment.appendChild(btn);
    });
    lineStrip.appendChild(fragment);
    lineStrip.dataset.signature=signature;
  }
  lineStrip.querySelectorAll(".line-chip").forEach(btn=>btn.classList.toggle("active",btn.dataset.line===state.selectedLineId));
}
