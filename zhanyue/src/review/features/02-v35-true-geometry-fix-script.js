
(() => {
  const MAX_ROUTE_SCALE = 2.7;
  const ENTER_DURATION = 980;
  const RETURN_DURATION = 900;
  const pathCache = new Map();
  const immersiveViewport = metroMap.querySelector('g[clip-path="url(#viewportClip)"]');

  state.immersiveStretch = Number.isFinite(state.immersiveStretch) ? state.immersiveStretch : 0;
  state.immersiveStretchRAF = 0;
  state.immersiveStretchToken = 0;
  state.trueCameraRAF = 0;
  state.trueCameraLast = 0;
  state.trueCameraVelocity = {x:0,y:0};
  state.trueCameraTarget = null;

  function easeInOutCubic(t){
    return t < .5 ? 4*t*t*t : 1-Math.pow(-2*t+2,3)/2;
  }
  function easeOutExpo(t){
    return t >= 1 ? 1 : 1-Math.pow(2,-10*t);
  }
  function routeScaleAt(stretch=state.immersiveStretch){
    return 1 + (MAX_ROUTE_SCALE-1)*easeInOutCubic(clamp(stretch,0,1));
  }
  function trainScaleAt(stretch=state.immersiveStretch){
    const t=clamp(stretch,0,1);
    return 1 - .70*easeOutExpo(t);
  }
  function routeCenter(line=currentLine()){
    if(!line)return {x:0,y:0};
    const [x1,y1,x2,y2]=line.bbox;
    return {x:(x1+x2)/2,y:(y1+y2)/2};
  }
  function stretchPoint(point,line=currentLine(),stretch=state.immersiveStretch){
    if(!line)return point;
    const c=routeCenter(line),s=routeScaleAt(stretch);
    return {x:c.x+(point.x-c.x)*s,y:c.y+(point.y-c.y)*s};
  }
  function displayPointAtProgress(progress,line=currentLine(),stretch=state.immersiveStretch){
    if(!line)return null;
    return stretchPoint(pointAtProgress(line,clamp(progress,0,1)),line,stretch);
  }
  function displayPointForOriginalIndex(index,line=currentLine(),stretch=state.immersiveStretch){
    if(!line||index<0||index>=line.stations.length)return null;
    return displayPointAtProgress(visualProgress(line,index),line,stretch);
  }

  function transformText(line,stretch=state.immersiveStretch){
    const c=routeCenter(line),s=routeScaleAt(stretch);
    return `translate(${c.x} ${c.y}) scale(${s}) translate(${-c.x} ${-c.y})`;
  }

  function applyImmersiveGeometry(){
    const line=currentLine();
    const active=!!line&&!state.reviewOpen&&state.selectedLineId;
    if(immersiveViewport){
      if(active)immersiveViewport.removeAttribute('clip-path');
      else immersiveViewport.setAttribute('clip-path','url(#viewportClip)');
    }
    const s=active?routeScaleAt():1;
    routeGroupMap.forEach((group,id)=>{
      if(active&&id===line.id)group.setAttribute('transform',transformText(line));
      else group.removeAttribute('transform');
    });
    const layers=[stationLayer,transferLayer,labelLayer,hoverLayer];
    layers.forEach(layer=>{
      if(active){
        layer.setAttribute('transform',transformText(line));
        layer.style.setProperty('--immersive-marker-inverse',String(1/s));
      }else{
        layer.removeAttribute('transform');
        layer.style.removeProperty('--immersive-marker-inverse');
      }
    });
    positionTrain(state.trainProgress);
  }

  function animateStretch(target,duration=ENTER_DURATION,onComplete=null){
    target=clamp(target,0,1);
    const token=++state.immersiveStretchToken;
    if(state.immersiveStretchRAF)cancelAnimationFrame(state.immersiveStretchRAF);
    const from=state.immersiveStretch;
    if(reducedMotionQuery.matches||duration<=0||Math.abs(target-from)<.0001){
      state.immersiveStretch=target;
      applyImmersiveGeometry();
      document.body.classList.remove('route-stretching');
      if(onComplete)onComplete();
      return;
    }
    document.body.classList.add('route-stretching');
    hoverLayer.querySelectorAll('.arrival-pulse-group').forEach(node=>node.remove());
    const start=performance.now();
    function frame(now){
      if(token!==state.immersiveStretchToken)return;
      const p=Math.min(1,(now-start)/duration);
      state.immersiveStretch=from+(target-from)*easeInOutCubic(p);
      applyImmersiveGeometry();
      if(p<1)state.immersiveStretchRAF=requestAnimationFrame(frame);
      else{
        state.immersiveStretchRAF=0;
        state.immersiveStretch=target;
        applyImmersiveGeometry();
        requestAnimationFrame(()=>document.body.classList.remove('route-stretching'));
        if(onComplete)onComplete();
      }
    }
    state.immersiveStretchRAF=requestAnimationFrame(frame);
  }

  function parsedPolyline(line){
    const cached=pathCache.get(line.id);
    if(cached&&cached.d===line.d)return cached;
    const tokens=String(line.d).match(/[ML]|[-+]?(?:\d*\.?\d+)(?:e[-+]?\d+)?/ig)||[];
    const points=[];
    let i=0,cmd='M';
    while(i<tokens.length){
      if(/[ML]/i.test(tokens[i]))cmd=tokens[i++].toUpperCase();
      if(i+1>=tokens.length)break;
      const x=Number(tokens[i++]),y=Number(tokens[i++]);
      if(Number.isFinite(x)&&Number.isFinite(y)&&(cmd==='M'||cmd==='L'))points.push({x,y});
      cmd='L';
    }
    const cumulative=[0];
    let total=0;
    for(let j=1;j<points.length;j++){
      total+=Math.hypot(points[j].x-points[j-1].x,points[j].y-points[j-1].y);
      cumulative.push(total);
    }
    const result={d:line.d,points,cumulative,total};
    pathCache.set(line.id,result);
    return result;
  }
  function pointAtDistance(poly,distance){
    const {points,cumulative,total}=poly;
    if(!points.length)return {x:0,y:0};
    if(distance<=0)return {...points[0]};
    if(distance>=total)return {...points.at(-1)};
    let lo=1,hi=points.length-1;
    while(lo<hi){
      const mid=(lo+hi)>>1;
      if(cumulative[mid]<distance)lo=mid+1;else hi=mid;
    }
    const i=lo,a=points[i-1],b=points[i];
    const span=Math.max(.000001,cumulative[i]-cumulative[i-1]);
    const t=(distance-cumulative[i-1])/span;
    return {x:a.x+(b.x-a.x)*t,y:a.y+(b.y-a.y)*t};
  }
  function fmt(n){return Number(n.toFixed(3));}
  function partialPathD(line,progress){
    const poly=parsedPolyline(line);
    if(poly.points.length<2||poly.total<=0)return '';
    const p=clamp(progress,0,1),distance=p*poly.total;
    const out=[];
    if(!state.reverse){
      if(p<=.000001)return '';
      out.push(poly.points[0]);
      for(let i=1;i<poly.points.length&&poly.cumulative[i]<distance-.000001;i++)out.push(poly.points[i]);
      out.push(pointAtDistance(poly,distance));
    }else{
      if(p>=.999999)return '';
      out.push(poly.points.at(-1));
      for(let i=poly.points.length-2;i>=0&&poly.cumulative[i]>distance+.000001;i--)out.push(poly.points[i]);
      out.push(pointAtDistance(poly,distance));
    }
    const clean=[];
    out.forEach(point=>{
      const prev=clean.at(-1);
      if(!prev||Math.hypot(point.x-prev.x,point.y-prev.y)>.0001)clean.push(point);
    });
    if(clean.length<2)return '';
    return clean.map((pt,index)=>`${index?'L':'M'} ${fmt(pt.x)} ${fmt(pt.y)}`).join(' ');
  }
  function lighten(value,amount=.34){
    const m=/^#([0-9a-f]{6})$/i.exec(String(value||''));
    if(!m)return value||'#fff';
    const rgb=[0,2,4].map(i=>parseInt(m[1].slice(i,i+2),16));
    const result=rgb.map(v=>Math.round(v+(255-v)*amount).toString(16).padStart(2,'0')).join('');
    return `#${result}`;
  }

  renderProgressPath=function(){
    const line=currentLine();
    routeLayer.querySelectorAll('.route-progress-halo').forEach(node=>node.remove());
    if(!line||!state.selectedLineId){
      routeLayer.querySelectorAll('.route-progress').forEach(node=>node.remove());
      return;
    }
    const group=routeGroupMap.get(line.id);
    if(!group)return;
    routeLayer.querySelectorAll('.route-progress').forEach(node=>{
      if(node.parentElement!==group)node.remove();
    });
    let path=group.querySelector('.route-progress');
    if(!path){
      path=svgEl('path',{class:'route-progress'});
      group.insertBefore(path,group.querySelector('.route-hit')||null);
    }
    const atPracticeStart=(state.mode==='timed'||state.mode==='full')&&state.currentIndex===0;
    const d=atPracticeStart?'':partialPathD(line,state.trainProgress);
    path.removeAttribute('pathLength');
    path.removeAttribute('stroke-dasharray');
    path.removeAttribute('stroke-dashoffset');
    path.setAttribute('stroke',lighten(line.color,.38));
    path.setAttribute('d',d||'M 0 0');
    path.style.display=d?'':'none';
  };
  updateProgressPathPosition=function(progress=state.trainProgress){
    state.trainProgress=progress;
    renderProgressPath();
  };

  // Current answer is the destination. Typing moves from the previous station into it.
  typingSegment=function(eased=state.typingFraction){
    const line=currentLine(),stations=displayStations();
    if(!line||!stations.length)return {start:0,end:0,target:0};
    const currentOriginal=originalIndexFromDisplay(state.currentIndex);
    const end=visualProgress(line,currentOriginal);
    if(state.currentIndex<=0){
      if(stations.length<=1)return {start:end,end,target:end};
      const inwardOriginal=originalIndexFromDisplay(1);
      const inward=visualProgress(line,inwardOriginal);
      const start=end+(inward-end)*.36;
      const t=clamp(eased,0,1);
      return {start,end,target:start+(end-start)*t};
    }
    const previousOriginal=originalIndexFromDisplay(state.currentIndex-1);
    const start=visualProgress(line,previousOriginal);
    const t=clamp(eased,0,1);
    return {start,end,target:start+(end-start)*t};
  };
  updatePracticeProgressBar=function(eased=state.typingFraction){
    const stations=displayStations(),segments=Math.max(1,stations.length-1);
    const completedBefore=Math.max(0,state.currentIndex-1);
    const active=state.currentIndex>0?clamp(eased,0,1):0;
    const overall=stations.length<=1?1:clamp((completedBefore+active)/segments,0,1);
    const bar=document.getElementById('progressBar');
    if(bar)bar.style.width=`${overall*100}%`;
  };

  function stopTrueCamera(){
    if(state.trueCameraRAF)cancelAnimationFrame(state.trueCameraRAF);
    state.trueCameraRAF=0;
    state.trueCameraLast=0;
    state.trueCameraVelocity.x=0;
    state.trueCameraVelocity.y=0;
    state.trueCameraTarget=null;
  }
  function requestTrueCamera(progress=state.trainProgress,{force=false}={}){
    if(window.__zhanyueBakedCameraFollow)return window.__zhanyueBakedCameraFollow(progress,{force});
    if(!(state.mode==='timed'||state.mode==='full')||state.cameraSuspended||document.body.classList.contains('route-stretching'))return;
    const line=currentLine(),p=displayPointAtProgress(progress,line);
    if(!line||!p)return;
    const direction=(state.trainTargetProgress-progress)||(state.reverse?-.01:.01);
    const ahead=displayPointAtProgress(clamp(progress+(direction<0?-1:1)/Math.max(24,line.stations.length*1.7),0,1),line)||p;
    const anchorX=.48,anchorY=.40;
    const u=(p.x-state.view.x)/Math.max(1,state.view.w),v=(p.y-state.view.y)/Math.max(1,state.view.h);
    const edge=Math.max(Math.abs(u-anchorX)/.21,Math.abs(v-anchorY)/.17);
    const strength=force?1:clamp(Math.pow(Math.max(0,edge-.42)/.58,1.55),0,1);
    if(strength<.01)return;
    const look={x:p.x+(ahead.x-p.x)*.34,y:p.y+(ahead.y-p.y)*.34};
    state.trueCameraTarget={
      x:state.view.x+(look.x-state.view.w*anchorX-state.view.x)*(.18+.82*strength),
      y:state.view.y+(look.y-state.view.h*anchorY-state.view.y)*(.18+.82*strength),
      w:state.view.w,h:state.view.h
    };
    if(state.trueCameraRAF)return;
    function frame(now){
      state.trueCameraRAF=0;
      if(!state.trueCameraTarget||state.cameraSuspended){stopTrueCamera();return;}
      const dt=Math.min(.032,Math.max(.001,(now-(state.trueCameraLast||now))/1000));
      state.trueCameraLast=now;
      const dx=state.trueCameraTarget.x-state.view.x,dy=state.trueCameraTarget.y-state.view.y;
      const normalized=Math.hypot(dx/Math.max(1,state.view.w),dy/Math.max(1,state.view.h));
      const k=46+94*clamp(Math.pow(normalized/.26,.72),0,1);
      const damping=2*Math.sqrt(k)*.94;
      state.trueCameraVelocity.x+=(dx*k-state.trueCameraVelocity.x*damping)*dt;
      state.trueCameraVelocity.y+=(dy*k-state.trueCameraVelocity.y*damping)*dt;
      state.view.x+=state.trueCameraVelocity.x*dt;
      state.view.y+=state.trueCameraVelocity.y*dt;
      applyView();
      if(Math.abs(dx)<state.view.w*.00015&&Math.abs(dy)<state.view.h*.00015&&Math.hypot(state.trueCameraVelocity.x,state.trueCameraVelocity.y)<.018){
        state.view.x=state.trueCameraTarget.x;state.view.y=state.trueCameraTarget.y;applyView();stopTrueCamera();return;
      }
      state.trueCameraRAF=requestAnimationFrame(frame);
    }
    state.trueCameraRAF=requestAnimationFrame(frame);
  }

  positionTrain=function(progress=state.trainProgress){
    const line=currentLine();
    if(!line){train.setAttribute('opacity','0');return;}
    const p=displayPointAtProgress(progress,line);
    if(!p)return;
    const scale=trainScaleAt();
    train.setAttribute('transform',`translate(${p.x} ${p.y}) scale(${scale})`);
    train.setAttribute('opacity','1');
    const body=train.querySelector('.train-body');
    if(body){
      body.setAttribute('x','-9');body.setAttribute('y','-6');body.setAttribute('width','18');body.setAttribute('height','12');body.setAttribute('rx','4');
      body.setAttribute('fill',line.color);
    }
    const windowPath=train.querySelector('.train-window');
    if(windowPath)windowPath.setAttribute('d','M-5.5 -1.5 H5.5');
    requestTrueCamera(progress);
  };

  function emitArrivalPulse(originalIndex){
    const line=currentLine(),p=displayPointForOriginalIndex(originalIndex,line);
    if(!line||!p)return;
    const group=svgEl('g',{class:'arrival-pulse-group'});
    // hoverLayer itself is geometrically stretched, therefore place this in original coordinates.
    const original=pointAtProgress(line,visualProgress(line,originalIndex));
    group.append(
      svgEl('circle',{class:'arrival-pulse outer',cx:original.x,cy:original.y,r:5}),
      svgEl('circle',{class:'arrival-pulse inner',cx:original.x,cy:original.y,r:5}),
      svgEl('circle',{class:'arrival-flash',cx:original.x,cy:original.y,r:4})
    );
    hoverLayer.appendChild(group);
    setTimeout(()=>group.remove(),1120);
  }

  completeTyping=async function(){
    if(state.answerLocked)return;
    state.answerLocked=true;
    const stations=displayStations(),station=currentStation(),target=practiceTarget(station);
    const arrivedOriginal=originalIndexFromDisplay(state.currentIndex);
    state.correct+=1;
    state.attempts+=1;
    typeInput.classList.add('correct');
    state.typingFraction=1;
    const segment=typingSegment(1);
    setTrainTarget(segment.end);
    updatePracticeProgressBar(1);
    renderPracticePinyin(true);
    requestTrueCamera(segment.end,{force:true});
    const fb=document.getElementById('feedback');
    fb.className='feedback ok';
    fb.textContent=`正确：${station.name} · ${target.display}`;
    playStationAudio(station,{silent:true}).catch(()=>{});
    await waitForTrainTarget(segment.end,460);
    emitArrivalPulse(arrivedOriginal);
    await delay(150);
    if(state.currentIndex<stations.length-1){
      // The train stays at the station just entered; the next answer drives it onward.
      state.currentIndex+=1;
      state.trainProgress=segment.end;
      state.trainTargetProgress=segment.end;
      state.typingFraction=0;
      state.selectedStationName=currentStation().name;
      typeInput.value='';
      state.lastValidInput='';
      typeInput.className='type-input';
      state.answerLocked=false;
      renderDynamic();
      requestTrueCamera(state.trainProgress,{force:true});
      const nextTarget=practiceTarget(currentStation());
      fb.className='feedback';
      fb.textContent=`下一站：${currentStation().name} · ${nextTarget.display}`;
      typeInput.focus();
    }else{
      stopTimer();
      fb.textContent=`完成全线，共答对 ${state.correct} 站。`;
      state.answerLocked=false;
      typeInput.classList.remove('correct');
    }
  };

  function finalImmersiveView(progress=state.trainProgress){
    const line=currentLine();
    if(!line)return {...state.overviewView};
    const p=displayPointAtProgress(progress,line,1)||{x:640,y:355};
    const direction=(state.trainTargetProgress-progress)||(state.reverse?-.01:.01);
    const ahead=displayPointAtProgress(clamp(progress+(direction<0?-1:1)/Math.max(18,line.stations.length*1.45),0,1),line,1)||p;
    const originalW=Math.max(line.bbox[2]-line.bbox[0],(line.bbox[3]-line.bbox[1])*(state.overviewView.w/state.overviewView.h));
    const w=clamp(originalW*.47,300,460);
    const h=w/(state.overviewView.w/state.overviewView.h);
    const look={x:p.x+(ahead.x-p.x)*.28,y:p.y+(ahead.y-p.y)*.28};
    return {x:look.x-w*.48,y:look.y-h*.40,w,h};
  }

  fitSelectedLine=function(duration=ENTER_DURATION,onComplete=null){
    const line=currentLine();
    if(!line){if(onComplete)onComplete();return;}
    const target=finalImmersiveView(state.trainProgress);
    let stretchDone=false,viewDone=false;
    const done=()=>{if(stretchDone&&viewDone){renderDynamic();applyImmersiveGeometry();if(onComplete)onComplete();}};
    animateStretch(1,duration,()=>{stretchDone=true;done();});
    animateView(target,duration,()=>{viewDone=true;done();},easeInOutCubic);
  };

  const previousRenderRoutes=renderRoutes;
  renderRoutes=function(){previousRenderRoutes();renderProgressPath();applyImmersiveGeometry();};
  const previousRenderStations=renderStations;
  renderStations=function(){previousRenderStations();applyImmersiveGeometry();};
  const previousRenderDynamic=renderDynamic;
  renderDynamic=function(){previousRenderDynamic();applyImmersiveGeometry();renderProgressPath();positionTrain(state.trainProgress);};
  const previousRenderAll=renderAll;
  renderAll=function(){previousRenderAll();requestAnimationFrame(()=>{applyImmersiveGeometry();renderProgressPath();positionTrain(state.trainProgress);});};

  const previousSelectLine=selectLine;
  selectLine=function(lineId,focus=true,originalIndex=0){
    stopTrueCamera();
    clearTimeout(state.arrivalPulseTimer);
    state.immersiveStretch=0;
    applyImmersiveGeometry();
    previousSelectLine(lineId,focus,originalIndex);
    clearTimeout(state.arrivalPulseTimer);
    if(!focus)animateStretch(1,ENTER_DURATION);
  };

  const previousSetMode=setMode;
  setMode=async function(mode){
    await previousSetMode(mode);
    if(!(mode==='timed'||mode==='full')||!currentLine())return;
    state.cameraFollowEnabled=false; // disable the superseded original-space camera.
    stopTrueCamera();
    const first=typingSegment(0);
    state.trainProgress=first.start;
    state.trainTargetProgress=first.start;
    state.typingFraction=0;
    renderDynamic();
    fitSelectedLine(820,()=>requestTrueCamera(state.trainProgress,{force:true}));
    const fb=document.getElementById('feedback');
    if(fb)fb.textContent='当前题目是目的站；完整输入时列车正好进站。';
  };

  const previousSetCurrentByOriginalIndex=setCurrentByOriginalIndex;
  setCurrentByOriginalIndex=function(originalIndex){
    previousSetCurrentByOriginalIndex(originalIndex);
    if(state.mode==='timed'||state.mode==='full'){
      const segment=typingSegment(0);
      state.trainProgress=segment.start;
      state.trainTargetProgress=segment.start;
      state.typingFraction=0;
      renderDynamic();
    }
  };

  clearSelection=function(){
    const token=++state.returnSequenceToken;
    stopTimer();stopBroadcast(true);stopTrainMotion();stopTrueCamera();
    clearTimeout(state.arrivalPulseTimer);
    state.cameraFollowEnabled=false;
    state.cameraSuspended=false;
    state.pendingOverviewReturn=false;
    state.mode='overview';state.running=false;state.showVertices=false;
    document.body.classList.remove('practice-on','camera-following','is-map-navigating');
    document.body.classList.add('route-returning','route-stretching');
    hero.classList.remove('hidden');
    renderPractice();renderModes();
    let stretchDone=false,viewDone=false;
    const finish=()=>{
      if(!stretchDone||!viewDone||token!==state.returnSequenceToken)return;
      state.selectedLineId=null;state.currentIndex=0;state.selectedStationName=null;
      state.immersiveStretch=0;
      applyImmersiveGeometry();
      document.body.classList.remove('route-returning','route-stretching');
      renderAll();
      setTimeout(()=>{if(token===state.returnSequenceToken&&!state.reviewOpen)setMapFlipped(true);},80);
    };
    animateStretch(0,RETURN_DURATION,()=>{stretchDone=true;finish();});
    animateView(state.overviewView,RETURN_DURATION,()=>{viewDone=true;finish();},easeInOutCubic);
  };

  const previousBeginMapNavigation=beginMapNavigation;
  beginMapNavigation=function(){stopTrueCamera();previousBeginMapNavigation();};

  // Initial cleanup and exact progress rebuild.
  routeLayer.querySelectorAll('.route-progress-halo').forEach(node=>node.remove());
  applyImmersiveGeometry();
  renderProgressPath();
})();
