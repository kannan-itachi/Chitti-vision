import { useEffect, useRef } from 'react';
import { useStore } from '../store';
import { VisionEngine, vision } from '../lib/vision';
import { onNewTarget, onTargetLost, onFaceRecognized, startVision } from '../lib/actions';

export default function VisionStage() {
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const status = useStore((s) => s.vision.status);
  const error = useStore((s) => s.vision.error);
  const phase = useStore((s) => s.phase);

  useEffect(() => {
    const engine = new VisionEngine(videoRef.current, canvasRef.current);
    engine.onNewTarget = onNewTarget;
    engine.onTargetLost = onTargetLost;
    engine.onFaceRecognized = onFaceRecognized;
    vision.engine = engine;
    return () => {
      engine.destroy();
      vision.engine = null;
    };
  }, []);

  const live = status === 'live';
  return (
    <section className={`stage stage-${status}`}>
      <video ref={videoRef} className="cam" autoPlay playsInline muted />
      <div className="stage-idle" aria-hidden={live}>
        <div className="hexgrid" />
      </div>
      <canvas ref={canvasRef} className="overlay" />
      <div className="stage-fx" aria-hidden>
        <div className="grid" />
        <div className="scanline" />
        <div className="sweep" />
        <div className="vignette" />
        <div className="reticle"><i /><i /><i /><i /></div>
      </div>

      {phase === 'online' && !live && (
        <div className="stage-msg">
          {status === 'starting' && <><div className="spinner" />ACTIVATING OPTICAL SENSORS</>}
          {status === 'loading-model' && <><div className="spinner" />LOADING NEURAL VISION MODEL</>}
          {(status === 'off' || status === 'error') && (
            <>
              <div className="stage-msg-title">OPTICAL SENSORS {status === 'error' ? 'FAULT' : 'OFFLINE'}</div>
              {error && <div className="stage-msg-err">{error}</div>}
              <button className="btn" onClick={startVision}>ACTIVATE VISION</button>
              <small>or say “start vision”</small>
            </>
          )}
        </div>
      )}
    </section>
  );
}
