import {StatusLink} from '../failure.js';
import {describeFailure} from '../../failure.js';
// A video (palette SPEC.md, *Kinds*: `video`): the poster at the video's aspect with a centred play button and the duration, then the
// web view's own <video> in place on the host's resource (Range requests; never downloaded whole). While bridge prepares the MP4
// (`ready` false) the poster says so and the viewer asks again (viewer.js). Keys inside the viewer: Space plays and pauses, ← / →
// seek 5 s, M mutes, F full screen.
import {h} from '../../../vendor/preact.mjs';
import {useEffect, useRef, useState} from '../../../vendor/hooks.mjs';
import htm from '../../../vendor/htm.mjs';
import {Glyph} from '../../glyphs.js';
import {resourcePath} from '../../host/host.js';
import {basePath, pagePath, snap} from '../../viewer.js';

const html = htm.bind(h);
const clock = s => { const t = Math.round(s ?? 0), m = Math.floor(t / 60); return m >= 60 ? `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}` : `${m}:${String(t % 60).padStart(2, '0')}`; };

export function Video({v, e, pane}) {
  const a = e.answer, ready = a.ready !== false;
  const [playing, setPlaying] = useState(false);
  const [failed, setFailed] = useState(false);
  const video = useRef(null), wrap = useRef(null);
  const w = snap(800 * (globalThis.devicePixelRatio || 1));
  const poster = v.host.resource(pagePath(e, 1, w));
  const stream = v.host.resource(resourcePath(a.stream ?? '') ?? `${basePath(e)}/video`);
  const play = () => { if (!ready) return; setFailed(false); setPlaying(true); };
  useEffect(() => { if (playing) video.current?.play?.().catch(() => {}); }, [playing]);
  pane.kind.current = {
    key(k) {
      const el = video.current;
      if (k === 'Space') { if (!el) play(); else el.paused ? el.play().catch(() => {}) : el.pause(); return true; }
      if (!el) return false;
      switch (k) {
        case 'Left': el.currentTime = Math.max(0, el.currentTime - 5); return true;
        case 'Right': el.currentTime = Math.min(el.duration || Infinity, el.currentTime + 5); return true;
        case 'M': el.muted = !el.muted; return true;
        case 'F': (document.fullscreenElement ? document.exitFullscreen() : (el.requestFullscreen ?? el.webkitEnterFullscreen)?.call(el))?.catch?.(() => {}); return true;
      }
      return false;
    },
  };
  const ratio = `${a.w > 0 ? a.w : 16} / ${a.h > 0 ? a.h : 9}`;
  return html`
    <div class="dv-scroll dv-videoscroll">
      <div class="dv-video" ref=${wrap} style=${`aspect-ratio:${ratio}`}>
        ${playing && ready && !failed
          ? html`<video ref=${video} src=${stream} poster=${poster} controls playsinline preload="metadata" onError=${() => setFailed(true)} onPlay=${() => v.firstPage(e, true)}></video>`
          : html`<img src=${poster} alt="" draggable="false" onLoad=${() => v.firstPage(e, true)} onError=${() => v.firstPage(e, false)} />
            ${ready && !failed ? html`<button class="dv-play" aria-label="Play (Space)" title="Play (Space)" onClick=${play}><${Glyph} name="play" size=${28} /></button>` : null}
            ${a.duration && ready && !failed ? html`<span class="dv-duration">${clock(a.duration)}</span>` : null}
            ${!ready ? html`<div class="dv-vnote" role="status">Preparing the video…</div>` : null}
            ${failed ? html`<div class="dv-vnote" role="alert">${describeFailure('bridge video', {code: 'http'}).message} <${StatusLink} host=${v.host} /> · <button class="dk-btn text" onClick=${play}>Retry</button></div>` : null}`}
      </div>
    </div>`;
}
