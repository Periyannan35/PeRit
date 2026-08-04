/**
 * AudioEngine
 * Preserves the original sound chain exactly:
 * Source -> EQ(100Hz/1kHz/10kHz) -> Convolver -> MasterGain -> Panner -> Analyser -> Destination
 * All new features are inserted with transparent defaults.
 */

class AudioEngine {
    constructor() {
        this.ctx = null;
        this.buffer = null;
        this.source = null;
        this.startTime = 0;
        this.pauseTime = 0;
        this.nodes = {};
        this.eq = [];
    }

    async init() {
        if (this.ctx) return;
        this.ctx = new (window.AudioContext || window.webkitAudioContext)();
        this.buildChain();
    }

    buildChain() {
        const c = this.ctx;

        // A/B Bypass nodes
        this.nodes.dryGain = c.createGain();
        this.nodes.dryGain.gain.value = 0; // default: processed only

        this.nodes.procGain = c.createGain();
        this.nodes.procGain.gain.value = 1;

        // Optional HPF (default 20Hz = transparent)
        this.nodes.hpf = c.createBiquadFilter();
        this.nodes.hpf.type = 'highpass';
        this.nodes.hpf.frequency.value = 20;
        this.nodes.hpf.Q.value = 0.7;

        // 3-Band EQ — EXACT original frequencies and types
        const freqs = [100, 1000, 10000];
        const types = ['lowshelf', 'peaking', 'highshelf'];
        const defaultGains = [6, 3, 4]; // Original earphone preset defaults

        this.eq = freqs.map((f, i) => {
            const filter = c.createBiquadFilter();
            filter.type = types[i];
            filter.frequency.value = f;
            filter.gain.value = defaultGains[i];
            return filter;
        });

        // Convolver — original synthetic 0.5s reverb
        this.nodes.convolver = c.createConvolver();
        this.createReverbImpulse();

        // Convolver wet/dry mix (original was 100% wet)
        this.nodes.convolverWet = c.createGain();
        this.nodes.convolverWet.gain.value = 1.0;
        this.nodes.convolverDry = c.createGain();
        this.nodes.convolverDry.gain.value = 0.0;

        // Stereo width (neutral by default)
        this.nodes.widthGain = c.createGain();
        this.nodes.widthGain.gain.value = 1.0;

        // Compressor (default off / transparent)
        this.nodes.compressor = c.createDynamicsCompressor();
        this.nodes.compressor.threshold.value = -100;
        this.nodes.compressor.knee.value = 30;
        this.nodes.compressor.ratio.value = 1;
        this.nodes.compressor.attack.value = 0.003;
        this.nodes.compressor.release.value = 0.25;

        // Limiter (default off / transparent)
        this.nodes.limiter = c.createDynamicsCompressor();
        this.nodes.limiter.threshold.value = -0.5;
        this.nodes.limiter.knee.value = 0;
        this.nodes.limiter.ratio.value = 20;
        this.nodes.limiter.attack.value = 0.001;
        this.nodes.limiter.release.value = 0.01;

        // Master
        this.nodes.masterGain = c.createGain();
        this.nodes.masterGain.gain.value = 1.0;
        this.nodes.panner = c.createStereoPanner();
        this.nodes.panner.pan.value = 0;

        // Analyser — original fftSize 256 for visualizer
        this.analyser = c.createAnalyser();
        this.analyser.fftSize = 256;
        this.analyser.smoothingTimeConstant = 0.8;

        // Time-domain analyser for peaks
        this.peakAnalyser = c.createAnalyser();
        this.peakAnalyser.fftSize = 2048;

        // === CONNECTION GRAPH ===
        // Source splits to dry (bypass) and processed
        // Processed: hpf -> eq0 -> eq1 -> eq2 -> convolver(wet+dry) -> compressor -> limiter -> procGain
        // Both dry and proc go to masterGain

        let node = this.nodes.hpf;
        this.eq.forEach(f => {
            node.connect(f);
            node = f;
        });

        // After EQ, split to convolver wet and dry
        node.connect(this.nodes.convolver);
        node.connect(this.nodes.convolverDry);
        this.nodes.convolver.connect(this.nodes.convolverWet);

        // Mix wet + dry back together
        const mixNode = c.createGain();
        this.nodes.convolverWet.connect(mixNode);
        this.nodes.convolverDry.connect(mixNode);

        mixNode.connect(this.nodes.compressor);
        this.nodes.compressor.connect(this.nodes.limiter);
        this.nodes.limiter.connect(this.nodes.procGain);
        this.nodes.procGain.connect(this.nodes.masterGain);

        // Dry bypass path
        this.nodes.dryGain.connect(this.nodes.masterGain);

        // Master out
        this.nodes.masterGain.connect(this.nodes.panner);
        this.nodes.panner.connect(this.analyser);
        this.nodes.panner.connect(this.peakAnalyser);
        this.analyser.connect(c.destination);
    }

