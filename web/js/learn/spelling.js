export const SPELLING_SCHEMES = Object.freeze([
  Object.freeze({id: 'pinyin', label: '普通话全拼'}),
  Object.freeze({id: 'jyutping', label: '粤拼'}),
  Object.freeze({id: 'zrm', label: '自然码双拼'}),
  Object.freeze({id: 'flypy', label: '小鹤双拼'}),
  Object.freeze({id: 'mspy', label: '微软双拼'}),
  Object.freeze({id: 'sogou', label: '搜狗双拼'}),
  Object.freeze({id: 'abc', label: '智能 ABC 双拼'}),
  Object.freeze({id: 'jiajia', label: '拼音加加双拼'}),
  Object.freeze({id: 'ziguang', label: '紫光双拼'}),
]);

export const VALID_SPELLING_SCHEMES = new Set(SPELLING_SCHEMES.map(item => item.id));

const SCHEMES = {
  zrm:{zero:'repeat',initials:{zh:'v',ch:'i',sh:'u'},finals:{iu:'q',ia:'w',ua:'w',er:'r',uan:'r',van:'r',ue:'t',ve:'t',v:'y',ing:'y',uai:'y',uo:'o',un:'p',vn:'p',ong:'s',iong:'s',iang:'d',uang:'d',en:'f',eng:'g',ang:'h',ian:'m',an:'j',iao:'c',ao:'k',ai:'l',ei:'z',ie:'x',ui:'v',ou:'b',in:'n'}},
  flypy:{zero:'repeat',initials:{zh:'v',ch:'i',sh:'u'},finals:{iu:'q',ei:'w',uan:'r',van:'r',ue:'t',ve:'t',un:'y',vn:'y',uo:'o',ie:'p',ong:'s',iong:'s',ing:'k',uai:'k',ai:'d',en:'f',eng:'g',iang:'l',uang:'l',ang:'h',ian:'m',an:'j',ou:'z',ia:'x',ua:'x',iao:'n',ao:'c',ui:'v',in:'b',er:'r',v:'v'}},
  mspy:{zero:'o',initials:{zh:'v',ch:'i',sh:'u'},finals:{iu:'q',ia:'w',ua:'w',er:'r',uan:'r',van:'r',ue:'t',ve:'t',v:'y',uai:'y',uo:'o',un:'p',vn:'p',ong:'s',iong:'s',iang:'d',uang:'d',en:'f',eng:'g',ang:'h',ian:'m',an:'j',iao:'c',ao:'k',ai:'l',ei:'z',ie:'x',ui:'v',ou:'b',in:'n',ing:';'}},
  sogou:{zero:'o',initials:{zh:'v',ch:'i',sh:'u'},finals:{iu:'q',ia:'w',ua:'w',er:'r',uan:'r',van:'r',ue:'t',ve:'t',v:'y',uai:'y',uo:'o',un:'p',vn:'p',ong:'s',iong:'s',iang:'d',uang:'d',en:'f',eng:'g',ang:'h',ian:'m',an:'j',iao:'c',ao:'k',ai:'l',ei:'z',ie:'x',ui:'v',ou:'b',in:'n',ing:';'}},
  abc:{zero:'o',initials:{zh:'a',ch:'e',sh:'v'},finals:{ei:'q',ian:'w',er:'r',iu:'r',iang:'t',uang:'t',ing:'y',uo:'o',uan:'p',van:'p',ong:'s',iong:'s',ia:'d',ua:'d',en:'f',eng:'g',ang:'h',an:'j',iao:'z',ao:'k',in:'c',uai:'c',ai:'l',ie:'x',ou:'b',un:'n',vn:'n',ue:'m',ve:'m',ui:'m',v:'v'}},
  jiajia:{zero:'o',initials:{zh:'v',ch:'u',sh:'i'},finals:{iu:'n',ia:'b',ua:'b',er:'q',ing:'q',uan:'c',van:'c',ue:'x',ve:'x',uai:'x',uo:'o',un:'z',vn:'z',ong:'y',iong:'y',iang:'h',uang:'h',en:'r',eng:'t',ang:'g',ian:'j',an:'f',iao:'k',ao:'d',ai:'s',ei:'w',ie:'m',ui:'v',ou:'p',in:'l',v:'v'}},
  ziguang:{zero:'o',initials:{zh:'u',ch:'a',sh:'i'},finals:{en:'w',eng:'t',in:'y',uai:'y',uo:'o',ai:'p',iang:'g',uang:'g',ang:'s',ie:'d',ian:'f',ong:'h',iong:'h',er:'j',iu:'j',ei:'k',uan:'l',van:'l',ing:';',ou:'z',ia:'x',ua:'x',iao:'b',ue:'n',ve:'n',ui:'n',un:'m',vn:'m',ao:'q',an:'r',v:'v'}},
};

function splitSyllable(raw) {
  const syllable = String(raw || '').toLowerCase().replace(/[üǖǘǚǜ]/g, 'v').replace(/u:/g, 'v').replace(/[1-5]/g, '');
  const compound = ['zh', 'ch', 'sh'].find(item => syllable.startsWith(item));
  const initial = compound || (/^([bpmfdtnlgkhjqxrzcsyw])/.exec(syllable) || [])[1] || '';
  let final = syllable.slice(initial.length);
  if (['j', 'q', 'x', 'y'].includes(initial) && final.startsWith('u')) final = `v${final.slice(1)}`;
  return {syllable, initial, final};
}

export function doublePinyinSyllable(raw, schemeId) {
  const scheme = SCHEMES[schemeId];
  if (!scheme) return String(raw || '');
  const {syllable, initial, final} = splitSyllable(raw);
  if (!syllable) return '';
  if (!initial) {
    const finalKey = scheme.finals[syllable] || scheme.finals[final] || syllable;
    if (scheme.zero === 'o') return `o${finalKey}`;
    const first = syllable[0];
    return syllable.length === 1 ? `${first}${first}` : `${first}${finalKey}`;
  }
  const initialKey = scheme.initials[initial] || initial;
  const finalKey = scheme.finals[final] || final || initialKey;
  return `${initialKey}${finalKey}`;
}

export function doublePinyinText(pinyin, schemeId) {
  return String(pinyin || '').trim().split(/\s+/).filter(Boolean)
    .map(token => doublePinyinSyllable(token, schemeId)).join(' ');
}

export function spellingTarget(station, schemeId = 'pinyin') {
  if (!station) return '';
  if (schemeId === 'jyutping') return String(station.jyutping || '').trim();
  if (schemeId === 'pinyin') return String(station.pinyin || '').trim();
  return doublePinyinText(station.pinyin, schemeId);
}

export function spellingLabel(schemeId) {
  return SPELLING_SCHEMES.find(item => item.id === schemeId)?.label || SPELLING_SCHEMES[0].label;
}

