import { useEffect, useState } from 'react';
import { useStore, store } from './store';
import { speech } from './lib/speech';
import { sfx } from './lib/sfx';
import { startMind } from './lib/mind';
import { perception } from './lib/perception';
import { vision } from './lib/vision';
import { handleInput, interrupt, uploadFile, loadMemory } from './lib/actions';
import * as api from './lib/api';
import VisionStage from './components/VisionStage';
import BootSequence from './components/BootSequence';
import TopBar from './components/TopBar';
import LeftDeck from './components/LeftDeck';
import CommsPanel from './components/CommsPanel';
import ThoughtsPanel from './components/ThoughtsPanel';
import KnowledgePanel from './components/KnowledgePanel';
import CoreOrb from './components/CoreOrb';
import CommandBar from './components/CommandBar';
import InfoCard from './components/InfoCard';
import UploadScanner from './components/UploadScanner';
import SettingsPanel from './components/SettingsPanel';
import Toasts from './components/Toasts';

export default function App() {
  const phase = useStore((s) => s.phase);
  const mode = useStore((s) => s.mode);
  const lowPower = useStore((s) => s.lowPower);
  const settingsOpen = useStore((s) => s.settingsOpen);
  const redAlert = useStore((s) => s.hazards.some((h) => h.kind === 'sharp' || h.kind === 'weapon'));
  const hazard = useStore((s) => s.hazards.find((h) => h.kind === 'sharp' || h.kind === 'weapon'));
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    document.documentElement.dataset.mode = mode;
  }, [mode]);

  useEffect(() => {
    speech.onCommand = (text) => handleInput(text, 'voice');
    store().merge('voice', speech.supported);
  }, []);

  useSettingsEffects();
  useBattery();
  useHealth();

  useEffect(() => {
    if (phase !== 'online') return;
    loadMemory();
    startMind();
  }, [phase]);

  // Global keys: Esc interrupts Chitti, "/" focuses the command line.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') {
        interrupt();
        store().set({ settingsOpen: false });
      }
      if (e.key === '/' && !['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement?.tagName)) {
        e.preventDefault();
        document.getElementById('cmd-input')?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const drop = {
    onDragOver: (e) => { e.preventDefault(); if (phase === 'online') setDragging(true); },
    onDragLeave: (e) => { if (!e.currentTarget.contains(e.relatedTarget)) setDragging(false); },
    onDrop: (e) => { e.preventDefault(); setDragging(false); if (phase === 'online') uploadFile(e.dataTransfer.files[0]); },
  };

  return (
    <div className={`app phase-${phase}${lowPower ? ' low-power' : ''}${redAlert ? ' red-alert' : ''}`} {...drop}>
      <VisionStage />
      <div className="hud-frame" aria-hidden>
        <i className="corner tl" /><i className="corner tr" /><i className="corner bl" /><i className="corner br" />
      </div>

      {phase !== 'online' && <BootSequence />}

      {phase === 'online' && (
        <div className="hud">
          <TopBar />
          <LeftDeck />
          <aside className="deck deck-right">
            <CommsPanel />
            <ThoughtsPanel />
            <KnowledgePanel />
          </aside>
          <footer className="dock">
            <CoreOrb />
            <CommandBar />
          </footer>
          <InfoCard />
          <UploadScanner />
          {settingsOpen && <SettingsPanel />}
        </div>
      )}

      <input id="file-input" type="file" hidden accept=".txt,.md,.markdown,.json,.csv,.tsv,.log,.pdf,.docx,.html,.htm,.xml,.yaml,.yml"
        onChange={(e) => { uploadFile(e.target.files[0]); e.target.value = ''; }} />

      {phase === 'online' && hazard && (
        <div className="alert-banner" role="alert">
          <b>⚠ {hazard.kind === 'weapon' ? 'WEAPON' : 'SHARP OBJECT'} DETECTED</b>
          <span>{hazard.name.toUpperCase()} · {hazard.source === 'focus' ? 'IN HAND' : hazard.side.toUpperCase()}{hazard.nearPerson ? ' · NEAR PERSON' : ''}</span>
        </div>
      )}
      {dragging && <div className="drop-overlay"><div>RELEASE TO SCAN DOCUMENT</div></div>}
      <Toasts />
    </div>
  );
}

// Apply settings that live outside React (sound, recognition, detector model).
function useSettingsEffects() {
  const sfxOn = useStore((s) => s.settings.sfx);
  const lang = useStore((s) => s.settings.lang);
  const offlineSpeech = useStore((s) => s.settings.offlineSpeech);
  const quality = useStore((s) => s.settings.detectQuality);
  const smart = useStore((s) => s.settings.smartIdentify);
  const live = useStore((s) => s.vision.status === 'live');

  useEffect(() => { sfx.setEnabled(sfxOn); }, [sfxOn]);
  useEffect(() => { speech.reconfigure(); }, [lang, offlineSpeech]);
  useEffect(() => {
    if (live && vision.engine) vision.engine.useDetector(quality).catch(() => store().toast('Could not load that detector model.', 'warn'));
  }, [quality, live]);
  useEffect(() => {
    if (live && smart) perception.init();
  }, [smart, live]);
}

function useBattery() {
  useEffect(() => {
    if (!('getBattery' in navigator)) return;
    let bat;
    const update = () => {
      const s = store();
      s.set({ battery: { level: bat.level, charging: bat.charging } });
      const low = bat.level <= 0.2 && !bat.charging;
      if (low && !s.lowPower) {
        s.set({ lowPower: true });
        s.toast('Battery critical — entering low power mode.', 'warn');
        speech.say('Warning. Battery critical. Entering low power mode.');
      } else if (s.lowPower && (bat.charging || bat.level > 0.3)) {
        s.set({ lowPower: false });
        speech.say('Power stable. Exiting low power mode.');
      }
    };
    navigator.getBattery().then((b) => {
      bat = b;
      update();
      b.addEventListener('levelchange', update);
      b.addEventListener('chargingchange', update);
    }).catch(() => {});
    return () => {
      bat?.removeEventListener('levelchange', update);
      bat?.removeEventListener('chargingchange', update);
    };
  }, []);
}

function useHealth() {
  useEffect(() => {
    let stop = false;
    const check = async () => {
      const prev = store().backend;
      try {
        const h = await api.getHealth();
        const next = { online: true, ai: h.ai.enabled, provider: h.ai.provider, model: h.ai.model, vision: h.ai.vision, reason: h.ai.reason };
        store().set({ backend: next });
        if (store().phase === 'online') {
          if (!prev.online) {
            store().toast('Neural link restored.', 'ok');
            loadMemory();
          }
          if (next.provider !== prev.provider && next.provider !== 'none') {
            store().addThought(`Language core connected: ${next.provider === 'claude' ? 'Claude' : `local ${next.model}`}.`, 'decide');
          }
        }
      } catch {
        store().merge('backend', { online: false, ai: false, provider: 'none' });
        if (prev.online) store().toast('Neural link lost — server offline. Offline mind still active.', 'warn');
      }
      if (!stop) setTimeout(check, 10000);
    };
    check();
    return () => { stop = true; };
  }, []);
}
