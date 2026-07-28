const SPELLING_SCHEME_LABELS={
  pinyin:"普通话全拼",jyutping:"粤拼",zrm:"自然码双拼",flypy:"小鹤双拼",mspy:"微软双拼",
  sogou:"搜狗双拼",abc:"智能 ABC 双拼",jiajia:"拼音加加双拼",ziguang:"紫光双拼"
};
const DOUBLE_PINYIN_SCHEMES={
  zrm:{zero:"repeat",initials:{zh:"v",ch:"i",sh:"u"},finals:{iu:"q",ia:"w",ua:"w",er:"r",uan:"r",van:"r",ue:"t",ve:"t",v:"y",ing:"y",uai:"y",uo:"o",un:"p",vn:"p",ong:"s",iong:"s",iang:"d",uang:"d",en:"f",eng:"g",ang:"h",ian:"m",an:"j",iao:"c",ao:"k",ai:"l",ei:"z",ie:"x",ui:"v",ou:"b",in:"n"}},
  flypy:{zero:"repeat",initials:{zh:"v",ch:"i",sh:"u"},finals:{iu:"q",ei:"w",uan:"r",van:"r",ue:"t",ve:"t",un:"y",vn:"y",uo:"o",ie:"p",ong:"s",iong:"s",ing:"k",uai:"k",ai:"d",en:"f",eng:"g",iang:"l",uang:"l",ang:"h",ian:"m",an:"j",ou:"z",ia:"x",ua:"x",iao:"n",ao:"c",ui:"v",in:"b",er:"r",v:"v"}},
  mspy:{zero:"o",initials:{zh:"v",ch:"i",sh:"u"},finals:{iu:"q",ia:"w",ua:"w",er:"r",uan:"r",van:"r",ue:"t",ve:"t",v:"y",uai:"y",uo:"o",un:"p",vn:"p",ong:"s",iong:"s",iang:"d",uang:"d",en:"f",eng:"g",ang:"h",ian:"m",an:"j",iao:"c",ao:"k",ai:"l",ei:"z",ie:"x",ui:"v",ou:"b",in:"n",ing:";"}},
  sogou:{zero:"o",initials:{zh:"v",ch:"i",sh:"u"},finals:{iu:"q",ia:"w",ua:"w",er:"r",uan:"r",van:"r",ue:"t",ve:"t",v:"y",uai:"y",uo:"o",un:"p",vn:"p",ong:"s",iong:"s",iang:"d",uang:"d",en:"f",eng:"g",ang:"h",ian:"m",an:"j",iao:"c",ao:"k",ai:"l",ei:"z",ie:"x",ui:"v",ou:"b",in:"n",ing:";"}},
  abc:{zero:"o",initials:{zh:"a",ch:"e",sh:"v"},finals:{ei:"q",ian:"w",er:"r",iu:"r",iang:"t",uang:"t",ing:"y",uo:"o",uan:"p",van:"p",ong:"s",iong:"s",ia:"d",ua:"d",en:"f",eng:"g",ang:"h",an:"j",iao:"z",ao:"k",in:"c",uai:"c",ai:"l",ie:"x",ou:"b",un:"n",vn:"n",ue:"m",ve:"m",ui:"m",v:"v"}},
  jiajia:{zero:"o",initials:{zh:"v",ch:"u",sh:"i"},finals:{iu:"n",ia:"b",ua:"b",er:"q",ing:"q",uan:"c",van:"c",ue:"x",ve:"x",uai:"x",uo:"o",un:"z",vn:"z",ong:"y",iong:"y",iang:"h",uang:"h",en:"r",eng:"t",ang:"g",ian:"j",an:"f",iao:"k",ao:"d",ai:"s",ei:"w",ie:"m",ui:"v",ou:"p",in:"l",v:"v"}},
  ziguang:{zero:"o",initials:{zh:"u",ch:"a",sh:"i"},finals:{en:"w",eng:"t",in:"y",uai:"y",uo:"o",ai:"p",iang:"g",uang:"g",ang:"s",ie:"d",ian:"f",ong:"h",iong:"h",er:"j",iu:"j",ei:"k",uan:"l",van:"l",ing:";",ou:"z",ia:"x",ua:"x",iao:"b",ue:"n",ve:"n",ui:"n",un:"m",vn:"m",ao:"q",an:"r",v:"v"}}
};
function savePracticePrefs(){
  try{localStorage.setItem(PRACTICE_PREFS_KEY,JSON.stringify({scheme:state.spellingScheme,inlineHint:state.inlineHint}));}catch(_err){}
}
function normalizePinyin(value){
  return String(value||"").toLowerCase().replace(/[üǖǘǚǜ]/g,"v").replace(/u:/g,"v").replace(/[1-9]/g,"").replace(/[^a-zv;]/g,"");
}
function splitPinyinSyllable(raw){
  let syllable=String(raw||"").toLowerCase().replace(/[üǖǘǚǜ]/g,"v").replace(/u:/g,"v").replace(/[1-5]/g,"");
  const compound=["zh","ch","sh"].find(item=>syllable.startsWith(item));
  let initial=compound||(/^([bpmfdtnlgkhjqxrzcsyw])/.exec(syllable)||[])[1]||"";
  let final=syllable.slice(initial.length);
  if(["j","q","x","y"].includes(initial)&&final.startsWith("u"))final="v"+final.slice(1);
  return {syllable,initial,final};
}
function doublePinyinSyllable(raw,schemeId){
  const scheme=DOUBLE_PINYIN_SCHEMES[schemeId];
  if(!scheme)return raw;
  const {syllable,initial,final}=splitPinyinSyllable(raw);
  if(!syllable)return "";
  if(!initial){
    const finalKey=scheme.finals[syllable]||scheme.finals[final]||syllable;
    if(scheme.zero==="o")return "o"+finalKey;
    const first=syllable[0];
    if(syllable.length===1)return first+first;
    return first+finalKey;
  }
  const initialKey=scheme.initials[initial]||initial;
  const finalKey=scheme.finals[final]||final||initialKey;
  return initialKey+finalKey;
}
function doublePinyinText(pinyin,schemeId){
  return String(pinyin||"").trim().split(/\s+/).filter(Boolean).map(token=>doublePinyinSyllable(token,schemeId)).join(" ");
}
let jyutpingLoadPromise=null;
let jyutpingCache={};
try{jyutpingCache=JSON.parse(localStorage.getItem(JYUTPING_CACHE_KEY)||"{}");}catch(_err){jyutpingCache={};}
function jyutpingApi(){
  const api=window.ToJyutping&&(window.ToJyutping.default||window.ToJyutping);
  return api&&typeof api.getJyutpingText==="function"?api:null;
}
function ensureJyutpingLibrary(){
  const ready=jyutpingApi();
  if(ready)return Promise.resolve(ready);
  if(jyutpingLoadPromise)return jyutpingLoadPromise;
  const sources=[
    "https://unpkg.com/to-jyutping@3.1.1/dist/index.js",
    "https://cdn.jsdelivr.net/npm/to-jyutping@3.1.1/dist/index.js"
  ];
  jyutpingLoadPromise=new Promise((resolve,reject)=>{
    function trySource(index){
      if(index>=sources.length){reject(new Error("无法加载粤拼库"));return;}
      const script=document.createElement("script");
      script.src=sources[index];
      script.async=true;
      const timer=setTimeout(()=>{script.remove();trySource(index+1);},9000);
      script.onload=()=>{
        clearTimeout(timer);
        const api=jyutpingApi();
        if(api)resolve(api);else{script.remove();trySource(index+1);}
      };
      script.onerror=()=>{clearTimeout(timer);script.remove();trySource(index+1);};
      document.head.appendChild(script);
    }
    trySource(0);
  }).catch(err=>{jyutpingLoadPromise=null;throw err;});
  return jyutpingLoadPromise;
}
async function prepareJyutpingForStation(st,api=null){
  if(!st)return "";
  if(st.jyutping)return st.jyutping;
  if(jyutpingCache[st.name]){st.jyutping=jyutpingCache[st.name];return st.jyutping;}
  api=api||await ensureJyutpingLibrary();
  const value=String(api.getJyutpingText(st.name)||"").trim();
  if(!value)throw new Error(`未找到“${st.name}”的粤拼`);
  st.jyutping=value;
  jyutpingCache[st.name]=value;
  return value;
}
async function prepareJyutpingForLine(line=currentLine()){
  if(!line)return false;
  const allCached=line.stations.every(st=>st.jyutping||jyutpingCache[st.name]);
  if(allCached){
    line.stations.forEach(st=>{if(!st.jyutping)st.jyutping=jyutpingCache[st.name];});
    return true;
  }
  state.jyutpingLoading=true;
  typeInput.disabled=true;
  try{
    const api=await ensureJyutpingLibrary();
    for(const st of line.stations)await prepareJyutpingForStation(st,api);
    try{localStorage.setItem(JYUTPING_CACHE_KEY,JSON.stringify(jyutpingCache));}catch(_err){}
    return true;
  }catch(err){
    showToast(err.message+"；请联网后重试");
    const fb=document.getElementById("feedback");
    if(fb){fb.className="feedback bad";fb.textContent=err.message+"，已保留当前页面数据。";}
    return false;
  }finally{
    state.jyutpingLoading=false;
    typeInput.disabled=false;
  }
}
function practiceTarget(st=currentStation()){
  if(!st)return {display:"",normalized:"",tokens:[]};
  let display="";
  if(state.spellingScheme==="pinyin")display=String(st.pinyin||"").trim();
  else if(state.spellingScheme==="jyutping")display=String(st.jyutping||jyutpingCache[st.name]||"").trim();
  else display=doublePinyinText(st.pinyin,state.spellingScheme);
  const tokens=display.split(/\s+/).filter(Boolean);
  return {display,normalized:normalizePinyin(display),tokens};
}
function renderTypingGhost(target,typed,forceComplete=false){
  if(!typingGhost)return;
  const typedLength=forceComplete?target.normalized.length:typed.length;
  typingGhost.innerHTML="";
  let logical=0;
  [...(target.display||"")].forEach(char=>{
    const span=document.createElement("span");
    span.textContent=char===" "?"\u00a0":char;
    const significant=/[a-zv;]/i.test(char);
    if(significant){
      span.className=logical<typedLength?"typed":logical===typedLength?"cursor-char":"pending";
      logical+=1;
    }else if(/[1-6]/.test(char)){
      span.className=`tone ${logical<=typedLength?"typed":"pending"}`;
    }
    typingGhost.appendChild(span);
  });
}
function renderPracticePinyin(forceComplete=false){
  const st=currentStation(),box=document.getElementById("practicePinyin");
  if(!st||!box)return;
  const target=practiceTarget(st);
  const typed=forceComplete?target.normalized:normalizePinyin(typeInput.value);
  let cursor=0;
  box.innerHTML="";
  (target.tokens.length?target.tokens:[state.spellingScheme==="jyutping"?"粤拼加载中":"待校核"]).forEach(token=>{
    const norm=normalizePinyin(token),span=document.createElement("span");
    span.textContent=token;
    if(typed.length>=cursor+norm.length)span.className="matched";
    else if(typed.length>cursor)span.className="active";
    box.appendChild(span);
    cursor+=norm.length;
  });
  typingField.classList.toggle("inline",state.inlineHint);
  document.body.classList.toggle("practice-inline-hint",state.inlineHint);
  renderTypingGhost(target,typed,forceComplete);
}
function nonlinearTypingProgress(value){
  const t=clamp(value,0,1),smooth=t*t*(3-2*t);
  return .16*t+.84*smooth;
}
function typingSegment(eased=state.typingFraction){
  const line=currentLine(),stations=displayStations();
  if(!line||!stations.length)return {start:0,end:0,target:0};
  const start=visualProgress(line,originalIndexFromDisplay(state.currentIndex));
  if(state.currentIndex>=stations.length-1)return {start,end:start,target:start};
  const end=visualProgress(line,originalIndexFromDisplay(state.currentIndex+1));
  return {start,end,target:start+(end-start)*clamp(eased,0,1)};
}
function updatePracticeProgressBar(eased=state.typingFraction){
  const stations=displayStations();
  const denominator=Math.max(1,stations.length-1);
  const overall=stations.length<=1?1:clamp((state.currentIndex+(state.currentIndex<stations.length-1?eased:0))/denominator,0,1);
  document.getElementById("progressBar").style.width=`${overall*100}%`;
}
function updateTypingMotion(typedLength,expectedLength){
  const ratio=expectedLength?clamp(typedLength/expectedLength,0,1):0;
  state.typingFraction=nonlinearTypingProgress(ratio);
  const segment=typingSegment(state.typingFraction);
  setTrainTarget(segment.target);
  updatePracticeProgressBar(state.typingFraction);
}
function renderPractice(){
  const line=currentLine(),visible=!!line&&state.mode!=="overview";
  practiceDock.classList.toggle("visible",visible);
  document.body.classList.toggle("practice-on",visible);
  const ft=document.getElementById("focusToggle");
  if(ft){
    ft.textContent=state.focusMode?"显示信息栏":"专注模式";
    ft.classList.toggle("active",state.focusMode);
  }
  if(!visible)return;
  const st=currentStation(),target=practiceTarget(st);
  document.getElementById("practiceStation").textContent=st.name;
  const challenge=state.mode==="timed"?"30 秒挑战":"全线挑战";
  document.getElementById("practiceLabel").textContent=`${SPELLING_SCHEME_LABELS[state.spellingScheme]} · ${challenge}`;
  document.getElementById("timeStat").textContent=state.mode==="timed"?state.seconds:"∞";
  document.getElementById("correctStat").textContent=state.correct;
  document.getElementById("accuracyStat").textContent=state.attempts?`${Math.round(state.correct/state.attempts*100)}%`:"—";
  spellingSchemeSelect.value=state.spellingScheme;
  inlineHintToggle.checked=state.inlineHint;
  typeInput.placeholder=state.inlineHint?"":"照着上方提示输入";
  updatePracticeProgressBar(state.typingFraction);
  renderPracticePinyin();
  if(state.spellingScheme==="jyutping"&&!target.display&&!state.jyutpingLoading){
    document.getElementById("feedback").textContent="粤拼尚未准备好，请重新选择粤拼方案。";
  }
}
function renderModes(){
  document.querySelectorAll(".mode-btn").forEach(btn=>btn.classList.toggle("active",btn.dataset.mode===state.mode))
}
async function setMode(mode){
  if(mode==="overview"){
    clearSelection();
    return
  }
  if(!state.selectedLineId){
    showToast("请先点击地图中的一条线路");
    return
  }
  if(state.spellingScheme==="jyutping"){
    showToast("正在准备本线粤拼……");
    if(!await prepareJyutpingForLine(currentLine()))return;
  }
  setMapFlipped(false);
  stopTimer();
  stopBroadcast(true);
  state.mode=mode;
  state.focusMode=true;
  state.currentIndex=0;
  state.correct=0;
  state.attempts=0;
  state.seconds=30;
  state.running=true;
  state.answerLocked=false;
  state.lastValidInput="";
  const line=currentLine(),idx=originalIndexFromDisplay(0);
  state.trainProgress=visualProgress(line,idx);
  state.trainTargetProgress=state.trainProgress;
  state.typingFraction=0;
  state.selectedStationName=currentStation().name;
  typeInput.value="";
  typeInput.className="type-input";
  const fb=document.getElementById("feedback");
  fb.className="feedback";
  fb.textContent=mode==="timed"?"输入第一个字符后开始计时；列车会随输入实时前进。":"从首站开始；输入进度会平滑驱动列车前往下一站。";
  renderDynamic();
  setTimeout(()=>typeInput.focus(),90);
}
function startTimer(){
  stopTimer();
  state.seconds=30;
  state.timer=setInterval(()=>{
    state.seconds-=1;
    renderPractice();
    if(state.seconds<=0){
      stopTimer();
      state.running=false;
      state.answerLocked=true;
      const fb=document.getElementById("feedback");
      fb.className="feedback";
      fb.textContent=`时间到：答对 ${state.correct} 站，正确率 ${state.attempts?Math.round(state.correct/state.attempts*100):0}%。`;
      typeInput.disabled=true;
      setTimeout(()=>{
        typeInput.disabled=false;
        state.answerLocked=false
      }
      ,700);
    }
  }
  ,1000);
}
function stopTimer(){
  if(state.timer){
    clearInterval(state.timer);
    state.timer=null
  }
}
function shakeInput(message){
  typeInput.classList.remove("shake","wrong");
  void typeInput.offsetWidth;
  typeInput.classList.add("shake","wrong");
  const fb=document.getElementById("feedback");
  fb.className="feedback bad";
  fb.textContent=message;
  setTimeout(()=>typeInput.classList.remove("shake","wrong"),360);
}
async function completeTyping(){
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
  const fb=document.getElementById("feedback");
  fb.className="feedback ok";
  fb.textContent=`正确：${station.name} · ${target.display}`;
  playStationAudio(station,{silent:true}).catch(()=>{});
  await waitForTrainTarget(segment.end,360);
  await delay(110);
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
}
function handleTypingInput(){
  if(state.answerLocked||!currentStation()||state.mode==="overview")return;
  const target=practiceTarget(currentStation());
  const expected=target.normalized,typed=normalizePinyin(typeInput.value);
  if(state.mode==="timed"&&!state.timer&&state.seconds>0&&typed)startTimer();
  if(!expected){
    shakeInput(state.spellingScheme==="jyutping"?"粤拼仍在加载，请稍后重试。":"当前站缺少可练习的拼音数据。");
    return;
  }
  if(!typed){
    state.lastValidInput=typeInput.value;
    typeInput.classList.remove("wrong","correct");
    updateTypingMotion(0,expected.length);
    renderPracticePinyin();
    return;
  }
  if(expected.startsWith(typed)){
    state.lastValidInput=typeInput.value;
    typeInput.classList.remove("wrong");
    updateTypingMotion(typed.length,expected.length);
    renderPracticePinyin();
    const fb=document.getElementById("feedback");
    fb.className="feedback";
    fb.textContent=typed===expected?"已完整匹配，列车正在抵达下一站……":`已输入 ${typed.length}/${expected.length}，列车随进度前进。`;
    if(typed===expected)completeTyping();
  }else{
    state.attempts+=1;
    const invalid=typeInput.value;
    typeInput.value=state.lastValidInput;
    const validTyped=normalizePinyin(state.lastValidInput);
    updateTypingMotion(validTyped.length,expected.length);
    shakeInput(`“${invalid.slice(-1)}”不匹配当前${SPELLING_SCHEME_LABELS[state.spellingScheme]}。`);
    renderPracticePinyin();
  }
}
function setCurrentByOriginalIndex(originalIndex){
  const line=currentLine();
  state.currentIndex=displayIndexFromOriginal(originalIndex);
  state.selectedStationName=line.stations[originalIndex].name;
  state.trainProgress=visualProgress(line,originalIndex);
  state.trainTargetProgress=state.trainProgress;
  state.typingFraction=0;
  stopTrainMotion();
  typeInput.value="";
  state.lastValidInput="";
  state.answerLocked=false;
  renderDynamic();
}
