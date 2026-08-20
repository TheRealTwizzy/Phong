/**
 * Web Audio API Sound Synthesizer for Retro & Modern Pong Sound FX, Procedural BGM, & Ambient Soundscapes
 * Zero-asset, low latency, cross-platform audio engine
 */

import { SoundscapeType } from '../types';

class SoundEngine {
  private ctx: AudioContext | null = null;
  private enabled: boolean = true;
  private sfxVolume: number = 0.8; // 0.0 to 1.0
  private bgmVolume: number = 0.5; // 0.0 to 1.0
  private soundscapeVolume: number = 0.5; // 0.0 to 1.0
  private currentSoundscape: SoundscapeType = 'none';

  private bgmGainNode: GainNode | null = null;
  private bgmInterval: number | null = null;
  private isBgmPlaying: boolean = false;
  private step: number = 0;

  // Soundscape audio nodes
  private soundscapeGainNode: GainNode | null = null;
  private soundscapeInterval: number | null = null;
  private soundscapeNodes: { [key: string]: any } = {};

  constructor() {
    // Lazy AudioContext initialization on first user interaction
  }

  private initCtx() {
    if (!this.ctx) {
      const AudioCtx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (AudioCtx) {
        this.ctx = new AudioCtx();
      }
    }
    if (this.ctx && this.ctx.state === 'suspended') {
      this.ctx.resume();
    }
  }

  public setEnabled(val: boolean) {
    this.enabled = val;
    if (!val) {
      this.stopBgm();
      this.stopSoundscape();
    } else {
      if (this.bgmVolume > 0 && !this.isBgmPlaying) {
        this.startBgm();
      }
      if (this.currentSoundscape !== 'none') {
        this.startSoundscape(this.currentSoundscape);
      }
    }
  }

  public setSfxVolume(vol: number) {
    this.sfxVolume = Math.max(0, Math.min(1, vol));
  }

  public setBgmVolume(vol: number) {
    this.bgmVolume = Math.max(0, Math.min(1, vol));
    if (this.bgmGainNode && this.ctx) {
      this.bgmGainNode.gain.setValueAtTime(
        this.enabled ? this.bgmVolume * 0.15 : 0,
        this.ctx.currentTime
      );
    }
    if (this.bgmVolume > 0 && this.enabled && !this.isBgmPlaying) {
      this.startBgm();
    } else if ((this.bgmVolume === 0 || !this.enabled) && this.isBgmPlaying) {
      this.stopBgm();
    }
  }

  public setSoundscapeVolume(vol: number) {
    this.soundscapeVolume = Math.max(0, Math.min(1, vol));
    if (this.soundscapeGainNode && this.ctx) {
      this.soundscapeGainNode.gain.setValueAtTime(
        this.enabled ? this.soundscapeVolume * 0.2 : 0,
        this.ctx.currentTime
      );
    }
  }

  public setSoundscape(type: SoundscapeType, volume?: number) {
    if (volume !== undefined) {
      this.soundscapeVolume = Math.max(0, Math.min(1, volume));
    }
    this.currentSoundscape = type;
    if (!this.enabled || type === 'none') {
      this.stopSoundscape();
      return;
    }
    this.startSoundscape(type);
  }

  public startSoundscape(type: SoundscapeType, volume?: number) {
    this.stopSoundscape();
    if (volume !== undefined) {
      this.soundscapeVolume = Math.max(0, Math.min(1, volume));
    }
    if (!this.enabled || type === 'none') return;
    this.initCtx();
    if (!this.ctx) return;

    this.currentSoundscape = type;

    if (!this.soundscapeGainNode) {
      this.soundscapeGainNode = this.ctx.createGain();
      this.soundscapeGainNode.connect(this.ctx.destination);
    }
    this.soundscapeGainNode.gain.setValueAtTime(this.soundscapeVolume * 0.2, this.ctx.currentTime);

    if (type === 'stadium') {
      this.initStadiumSoundscape();
    } else if (type === 'cyberpunk') {
      this.initCyberpunkSoundscape();
    } else if (type === 'zen') {
      this.initZenSoundscape();
    }
  }

