/* Sound, synthesised rather than downloaded.
 *
 * 🎯 [owner 2026-08-22] "เพิ่มเสียง ... เอาเสียงฟรี ... มีการปิดเสียงเพลงได้"
 *
 * "Free sounds" would normally mean finding CC0 files and shipping them. This game's first property
 * is that it runs from a bare checkout with no build step, no dependency and no network, and a
 * folder of .mp3 files works against all three: it is bytes to carry, a licence file to keep
 * accurate, and an attribution list that goes stale the moment someone swaps a clip. The Web Audio
 * API can make every sound this game needs out of oscillators and a noise buffer — no files, no
 * licence, nothing to attribute, and it is genuinely free in both senses.
 *
 * It also means each sound is a few lines that can be read and tuned, rather than a binary nobody
 * can inspect.
 *
 * Nothing here starts on load. Browsers refuse to begin audio before a gesture, and a game that
 * tries anyway just logs a warning on every start — the context is created on the first real
 * interaction and everything before that is a no-op.
 */

const Audio = (() => {
  let ctx = null;
  let master = null;
  let musicGain = null;
  let sfxGain = null;
  let musicTimer = null;
  let musicStep = 0;
  const prefs = { music: true, sfx: true };

  /* One context, made on demand. Calling this before a gesture is harmless: the context is created
   * suspended and resume() is what a gesture unlocks. */
  function ensure() {
    if (ctx) return ctx;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = 0.9;
    master.connect(ctx.destination);
    musicGain = ctx.createGain();
    musicGain.gain.value = prefs.music ? 0.05 : 0;   // music sits far under the effects, deliberately
    musicGain.connect(master);
    sfxGain = ctx.createGain();
    sfxGain.gain.value = prefs.sfx ? 0.35 : 0;
    sfxGain.connect(master);
    return ctx;
  }

  function unlock() {
    const c = ensure();
    if (c && c.state === "suspended") c.resume();
  }

  /* A single plucked note. `type` picks the timbre; the envelope is what stops it sounding like a
   * test tone — an instant attack and an exponential tail is most of the difference between "a
   * sound" and "a beep". */
  function tone(freq, { at = 0, dur = 0.18, type = "sine", gain = 1, to = null } = {}) {
    const c = ensure();
    if (!c) return;
    const t0 = c.currentTime + at;
    const osc = c.createOscillator();
    const env = c.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    if (to) osc.frequency.exponentialRampToValueAtTime(to, t0 + dur);
    env.gain.setValueAtTime(0.0001, t0);
    env.gain.exponentialRampToValueAtTime(gain, t0 + 0.012);
    env.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(env).connect(sfxGain);
    osc.start(t0);
    osc.stop(t0 + dur + 0.02);
  }

  /* Filtered noise — the body of anything that is a THUMP rather than a note. */
  function noise({ at = 0, dur = 0.12, freq = 1200, q = 1, gain = 0.5 } = {}) {
    const c = ensure();
    if (!c) return;
    const t0 = c.currentTime + at;
    const frames = Math.max(1, Math.floor(c.sampleRate * dur));
    const buf = c.createBuffer(1, frames, c.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < frames; i++) data[i] = Math.random() * 2 - 1;
    const src = c.createBufferSource();
    src.buffer = buf;
    const filt = c.createBiquadFilter();
    filt.type = "bandpass";
    filt.frequency.value = freq;
    filt.Q.value = q;
    const env = c.createGain();
    env.gain.setValueAtTime(gain, t0);
    env.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(filt).connect(env).connect(sfxGain);
    src.start(t0);
    src.stop(t0 + dur);
  }

  /* The effects, one line of intent each. Pentatonic throughout, so two landing together never
   * clash — which happens constantly in an idle game where a harvest, a level and a dividend can
   * all resolve on the same tick. */
  const SFX = {
    tap:      () => tone(660, { dur: 0.06, type: "triangle", gain: 0.25 }),
    action:   () => { tone(392, { dur: 0.10, type: "triangle", gain: 0.3 }); noise({ freq: 900, gain: 0.18 }); },
    gain:     () => { tone(587, { dur: 0.10, type: "sine", gain: 0.3 }); tone(880, { at: 0.06, dur: 0.14, gain: 0.22 }); },
    levelup:  () => [523, 659, 784, 1047].forEach((f, i) =>
                      tone(f, { at: i * 0.09, dur: 0.30, type: "triangle", gain: 0.3 })),
    money:    () => { tone(1047, { dur: 0.09, gain: 0.22 }); tone(1319, { at: 0.05, dur: 0.12, gain: 0.18 }); },
    harvest:  () => { tone(523, { dur: 0.14, type: "sine", gain: 0.26 }); tone(784, { at: 0.08, dur: 0.18, gain: 0.2 }); },
    warn:     () => tone(233, { dur: 0.28, type: "sawtooth", gain: 0.22, to: 175 }),
    hit:      () => { noise({ freq: 320, q: 0.8, dur: 0.14, gain: 0.5 }); tone(110, { dur: 0.12, type: "square", gain: 0.2 }); },
  };

  /* The music: four bars of a slow pentatonic arpeggio over a drifting drone, one note every 1.1s.
   * Written rather than sampled for the same reason as the effects, and deliberately sparse — this
   * plays for hours behind a game whose whole premise is leaving it running, so anything with a
   * tune would become unbearable long before it became familiar. */
  const MOTIF = [0, 3, 5, 7, 10, 7, 5, 3];          // semitones over the root, minor pentatonic
  const ROOT = 220;                                  // A3

  function musicStepFn() {
    const c = ensure();
    if (!c || !prefs.music) return;
    const semi = MOTIF[musicStep % MOTIF.length];
    const freq = ROOT * Math.pow(2, semi / 12);
    const t0 = c.currentTime;

    const voice = (f, gain, dur, type) => {
      const osc = c.createOscillator();
      const env = c.createGain();
      osc.type = type;
      osc.frequency.value = f;
      env.gain.setValueAtTime(0.0001, t0);
      env.gain.exponentialRampToValueAtTime(gain, t0 + 0.35);      // slow swell, never a pluck
      env.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      osc.connect(env).connect(musicGain);
      osc.start(t0);
      osc.stop(t0 + dur + 0.05);
    };

    voice(freq, 0.5, 2.4, "sine");
    voice(freq * 2, 0.18, 2.0, "triangle");                        // a quiet octave for air
    if (musicStep % 4 === 0) voice(ROOT / 2, 0.4, 4.4, "sine");    // the drone, once a bar
    musicStep++;
  }

  function startMusic() {
    if (musicTimer || !prefs.music) return;
    if (!ensure()) return;
    musicStepFn();
    musicTimer = setInterval(musicStepFn, 1100);
  }

  function stopMusic() {
    if (musicTimer) { clearInterval(musicTimer); musicTimer = null; }
  }

  return {
    unlock,
    /* Every caller goes through here, so one `prefs.sfx` check covers the whole game and a sound
     * added later cannot forget to respect the setting. */
    play(name) {
      if (!prefs.sfx) return;
      const fn = SFX[name];
      if (!fn) return;
      try { fn(); } catch (e) { /* audio must never be able to break a game tick */ }
    },
    setMusic(on) {
      prefs.music = !!on;
      if (musicGain) musicGain.gain.value = on ? 0.05 : 0;
      if (on) startMusic(); else stopMusic();
    },
    setSfx(on) {
      prefs.sfx = !!on;
      if (sfxGain) sfxGain.gain.value = on ? 0.35 : 0;
    },
    get music() { return prefs.music; },
    get sfx() { return prefs.sfx; },
    startMusic,
    stopMusic,
    available() { return !!(window.AudioContext || window.webkitAudioContext); },
  };
})();
