/**
 * SonicEnhance Pro — Main Application Controller
 * Ties AudioEngine, Visualizer, and Playlist together.
 */

// ==================== GLOBAL STATE ====================
window.appState = {
    isPlaying: false,
    loopMode: 'none',
    isShuffle: false,
    currentTrack: 0,
    volume: 1.0,
    playbackRate: 1.0,
    abBypass: false,
    visualizerMode: 0,
    isFullscreen: false,
    muted: false,
    preMuteVolume: 1.0
};

// ==================== UTILITIES ====================
const $ = id => document.getElementById(id);
const fmtTime = s => {
    if (!isFinite(s)) return '0:00';
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return `${m}:${sec.toString().padStart(2, '0')}`;
};
const showToast = (msg, type = 'info', duration = 3000) => {
    const container = $('toastContainer');
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = msg;
    container.appendChild(toast);
    requestAnimationFrame(() => toast.classList.add('show'));
    setTimeout(() => {
        toast.classList.remove('show');
        setTimeout(() => toast.remove(), 400);
    }, duration);
};
const setStatus = (msg, type = 'ready') => {
    const el = $('status');
    el.textContent = msg;
    el.className = `status ${type}`;
};

// ==================== PLAYLIST MANAGER ====================
class PlaylistManager {
    constructor() {
        this.items = [];
        this.current = 0;
    }
    add(file, buffer) {
        const item = {
            file, buffer,
            name: file.name,
            size: file.size,
            duration: buffer.duration,
            sampleRate: buffer.sampleRate,
            channels: buffer.numberOfChannels,
            bitrate: Math.round((file.size * 8) / buffer.duration / 1000)
        };
        this.items.push(item);
        this.render();
        return this.items.length - 1;
    }
    clear() {
        this.items = [];
        this.current = 0;
        this.render();
    }
    remove(index) {
        this.items.splice(index, 1);
        if (this.current >= this.items.length) this.current = Math.max(0, this.items.length - 1);
        this.render();
    }
    getCurrent() { return this.items[this.current]; }
    next() {
        if (window.appState.isShuffle) {
            let next;
            do { next = Math.floor(Math.random() * this.items.length); } while (next === this.current && this.items.length > 1);
            this.current = next;
        } else {
            this.current = (this.current + 1) % this.items.length;
        }
        return this.current;
    }
    prev() {
        this.current = (this.current - 1 + this.items.length) % this.items.length;
        return this.current;
    }
    select(index) {
        if (index >= 0 && index < this.items.length) {
            this.current = index;
            this.render();
            return this.items[index];
        }
        return null;
    }
    render() {
        const list = $('playlist');
        const section = $('playlistSection');
        const count = $('playlistCount');
        if (this.items.length === 0) {
            section.style.display = 'none';
            list.innerHTML = '';
            count.textContent = '0 tracks';
            return;
        }
        section.style.display = 'block';
        count.textContent = `${this.items.length} track${this.items.length !== 1 ? 's' : ''}`;
        list.innerHTML = '';
        this.items.forEach((item, i) => {
            const li = document.createElement('li');
            li.className = `playlist-item ${i === this.current ? 'active' : ''}`;
            li.innerHTML = `
                <span class="pl-num">${i + 1}</span>
                <div class="pl-info">
                    <div class="pl-name">${item.name.replace(/</g, '&lt;')}</div>
                    <div class="pl-meta">${fmtTime(item.duration)} • ${item.bitrate} kbps</div>
                </div>
                <button class="pl-remove" data-idx="${i}" title="Remove">✕</button>
            `;
            li.addEventListener('click', (e) => {
                if (e.target.classList.contains('pl-remove')) return;
                window.app.loadTrack(i);
            });
            li.querySelector('.pl-remove').addEventListener('click', (e) => {
                e.stopPropagation();
                this.remove(i);
                showToast('Removed from playlist', 'info');
            });
            list.appendChild(li);
        });
    }
}