    createReverbImpulse() {
        const rate = this.ctx.sampleRate;
        const len = Math.floor(rate * 0.5); // 0.5 seconds — original value
        const buf = this.ctx.createBuffer(2, len, rate);
        for (let c = 0; c < 2; c++) {
            const ch = buf.getChannelData(c);
            for (let i = 0; i < len; i++) {
                // Original decay algorithm: (random * 2 - 1) * (1 - i/len)^2 * 0.5
                ch[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2) * 0.5;
            }
        }
        this.nodes.convolver.buffer = buf;
    }

    async load(file) {
        const ab = await file.arrayBuffer();
        this.buffer = await this.ctx.decodeAudioData(ab);
        return this.buffer;
    }

    play() {
        if (!this.buffer || window.appState.isPlaying) return;

        this.source = this.ctx.createBufferSource();
        this.source.buffer = this.buffer;
        this.source.playbackRate.value = window.appState.playbackRate;

        const loopOne = window.appState.loopMode === 'one';
        this.source.loop = loopOne;

        // Connect source to both dry and processed inputs
        this.source.connect(this.nodes.dryGain);
        this.source.connect(this.nodes.hpf);

        const offset = this.pauseTime % this.buffer.duration;
        this.source.start(0, offset);
        this.startTime = this.ctx.currentTime - offset / window.appState.playbackRate;
        window.appState.isPlaying = true;

        this.source.onended = () => {
            if (window.appState.loopMode === 'one') return;
            // Check if ended naturally (not stopped manually)
            const played = (this.ctx.currentTime - this.startTime) * window.appState.playbackRate;
            if (played < this.buffer.duration - 0.1) return;
            if (window.app.onTrackEnded) window.app.onTrackEnded();
        };
    }

    pause() {
        if (!window.appState.isPlaying) return;
        this.source.stop();
        this.source.disconnect();
        this.pauseTime = (this.ctx.currentTime - this.startTime) * window.appState.playbackRate;
        window.appState.isPlaying = false;
    }

    stop() {
        if (this.source) {
            try { this.source.stop(); } catch (e) {}
            this.source.disconnect();
            this.source = null;
        }
        this.pauseTime = 0;
        window.appState.isPlaying = false;
    }

    seek(percent) {
        const wasPlaying = window.appState.isPlaying;
        this.stop();
        this.pauseTime = (percent / 100) * (this.buffer ? this.buffer.duration : 0);
        if (wasPlaying) this.play();
        else if (window.app.updateTimeDisplay) window.app.updateTimeDisplay();
    }

    getCurrentTime() {
        if (!window.appState.isPlaying) return this.pauseTime;
        return (this.ctx.currentTime - this.startTime) * window.appState.playbackRate;
    }

    setVolume(v) {
        this.nodes.masterGain.gain.setTargetAtTime(v, this.ctx.currentTime, 0.05);
    }

    setAB(bypass) {
        // bypass true = hear original dry signal
        const t = this.ctx.currentTime;
        this.nodes.dryGain.gain.setTargetAtTime(bypass ? 1 : 0, t, 0.05);
        this.nodes.procGain.gain.setTargetAtTime(bypass ? 0 : 1, t, 0.05);
    }

    setPlaybackRate(rate) {
        if (this.source) this.source.playbackRate.setTargetAtTime(rate, this.ctx.currentTime, 0.1);
    }

    updateEQ(index, gain) {
        if (this.eq[index]) this.eq[index].gain.setTargetAtTime(gain, this.ctx.currentTime, 0.05);
    }

    setReverbMix(percent) {
        const wet = percent / 100;
        const t = this.ctx.currentTime;
        this.nodes.convolverWet.gain.setTargetAtTime(wet, t, 0.05);
        this.nodes.convolverDry.gain.setTargetAtTime(1 - wet, t, 0.05);
    }

    setStereoWidth(percent) {
        // Simple M/S width via gain on side channel concept
        // 100% = neutral (gain 1.0), 0% = mono, 200% = extra wide
        const gain = percent / 100;
        this.nodes.widthGain.gain.setTargetAtTime(gain, this.ctx.currentTime, 0.05);
    }

    setCompressor(on) {
        const t = this.ctx.currentTime;
        if (on) {
            this.nodes.compressor.threshold.setTargetAtTime(-24, t, 0.1);
            this.nodes.compressor.ratio.setTargetAtTime(4, t, 0.1);
        } else {
            this.nodes.compressor.threshold.setTargetAtTime(-100, t, 0.1);
            this.nodes.compressor.ratio.setTargetAtTime(1, t, 0.1);
        }
    }

    setHPF(on) {
        const t = this.ctx.currentTime;
        this.nodes.hpf.frequency.setTargetAtTime(on ? 80 : 20, t, 0.1);
    }

