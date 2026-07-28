
/* v3.4 immersive camera-follow patch. Data coordinates remain untouched. */
(() => {
  const PRACTICE_MODES = new Set(["timed", "full"]);
  const RETURN_ZOOM_MS = 690;
  const RETURN_FLIP_DELAY = 90;

  Object.assign(state, {
    cameraFollowEnabled: false,
    cameraSuspended: false,
    cameraFollowRAF: 0,
    cameraTargetView: null,
    cameraVelocity: {x:0, y:0},
    cameraLastTime: 0,
    cameraResumeTimer: 0,
    arrivalPulseTimer: 0,
    returnSequenceToken: 0,
    immersiveViewSize: null
  });

  function practiceActive(){
    return !!state.selectedLineId && PRACTICE_MODES.has(state.mode);
  }

  function mix(a,b,t){ return a+(b-a)*t; }
  function smoothstep(t){ t=clamp(t,0,1); return t*t*(3-2*t); }
  function easeInOutQuint(t){
    return t<.5 ? 16*t*t*t*t*t : 1-Math.pow(-2*t+2,5)/2;
  }
  function easeOutQuint(t){ return 1-Math.pow(1-t,5); }

  function parseHexColor(value){
    const text=String(value||"").trim();
    const short=/^#([0-9a-f]{3})$/i.exec(text);
    if(short){
      return short[1].split("").map(ch=>parseInt(ch+ch,16));
    }
    const full=/^#([0-9a-f]{6})$/i.exec(text);
    if(full){
      return [0,2,4].map(i=>parseInt(full[1].slice(i,i+2),16));
    }
    return [126,208,255];
  }
  function rgbText(rgb){
    return `rgb(${rgb.map(v=>Math.round(clamp(v,0,255))).join(",")})`;
  }
  function brightenColor(value,amount=.52){
    const rgb=parseHexColor(value);
    return rgbText(rgb.map(v=>mix(v,255,amount)));
  }

  function setProgressDash(path,progress){
    const raw=clamp(progress,0,1);
    const completed=state.reverse?1-raw:raw;
    path.setAttribute("stroke-dasharray",`${Math.max(.0001,completed)} ${Math.max(.0001,1-completed)}`);
    path.setAttribute("stroke-dashoffset",state.reverse?String(-raw):"0");
  }

  renderProgressPath = function(){
    const line=currentLine();
    if(!line||state.mode==="overview"&&!state.selectedLineId){
      routeLayer.querySelectorAll(".route-progress,.route-progress-halo").forEach(el=>el.remove());
      return;
    }
    const selectedGroup=routeGroupMap.get(line.id)||routeLayer.querySelector(`[data-line="${line.id}"]`);
    if(!selectedGroup)return;
    routeLayer.querySelectorAll(".route-progress,.route-progress-halo").forEach(el=>{
      if(el.parentElement!==selectedGroup)el.remove();
    });
    const hit=selectedGroup.querySelector(".route-hit");
    let halo=selectedGroup.querySelector(".route-progress-halo");
    let progressPath=selectedGroup.querySelector(".route-progress");
    if(!halo){
      halo=svgEl("path",{class:"route-progress-halo",pathLength:"1"});
      selectedGroup.insertBefore(halo,hit||null);
    }
    if(!progressPath){
      progressPath=svgEl("path",{class:"route-progress",pathLength:"1"});
      selectedGroup.insertBefore(progressPath,hit||null);
    }
    const bright=brightenColor(line.color,.5);
    halo.setAttribute("d",line.d);
    halo.setAttribute("stroke",bright);
    progressPath.setAttribute("d",line.d);
    progressPath.setAttribute("stroke",brightenColor(line.color,.68));
    setProgressDash(halo,state.trainProgress);
    setProgressDash(progressPath,state.trainProgress);
  };

  updateProgressPathPosition = function(progress=state.trainProgress){
    const line=currentLine();
    if(!line)return;
    const selectedGroup=routeGroupMap.get(line.id);
    if(!selectedGroup)return;
    selectedGroup.querySelectorAll(".route-progress,.route-progress-halo").forEach(path=>setProgressDash(path,progress));
  };

  function trainPoint(progress){
    const line=currentLine();
    const geometry=line&&getPathGeometry(line);
    if(!geometry)return null;
    const p=geometry.path.getPointAtLength(clamp(progress,0,1)*geometry.total);
    return {x:p.x,y:p.y};
  }

  function pointAhead(progress){
    const line=currentLine();
    const geometry=line&&getPathGeometry(line);
    if(!geometry)return trainPoint(progress);
    const direction=(state.trainTargetProgress-progress)|| (state.reverse?-.01:.01);
    const sign=direction<0?-1:1;
    const avgStep=1/Math.max(18,(line.stations.length-1)*1.45);
    const ahead=clamp(progress+sign*avgStep,0,1);
    const p=geometry.path.getPointAtLength(ahead*geometry.total);
    return {x:p.x,y:p.y};
  }

  function stopCameraFollow({commit=true}={}){
    if(state.cameraFollowRAF)cancelAnimationFrame(state.cameraFollowRAF);
    state.cameraFollowRAF=0;
    state.cameraLastTime=0;
    state.cameraVelocity.x=0;
    state.cameraVelocity.y=0;
    document.body.classList.remove("camera-following");
    if(commit)commitView();
  }

  function cameraIdealView(progress,force=false){
    const p=trainPoint(progress);
    if(!p)return null;
    const ahead=pointAhead(progress)||p;
    const view=state.view;
    const u=(p.x-view.x)/Math.max(.001,view.w);
    const v=(p.y-view.y)/Math.max(.001,view.h);
    // Train sits slightly above center because the practice dock occupies the bottom.
    const idealAnchorX=.48;
    const idealAnchorY=.42;
    const lookX=mix(p.x,ahead.x,.3);
    const lookY=mix(p.y,ahead.y,.3);
    const idealX=lookX-view.w*idealAnchorX;
    const idealY=lookY-view.h*idealAnchorY;
    const nx=Math.abs(u-idealAnchorX)/.19;
    const ny=Math.abs(v-idealAnchorY)/.16;
    const edge=Math.max(nx,ny);
    // A dead zone lets users zoom and inspect freely. Near/outside the edge, follow strongly.
    const strength=force?1:smoothstep((edge-.38)/.72);
    if(strength<.015)return null;
    return {
      x:mix(view.x,idealX,.18+.82*strength),
      y:mix(view.y,idealY,.18+.82*strength),
      w:view.w,
      h:view.h
    };
  }

  function startCameraSpring(){
    if(state.cameraFollowRAF||!state.cameraTargetView)return;
    document.body.classList.add("camera-following");
    function frame(now){
      state.cameraFollowRAF=0;
      if(!state.cameraFollowEnabled||state.cameraSuspended||!state.cameraTargetView){
        stopCameraFollow();
        return;
      }
      const last=state.cameraLastTime||now;
      const dt=Math.min(.034,Math.max(.001,(now-last)/1000));
      state.cameraLastTime=now;
      const target=state.cameraTargetView;
      const dx=target.x-state.view.x;
      const dy=target.y-state.view.y;
      // Critically damped-ish spring: fast when off-screen, gentle near the target.
      const distance=Math.hypot(dx/Math.max(1,state.view.w),dy/Math.max(1,state.view.h));
      const stiffness=52+76*clamp(distance/.28,0,1);
      const damping=2*Math.sqrt(stiffness)*.92;
      state.cameraVelocity.x+=(dx*stiffness-state.cameraVelocity.x*damping)*dt;
      state.cameraVelocity.y+=(dy*stiffness-state.cameraVelocity.y*damping)*dt;
      state.view.x+=state.cameraVelocity.x*dt;
      state.view.y+=state.cameraVelocity.y*dt;
      applyView();
      const settled=Math.abs(dx)<state.view.w*.00012&&Math.abs(dy)<state.view.h*.00012&&
        Math.abs(state.cameraVelocity.x)<.012&&Math.abs(state.cameraVelocity.y)<.012;
      if(settled){
        state.view.x=target.x;
        state.view.y=target.y;
        applyView();
        stopCameraFollow();
        return;
      }
      state.cameraFollowRAF=requestAnimationFrame(frame);
    }
    state.cameraFollowRAF=requestAnimationFrame(frame);
  }

  function requestCameraFollow(progress=state.trainProgress,{force=false}={}){
    if(!practiceActive()||!state.cameraFollowEnabled||state.cameraSuspended)return;
    const target=cameraIdealView(progress,force);
    if(!target)return;
    state.cameraTargetView=target;
    startCameraSpring();
  }

  const originalPositionTrain=positionTrain;
  positionTrain=function(progress=state.trainProgress){
    originalPositionTrain(progress);
    requestCameraFollow(progress);
  };

  function pulseArrival(originalIndex,{delay=0}={}){
    clearTimeout(state.arrivalPulseTimer);
    state.arrivalPulseTimer=setTimeout(()=>{
      const line=currentLine();
      if(!line||originalIndex<0||originalIndex>=line.stations.length)return;
      const p=visualPoint(line,originalIndex);
      const group=svgEl("g",{class:"arrival-pulse-group"});
      group.append(
        svgEl("circle",{class:"arrival-pulse outer",cx:p.x,cy:p.y,r:5}),
        svgEl("circle",{class:"arrival-pulse inner",cx:p.x,cy:p.y,r:5}),
        svgEl("circle",{class:"arrival-flash",cx:p.x,cy:p.y,r:4})
      );
      hoverLayer.appendChild(group);
      setTimeout(()=>group.remove(),1120);
    },delay);
  }

  function calculateFullLineView(line){
    const [minX,minY,maxX,maxY]=line.bbox;
    const padX=Math.max(48,(maxX-minX)*.095);
    const padY=Math.max(42,(maxY-minY)*.13);
    let x=minX-padX,y=minY-padY,w=maxX-minX+padX*2,h=maxY-minY+padY*2;
    const ratio=state.overviewView.w/state.overviewView.h;
    if(w/h>ratio){
      const targetH=w/ratio;
      y-=(targetH-h)/2;
      h=targetH;
    }else{
      const targetW=h*ratio;
      x-=(targetW-w)/2;
      w=targetW;
    }
    return {x,y,w,h};
  }

  function immersiveViewForProgress(progress,{strong=false}={}){
    const line=currentLine();
    if(!line)return {...state.overviewView};
    const full=calculateFullLineView(line);
    const count=Math.max(2,line.stations.length);
    // Longer routes zoom in more, making the selected route feel physically extended.
    const factor=clamp((strong?.49:.62)+8/count,.5,.72);
    const w=Math.max(245,full.w*factor);
    const h=w/(state.overviewView.w/state.overviewView.h);
    const p=trainPoint(progress)||{x:full.x+full.w/2,y:full.y+full.h/2};
    const ahead=pointAhead(progress)||p;
    const cx=mix(p.x,ahead.x,.27);
    const cy=mix(p.y,ahead.y,.27);
    state.immersiveViewSize={w,h};
    return {x:cx-w*.48,y:cy-h*.42,w,h};
  }

  fitSelectedLine=function(duration=620,onComplete=null){
    const line=currentLine();
    if(!line){ if(onComplete)onComplete(); return; }
    const progress=Number.isFinite(state.trainProgress)?state.trainProgress:visualProgress(line,originalIndexFromDisplay());
    const target=immersiveViewForProgress(progress,{strong:practiceActive()});
    animateView(target,duration,onComplete);
  };

  animateView=function(target,duration=520,onComplete=null,easing=easeInOutQuint){
    const token=++state.viewAnimationToken;
    stopCameraFollow({commit:false});
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
      const p=Math.min(1,(now-t0)/duration),e=easing(p);
      state.view={
        x:mix(start.x,target.x,e),
        y:mix(start.y,target.y,e),
        w:mix(start.w,target.w,e),
        h:mix(start.h,target.h,e)
      };
      applyView();
      if(p<1)state.viewAnimationRAF=requestAnimationFrame(frame);
      else{
        state.viewAnimationRAF=0;
        state.view={...target};
        commitView();
        document.body.classList.remove("is-view-animating");
        if(onComplete)onComplete();
      }
    }
    state.viewAnimationRAF=requestAnimationFrame(frame);
  };

  const originalBeginMapNavigation=beginMapNavigation;
  beginMapNavigation=function(){
    state.cameraSuspended=true;
    stopCameraFollow();
    originalBeginMapNavigation();
  };

  const originalScheduleMapNavigationEnd=scheduleMapNavigationEnd;
  scheduleMapNavigationEnd=function(delay=90){
    originalScheduleMapNavigationEnd(delay);
    clearTimeout(state.cameraResumeTimer);
    state.cameraResumeTimer=setTimeout(()=>{
      // Keep the user's manual pan/zoom. Following resumes on the next typing/train movement.
      state.cameraSuspended=false;
    },delay+80);
  };

  const originalSetMode=setMode;
  setMode=async function(mode){
    await originalSetMode(mode);
    if(!PRACTICE_MODES.has(mode)||!state.selectedLineId){
      state.cameraFollowEnabled=false;
      stopCameraFollow();
      return;
    }
    state.cameraFollowEnabled=true;
    state.cameraSuspended=false;
    const target=immersiveViewForProgress(state.trainProgress,{strong:true});
    animateView(target,720,()=>{
      pulseArrival(originalIndexFromDisplay(state.currentIndex));
      requestCameraFollow(state.trainProgress,{force:true});
    });
  };

  const originalSelectLine=selectLine;
  selectLine=function(lineId,focus=true,originalIndex=0){
    state.cameraFollowEnabled=false;
    stopCameraFollow();
    originalSelectLine(lineId,focus,originalIndex);
    const delay=focus?820:80;
    pulseArrival(originalIndex,{delay});
  };

  clearSelection=function(){
    const token=++state.returnSequenceToken;
    stopTimer();
    stopBroadcast(true);
    stopTrainMotion();
    stopCameraFollow();
    state.cameraFollowEnabled=false;
    state.cameraSuspended=false;
    resetWheelAccumulator();
    state.pendingOverviewReturn=false;
    document.body.classList.remove("is-map-navigating","practice-on","camera-following");
    state.selectedLineId=null;
    state.currentIndex=0;
    state.selectedStationName=null;
    state.mode="overview";
    state.running=false;
    state.showVertices=false;
    hero.classList.remove("hidden");
    renderNavigationShell();
    // First shrink back to the complete network, then turn the cover over.
    animateView(state.overviewView,RETURN_ZOOM_MS,()=>{
      if(token!==state.returnSequenceToken)return;
      if(!state.reviewOpen){
        setTimeout(()=>{
          if(token===state.returnSequenceToken)setMapFlipped(true);
        },RETURN_FLIP_DELAY);
      }
      scheduleFullRender(FLIP_DURATION+RETURN_FLIP_DELAY+20);
    },easeOutQuint);
  };

  completeTyping=async function(){
    if(state.answerLocked)return;
    state.answerLocked=true;
    const stations=displayStations(),station=currentStation(),target=practiceTarget(station);
    state.correct+=1;
    state.attempts+=1;
    typeInput.classList.add("correct");
    state.typingFraction=1;
    const segment=typingSegment(1);
    setTrainTarget(segment.end);
    updatePracticeProgressBar(1);
    renderPracticePinyin(true);
    requestCameraFollow(segment.end,{force:true});
    const fb=document.getElementById("feedback");
    fb.className="feedback ok";
    fb.textContent=`正确：${station.name} · ${target.display}`;
    playStationAudio(station,{silent:true}).catch(()=>{});
    await waitForTrainTarget(segment.end,430);
    const arrivedDisplay=Math.min(state.currentIndex+1,stations.length-1);
    pulseArrival(originalIndexFromDisplay(arrivedDisplay));
    await delay(170);
    if(state.currentIndex<stations.length-1){
      state.currentIndex+=1;
      state.trainProgress=segment.end;
      state.trainTargetProgress=segment.end;
      state.typingFraction=0;
      state.selectedStationName=currentStation().name;
      typeInput.value="";
      state.lastValidInput="";
      typeInput.className="type-input";
      state.answerLocked=false;
      renderDynamic();
      requestCameraFollow(state.trainProgress,{force:true});
      const nextTarget=practiceTarget(currentStation());
      fb.className="feedback";
      fb.textContent=`下一站：${currentStation().name} · ${nextTarget.display}`;
      typeInput.focus();
    }else{
      stopTimer();
      fb.textContent=`完成全线，共答对 ${state.correct} 站。`;
      state.answerLocked=false;
      typeInput.classList.remove("correct");
    }
  };

  const originalSetCurrentByOriginalIndex=setCurrentByOriginalIndex;
  setCurrentByOriginalIndex=function(originalIndex){
    originalSetCurrentByOriginalIndex(originalIndex);
    pulseArrival(originalIndex,{delay:20});
    if(practiceActive())requestCameraFollow(state.trainProgress,{force:true});
  };

  const originalRenderStations=renderStations;
  renderStations=function(){
    originalRenderStations();
    stationLayer.querySelectorAll(".pulse-ring").forEach(el=>el.remove());
  };

  // Remove any permanent ripple left by a render that ran before this patch loaded.
  document.querySelectorAll(".pulse-ring").forEach(el=>el.remove());
  renderRoutes();
})();
