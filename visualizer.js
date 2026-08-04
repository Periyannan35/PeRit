/**
 * Visualizer — 3 modes: Frequency Bars, Waveform, Circular
 */

class Visualizer {
    constructor(engine) {
        this.engine = engine;
        this.canvas = document.getElementById('visualizer');
        this.ctx = this.canvas.getContext('2d');
        this.mode = 0; // 0=freq, 1=waveform, 2=circular
        this.resize();
        window.addEventListener('resize', () => this.resize());
    }

    resize() {
        const dpr = window.devicePixelRatio || 1;
        const rect = this.canvas.parentElement.getBoundingClientRect();
        this.canvas.width = rect.width * dpr;
        this.canvas.height = rect.height * dpr;
        this.ctx.scale(dpr, dpr);
        this.w = rect.width;
        this.h = rect.height;
    }

    start() {
        if (this.raf) cancelAnimationFrame(this.raf);
        this.draw();
    }

    stop() {
        if (this.raf) cancelAnimationFrame(this.raf);
        this.raf = null;
    }

    draw() {
        this.raf = requestAnimationFrame(() => this.draw());
        const ctx = this.ctx;
        const w = this.w, h = this.h;

        if (this.mode === 0) this.drawFreq(ctx, w, h);
        else if (this.mode === 1) this.drawWave(ctx, w, h);
        else this.drawCircular(ctx, w, h);
    }

    drawFreq(ctx, w, h) {
        const data = new Uint8Array(this.engine.analyser.frequencyBinCount);
        this.engine.analyser.getByteFrequencyData(data);
        ctx.fillStyle = 'rgba(10,10,18,0.25)';
        ctx.fillRect(0, 0, w, h);
        const bars = 64;
        const barW = w / bars;
        for (let i = 0; i < bars; i++) {
            const idx = Math.floor(i * data.length / bars);
            const value = data[idx] / 255;
            const barH = value * h * 0.85;
            const x = i * barW;
            const y = h - barH;
            const grad = ctx.createLinearGradient(0, h, 0, y);
            grad.addColorStop(0, '#00d4ff');
            grad.addColorStop(1, '#7b2cbf');
            ctx.fillStyle = grad;
            ctx.fillRect(x + 1, y, barW - 2, barH);
        }
    }

    drawWave(ctx, w, h) {
        const data = new Uint8Array(this.engine.analyser.frequencyBinCount);
        this.engine.analyser.getByteTimeDomainData(data);
        ctx.fillStyle = 'rgba(10,10,18,0.2)';
        ctx.fillRect(0, 0, w, h);
        ctx.lineWidth = 2;
        ctx.strokeStyle = '#00d4ff';
        ctx.beginPath();
        const slice = w / data.length;
        for (let i = 0; i < data.length; i++) {
            const v = data[i] / 128.0;
            const y = (v * h) / 2;
            if (i === 0) ctx.moveTo(0, y);
            else ctx.lineTo(i * slice, y);
        }
        ctx.stroke();

        ctx.strokeStyle = 'rgba(123,44,191,0.5)';
        ctx.beginPath();
        for (let i = 0; i < data.length; i++) {
            const v = data[i] / 128.0;
            const y = h - (v * h) / 2;
            if (i === 0) ctx.moveTo(0, y);
            else ctx.lineTo(i * slice, y);
        }
        ctx.stroke();
    }

    drawCircular(ctx, w, h) {
        const data = new Uint8Array(this.engine.analyser.frequencyBinCount);
        this.engine.analyser.getByteFrequencyData(data);
        ctx.fillStyle = 'rgba(10,10,18,0.3)';
        ctx.fillRect(0, 0, w, h);
        const cx = w / 2, cy = h / 2;
        const radius = Math.min(w, h) * 0.25;
        const bars = 60;
        ctx.lineWidth = 3;
        for (let i = 0; i < bars; i++) {
            const idx = Math.floor(i * data.length / bars);
            const value = data[idx] / 255;
            const angle = (i / bars) * Math.PI * 2;
            const barLen = value * radius * 1.2;
            const x1 = cx + Math.cos(angle) * radius;
            const y1 = cy + Math.sin(angle) * radius;
            const x2 = cx + Math.cos(angle) * (radius + barLen);
            const y2 = cy + Math.sin(angle) * (radius + barLen);
            const grad = ctx.createLinearGradient(x1, y1, x2, y2);
            grad.addColorStop(0, '#00d4ff');
            grad.addColorStop(1, '#ff2d95');
            ctx.strokeStyle = grad;
            ctx.beginPath();
            ctx.moveTo(x1, y1);
            ctx.lineTo(x2, y2);
            ctx.stroke();
        }
        ctx.strokeStyle = 'rgba(255,255,255,0.1)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(cx, cy, radius - 4, 0, Math.PI * 2);
        ctx.stroke();
    }

    setMode(idx) {
        this.mode = idx % 3;
    }
}