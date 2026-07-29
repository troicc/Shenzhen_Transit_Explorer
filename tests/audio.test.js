import test from 'node:test';
import assert from 'node:assert/strict';

import {
  findCantoneseVoice,
  isSafariBrowser,
  StationAudioPlayer,
  waitForCantoneseVoice,
} from '../web/js/learn/audio.js';

test('Cantonese voice selection prioritizes zh-HK and known Yue identifiers', () => {
  const mandarin = {lang: 'zh-CN', name: 'Ting-Ting'};
  const hongKong = {lang: 'zh-HK', name: 'Sin-ji'};
  assert.equal(findCantoneseVoice([mandarin, hongKong]), hongKong);

  const yue = {lang: 'yue-Hant-HK', name: 'Cantonese'};
  assert.equal(findCantoneseVoice([mandarin, yue]), yue);

  const legacySafari = {lang: 'zh_HK', name: 'Sin Ji'};
  assert.equal(findCantoneseVoice([mandarin, legacySafari]), legacySafari);

  const safariName = {lang: '', name: 'Sin-ji (Premium)'};
  assert.equal(findCantoneseVoice([mandarin, safariName]), safariName);
});

test('Safari detection excludes Chrome even though Chrome UA contains Safari', () => {
  const safari = {
    vendor: 'Apple Computer, Inc.',
    userAgent: 'Mozilla/5.0 Version/16.6 Safari/605.1.15',
  };
  const chrome = {
    vendor: 'Google Inc.',
    userAgent: 'Mozilla/5.0 Chrome/126.0.0.0 Safari/537.36',
  };
  assert.equal(isSafariBrowser(safari), true);
  assert.equal(isSafariBrowser(chrome), false);
});

test('Cantonese voice selection never falls back to Mandarin or Taiwanese voices', () => {
  const voices = [
    {lang: 'zh-CN', name: 'Ting-Ting'},
    {lang: 'zh-TW', name: 'Mei-Jia'},
    {lang: 'cmn-CN', name: 'Mandarin'},
  ];
  assert.equal(findCantoneseVoice(voices), null);
});

test('Safari voice loading waits for a Cantonese voice instead of accepting the first Chinese subset', async () => {
  const mandarin = {lang: 'zh-CN', name: 'Ting-Ting'};
  const cantonese = {lang: 'zh-HK', name: 'Sin-ji'};
  let voices = [mandarin];
  const synthesis = {
    getVoices: () => voices,
    addEventListener() {},
    removeEventListener() {},
  };
  setTimeout(() => { voices = [mandarin, cantonese]; }, 5);
  const selected = await waitForCantoneseVoice(synthesis, {timeout: 100, pollInterval: 5});
  assert.equal(selected, cantonese);
});

test('StationAudioPlayer binds the exact Cantonese voice before Safari speaks', async () => {
  const voice = {lang: 'zh-HK', name: 'Sin-ji'};
  let spoken = null;
  const synthesis = {
    getVoices: () => [voice],
    addEventListener() {},
    removeEventListener() {},
    cancel() {},
    speak(utterance) {
      spoken = utterance;
      queueMicrotask(() => utterance.onend());
    },
  };
  const player = new StationAudioPlayer({
    synthesis,
    utteranceFactory: text => ({text}),
    voiceWaitTimeout: 0,
  });
  await player.speakCantonese('福田');
  assert.equal(spoken.voice, voice);
  assert.equal(spoken.lang, 'zh-HK');
  assert.equal(spoken.text, '福田');
});

test('StationAudioPlayer blocks speech when Safari exposes only Mandarin', async () => {
  let speakCalls = 0;
  const synthesis = {
    getVoices: () => [{lang: 'zh-CN', name: 'Ting-Ting'}],
    addEventListener() {},
    removeEventListener() {},
    cancel() {},
    speak() { speakCalls += 1; },
  };
  const player = new StationAudioPlayer({
    synthesis,
    utteranceFactory: text => ({text}),
    voiceWaitTimeout: 0,
  });
  await assert.rejects(
    player.speakCantonese('福田'),
    /已阻止 Safari 改用普通话/,
  );
  assert.equal(speakCalls, 0);
});

test('StationAudioPlayer uses native Cantonese audio first only in Safari mode', async () => {
  let speakCalls = 0;
  let playedUrl = '';
  const synthesis = {
    getVoices: () => [{lang: 'zh-CN', name: 'Ting-Ting'}],
    addEventListener() {},
    removeEventListener() {},
    cancel() {},
    speak() { speakCalls += 1; },
  };
  const player = new StationAudioPlayer({
    synthesis,
    utteranceFactory: text => ({text}),
    nativeSpeechUrl: text => `/api/metro/learn/speech?v=2&text=${encodeURIComponent(text)}`,
    nativeSpeechFirst: true,
    voiceWaitTimeout: 0,
  });
  player.playUrl = async url => { playedUrl = url; };

  await player.speakCantonese('会展中心');

  assert.equal(playedUrl, '/api/metro/learn/speech?v=2&text=%E4%BC%9A%E5%B1%95%E4%B8%AD%E5%BF%83');
  assert.equal(speakCalls, 0);
});

test('StationAudioPlayer keeps the original Chrome Web Speech voice before native audio', async () => {
  const voice = {lang: 'zh-HK', name: 'Chrome Cantonese'};
  let spoken = null;
  let nativeCalls = 0;
  const synthesis = {
    getVoices: () => [voice],
    addEventListener() {},
    removeEventListener() {},
    cancel() {},
    speak(utterance) {
      spoken = utterance;
      queueMicrotask(() => utterance.onend());
    },
  };
  const player = new StationAudioPlayer({
    synthesis,
    utteranceFactory: text => ({text}),
    nativeSpeechUrl: () => '/api/metro/learn/speech?v=2',
    nativeSpeechFirst: false,
    voiceWaitTimeout: 0,
  });
  player.playUrl = async () => { nativeCalls += 1; };

  await player.speakCantonese('福田');

  assert.equal(spoken.voice, voice);
  assert.equal(spoken.rate, .8);
  assert.equal(nativeCalls, 0);
});