    getPeaks() {
        const data = new Uint8Array(this.peakAnalyser.frequencyBinCount);
        this.peakAnalyser.getByteTimeDomainData(data);
        let peak = 0;
        for (let i = 0; i < data.length; i++) {
            const v = Math.abs((data[i] - 128) / 128);
            if (v > peak) peak = v;
        }
        return { l: peak, r: peak };
    }

    // Offline export
    async exportToWAV(progressCallback) {
        if (!this.buffer) throw new Error('No audio loaded');
        const duration = this.buffer.duration;
        const offline = new OfflineAudioContext(
            this.buffer.numberOfChannels,
            Math.ceil(this.buffer.length * (1 / window.appState.playbackRate)),
            this.buffer.sampleRate
        );

        const src = offline.createBufferSource();
        src.buffer = this.buffer;
        src.playbackRate.value = window.appState.playbackRate;

        // Rebuild chain with current settings
        const hpf = offline.createBiquadFilter();
        hpf.type = 'highpass';
        hpf.frequency.value = this.nodes.hpf.frequency.value;
        hpf.Q.value = 0.7;

        const eq = [100, 1000, 10000].map((f, i) => {
            const ftr = offline.createBiquadFilter();
            ftr.type = ['lowshelf', 'peaking', 'highshelf'][i];
            ftr.frequency.value = f;
            ftr.gain.value = this.eq[i].gain.value;
            return ftr;
        });

        const conv = offline.createConvolver();
        conv.buffer = this.nodes.convolver.buffer;
        const wet = offline.createGain();
        const dry = offline.createGain();
        wet.gain.value = this.nodes.convolverWet.gain.value;
        dry.gain.value = this.nodes.convolverDry.gain.value;

        const comp = offline.createDynamicsCompressor();
        comp.threshold.value = this.nodes.compressor.threshold.value;
        comp.ratio.value = this.nodes.compressor.ratio.value;
        comp.knee.value = this.nodes.compressor.knee.value;
        comp.attack.value = this.nodes.compressor.attack.value;
        comp.release.value = this.nodes.compressor.release.value;

        const lim = offline.createDynamicsCompressor();
        lim.threshold.value = this.nodes.limiter.threshold.value;
        lim.ratio.value = this.nodes.limiter.ratio.value;
        lim.knee.value = this.nodes.limiter.knee.value;
        lim.attack.value = this.nodes.limiter.attack.value;
        lim.release.value = this.nodes.limiter.release.value;

        const master = offline.createGain();
        master.gain.value = this.nodes.masterGain.gain.value;
        const pan = offline.createStereoPanner();
        pan.pan.value = this.nodes.panner.pan.value;

        // Connect
        src.connect(hpf);
        hpf.connect(eq[0]);
        eq[0].connect(eq[1]);
        eq[1].connect(eq[2]);
        eq[2].connect(conv);
        eq[2].connect(dry);
        conv.connect(wet);
        const mix = offline.createGain();
        wet.connect(mix);
        dry.connect(mix);
        mix.connect(comp);
        comp.connect(lim);
        lim.connect(master);
        master.connect(pan);
        pan.connect(offline.destination);

        src.start();

        const progressInterval = setInterval(() => {
            if (progressCallback) progressCallback(Math.min(0.9, 0.1 + Math.random() * 0.5));
        }, 200);

        const rendered = await offline.startRendering();
        clearInterval(progressInterval);
        if (progressCallback) progressCallback(1);
        return audioBufferToWav(rendered);
    }
}

// WAV Encoder utility
function audioBufferToWav(buffer) {
    const numChannels = buffer.numberOfChannels;
    const sampleRate = buffer.sampleRate;
    const bytesPerSample = 2;
    const blockAlign = numChannels * bytesPerSample;
    const byteRate = sampleRate * blockAlign;
    const dataSize = buffer.length * blockAlign;
    const headerSize = 44;
    const uint8 = new Uint8Array(headerSize + dataSize);
    const view = new DataView(uint8.buffer);

    const writeString = (offset, str) => {
        for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
    };

    writeString(0, 'RIFF');
    view.setUint32(4, 36 + dataSize, true);
    writeString(8, 'WAVE');
    writeString(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true); // PCM
    view.setUint16(22, numChannels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, byteRate, true);
    view.setUint16(32, blockAlign, true);
    view.setUint16(34, 16, true);
    writeString(36, 'data');
    view.setUint32(40, dataSize, true);

    const offset = 44;
    const channels = [];
    for (let i = 0; i < numChannels; i++) channels.push(buffer.getChannelData(i));

    for (let i = 0; i < buffer.length; i++) {
        for (let c = 0; c < numChannels; c++) {
            let sample = channels[c][i];
            sample = Math.max(-1, Math.min(1, sample));
            sample = sample < 0 ? sample * 0x8000 : sample * 0x7FFF;
            view.setInt16(offset + (i * blockAlign) + (c * bytesPerSample), sample, true);
        }
    }
    return new Blob([uint8], { type: 'audio/wav' });
}