// ==================== MAIN APP ====================
class App {
    constructor() {
        this.engine = new AudioEngine();
        this.playlist = new PlaylistManager();
        this.visualizer = null;
        this.progressRaf = null;
        this.peakRaf = null;
        this.init();
    }

    async init() {
        this.bindEvents();
        this.loadSettings();
        if (!this.visualizer && this.engine.analyser) {
            this.visualizer = new Visualizer(this.engine);
        }
        this.startPeakLoop();
    }

    // ---------- EVENT BINDING ----------
    bindEvents() {
        // Upload
        $('btnUpload').addEventListener('click', () => $('fileInput').click());
        $('fileInput').addEventListener('change', (e) => this.handleFiles(e.target.files));

        const upload = $('uploadSection');
        upload.addEventListener('click', (e) => {
            if (e.target === upload || e.target.closest('.upload-icon') || e.target.tagName === 'H3' || e.target.tagName === 'P') {
                $('fileInput').click();
            }
        });
        upload.addEventListener('dragover', (e) => { e.preventDefault(); upload.classList.add('dragover'); });
        upload.addEventListener('dragleave', () => upload.classList.remove('dragover'));
        upload.addEventListener('drop', (e) => {
            e.preventDefault();
            upload.classList.remove('dragover');
            this.handleFiles(e.dataTransfer.files);
        });

        // Global drop overlay
        const overlay = $('dropOverlay');
        let dragCounter = 0;
        window.addEventListener('dragenter', () => { dragCounter++; overlay.classList.add('active'); });
        window.addEventListener('dragleave', () => { dragCounter--; if (dragCounter <= 0) overlay.classList.remove('active'); });
        window.addEventListener('drop', (e) => {
            e.preventDefault();
            dragCounter = 0;
            overlay.classList.remove('active');
            if (e.dataTransfer.files.length) this.handleFiles(e.dataTransfer.files);
        });

        // Playback
        $('btnPlay').addEventListener('click', () => this.togglePlay());
        $('btnStop').addEventListener('click', () => this.stop());
        $('btnPrev').addEventListener('click', () => this.prevTrack());
        $('btnNext').addEventListener('click', () => this.nextTrack());
        $('btnLoop').addEventListener('click', () => this.cycleLoop());
        $('btnShuffle').addEventListener('click', () => this.toggleShuffle());

        // Progress bar
        const prog = $('progressContainer');
        const tooltip = $('progressTooltip');
        prog.addEventListener('click', (e) => {
            const rect = prog.getBoundingClientRect();
            const pct = ((e.clientX - rect.left) / rect.width) * 100;
            this.engine.seek(pct);
        });
        prog.addEventListener('mousemove', (e) => {
            const rect = prog.getBoundingClientRect();
            const pct = (e.clientX - rect.left) / rect.width;
            const t = pct * (this.engine.buffer ? this.engine.buffer.duration : 0);
            tooltip.textContent = fmtTime(t);
            tooltip.style.left = (pct * 100) + '%';
            tooltip.style.opacity = 1;
        });
        prog.addEventListener('mouseleave', () => { tooltip.style.opacity = 0; });

        // Volume & Speed
        $('volumeSlider').addEventListener('input', (e) => {
            const v = e.target.value / 100;
            window.appState.volume = v;
            window.appState.muted = false;
            this.engine.setVolume(v);
            $('volumeValue').textContent = e.target.value + '%';
            this.saveSettings();
        });
        $('speedSlider').addEventListener('input', (e) => {
            const r = e.target.value / 100;
            window.appState.playbackRate = r;
            this.engine.setPlaybackRate(r);
            $('speedValue').textContent = r.toFixed(1) + 'x';
        });

        // A/B Bypass
        $('btnAB').addEventListener('click', () => {
            window.appState.abBypass = !window.appState.abBypass;
            this.engine.setAB(window.appState.abBypass);
            $('btnAB').classList.toggle('bypass-active', window.appState.abBypass);
            showToast(window.appState.abBypass ? 'A/B: Original Signal' : 'A/B: Enhanced Signal', 'info');
        });

        // Visualizer
        $('btnVisMode').addEventListener('click', () => {
            window.appState.visualizerMode = (window.appState.visualizerMode + 1) % 3;
            this.visualizer.setMode(window.appState.visualizerMode);
            const modes = ['Frequency Bars', 'Waveform', 'Circular'];
            showToast(`Visualizer: ${modes[window.appState.visualizerMode]}`, 'info');
        });
        $('btnFullscreen').addEventListener('click', () => this.toggleFullscreen());
        $('visualizerSection').addEventListener('dblclick', () => this.toggleFullscreen());

        // EQ sliders
        ['eqLow', 'eqMid', 'eqHigh'].forEach((id, i) => {
            $(id).addEventListener('input', (e) => {
                const gain = parseInt(e.target.value);
                this.engine.updateEQ(i, gain);
                const sign = gain > 0 ? '+' : '';
                document.getElementById(['valLow', 'valMid', 'valHigh'][i]).textContent = `${sign}${gain}dB`;
                document.querySelectorAll('.preset-btn').forEach(b => b.classList.remove('active'));
            });
        });

        // Enhancement toggles
        const toggles = ['clarity', 'earphone', 'bass', 'spatial', 'compressor', 'limiter', 'hpf'];
        toggles.forEach(name => {
            const el = $(name + 'Toggle');
            el.addEventListener('click', () => {
                el.classList.toggle('active');
                const input = el.querySelector('input');
                input.checked = el.classList.contains('active');
                if (name === 'compressor') this.engine.setCompressor(el.classList.contains('active'));
                if (name === 'hpf') this.engine.setHPF(el.classList.contains('active'));
                this.saveSettings();
            });
        });

        // Advanced sliders
        $('reverbMix').addEventListener('input', (e) => {
            $('reverbMixVal').textContent = e.target.value + '%';
            this.engine.setReverbMix(parseInt(e.target.value));
            this.saveSettings();
        });
        $('stereoWidth').addEventListener('input', (e) => {
            $('stereoWidthVal').textContent = e.target.value + '%';
            this.engine.setStereoWidth(parseInt(e.target.value));
            this.saveSettings();
        });

        // Presets
        document.querySelectorAll('.preset-btn').forEach(btn => {
            btn.addEventListener('click', () => this.applyPreset(btn.dataset.preset));
        });

        // Advanced accordion
        $('advancedHeader').addEventListener('click', () => {
            $('advancedContent').classList.toggle('open');
            $('advancedHeader').classList.toggle('open');
        });

        // Playlist actions
        $('btnClear').addEventListener('click', () => {
            this.playlist.clear();
            this.engine.stop();
            this.engine.buffer = null;
            $('trackInfo').style.display = 'none';
            $('fileInfo').textContent = '';
            setStatus('Playlist cleared', 'ready');
        });

        // Export
        $('btnExport').addEventListener('click', () => this.openExportModal());
        $('btnStartExport').addEventListener('click', () => this.startExport());
        $('btnCloseExport').addEventListener('click', () => $('exportModal').classList.remove('open'));

        // Shortcuts modal
        $('btnShortcuts').addEventListener('click', () => $('shortcutsModal').classList.add('open'));
        $('btnCloseShortcuts').addEventListener('click', () => $('shortcutsModal').classList.remove('open'));
        $('shortcutsModal').addEventListener('click', (e) => {
            if (e.target === $('shortcutsModal')) $('shortcutsModal').classList.remove('open');
        });

        // Keyboard shortcuts
        document.addEventListener('keydown', (e) => this.handleKey(e));

        // Touch swipe on visualizer
        let touchStartX = 0;
        const vis = $('visualizerSection');
        vis.addEventListener('touchstart', (e) => { touchStartX = e.touches[0].clientX; }, { passive: true });
        vis.addEventListener('touchend', (e) => {
            const diff = e.changedTouches[0].clientX - touchStartX;
            if (Math.abs(diff) > 50) {
                window.appState.visualizerMode = (window.appState.visualizerMode + (diff > 0 ? 1 : 2)) % 3;
                this.visualizer.setMode(window.appState.visualizerMode);
            }
        }, { passive: true });
    }

