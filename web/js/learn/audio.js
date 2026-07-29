const DATABASE_NAME = 'transit-explorer-station-audio-v3';
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

function availableVoices(synthesis) {
  try {
    return Array.from(synthesis?.getVoices?.() || []);
  } catch (_) {
    return [];
  }
}

export function findCantoneseVoice(voices = []) {
  const list = Array.from(voices || []);
  const language = voice => String(voice?.lang || '').trim();
  const description = voice => `${language(voice)} ${voice?.name || ''} ${voice?.voiceURI || ''}`;
  return list.find(voice => /^zh(?:[-_]Hant)?[-_]HK$/i.test(language(voice)))
    || list.find(voice => /^(?:yue|zh[-_]yue)(?:[-_].*)?$/i.test(language(voice)))
    || list.find(voice => /(^|[-_\s])(sin[-_\s]?ji|sinji|kayan|hoyin|cantonese)([-_\s]|$)/i.test(description(voice)))
    || list.find(voice => /hong\s*kong|香港|廣東話|广东话|粵語|粤语/i.test(description(voice)))
    || null;
}

export function waitForCantoneseVoice(
  synthesis = globalThis.speechSynthesis,
  {timeout = 1800, pollInterval = 80} = {},
) {
  return new Promise(resolve => {
    if (!synthesis?.getVoices) {
      resolve(null);
      return;
    }

    let settled = false;
    let deadlineTimer = 0;
    let pollTimer = 0;
    const finish = voice => {
      if (settled) return;
      settled = true;
      clearTimeout(deadlineTimer);
      clearTimeout(pollTimer);
      synthesis.removeEventListener?.('voiceschanged', handleVoicesChanged);
      resolve(voice || null);
    };
    const inspect = () => {
      const voice = findCantoneseVoice(availableVoices(synthesis));
      if (voice) finish(voice);
      return voice;
    };
    const handleVoicesChanged = () => inspect();
    const poll = () => {
      if (settled || inspect()) return;
      pollTimer = setTimeout(poll, Math.max(20, Number(pollInterval) || 80));
    };

    synthesis.addEventListener?.('voiceschanged', handleVoicesChanged);
    if (inspect()) return;
    pollTimer = setTimeout(poll, Math.max(20, Number(pollInterval) || 80));
    deadlineTimer = setTimeout(
      () => finish(findCantoneseVoice(availableVoices(synthesis))),
      Math.max(0, Number(timeout) || 0),
    );
  });
}

export class StationAudioPlayer {
  constructor({
    synthesis = globalThis.speechSynthesis,
    utteranceFactory = text => new globalThis.SpeechSynthesisUtterance(text),
    nativeSpeechUrl = null,
    voiceWaitTimeout = 1800,
    voicePollInterval = 80,
  } = {}) {
    this.audio = null;
    this.objectUrl = null;
    this.token = 0;
    this.synthesis = synthesis;
    this.utteranceFactory = utteranceFactory;
    this.nativeSpeechUrl = nativeSpeechUrl;
    this.voiceWaitTimeout = voiceWaitTimeout;
    this.voicePollInterval = voicePollInterval;
    this.cantoneseVoicePromise = null;
    this.prepareCantoneseVoice();
  }

  prepareCantoneseVoice({refresh = false} = {}) {
    const current = findCantoneseVoice(availableVoices(this.synthesis));
    if (current) return Promise.resolve(current);
    if (this.cantoneseVoicePromise && !refresh) return this.cantoneseVoicePromise;
    const pending = waitForCantoneseVoice(this.synthesis, {
      timeout: this.voiceWaitTimeout,
      pollInterval: this.voicePollInterval,
    });
    this.cantoneseVoicePromise = pending;
    pending.then(voice => {
      if (!voice && this.cantoneseVoicePromise === pending) this.cantoneseVoicePromise = null;
    });
    return pending;
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
    this.synthesis?.cancel?.();
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
    if (typeof this.nativeSpeechUrl === 'function') {
      try {
        return await this.playUrl(this.nativeSpeechUrl(text));
      } catch (_) {
        // Fall back only to an explicitly identified browser Cantonese voice.
      }
    }
    if (!this.synthesis?.speak || typeof this.utteranceFactory !== 'function') {
      throw new Error('本机粤语服务和当前浏览器的粤语语音均不可用');
    }
    const voice = findCantoneseVoice(availableVoices(this.synthesis))
      || await this.prepareCantoneseVoice();
    if (!voice) {
      throw new Error('本机粤语服务暂时不可用，且 Safari 未暴露粤语声音；已阻止 Safari 改用普通话');
    }
    const token = ++this.token;
    return new Promise((resolve, reject) => {
      const utterance = this.utteranceFactory(text);
      utterance.voice = voice;
      utterance.lang = String(voice.lang || 'zh-HK');
      utterance.rate = .8;
      utterance.pitch = 1;
      utterance.onend = () => { if (token === this.token) resolve(); };
      utterance.onerror = () => reject(new Error('系统粤语播放失败'));
      this.synthesis.speak(utterance);
    });
  }
}
