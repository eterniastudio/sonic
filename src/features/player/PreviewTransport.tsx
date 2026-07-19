import { useEffect, useRef, useState, type MouseEvent } from "react";
import { CircleNotch, Metronome, Pause, Play, Repeat, SpeakerHigh, Waveform, X } from "@phosphor-icons/react";
import { useSonic } from "../../app/SonicProvider";
import { formatDuration } from "../../domain/format";

function fallbackWaveform(count = 128) {
  return Array.from({ length: count }, (_, index) => 0.18 + Math.abs(Math.sin(index * 0.43)) * 0.42);
}

export function PreviewTransport() {
  const {
    state,
    selectedJob,
    bridgeMode,
    updateMetadata,
    releasePreview,
    setPlaying,
    setPlayerTime,
    setPlayerLoop,
  } = useSonic();
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const currentTimeRef = useRef(0);
  const tapsRef = useRef<number[]>([]);
  const [tapBpm, setTapBpm] = useState<number | null>(null);
  const [mediaError, setMediaError] = useState<string | null>(null);
  const player = state.player;
  const asset = player.asset;
  const duration = asset?.durationSeconds ?? 0;
  const waveform = asset?.waveform.length ? asset.waveform : fallbackWaveform();
  const editableJob = state.route === "session" ? selectedJob : undefined;

  currentTimeRef.current = player.currentTime;

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.pause();
    audio.removeAttribute("src");
    audio.load();
    setMediaError(null);
    if (!asset?.mediaUrl) return;
    audio.src = asset.mediaUrl;
    audio.load();
    audio.currentTime = currentTimeRef.current;
    return () => {
      audio.pause();
      audio.removeAttribute("src");
      audio.load();
    };
  }, [asset?.mediaUrl]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || !asset?.mediaUrl) return;
    audio.loop = player.loop;
    if (player.playing) void audio.play().catch(() => setPlaying(false));
    else audio.pause();
  }, [asset?.mediaUrl, player.loop, player.playing, setPlaying]);

  useEffect(() => {
    if (!player.playing || asset?.mediaUrl || bridgeMode !== "preview" || !duration) return;
    const timer = window.setInterval(() => {
      const next = currentTimeRef.current + 0.25;
      if (next >= duration) {
        if (player.loop) setPlayerTime(0);
        else {
          setPlayerTime(duration);
          setPlaying(false);
        }
      } else setPlayerTime(next);
    }, 250);
    return () => window.clearInterval(timer);
  }, [asset?.mediaUrl, bridgeMode, duration, player.loop, player.playing, setPlayerTime, setPlaying]);

  const seek = (time: number) => {
    const clamped = Math.max(0, Math.min(duration, time));
    if (audioRef.current) audioRef.current.currentTime = clamped;
    setPlayerTime(clamped);
  };

  const waveformSeek = (event: MouseEvent<HTMLButtonElement>) => {
    if (!duration) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    seek(((event.clientX - bounds.left) / bounds.width) * duration);
  };

  const tap = () => {
    const now = performance.now();
    const previous = tapsRef.current.filter((time) => now - time < 3_500);
    previous.push(now);
    tapsRef.current = previous.slice(-7);
    if (tapsRef.current.length < 2) return;
    const intervals = tapsRef.current.slice(1).map((time, index) => time - tapsRef.current[index]);
    const bpm = Math.round(60_000 / (intervals.reduce((sum, interval) => sum + interval, 0) / intervals.length));
    if (bpm >= 20 && bpm <= 400) {
      setTapBpm(bpm);
      if (editableJob && ["review", "queued"].includes(editableJob.status)) updateMetadata(editableJob.id, { bpm: bpm.toString(), camelot: undefined });
    }
  };

  const changeTempoFeel = (factor: number) => {
    if (!editableJob) return;
    const current = Number(editableJob.metadata.bpm);
    const next = current * factor;
    if (Number.isFinite(next) && next >= 20 && next <= 400) updateMetadata(editableJob.id, { bpm: next.toString() });
  };

  return (
    <footer className={`preview-transport${asset || player.loading || player.error ? " has-preview" : ""}`} aria-label="Audio preview transport">
      <audio
        ref={audioRef}
        onTimeUpdate={(event) => setPlayerTime(event.currentTarget.currentTime)}
        onDurationChange={(event) => {
          if (event.currentTarget.duration && event.currentTarget.duration !== Infinity) setPlayerTime(Math.min(player.currentTime, event.currentTarget.duration));
        }}
        onEnded={() => setPlaying(false)}
        onError={() => {
          setMediaError("The cached preview could not be played. Try loading it again.");
          setPlaying(false);
        }}
      />
      <div className="transport-identity">
        <span className="transport-icon"><SpeakerHigh size={19} aria-hidden="true" /></span>
        <span>
          <small>{player.loading ? "Preparing preview" : player.error || mediaError ? "Preview unavailable" : asset ? "Local preview" : "Preview transport"}</small>
          <strong>{mediaError ?? asset?.title ?? player.error ?? "Select a source and load its preview"}</strong>
        </span>
      </div>

      <div className="transport-controls">
        <button
          className="transport-play"
          type="button"
          disabled={!asset || player.loading}
          onClick={() => setPlaying(!player.playing)}
          aria-label={player.playing ? "Pause audio preview" : "Play audio preview"}
        >
          {player.loading ? <CircleNotch className="spin" size={18} aria-hidden="true" /> : player.playing ? <Pause size={18} weight="fill" aria-hidden="true" /> : <Play size={18} weight="fill" aria-hidden="true" />}
        </button>
        <span className="transport-time">{formatDuration(player.currentTime)}</span>
        <div className="waveform-control">
          <button type="button" disabled={!asset} onClick={waveformSeek} aria-label="Seek within audio preview using waveform">
            <span className="waveform-bars" aria-hidden="true">
              {waveform.map((peak, index) => {
                const played = duration ? index / waveform.length <= player.currentTime / duration : false;
                return <i key={index} className={played ? "is-played" : ""} style={{ height: `${Math.max(8, peak * 100)}%` }} />;
              })}
            </span>
          </button>
          <label className="sr-only" htmlFor="preview-seek">Preview position</label>
          <input id="preview-seek" type="range" min={0} max={duration || 1} step={0.1} value={Math.min(player.currentTime, duration || 1)} disabled={!asset} onChange={(event) => seek(Number(event.target.value))} />
        </div>
        <span className="transport-time">{formatDuration(duration)}</span>
        <button className={player.loop ? "is-active" : ""} type="button" disabled={!asset} onClick={() => setPlayerLoop(!player.loop)} aria-pressed={player.loop} aria-label="Loop audio preview"><Repeat size={18} weight={player.loop ? "bold" : "regular"} aria-hidden="true" /></button>
      </div>

      <div className="transport-tools">
        <button type="button" aria-label="Use half-time tempo" disabled={!editableJob?.metadata.bpm || Number(editableJob.metadata.bpm) / 2 < 20} onClick={() => changeTempoFeel(0.5)} title="Use half-time tempo"><b className="tempo-symbol" aria-hidden="true">½</b><span>½ tempo</span></button>
        <button type="button" aria-label="Use double-time tempo" disabled={!editableJob?.metadata.bpm || Number(editableJob.metadata.bpm) * 2 > 400} onClick={() => changeTempoFeel(2)} title="Use double-time tempo"><b className="tempo-symbol" aria-hidden="true">2×</b><span>2× tempo</span></button>
        <button type="button" disabled={!editableJob} onClick={tap} title={editableJob ? "Tap repeatedly to estimate tempo" : "Tap tempo is available while editing a Session item"}><Metronome size={18} aria-hidden="true" /><span>{tapBpm ? `${tapBpm} BPM` : "Tap tempo"}</span></button>
        {asset || player.error ? <button className="transport-close" type="button" onClick={() => void releasePreview()} aria-label="Close preview"><X size={17} aria-hidden="true" /></button> : <Waveform size={19} aria-hidden="true" />}
      </div>
    </footer>
  );
}