    // ---------- FILE HANDLING ----------
    async handleFiles(files) {
        if (!files.length) return;
        if (!this.engine.ctx) await this.engine.init();
        if (!this.visualizer) this.visualizer = new Visualizer(this.engine);

        const valid = Array.from(files).filter(f =>
            f.type.includes('audio') || /\.(mp3|wav|ogg|flac|m4a|aac|wma)$/i.test(f.name)
        );
        if (!valid.length) {
            showToast('Please upload valid audio files', 'error');
            return;
        }

        setStatus('⏳ Decoding audio...', 'processing');
        let loadedCount = 0;
        for (const file of valid) {
            try {
                const buffer = await this.engine.load(file);
                const idx = this.playlist.add(file, buffer);
                if (this.playlist.items.length === 1) await this.loadTrack(idx);
                loadedCount++;
            } catch (err) {
                showToast(`Failed to load ${file.name}`, 'error');
                console.error(err);
            }
        }
        if (loadedCount > 0) {
            setStatus('✅ Ready — Enhanced for your earphones', 'ready');
        } else {
            setStatus('No files could be loaded', 'error');
        }
    }

    // ---------- TRACK MANAGEMENT ----------
    async loadTrack(index) {
        const item = this.playlist.select(index);
        if (!item) return;
        this.engine.stop();
        this.engine.buffer = item.buffer;
        this.engine.pauseTime = 0;
        window.appState.currentTrack = index;

        // Update track info panel
        $('trackInfo').style.display = 'block';
        $('infoName').textContent = item.name;
        $('infoSize').textContent = (item.size / 1024 / 1024).toFixed(2) + ' MB';
        $('infoDuration').textContent = fmtTime(item.duration);
        $('infoSampleRate').textContent = item.sampleRate + ' Hz';
        $('infoChannels').textContent = item.channels + (item.channels === 1 ? ' (Mono)' : ' (Stereo)');
        $('infoBitrate').textContent = item.bitrate + ' kbps (est)';
        $('duration').textContent = fmtTime(item.duration);
        $('currentTime').textContent = '0:00';
        $('progressFill').style.width = '0%';

        showToast(`Loaded: ${item.name}`, 'success');
        setStatus('✅ Ready — Enhanced for your earphones', 'ready');

        // Auto-play
        this.engine.play();
        this.visualizer.start();
        this.startProgressLoop();
        this.updatePlayButton();
    }