  public stopSoundscape() {
    if (this.soundscapeInterval !== null) {
      clearInterval(this.soundscapeInterval);
      this.soundscapeInterval = null;
    }
    // Stop and disconnect all active nodes
    Object.values(this.soundscapeNodes).forEach((node: any) => {
      try {
        if (node && typeof node.stop === 'function') node.stop();
        if (node && typeof node.disconnect === 'function') node.disconnect();
      } catch {}
    });
    this.soundscapeNodes = {};
  }

  private createNoiseBuffer(): AudioBuffer | null {
    if (!this.ctx) return null;
    const bufferSize = this.ctx.sampleRate * 2; // 2 seconds of noise
    const buffer = this.ctx.createBuffer(1, bufferSize, this.ctx.sampleRate);
    const output = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
      output[i] = Math.random() * 2 - 1;
    }
    return buffer;
  }

  private initStadiumSoundscape() {
    if (!this.ctx || !this.soundscapeGainNode) return;
    const noiseBuffer = this.createNoiseBuffer();
    if (!noiseBuffer) return;

    // Crowd Murmur Noise Loop
    const noiseSource = this.ctx.createBufferSource();
    noiseSource.buffer = noiseBuffer;
    noiseSource.loop = true;

    const filter = this.ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.setValueAtTime(380, this.ctx.currentTime);
    filter.Q.setValueAtTime(1.5, this.ctx.currentTime);

    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(0.4, this.ctx.currentTime);

    noiseSource.connect(filter);
    filter.connect(gain);
    gain.connect(this.soundscapeGainNode);
    noiseSource.start();

    this.soundscapeNodes['stadium_noise'] = noiseSource;
    this.soundscapeNodes['stadium_filter'] = filter;

    // Periodic subtle crowd swell / clap bursts
    this.soundscapeInterval = window.setInterval(() => {
      if (!this.ctx || !this.soundscapeGainNode || this.currentSoundscape !== 'stadium') return;
      try {
        const now = this.ctx.currentTime;
        const swellOsc = this.ctx.createOscillator();
        const swellGain = this.ctx.createGain();
        const swellFilter = this.ctx.createBiquadFilter();

        swellFilter.type = 'lowpass';
        swellFilter.frequency.setValueAtTime(600, now);

        swellOsc.type = 'triangle';
        swellOsc.frequency.setValueAtTime(120 + Math.random() * 80, now);

        swellGain.gain.setValueAtTime(0.01, now);
        swellGain.gain.linearRampToValueAtTime(0.12, now + 1.2);
        swellGain.gain.exponentialRampToValueAtTime(0.001, now + 2.8);

        swellOsc.connect(swellFilter);
        swellFilter.connect(swellGain);
        swellGain.connect(this.soundscapeGainNode);

        swellOsc.start(now);
        swellOsc.stop(now + 3.0);
      } catch {}
    }, 4200);
  }

  private initCyberpunkSoundscape() {
    if (!this.ctx || !this.soundscapeGainNode) return;

    // Deep Sub Drone (60Hz neon transformer hum + fifth harmonic)
    const droneOsc = this.ctx.createOscillator();
    droneOsc.type = 'sawtooth';
    droneOsc.frequency.setValueAtTime(55, this.ctx.currentTime); // A1 note

    const droneFilter = this.ctx.createBiquadFilter();
    droneFilter.type = 'lowpass';
    droneFilter.frequency.setValueAtTime(180, this.ctx.currentTime);
    droneFilter.Q.setValueAtTime(6, this.ctx.currentTime);

    const droneGain = this.ctx.createGain();
    droneGain.gain.setValueAtTime(0.45, this.ctx.currentTime);

    droneOsc.connect(droneFilter);
    droneFilter.connect(droneGain);
    droneGain.connect(this.soundscapeGainNode);
    droneOsc.start();

    // High Neon Buzz (120Hz sine with slight tremolo)
    const neonOsc = this.ctx.createOscillator();
    neonOsc.type = 'sine';
    neonOsc.frequency.setValueAtTime(110, this.ctx.currentTime);

    const neonGain = this.ctx.createGain();
    neonGain.gain.setValueAtTime(0.2, this.ctx.currentTime);

    neonOsc.connect(neonGain);
    neonGain.connect(this.soundscapeGainNode);
    neonOsc.start();

    this.soundscapeNodes['cyber_drone'] = droneOsc;
    this.soundscapeNodes['cyber_neon'] = neonOsc;

    // Distant cyber radar pings
    this.soundscapeInterval = window.setInterval(() => {
      if (!this.ctx || !this.soundscapeGainNode || this.currentSoundscape !== 'cyberpunk') return;
      try {
        const now = this.ctx.currentTime;
        const ping = this.ctx.createOscillator();
        const pingGain = this.ctx.createGain();

        ping.type = 'sine';
        ping.frequency.setValueAtTime(1200 + Math.random() * 400, now);
        ping.frequency.exponentialRampToValueAtTime(300, now + 0.6);

        pingGain.gain.setValueAtTime(0.08, now);
        pingGain.gain.exponentialRampToValueAtTime(0.001, now + 0.6);

        ping.connect(pingGain);
        pingGain.connect(this.soundscapeGainNode);

        ping.start(now);
        ping.stop(now + 0.65);
      } catch {}
    }, 5500);
  }

  private initZenSoundscape() {
    if (!this.ctx || !this.soundscapeGainNode) return;

    // Harmonic singing bowl drone (432Hz calming resonance)
    const baseFreq = 216; // Harmonic root
    const bowlOsc1 = this.ctx.createOscillator();
    bowlOsc1.type = 'sine';
    bowlOsc1.frequency.setValueAtTime(baseFreq, this.ctx.currentTime);

    const bowlOsc2 = this.ctx.createOscillator();
    bowlOsc2.type = 'sine';
    bowlOsc2.frequency.setValueAtTime(baseFreq * 1.5, this.ctx.currentTime); // Perfect fifth (324Hz)

    const bowlGain1 = this.ctx.createGain();
    bowlGain1.gain.setValueAtTime(0.3, this.ctx.currentTime);

    const bowlGain2 = this.ctx.createGain();
    bowlGain2.gain.setValueAtTime(0.18, this.ctx.currentTime);

    bowlOsc1.connect(bowlGain1);
    bowlGain1.connect(this.soundscapeGainNode);
    bowlOsc2.connect(bowlGain2);
    bowlGain2.connect(this.soundscapeGainNode);

    bowlOsc1.start();
    bowlOsc2.start();

    this.soundscapeNodes['zen_bowl1'] = bowlOsc1;
    this.soundscapeNodes['zen_bowl2'] = bowlOsc2;

    // Soft crystalline bell chimes
    const chimeFreqs = [528, 660, 792, 1056];
    this.soundscapeInterval = window.setInterval(() => {
      if (!this.ctx || !this.soundscapeGainNode || this.currentSoundscape !== 'zen') return;
      try {
        const now = this.ctx.currentTime;
        const chime = this.ctx.createOscillator();
        const chimeGain = this.ctx.createGain();

        const freq = chimeFreqs[Math.floor(Math.random() * chimeFreqs.length)];
        chime.type = 'sine';
        chime.frequency.setValueAtTime(freq, now);

        chimeGain.gain.setValueAtTime(0.15, now);
        chimeGain.gain.exponentialRampToValueAtTime(0.001, now + 2.5);

        chime.connect(chimeGain);
        chimeGain.connect(this.soundscapeGainNode);

        chime.start(now);
        chime.stop(now + 2.6);
      } catch {}
    }, 4800);
  }

  public startBgm() {
    if (this.isBgmPlaying || !this.enabled || this.bgmVolume <= 0) return;
    this.initCtx();
    if (!this.ctx) return;

    this.isBgmPlaying = true;
    if (!this.bgmGainNode) {
      this.bgmGainNode = this.ctx.createGain();
      this.bgmGainNode.gain.setValueAtTime(this.bgmVolume * 0.15, this.ctx.currentTime);
      this.bgmGainNode.connect(this.ctx.destination);
    } else {
      this.bgmGainNode.gain.setValueAtTime(this.bgmVolume * 0.15, this.ctx.currentTime);
    }

    // Melodic sequence for a pulsing cyberpunk/synthwave Pong theme
    // Pentatonic minor progression: A2, C3, D3, E3, G3, A3, C4
    const scale = [110, 130.81, 146.83, 164.81, 196.0, 220.0, 261.63, 329.63];
    const bassNotes = [55, 55, 65.41, 73.42, 82.41, 82.41, 73.42, 65.41];
    const melodyPattern = [0, 4, 2, 5, 1, 4, 3, 6, 2, 5, 3, 7, 1, 4, 2, 5];

    const sixteenthTime = 135; // ms per 16th note ~ 111 BPM

    this.bgmInterval = window.setInterval(() => {
      if (!this.ctx || !this.isBgmPlaying || !this.enabled || !this.bgmGainNode) return;
      if (this.ctx.state === 'suspended') return;

      try {
        const now = this.ctx.currentTime;
        const noteIdx = melodyPattern[this.step % melodyPattern.length];
        const freq = scale[noteIdx % scale.length];

        // Synth Lead / Arp Pulse
        const osc = this.ctx.createOscillator();
        const noteGain = this.ctx.createGain();
        const filter = this.ctx.createBiquadFilter();

        osc.type = this.step % 4 === 0 ? 'sawtooth' : 'triangle';
        osc.frequency.setValueAtTime(freq, now);

        filter.type = 'lowpass';
        filter.frequency.setValueAtTime(600 + (this.step % 8) * 120, now);
        filter.Q.setValueAtTime(4, now);

        noteGain.gain.setValueAtTime(0.35, now);
        noteGain.gain.exponentialRampToValueAtTime(0.001, now + 0.11);

        osc.connect(filter);
        filter.connect(noteGain);
        noteGain.connect(this.bgmGainNode);

        osc.start(now);
        osc.stop(now + 0.12);

        // Sub Bass on strong beats
        if (this.step % 4 === 0) {
          const bassOsc = this.ctx.createOscillator();
          const bassGain = this.ctx.createGain();
          const bassFreq = bassNotes[Math.floor(this.step / 4) % bassNotes.length];

          bassOsc.type = 'sine';
          bassOsc.frequency.setValueAtTime(bassFreq, now);

          bassGain.gain.setValueAtTime(0.6, now);
          bassGain.gain.exponentialRampToValueAtTime(0.01, now + 0.35);

          bassOsc.connect(bassGain);
          bassGain.connect(this.bgmGainNode);

          bassOsc.start(now);
          bassOsc.stop(now + 0.38);
        }

        this.step++;
      } catch {
        // Safe Web Audio fallback
      }
    }, sixteenthTime);
  }

  public stopBgm() {
    this.isBgmPlaying = false;
    if (this.bgmInterval !== null) {
      clearInterval(this.bgmInterval);
      this.bgmInterval = null;
    }
  }

  public playPaddleHit(speedRatio: number = 1.0) {
    if (!this.enabled || this.sfxVolume <= 0) return;
    this.initCtx();
    if (!this.ctx) return;

    try {
      const now = this.ctx.currentTime;
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();

      osc.type = 'square';
      const baseFreq = 440 + Math.min(speedRatio * 150, 400);
      osc.frequency.setValueAtTime(baseFreq, now);
      osc.frequency.exponentialRampToValueAtTime(baseFreq * 1.5, now + 0.08);

      const targetGain = 0.25 * this.sfxVolume;
      gain.gain.setValueAtTime(targetGain, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.09);

      osc.connect(gain);
      gain.connect(this.ctx.destination);

      osc.start(now);
      osc.stop(now + 0.09);
    } catch {
      // AudioContext failed silently
    }
  }

  public playOpponentPaddleHit() {
    if (!this.enabled || this.sfxVolume <= 0) return;
    this.initCtx();
    if (!this.ctx) return;

    try {
      const now = this.ctx.currentTime;
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      const filter = this.ctx.createBiquadFilter();

      // Muffled low-pass filter to sound distant / in the opponent's room!
      filter.type = 'lowpass';
      filter.frequency.setValueAtTime(450, now);

      osc.type = 'triangle';
      osc.frequency.setValueAtTime(320, now);
      osc.frequency.exponentialRampToValueAtTime(220, now + 0.12);

      const targetGain = 0.18 * this.sfxVolume;
      gain.gain.setValueAtTime(targetGain, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.12);

      osc.connect(filter);
      filter.connect(gain);
      gain.connect(this.ctx.destination);

      osc.start(now);
      osc.stop(now + 0.12);
    } catch {
      // ignore
    }
  }

  public playWallBounce() {
    if (!this.enabled || this.sfxVolume <= 0) return;
    this.initCtx();
    if (!this.ctx) return;

    try {
      const now = this.ctx.currentTime;
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();

      osc.type = 'sine';
      osc.frequency.setValueAtTime(750, now);
      osc.frequency.exponentialRampToValueAtTime(500, now + 0.05);

      const targetGain = 0.2 * this.sfxVolume;
      gain.gain.setValueAtTime(targetGain, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.05);

      osc.connect(gain);
      gain.connect(this.ctx.destination);

      osc.start(now);
      osc.stop(now + 0.05);
    } catch {
      // ignore
    }
  }

  public playNetWhoosh() {
    if (!this.enabled || this.sfxVolume <= 0) return;
    this.initCtx();
    if (!this.ctx) return;

    try {
      const now = this.ctx.currentTime;
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();

      // Futuristic warp sound when ball crosses net into opponent's half
      osc.type = 'sine';
      osc.frequency.setValueAtTime(800, now);
      osc.frequency.exponentialRampToValueAtTime(200, now + 0.18);

      const targetGain = 0.15 * this.sfxVolume;
      gain.gain.setValueAtTime(targetGain, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.18);

      osc.connect(gain);
      gain.connect(this.ctx.destination);

      osc.start(now);
      osc.stop(now + 0.18);
    } catch {
      // ignore
    }
  }

  public playBallIncoming() {
    if (!this.enabled || this.sfxVolume <= 0) return;
    this.initCtx();
    if (!this.ctx) return;

    try {
      const now = this.ctx.currentTime;
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();

      // Chirp when ball emerges from top net towards player
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(220, now);
      osc.frequency.exponentialRampToValueAtTime(880, now + 0.12);

      const targetGain = 0.2 * this.sfxVolume;
      gain.gain.setValueAtTime(targetGain, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.12);

      osc.connect(gain);
      gain.connect(this.ctx.destination);

      osc.start(now);
      osc.stop(now + 0.12);
    } catch {
      // ignore
    }
  }

  public playScore(isWinPoint: boolean = false) {
    if (!this.enabled || this.sfxVolume <= 0) return;
    this.initCtx();
    if (!this.ctx) return;

    try {
      const now = this.ctx.currentTime;
      const notes = isWinPoint ? [523.25, 659.25, 783.99, 1046.5] : [440, 554.37, 659.25];
      const noteDuration = isWinPoint ? 0.15 : 0.1;

      notes.forEach((freq, index) => {
        if (!this.ctx) return;
        const osc = this.ctx.createOscillator();
        const gain = this.ctx.createGain();

        osc.type = 'triangle';
        osc.frequency.setValueAtTime(freq, now + index * noteDuration);

        const startTime = now + index * noteDuration;
        const targetGain = 0.25 * this.sfxVolume;
        gain.gain.setValueAtTime(targetGain, startTime);
        gain.gain.exponentialRampToValueAtTime(0.001, startTime + noteDuration * 1.2);

        osc.connect(gain);
        gain.connect(this.ctx.destination);

        osc.start(startTime);
        osc.stop(startTime + noteDuration * 1.2);
      });
    } catch {
      // ignore
    }
  }

  public playLose() {
    if (!this.enabled || this.sfxVolume <= 0) return;
    this.initCtx();
    if (!this.ctx) return;

    try {
      const now = this.ctx.currentTime;
      const notes = [440, 370, 311, 220];
      const noteDuration = 0.12;

      notes.forEach((freq, index) => {
        if (!this.ctx) return;
        const osc = this.ctx.createOscillator();
        const gain = this.ctx.createGain();

        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(freq, now + index * noteDuration);

        const startTime = now + index * noteDuration;
        const targetGain = 0.2 * this.sfxVolume;
        gain.gain.setValueAtTime(targetGain, startTime);
        gain.gain.exponentialRampToValueAtTime(0.001, startTime + noteDuration * 1.1);

        osc.connect(gain);
        gain.connect(this.ctx.destination);

        osc.start(startTime);
        osc.stop(startTime + noteDuration * 1.1);
      });
    } catch {
      // ignore
    }
  }
}

export const sound = new SoundEngine();
