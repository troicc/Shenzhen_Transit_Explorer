const SVG_NS = "http://www.w3.org/2000/svg";
const KEY_STATIONS = new Set([
  "罗湖","老街","大剧院","科学馆","岗厦北","岗厦","福田","会展中心","购物公园","车公庙",
  "深圳北","前海湾","宝安中心","机场北","机场东","后海","红树湾南","赤湾","松岗","光明",
  "凤凰城","布吉","五和","大运","黄贝岭","红岭北","福民","福田口岸","坪山围","坪山","盐田路"
]);
const state = {
  selectedLineId: null,
  reverse: false,
  currentIndex: 0,
  selectedStationName: null,
  mode: "overview",
  showAllLabels: false,
  balancedSpacing: true,
  running: false,
  correct: 0,
  attempts: 0,
  seconds: 30,
  timer: null,
  trainProgress: 0,
  view: {
    x:20,y:45,w:1240,h:625
  }
  ,
  overviewView: {
    x:20,y:45,w:1240,h:625
  }
  ,
  focusMode:true,
  draggingMap:false,
  dragMoved:false,
  lastX:0,
  lastY:0,
  panRAF:0,
  pendingPan:null,
  reviewOpen:false,
  showVertices:false,
  dragVertex:null,
  dragStation:null,
  pointerId:null,
  dragRAF:0,
  pendingDragPoint:null,
  initialDrawn:false,
  broadcasting:false,
  broadcastToken:0,
  answerLocked:false,
  lastValidInput:"",
  undoStack:[],
  flipTimer:null,
  viewAnimationRAF:0,
  viewAnimationToken:0,
  trainPositionRAF:0,
  dragVertexPoints:null,
  deferredRenderTimer:0,
  navigationStopTimer:0,
  wheelRAF:0,
  wheelPanX:0,
  wheelPanY:0,
  wheelZoomDelta:0,
  wheelAnchorX:.5,
  wheelAnchorY:.5,
  wheelZoomingOut:false,
  safariGesture:null,
  gestureRAF:0,
  pendingGestureScale:1,
  pendingOverviewReturn:false,
  spellingScheme:"pinyin",
  inlineHint:false,
  typingFraction:0,
  trainTargetProgress:0,
  trainMotionRAF:0,
  trainMotionLast:0,
  jyutpingLoading:false
}
;
const routeLayer = document.getElementById("routeLayer");
const stationLayer = document.getElementById("stationLayer");
const transferLayer = document.getElementById("transferLayer");
const labelLayer = document.getElementById("labelLayer");
const reviewLayer = document.getElementById("reviewLayer");
const hoverLayer = document.getElementById("hoverLayer");
const train = document.getElementById("train");
const mapSvg = document.getElementById("metroMap");
const mapStage = document.getElementById("mapStage");
const mapFlipStage = document.getElementById("mapFlipStage");
const hero = document.getElementById("hero");
const focusCard = document.getElementById("focusCard");
const stationCard = document.getElementById("stationCard");
const practiceDock = document.getElementById("practiceDock");
const lineInfoDock = document.getElementById("lineInfoDock");
const lineStrip = document.getElementById("lineStrip");
const typeInput = document.getElementById("typeInput");
const typingField = document.getElementById("typingField");
const typingGhost = document.getElementById("typingGhost");
const spellingSchemeSelect = document.getElementById("spellingScheme");
const inlineHintToggle = document.getElementById("inlineHintToggle");
const PRACTICE_PREFS_KEY = "zhanyue-practice-prefs-v2";
const JYUTPING_CACHE_KEY = "zhanyue-jyutping-cache-v1";
try{
  const prefs=JSON.parse(localStorage.getItem(PRACTICE_PREFS_KEY)||"{}");
  if(["pinyin","jyutping","zrm","flypy","mspy","sogou","abc","jiajia","ziguang"].includes(prefs.scheme))state.spellingScheme=prefs.scheme;
  state.inlineHint=!!prefs.inlineHint;
}catch(_err){}
spellingSchemeSelect.value=state.spellingScheme;
inlineHintToggle.checked=state.inlineHint;
let lineMap = new Map();
const pathMap = new Map();
const pathGeometryCache = new Map();
const polylineCache = new Map();
const routeGroupMap = new Map();
let routeGeometrySignature = "";
let stationOccurrences = new Map();
let stationNodeMap = new Map();
let overviewStationsCache = [];
let layoutObstacles=[];
const balancedCache = new Map();
let currentAudio = null;
let currentAudioUrl = null;
let committedView = {...state.view};
const IS_SAFARI = /^((?!chrome|android).)*safari/i.test(navigator.userAgent);
document.body.classList.toggle("is-safari",IS_SAFARI);
document.body.classList.toggle("practice-inline-hint",state.inlineHint);
function rebuildIndexes(){
  lineMap = new Map(LINES.map(line => [line.id,line]));
  stationOccurrences = new Map();
  const overviewMap = new Map();
  LINES.forEach(line => line.stations.forEach((station,index) => {
    if(!stationOccurrences.has(station.name)) stationOccurrences.set(station.name,[]);
    stationOccurrences.get(station.name).push({line,index,station});
    if(!overviewMap.has(station.name))overviewMap.set(station.name,{line,st:station,index});
  }));
  overviewStationsCache=[...overviewMap.values()];
  balancedCache.clear();
  pathGeometryCache.clear();
  polylineCache.clear();
}
rebuildIndexes();
function codeFor(line){
  if(line.id==="2-8") return "2/8";
  if(line.id==="6b") return "6支";
  return line.id;
}
function selectedRouteColor(value){
  const m=String(value||"").trim().match(/^#([0-9a-f]{6})$/i);
  if(!m)return value;
  const n=parseInt(m[1],16),mix=.22;
  const r=(n>>16)&255,g=(n>>8)&255,b=n&255;
  const lift=c=>Math.round(c+(255-c)*mix).toString(16).padStart(2,"0");
  return `#${lift(r)}${lift(g)}${lift(b)}`;
}
function displayStations(){
  if(!state.selectedLineId) return [];
  const stations = lineMap.get(state.selectedLineId).stations;
  return state.reverse ? [...stations].reverse() : stations;
}
function originalIndexFromDisplay(index=state.currentIndex){
  const line=currentLine();
  if(!line)return -1;
  return state.reverse ? line.stations.length-1-index : index;
}
function displayIndexFromOriginal(index){
  const line=currentLine();
  if(!line)return 0;
  return state.reverse ? line.stations.length-1-index : index;
}
function currentLine(){
  return state.selectedLineId ? lineMap.get(state.selectedLineId) : null;
}
function currentStation(){
  return displayStations()[state.currentIndex] || null;
}
function clamp(value,min,max){
  return Math.max(min,Math.min(max,value));
}
function svgEl(tag,attrs={
}
){
  const el=document.createElementNS(SVG_NS,tag);
  Object.entries(attrs).forEach(([k,v])=>el.setAttribute(k,String(v)));
  return el;
}
function parsePathPoints(d){
  const nums=(d.match(/-?\d+(?:\.\d+)?/g)||[]).map(Number);
  const pts=[];
  for(let i=0;
  i+1<nums.length;
  i+=2)pts.push({
    x:nums[i],y:nums[i+1]
  }
  );
  return pts;
}
function pointsToPath(points){
  return points.map((p,i)=>`${i?"L":"M"} ${p.x.toFixed(2)} ${p.y.toFixed(2)}`).join(" ");
}
function getPolylineMetrics(line){
  const cached=polylineCache.get(line.id);
  if(cached&&cached.d===line.d)return cached;
  const pts=parsePathPoints(line.d),lengths=[];
  let total=0;
  for(let i=0;i<pts.length-1;i++){
    const len=Math.hypot(pts[i+1].x-pts[i].x,pts[i+1].y-pts[i].y);
    lengths.push(len);
    total+=len;
  }
  const value={d:line.d,pts,lengths,total};
  polylineCache.set(line.id,value);
  return value;
}
function projectToPolyline(line,x,y){
  const {pts,lengths,total}=getPolylineMetrics(line);
  let best={distance:Infinity,progress:0,x:pts[0]?.x||0,y:pts[0]?.y||0};
  let acc=0;
  for(let i=0;i<lengths.length;i++){
    const a=pts[i],b=pts[i+1],len=lengths[i];
    if(!len)continue;
    const vx=b.x-a.x,vy=b.y-a.y;
    const t=clamp(((x-a.x)*vx+(y-a.y)*vy)/(len*len),0,1);
    const px=a.x+t*vx,py=a.y+t*vy;
    const distance=Math.hypot(x-px,y-py);
    if(distance<best.distance)best={distance,progress:total?(acc+t*len)/total:0,x:px,y:py};
    acc+=len;
  }
  return best;
}
function getPathGeometry(line){
  const path=pathMap.get(line.id);
  if(!path)return null;
  const cached=pathGeometryCache.get(line.id);
  if(cached&&cached.path===path&&cached.d===line.d)return cached;
  const value={path,d:line.d,total:path.getTotalLength()};
  pathGeometryCache.set(line.id,value);
  return value;
}
function invalidateLineGeometry(lineId){
  pathGeometryCache.delete(lineId);
  polylineCache.delete(lineId);
}
function pointAtProgress(line,progress){
  const geometry=getPathGeometry(line);
  if(!geometry)return {x:0,y:0};
  return geometry.path.getPointAtLength(clamp(progress,0,1)*geometry.total);
}
function tangentAtProgress(line,progress){
  const geometry=getPathGeometry(line);
  if(!geometry)return {x:1,y:0};
  const s=clamp(progress,0,1)*geometry.total;
  const a=geometry.path.getPointAtLength(Math.max(0,s-3));
  const b=geometry.path.getPointAtLength(Math.min(geometry.total,s+3));
  const len=Math.hypot(b.x-a.x,b.y-a.y)||1;
  return {x:(b.x-a.x)/len,y:(b.y-a.y)/len};
}
function balancedProgresses(line){
  const signature=line.stations.map(s=>s.progress.toFixed(5)).join(",");
  const cached=balancedCache.get(line.id);
  if(cached&&cached.signature===signature)return cached.result;
  const actual=line.stations.map(s=>s.progress);
  const result=[...actual];
  const anchors=[0];
  line.stations.forEach((s,i)=>{
    if(i>0&&i<line.stations.length-1&&s.transfer)anchors.push(i);
  });
  anchors.push(line.stations.length-1);
  for(let a=0;a<anchors.length-1;a++){
    const left=anchors[a],right=anchors[a+1];
    if(right-left<2)continue;
    const p0=actual[left],p1=actual[right];
    for(let i=left+1;i<right;i++){
      const t=(i-left)/(right-left);
      const even=p0+(p1-p0)*t;
      result[i]=actual[i]*.38+even*.62;
    }
  }
  const total=getPathGeometry(line)?.total||600;
  const minGap=Math.min(.012,7/Math.max(1,total));
  for(let i=1;i<result.length;i++)result[i]=Math.max(result[i],result[i-1]+minGap);
  for(let i=result.length-2;i>=0;i--)result[i]=Math.min(result[i],result[i+1]-minGap);
  result[0]=actual[0];
  result[result.length-1]=actual.at(-1);
  balancedCache.set(line.id,{signature,result});
  return result;
}
function visualProgress(line,index){
  if(state.selectedLineId===line.id && state.balancedSpacing && !state.reviewOpen){
    return balancedProgresses(line)[index];
  }
  return line.stations[index].progress;
}
function visualPoint(line,index){
  return pointAtProgress(line,visualProgress(line,index));
}
function currentVisualProgress(){
  const line=currentLine();
  if(!line)return 0;
  return visualProgress(line,originalIndexFromDisplay());
}
function currentRouteGeometrySignature(){
  return LINES.map(line=>`${line.id}:${line.color}:${line.d}`).join("|");
}