    togglePlay() {
        if (!this.engine.buffer) {
            showToast('Load an audio file first', 'info');
            return;
        }
        if (window.appState.isPlaying) {
            this.engine.pause();
            this.visualizer.stop();
            this.stopProgressLoop();
        } else {
            this.engine.play();
            this.visualizer.start();
            this.startProgressLoop();
        }
        this.updatePlayButton();
    }

    stop() {
        this.engine.stop();
        this.visualizer.stop();
        this.stopProgressLoop();
        this.updatePlayButton();
        $('progressFill').style.width = '0%';
        $('currentTime').textContent = '0:00';
    }

    prevTrack() {
        if (!this.playlist.items.length) return;
        const idx = this.playlist.prev();
        this.loadTrack(idx);
    }

    nextTrack() {
        if (!this.playlist.items.length) return;
        const idx = this.playlist.next();
        this.loadTrack(idx);
    }

    onTrackEnded() {
        if (window.appState.loopMode === 'one') {
            this.engine.stop();
            this.engine.play();
            return;
        }
        if (this.playlist.items.length > 1 && (window.appState.loopMode === 'all' || window.appState.currentTrack < this.playlist.items.length - 1)) {
            const idx = this.playlist.next();
            this.loadTrack(idx);
        } else if (window.appState.loopMode === 'all' && this.playlist.items.length === 1) {
            this.engine.stop();
            this.engine.play();
        } else {
            this.stop();
            setStatus('⏹ Playback finished', 'ready');
        }
    }

