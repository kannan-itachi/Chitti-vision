// Voice I/O for Chitti.
//  • TTS is a sentence queue at full volume with a chosen (offline-first) voice.
//  • Recognition pauses while Chitti talks, so it never hears and obeys itself.
//  • A watchdog restarts recognition if the browser silently drops it, and a phrase
//    that stalls as "interim" (a common Chrome glitch) is acted on anyway.
//  • On-device recognition is used when the browser offers it (works offline).
//  • The level meter opens the mic WITHOUT echo cancellation: echo cancellation
//    puts Windows into "communications" mode, which ducks all other audio —
//    that was why Chitti's voice sounded so quiet.
import { store } from '../store';

const SR = typeof window !== 'undefined' && (window.SpeechRecognition || window.webkitSpeechRecognition);
const HAS_TTS = typeof window !== 'undefined' && 'speechSynthesis' in window;

// Ways recognisers commonly spell "Chitti".
export const NAME = '(?:chitti|chiti|chitty|chittie|cheety|cheetie|chetty|chethi|chithi|chitthi|chiddy|chitti robot)';
// Wake words: "Chitti", or a call-out like "hey", "ok", "hello" (with or without the name).
export const WAKE_WORDS = '(?:hey|hi|hello|ok|okay|oye|yo|excuse me|listen)';
const WAKE = new RegExp(`^(?:${WAKE_WORDS}[\\s,!.]+${NAME}|${NAME}|${WAKE_WORDS})\\b[\\s,!.:-]*`, 'i');
const CONVO_WINDOW_MS = 8000; // after Chitti replies, follow-ups need no wake word

