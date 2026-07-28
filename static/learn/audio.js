const DATABASE_NAME = 'zhanyue-bus-audio-v2';
const STORE_NAME = 'stations';

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, 1);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE_NAME)) database.createObjectStore(STORE_NAME);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function getLocalAudio(stationName) {
  const database = await openDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const request = database.transaction(STORE_NAME).objectStore(STORE_NAME).get(stationName);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error);
    });
  } finally {
    database.close();
  }
}

export async function putLocalAudio(stationName, blob) {
  const database = await openDatabase();
  try {
    await new Promise((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, 'readwrite');
      transaction.objectStore(STORE_NAME).put(blob, stationName);
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error);
    });
  } finally {
    database.close();
  }
}

export async function deleteLocalAudio(stationName) {
  const database = await openDatabase();
  try {
    await new Promise((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, 'readwrite');
      transaction.objectStore(STORE_NAME).delete(stationName);
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error);
    });
  } finally {
    database.close();
  }
}

function waitForVoices(timeout = 600) {
  return new Promise(resolve => {
    if (!('speechSynthesis' in window)) return resolve([]);
    const existing = speechSynthesis.getVoices();
    if (existing.length) return resolve(existing);
    const timer = setTimeout(() => resolve(speechSynthesis.getVoices()), timeout);
    speechSynthesis.addEventListener('voiceschanged', () => {
      clearTimeout(timer);
      resolve(speechSynthesis.getVoices());
    }, {once: true});
  });
}

export class StationAudioPlayer {
  constructor() {
    this.audio = null;
    this.objectUrl = null;
    this.token = 0;
  }

  stop() {
    this.token += 1;
    if (this.audio) {
      this.audio.pause();
      this.audio.removeAttribute('src');
      this.audio.load();
      this.audio = null;
    }
    if (this.objectUrl) {
      URL.revokeObjectURL(this.objectUrl);
      this.objectUrl = null;
    }
    if ('speechSynthesis' in window) speechSynthesis.cancel();
  }

  async playStation(station) {
    if (!station) throw new Error('没有可播放的站点');
    this.stop();
    const local = await getLocalAudio(station.name).catch(() => null);
    if (local) return this.playBlob(local);
    if (station.audioUrl) {
      try {
        return await this.playUrl(station.audioUrl);
      } catch (_) {
        // Continue to the system voice fallback.
      }
    }
    return this.speakCantonese(station.name);
  }

  playBlob(blob) {
    this.objectUrl = URL.createObjectURL(blob);
    return this.playUrl(this.objectUrl, true);
  }

  playUrl(url, revokeAfter = false) {
    const token = ++this.token;
    return new Promise((resolve, reject) => {
      const audio = new Audio();
      this.audio = audio;
      audio.preload = 'auto';
      audio.src = url;
      const clean = () => {
        if (this.audio === audio) this.audio = null;
        if (revokeAfter && this.objectUrl) {
          URL.revokeObjectURL(this.objectUrl);
          this.objectUrl = null;
        }
      };
      audio.onended = () => { clean(); if (token === this.token) resolve(); };
      audio.onerror = () => { clean(); reject(new Error('粤语音频无法播放')); };
      audio.play().catch(error => { clean(); reject(error); });
    });
  }

  async speakCantonese(text) {
    if (!('speechSynthesis' in window)) throw new Error('当前浏览器不支持系统语音');
    const voices = await waitForVoices();
    const voice = voices.find(item => /^zh-HK$/i.test(item.lang))
      || voices.find(item => /yue|cantonese|zh[_-]HK/i.test(`${item.lang} ${item.name}`))
      || voices.find(item => /^zh/i.test(item.lang));
    const token = ++this.token;
    return new Promise((resolve, reject) => {
      const utterance = new SpeechSynthesisUtterance(text);
      if (voice) utterance.voice = voice;
      utterance.lang = voice?.lang || 'zh-HK';
      utterance.rate = .8;
      utterance.pitch = 1;
      utterance.onend = () => { if (token === this.token) resolve(); };
      utterance.onerror = () => reject(new Error('系统粤语播放失败'));
      speechSynthesis.speak(utterance);
    });
  }
}