    // ---------- LOOP & SHUFFLE ----------
    cycleLoop() {
        const modes = ['none', 'one', 'all'];
        const idx = modes.indexOf(window.appState.loopMode);
        window.appState.loopMode = modes[(idx + 1) % 3];
        this.updateLoopButton();
        const labels = { none: 'Off', one: 'One', all: 'All' };
        showToast(`Loop: ${labels[window.appState.loopMode]}`, 'info');
        this.saveSettings();
    }

    toggleShuffle() {
        window.appState.isShuffle = !window.appState.isShuffle;
        this.updateShuffleButton();
        showToast(`Shuffle: ${window.appState.isShuffle ? 'On' : 'Off'}`, 'info');
        this.saveSettings();
    }

    // ---------- PRESETS ----------
    applyPreset(name) {
        document.querySelectorAll('.preset-btn').forEach(b => b.classList.remove('active'));
        const btn = document.querySelector(`[data-preset="${name}"]`);
        if (btn) btn.classList.add('active');

        const presets = {
            earphone: [6, 3, 4],
            bass: [12, 0, 2],
            vocal: [-2, 8, 6],
            flat: [0, 0, 0]
        };
        const vals = presets[name] || [6, 3, 4];

        $('eqLow').value = vals[0];
        $('valLow').textContent = (vals[0] > 0 ? '+' : '') + vals[0] + 'dB';
        this.engine.updateEQ(0, vals[0]);

        $('eqMid').value = vals[1];
        $('valMid').textContent = (vals[1] > 0 ? '+' : '') + vals[1] + 'dB';
        this.engine.updateEQ(1, vals[1]);

        $('eqHigh').value = vals[2];
        $('valHigh').textContent = (vals[2] > 0 ? '+' : '') + vals[2] + 'dB';
        this.engine.updateEQ(2, vals[2]);

        // Update toggles to match preset intent
        const toggleMap = {
            earphone: { clarity: true, earphone: true, bass: true, spatial: false },
            bass: { clarity: false, earphone: false, bass: true, spatial: false },
            vocal: { clarity: true, earphone: true, bass: false, spatial: false },
            flat: { clarity: false, earphone: false, bass: false, spatial: false }
        };
        const map = toggleMap[name];
        if (map) {
            Object.entries(map).forEach(([key, val]) => {
                const el = $(key + 'Toggle');
                el.classList.toggle('active', val);
                el.querySelector('input').checked = val;
            });
        }
        this.saveSettings();
    }

    // ---------- EXPORT ----------
    openExportModal() {
        if (!this.engine.buffer) {
            showToast('Load a track before exporting', 'info');
            return;
        }
        $('exportModal').classList.add('open');
        $('exportBar').style.width = '0%';
        $('exportStatus').textContent = 'Ready to export';
        $('btnStartExport').disabled = false;
        $('btnStartExport').textContent = 'Start Export';
    }

    async startExport() {
        $('btnStartExport').disabled = true;
        $('btnStartExport').textContent = 'Exporting...';
        $('exportStatus').textContent = 'Rendering offline...';

        try {
            const blob = await this.engine.exportToWAV((pct) => {
                $('exportBar').style.width = (pct * 100) + '%';
                if (pct < 1) $('exportStatus').textContent = `Rendering... ${Math.round(pct * 100)}%`;
                else $('exportStatus').textContent = 'Encoding WAV...';
            });

            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            const item = this.playlist.getCurrent();
            a.download = (item ? item.name.replace(/\.[^.]+$/, '') : 'enhanced') + '_sonicenhance.wav';
            a.href = url;
            a.click();
            URL.revokeObjectURL(url);

            $('exportStatus').textContent = 'Export complete!';
            showToast('WAV exported successfully', 'success');
            setTimeout(() => $('exportModal').classList.remove('open'), 800);
        } catch (err) {
            console.error(err);
            $('exportStatus').textContent = 'Export failed';
            showToast('Export failed: ' + err.message, 'error');
        } finally {
            $('btnStartExport').disabled = false;
            $('btnStartExport').textContent = 'Start Export';
        }
    }