const clean = (t) => t.replace(/[*_`#>]+/g, '').replace(/\[(\d+)\]/g, '').replace(/\s+/g, ' ').trim();
const sentences = (t) => clean(t).match(/[^.!?…]+[.!?…]*["')\]]*\s*/g)?.map((s) => s.trim()).filter(Boolean) || [];

const setVoice = (patch) => store().merge('voice', patch);

// Human-sounding voices first while online (Chrome's Google voices, Edge's "Natural"
// voices); the robotic-but-offline Windows voices only when there's no internet.
function rankVoice(v, offline) {
  const name = `${v.name} ${v.lang}`;
  let score = /^en/i.test(v.lang) ? 20 : 0;
  if (offline) {
    score += v.localService ? 10 : -40;
  } else {
    if (/Natural|Neural/i.test(v.name)) score += 12;
    if (/Google/i.test(v.name)) score += 10;
    if (/Google UK English Male/i.test(v.name)) score += 6;
  }
  if (/Prabhat|Neerja|en[-_]IN/i.test(name)) score += 2;
  if (/Male|Ravi|Prabhat|David|Guy|Ryan|Daniel|Brian|Andrew/i.test(name)) score += 2;
  return score;
}

class SpeechEngine {
  constructor() {
    this.queue = [];
    this.talking = false;
    this.recActive = false;
    this.wantListen = false;
    this.onCommand = null;
    this.voices = [];
    this.analyser = null;
    this.micStream = null;
    this.stallTimer = null;
    this.lastInterim = '';
    this.convoUntil = 0;

    if (HAS_TTS) {
      const load = () => {
        this.voices = speechSynthesis.getVoices();
        setVoice({ voices: this.voices.filter((v) => /^en/i.test(v.lang)).map((v) => ({ uri: v.voiceURI, name: v.name, lang: v.lang, local: v.localService })) });
      };
      load();
      speechSynthesis.addEventListener?.('voiceschanged', load);
    }
    if (SR) this.initRecognition();
    window.addEventListener('online', () => { this.forceLocal = false; });
    // Watchdog: browsers end recognition sessions on their own; bring it back.
    setInterval(() => {
      if (this.wantListen && !this.recActive && !this.talking) this.startRec();
    }, 2500);
  }

  get supported() {
    return { stt: !!SR, tts: HAS_TTS };
  }

  get voice() {
    const offline = !navigator.onLine || this.forceLocal;
    const uri = store().settings.voiceURI;
    const chosen = uri && this.voices.find((v) => v.voiceURI === uri);
    if (chosen && (chosen.localService || !offline)) return chosen;
    return [...this.voices].sort((a, b) => rankVoice(b, offline) - rankVoice(a, offline))[0] || null;
  }

  // ---------- recognition ----------

  async initRecognition() {
    const r = new SR();
    r.continuous = true;
    r.interimResults = true;
    r.maxAlternatives = 3;
    this.recognition = r;
    await this.configureLocal();

    r.onstart = () => {
      this.recActive = true;
      setVoice({ listening: true });
    };
    r.onresult = (e) => {
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i];
        if (res.isFinal) {
          this.clearStall();
          setVoice({ interim: '' });
          this.handleFinal(this.bestAlternative(res));
        } else {
          interim += res[0].transcript;
        }
      }
      if (interim.trim()) {
        setVoice({ interim: interim.trim() });
        this.armStall(interim.trim());
      }
    };
    r.onerror = (e) => {
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
        this.wantListen = false;
        setVoice({ micOn: false });
        store().toast('Microphone access denied — voice commands disabled.', 'warn');
      } else if (e.error === 'network') {
        store().toast(this.recognition.processLocally
          ? 'Speech recognition failed. Type your command instead.'
          : 'Speech recognition needs internet in this browser. Enable offline speech in Settings, or type.', 'warn');
      } else if (e.error === 'language-not-supported') {
        store().setSetting({ lang: 'en-US' });
        this.recognition.lang = 'en-US';
      }
    };
    r.onend = () => {
      this.recActive = false;
      setVoice({ listening: false });
      if (this.wantListen && !this.talking) setTimeout(() => this.startRec(), 200);
    };
  }

  // Use on-device recognition when the browser supports it (Chrome 139+).
  async configureLocal() {
    const r = this.recognition;
    if (!r) return;
    const { lang, offlineSpeech } = store().settings;
    r.lang = lang;
    let local = false;
    if (offlineSpeech && 'processLocally' in r && typeof SR.available === 'function') {
      try {
        const state = await SR.available({ langs: [lang], processLocally: true });
        if (state === 'available') local = true;
        else if ((state === 'downloadable' || state === 'downloading') && typeof SR.install === 'function') {
          SR.install({ langs: [lang], processLocally: true }).then((ok) => {
            if (ok) {
              r.processLocally = true;
              setVoice({ local: true });
              store().toast('Offline speech recognition installed.', 'ok');
            }
          }).catch(() => {});
        }
      } catch { /* not supported */ }
    }
    if ('processLocally' in r) r.processLocally = local;
    setVoice({ local });
  }

  async reconfigure() {
    const was = this.wantListen;
    this.stopRec();
    await this.configureLocal();
    if (was) setTimeout(() => this.startRec(), 300);
  }

  // Prefer an alternative that contains Chitti's name or a known command word.
  bestAlternative(res) {
    const alts = Array.from({ length: res.length }, (_, i) => res[i].transcript.trim());
    const re = new RegExp(NAME, 'i');
    return alts.find((a) => re.test(a)) || alts[0] || '';
  }

  // Chrome sometimes never finalises a phrase; act on it after a pause.
  armStall(text) {
    this.lastInterim = text;
    clearTimeout(this.stallTimer);
    this.stallTimer = setTimeout(() => {
      if (this.lastInterim === text) {
        setVoice({ interim: '' });
        this.lastInterim = '';
        this.handleFinal(text);
        this.stopRec(); // reset the session so the stalled phrase is not delivered twice
      }
    }, 1600);
  }

  clearStall() {
    clearTimeout(this.stallTimer);
    this.lastInterim = '';
  }

  handleFinal(raw) {
    let text = raw.trim();
    if (!text) return;
    if (store().settings.wakeWord) {
      const inConversation = Date.now() < this.convoUntil;
      if (!WAKE.test(text) && !inConversation) return;
      const rest = text.replace(WAKE, '').trim();
      if (!rest) {
        // Just "hey" / "ok Chitti": acknowledge and wait for the actual request.
        this.convoUntil = Date.now() + CONVO_WINDOW_MS;
        if (/chitt|chet|chith|chidd/i.test(text)) return this.onCommand?.(text); // "hi chitti" alone is a greeting
        return this.say('Yes?');
      }
      text = rest;
    }
    this.convoUntil = Date.now() + CONVO_WINDOW_MS;
    this.onCommand?.(text);
  }

  startRec() {
    if (!this.recognition || this.recActive || !this.wantListen || this.talking) return;
    try { this.recognition.start(); } catch { /* already starting */ }
  }

  stopRec() {
    if (this.recognition && this.recActive) {
      try { this.recognition.abort(); } catch { /* ignore */ }
    }
  }

  async listen(on) {
    if (!SR) {
      store().toast('Speech recognition is not supported here. Use Chrome or Edge, or type.', 'warn');
      return;
    }
    this.wantListen = on;
    setVoice({ micOn: on });
    if (on) {
      await this.startMeter();
      this.startRec();
    } else {
      this.stopRec();
      this.stopMeter();
      setVoice({ interim: '' });
    }
  }

  // ---------- audio level meter (drives the core orb) ----------

  async startMeter() {
    if (this.analyser) return;
    try {
      this.micStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      });
      const ctx = new AudioContext();
      const src = ctx.createMediaStreamSource(this.micStream);
      this.analyser = ctx.createAnalyser();
      this.analyser.fftSize = 512;
      this.meterData = new Uint8Array(this.analyser.fftSize);
      src.connect(this.analyser);
      this.meterCtx = ctx;
    } catch {
      /* meter is cosmetic; recognition still works without it */
    }
  }

  stopMeter() {
    this.micStream?.getTracks().forEach((t) => t.stop());
    this.meterCtx?.close().catch(() => {});
    this.analyser = this.micStream = this.meterCtx = null;
  }

  level() {
    const now = performance.now() / 1000;
    if (this.talking) return 0.35 + 0.3 * Math.abs(Math.sin(now * 9)) * Math.abs(Math.sin(now * 2.3 + 1));
    if (!this.analyser || !this.recActive) return 0;
    this.analyser.getByteTimeDomainData(this.meterData);
    let sum = 0;
    for (const v of this.meterData) sum += ((v - 128) / 128) ** 2;
    return Math.min(1, Math.sqrt(sum / this.meterData.length) * 4);
  }

  // ---------- speech synthesis ----------

  prime() {
    if (!HAS_TTS) return;
    const u = new SpeechSynthesisUtterance('');
    u.volume = 0;
    speechSynthesis.speak(u);
  }

  say(text, { interrupt = false } = {}) {
    if (!HAS_TTS || store().voice.muted || !text) return;
    if (interrupt) this.stop();
    this.queue.push(...sentences(text));
    this.pump();
  }

  stop() {
    this.queue = [];
    if (HAS_TTS) speechSynthesis.cancel();
    this.talking = false;
    setVoice({ speaking: false });
    setTimeout(() => this.startRec(), 200);
  }

  pump() {
    if (this.talking) return;
    const next = this.queue.shift();
    if (!next) {
      setVoice({ speaking: false });
      // Chitti just finished talking: keep listening for a follow-up without a wake word.
      if (this.convoUntil) this.convoUntil = Math.max(this.convoUntil, Date.now() + CONVO_WINDOW_MS);
      setTimeout(() => this.startRec(), 300);
      return;
    }
    this.talking = true;
    setVoice({ speaking: true });
    this.clearStall();
    this.stopRec();

    const u = new SpeechSynthesisUtterance(next);
    const v = this.voice;
    if (v) {
      u.voice = v;
      u.lang = v.lang;
    }
    const { mode, lowPower, settings } = store();
    u.volume = settings.volume;
    u.pitch = Math.max(0.1, settings.pitch * (mode === 'combat' ? 0.7 : 1));
    u.rate = settings.rate * (mode === 'combat' ? 1.08 : lowPower ? 1.12 : 1);
    const done = () => {
      clearTimeout(guard);
      if (!this.talking) return;
      this.talking = false;
      this.pump();
    };
    // Some voices never fire onend; don't let that freeze the mic forever.
    const guard = setTimeout(done, 2500 + (next.length * 120) / u.rate);
    u.onend = done;
    u.onerror = (e) => {
      // An online voice failed (no internet): switch to an offline voice and retry this sentence.
      if (v && !v.localService && !this.forceLocal && e.error !== 'interrupted' && e.error !== 'canceled') {
        this.forceLocal = true;
        this.queue.unshift(next);
      }
      done();
    };
    speechSynthesis.speak(u);
  }
}

export const speech = new SpeechEngine();