    // ---------- KEYBOARD ----------
    handleKey(e) {
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

        switch (e.key) {
            case ' ':
                e.preventDefault();
                this.togglePlay();
                break;
            case 'ArrowLeft':
                if (this.engine.buffer) this.engine.seek(Math.max(0, ((this.engine.getCurrentTime() / this.engine.buffer.duration) * 100) - 5));
                break;
            case 'ArrowRight':
                if (this.engine.buffer) this.engine.seek(Math.min(100, ((this.engine.getCurrentTime() / this.engine.buffer.duration) * 100) + 5));
                break;
            case 'ArrowUp':
                e.preventDefault();
                {
                    const v = Math.min(200, parseInt($('volumeSlider').value) + 10);
                    $('volumeSlider').value = v;
                    $('volumeSlider').dispatchEvent(new Event('input'));
                }
                break;
            case 'ArrowDown':
                e.preventDefault();
                {
                    const v = Math.max(0, parseInt($('volumeSlider').value) - 10);
                    $('volumeSlider').value = v;
                    $('volumeSlider').dispatchEvent(new Event('input'));
                }
                break;
            case 'm':
            case 'M':
                if (window.appState.muted) {
                    window.appState.muted = false;
                    this.engine.setVolume(window.appState.preMuteVolume);
                    $('volumeSlider').value = Math.round(window.appState.preMuteVolume * 100);
                    $('volumeValue').textContent = Math.round(window.appState.preMuteVolume * 100) + '%';
                } else {
                    window.appState.muted = true;
                    window.appState.preMuteVolume = window.appState.volume;
                    this.engine.setVolume(0);
                    $('volumeSlider').value = 0;
                    $('volumeValue').textContent = '0%';
                }
                break;
            case 'a':
            case 'A':
                $('btnAB').click();
                break;
            case 'f':
            case 'F':
                this.toggleFullscreen();
                break;
            case '1':
                this.applyPreset('earphone');
                showToast('Preset: Wired Earphones', 'info');
                break;
            case '2':
                this.applyPreset('bass');
                showToast('Preset: Bass Boost', 'info');
                break;
            case '3':
                this.applyPreset('vocal');
                showToast('Preset: Vocal Clarity', 'info');
                break;
            case '4':
                this.applyPreset('flat');
                showToast('Preset: Flat', 'info');
                break;
            case 'l':
            case 'L':
                this.cycleLoop();
                break;
            case 's':
            case 'S':
                this.toggleShuffle();
                break;
            case 'n':
            case 'N':
                this.nextTrack();
                break;
            case 'p':
            case 'P':
                this.prevTrack();
                break;
            case 'Escape':
                $('shortcutsModal').classList.remove('open');
                $('exportModal').classList.remove('open');
                if (window.appState.isFullscreen) this.toggleFullscreen();
                break;
        }
    }

    // ---------- FULLSCREEN ----------
    toggleFullscreen() {
        const el = $('visualizerSection');
        if (!document.fullscreenElement) {
            el.requestFullscreen().catch(() => {});
            el.classList.add('fullscreen');
            window.appState.isFullscreen = true;
        } else {
            document.exitFullscreen();
            el.classList.remove('fullscreen');
            window.appState.isFullscreen = false;
        }
        setTimeout(() => { if (this.visualizer) this.visualizer.resize(); }, 300);
    }

    // ---------- SETTINGS ----------
    saveSettings() {
        const data = {
            volume: window.appState.volume,
            loopMode: window.appState.loopMode,
            isShuffle: window.appState.isShuffle,
            preset: document.querySelector('.preset-btn.active')?.dataset.preset || 'earphone',
            toggles: {
                clarity: $('clarityToggle').classList.contains('active'),
                earphone: $('earphoneToggle').classList.contains('active'),
                bass: $('bassToggle').classList.contains('active'),
                spatial: $('spatialToggle').classList.contains('active'),
                compressor: $('compressorToggle').classList.contains('active'),
                limiter: $('limiterToggle').classList.contains('active'),
                hpf: $('hpfToggle').classList.contains('active')
            },
            advanced: {
                reverbMix: $('reverbMix').value,
                stereoWidth: $('stereoWidth').value
            }
        };
        try { localStorage.setItem('sonicenhance_settings', JSON.stringify(data)); } catch (e) {}
    }

    loadSettings() {
        try {
            const raw = localStorage.getItem('sonicenhance_settings');
            if (!raw) return;
            const data = JSON.parse(raw);

            if (data.volume !== undefined) {
                window.appState.volume = data.volume;
                $('volumeSlider').value = Math.round(data.volume * 100);
                $('volumeValue').textContent = Math.round(data.volume * 100) + '%';
            }
            if (data.loopMode) { window.appState.loopMode = data.loopMode; this.updateLoopButton(); }
            if (data.isShuffle !== undefined) { window.appState.isShuffle = data.isShuffle; this.updateShuffleButton(); }
            if (data.toggles) {
                Object.entries(data.toggles).forEach(([k, v]) => {
                    const el = $(k + 'Toggle');
                    if (el) {
                        el.classList.toggle('active', v);
                        const inp = el.querySelector('input');
                        if (inp) inp.checked = v;
                    }
                });
            }
            if (data.advanced) {
                if (data.advanced.reverbMix) { $('reverbMix').value = data.advanced.reverbMix; $('reverbMixVal').textContent = data.advanced.reverbMix + '%'; }
                if (data.advanced.stereoWidth) { $('stereoWidth').value = data.advanced.stereoWidth; $('stereoWidthVal').textContent = data.advanced.stereoWidth + '%'; }
            }
            if (data.preset) this.applyPreset(data.preset);
        } catch (e) { console.warn('Settings load failed', e); }
    }

    // ---------- UI UPDATES ----------
    updatePlayButton() {
        const btn = $('btnPlay');
        btn.textContent = window.appState.isPlaying ? '⏸' : '▶';
        btn.classList.toggle('active', window.appState.isPlaying);
    }

    startProgressLoop() {
        this.stopProgressLoop();
        const tick = () => {
            if (!window.appState.isPlaying || !this.engine.buffer) return;
            const curr = this.engine.getCurrentTime();
            const dur = this.engine.buffer.duration;
            $('currentTime').textContent = fmtTime(curr);
            $('progressFill').style.width = ((curr / dur) * 100) + '%';
            if (curr >= dur && !this.engine.source?.loop) {
                this.onTrackEnded();
                return;
            }
            this.progressRaf = requestAnimationFrame(tick);
        };
        tick();
    }

    stopProgressLoop() {
        if (this.progressRaf) cancelAnimationFrame(this.progressRaf);
        this.progressRaf = null;
    }

    startPeakLoop() {
        const tick = () => {
            if (this.engine.ctx) {
                const peaks = this.engine.getPeaks();
                $('peakLeft').style.width = Math.min(100, peaks.l * 100) + '%';
                $('peakRight').style.width = Math.min(100, peaks.r * 100) + '%';
            }
            this.peakRaf = requestAnimationFrame(tick);
        };
        tick();
    }

    updateLoopButton() {
        const btn = $('btnLoop');
        const icons = { none: '🔁', one: '🔂', all: '🔁' };
        const titles = { none: 'Loop: Off', one: 'Loop: One', all: 'Loop: All' };
        btn.textContent = icons[window.appState.loopMode];
        btn.title = titles[window.appState.loopMode] + ' (L)';
        btn.classList.toggle('active', window.appState.loopMode !== 'none');
    }

    updateShuffleButton() {
        $('btnShuffle').classList.toggle('active', window.appState.isShuffle);
    }
}

// ==================== BOOT ====================
window.addEventListener('DOMContentLoaded', () => {
    window.app = new App();
});