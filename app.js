/* ==========================================================================
   SWARAA — A LITTLE UNIVERSE
   Cinematic birthday experience · application engine
   --------------------------------------------------------------------------
   · Utils            small shared helpers
   · PortraitReveal   real-pixel particle reconstruction (canvas)
   · OrbitGallery     3D orbital photo gallery + lightbox
   · LetterPage       editable letter persistence + scroll reveals
   · Toast            graceful error reporting
   ========================================================================== */
(function () {
    'use strict';

    /* ------------------------------------------------------------------ *
     *  Utils
     * ------------------------------------------------------------------ */
    const PREFIX = window.location.pathname.indexOf('/pages/') !== -1 ? '../' : '';

    const FALLBACK_MANIFEST = {
        portrait: 'assets/images/portrait.jpeg',
        memories: [
            'assets/images/memory-01.png',
            'assets/images/memory-02.png',
            'assets/images/memory-03.png',
            'assets/images/memory-04.png',
            'assets/images/memory-05.png',
            'assets/images/memory-06.png'
        ]
    };

    const clamp = (v, min, max) => (v < min ? min : v > max ? max : v);
    const lerp = (a, b, t) => a + (b - a) * t;
    const rand = (a, b) => a + Math.random() * (b - a);
    const $ = (sel, root) => (root || document).querySelector(sel);
    const $$ = (sel, root) => Array.prototype.slice.call((root || document).querySelectorAll(sel));

    const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    const isCoarsePointer = window.matchMedia('(pointer: coarse)').matches;

    function easeOutQuint(t) { return 1 - Math.pow(1 - t, 5); }
    function easeOutCubic(t) { return 1 - Math.pow(1 - t, 3); }
    function easeInOutSine(t) { return -(Math.cos(Math.PI * t) - 1) / 2; }

    /* ------------------------------------------------------------------ *
     *  Toast — graceful, non-blocking error reporting
     * ------------------------------------------------------------------ */
    const Toast = {
        stack: null,
        ensure() {
            if (!this.stack) {
                this.stack = document.createElement('div');
                this.stack.className = 'toast-stack';
                this.stack.setAttribute('role', 'status');
                this.stack.setAttribute('aria-live', 'polite');
                document.body.appendChild(this.stack);
            }
            return this.stack;
        },
        show(message) {
            if (!message) return;
            const el = document.createElement('div');
            el.className = 'toast';
            el.textContent = message;
            this.ensure().appendChild(el);
            requestAnimationFrame(() => el.classList.add('is-visible'));
            window.setTimeout(() => {
                el.classList.remove('is-visible');
                window.setTimeout(() => el.remove(), 420);
            }, 4200);
        }
    };

    /* ------------------------------------------------------------------ *
     *  Manifest
     * ------------------------------------------------------------------ */
    const Manifest = {
        data: { portrait: FALLBACK_MANIFEST.portrait, memories: FALLBACK_MANIFEST.memories.slice() },
        async load() {
            try {
                const res = await fetch(PREFIX + 'image-manifest.json', { cache: 'no-cache' });
                if (!res.ok) return this.data;
                const json = await res.json();
                if (json.portrait) this.data.portrait = json.portrait;
                if (Array.isArray(json.memories) && json.memories.length) this.data.memories = json.memories;
            } catch (err) {
                /* file:// or offline — the hardcoded manifest already covers it */
            }
            return this.data;
        }
    };

    /* ================================================================== *
     *  PORTRAIT REVEAL
     *  Samples the real photograph, disperses its pixels across the
     *  viewport, and draws them back together with an invisible gravity.
     * ================================================================== */
    class PortraitReveal {
        constructor(options) {
            this.opts = options || {};
            this.canvas = this.opts.canvas;
            this.frame = this.opts.frame;
            this.image = this.opts.image;
            this.loader = this.opts.loader;
            this.statePanel = this.opts.statePanel;
            this.copy = this.opts.copy;
            this.skipBtn = this.opts.skipBtn;
            this.replayBtn = this.opts.replayBtn;
            this.source = this.opts.source;

            this.ctx = this.canvas ? this.canvas.getContext('2d', { alpha: true }) : null;
            this.particles = [];
            this.spriteCache = new Map();
            this.state = 'idle';
            this.rafId = null;
            this.startedAt = 0;
            this.lastFrame = 0;
            this.settleAt = 0;
            this.fadeOutAt = 0;
            this.quality = 1;
            this.frameTimes = [];
            this.usedImageData = false;
        }

        /* ---------------------------------------------------------- */
        init() {
            if (!this.canvas || !this.frame) return;

            this._onResize = this._onResize.bind(this);
            window.addEventListener('resize', this._onResize, { passive: true });
            window.addEventListener('orientationchange', this._onResize, { passive: true });

            if (this.skipBtn) {
                this.skipBtn.addEventListener('click', () => this.skip());
            }
            if (this.replayBtn) {
                this.replayBtn.addEventListener('click', () => this.replay());
            }
            const retry = this.opts.retryBtn;
            if (retry) {
                retry.addEventListener('click', () => {
                    if (this.statePanel) this.statePanel.hidden = true;
                    this.start();
                });
            }

            this._onResize();
            this.start();
        }

        /* ---------------------------------------------------------- */
        _onResize() {
            if (!this.canvas) return;
            const dpr = clamp(window.devicePixelRatio || 1, 1, 2);
            const w = this.canvas.clientWidth || window.innerWidth;
            const h = this.canvas.clientHeight || window.innerHeight;
            this.canvas.width = Math.round(w * dpr);
            this.canvas.height = Math.round(h * dpr);
            this.viewW = w;
            this.viewH = h;
            this.dpr = dpr;
            if (this.ctx) this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
            if (this.state === 'running') this._rebuildTargets();
        }

        /* ---------------------------------------------------------- */
        start() {
            if (!this.ctx) { this._fail('The canvas could not be created.'); return; }
            this.state = 'loading';
            this.particles = [];
            this._clear();

            if (this.loader) this.loader.hidden = false;
            if (this.frame) this.frame.classList.remove('is-revealed', 'is-settled');
            if (this.copy) this.copy.classList.remove('is-revealed');
            if (this.skipBtn) this.skipBtn.hidden = true;
            if (this.replayBtn) this.replayBtn.hidden = true;
            if (this.statePanel) this.statePanel.hidden = true;

            const src = this.source;
            const img = new Image();
            img.decoding = 'async';
            /* Only request CORS on http(s); on file:// it would break the load. */
            if (/^https?:$/.test(window.location.protocol)) img.crossOrigin = 'anonymous';

            img.onload = () => {
                this._onImageReady(img);
            };
            img.onerror = () => {
                this._fail('We could not find the portrait photograph.');
            };
            img.src = src;
        }

        /* ---------------------------------------------------------- */
        _onImageReady(img) {
            if (this.loader) this.loader.hidden = true;

            /* The final frame always shows the untouched photograph. */
            if (this.image) {
                this.image.src = img.src;
                this.image.alt = 'Swarali';
            }

            if (prefersReducedMotion.matches) {
                this._settleImmediately();
                return;
            }

            let data = null;
            try {
                data = this._sample(img);
            } catch (err) {
                data = null;
            }

            if (!data) {
                /* Pixel access is blocked (e.g. file:// canvas taint) —
                   fall back to a graceful, still-beautiful reveal. */
                this.usedImageData = false;
                this._softReveal();
                return;
            }

            this.usedImageData = true;
            this._buildParticles(data);
            this._startAnimation();
        }

        /* ---------------------------------------------------------- */
        _sample(img) {
            const w = img.naturalWidth || img.width;
            const h = img.naturalHeight || img.height;
            if (!w || !h) return null;

            const off = document.createElement('canvas');
            off.width = w;
            off.height = h;
            const octx = off.getContext('2d', { willReadFrequently: true });
            octx.drawImage(img, 0, 0, w, h);
            return octx.getImageData(0, 0, w, h);
        }

        /* --- colour handling ----------------------------------------- *
         *  The photograph's own pixels are reproduced faithfully: every
         *  particle keeps a quantised copy of its source colour, and a
         *  soft glow sprite is cached on demand for each of them.
         * ---------------------------------------------------------------- */
        _quantise(r, g, b, bits) {
            const shift = 8 - bits;
            return (((r >> shift) << (bits * 2)) | ((g >> shift) << bits) | (b >> shift));
        }

        _tint(r, g, b) {
            /* a whisper of champagne, then a gentle lift through the shadows */
            let cr = clamp(Math.round(r * 0.9 + 232 * 0.1), 0, 255);
            let cg = clamp(Math.round(g * 0.9 + 203 * 0.1), 0, 255);
            let cb = clamp(Math.round(b * 0.9 + 145 * 0.1), 0, 255);
            cr = Math.round(255 - (255 - cr) * 0.86);
            cg = Math.round(255 - (255 - cg) * 0.86);
            cb = Math.round(255 - (255 - cb) * 0.86);
            return [cr, cg, cb];
        }

        _spriteFor(r, g, b) {
            const key = this._quantise(r, g, b, 4);
            let sprite = this.spriteCache.get(key);
            if (sprite) return sprite;

            const size = 28;
            const cv = document.createElement('canvas');
            cv.width = size;
            cv.height = size;
            const cx = cv.getContext('2d');
            const grad = cx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
            grad.addColorStop(0.00, 'rgba(' + r + ',' + g + ',' + b + ',1)');
            grad.addColorStop(0.40, 'rgba(' + r + ',' + g + ',' + b + ',0.88)');
            grad.addColorStop(0.70, 'rgba(' + r + ',' + g + ',' + b + ',0.28)');
            grad.addColorStop(1.00, 'rgba(' + r + ',' + g + ',' + b + ',0)');
            cx.fillStyle = grad;
            cx.fillRect(0, 0, size, size);

            sprite = { canvas: cv, r: r, g: g, b: b, rgb: 'rgb(' + r + ',' + g + ',' + b + ')' };
            this.spriteCache.set(key, sprite);
            return sprite;
        }

        /* --- the particle field ------------------------------------- */
        _buildParticles(imageData) {
            const rect = this.frame.getBoundingClientRect();
            const origin = this.canvas.getBoundingClientRect();
            const srcW = imageData.width;
            const srcH = imageData.height;

            const area = Math.max(1, rect.width * rect.height);
            const budget = this.opts.count || (isCoarsePointer ? 2400 : 4400);
            const cell = Math.sqrt(area / budget);
            const cols = Math.max(6, Math.round(rect.width / cell));
            const rows = Math.max(6, Math.round(rect.height / cell));

            this.spriteCache = new Map();

            const data = imageData.data;
            const particles = [];

            const cx = this.viewW / 2;
            const cy = this.viewH / 2;
            const maxR = Math.max(this.viewW, this.viewH) * 0.62;

            for (let r = 0; r < rows; r++) {
                for (let c = 0; c < cols; c++) {
                    const fx = (c + 0.5) / cols;
                    const fy = (r + 0.5) / rows;
                    const sx = clamp(Math.floor(fx * srcW), 0, srcW - 1);
                    const sy = clamp(Math.floor(fy * srcH), 0, srcH - 1);
                    const idx = (sy * srcW + sx) * 4;
                    const pr = data[idx], pg = data[idx + 1], pb = data[idx + 2];

                    const lum = (pr * 0.299 + pg * 0.587 + pb * 0.114) / 255;

                    const tx = (rect.left - origin.left) + fx * rect.width;
                    const ty = (rect.top - origin.top) + fy * rect.height;

                    /* start position: mostly scattered, some already near */
                    const near = Math.random() < 0.34;
                    let sx0, sy0;
                    if (near) {
                        const a = rand(0, Math.PI * 2);
                        const d = rand(0, maxR * 0.34);
                        sx0 = cx + Math.cos(a) * d;
                        sy0 = cy + Math.sin(a) * d * 0.72;
                    } else {
                        const a = rand(0, Math.PI * 2);
                        const d = Math.pow(Math.random(), 0.58) * maxR;
                        sx0 = cx + Math.cos(a) * d * 1.18;
                        sy0 = cy + Math.sin(a) * d * 0.86;
                    }
                    /* keep scattered points on screen */
                    sx0 = clamp(sx0, -40, this.viewW + 40);
                    sy0 = clamp(sy0, -40, this.viewH + 40);

                    const dx = tx - sx0;
                    const dy = ty - sy0;
                    const dist = Math.hypot(dx, dy) || 1;

                    const tint = this._tint(pr, pg, pb);
                    const sprite = this._spriteFor(tint[0], tint[1], tint[2]);

                    particles.push({
                        sx: sx0,
                        sy: sy0,
                        tx: tx,
                        ty: ty,
                        /* perpendicular offset gives the swirl */
                        px: -dy / dist,
                        py: dx / dist,
                        swirl: rand(28, 132) * (near ? 0.35 : 1),
                        wobble: rand(0.4, 1.5),
                        phase: rand(0, Math.PI * 2),
                        size: 1.15 + lum * 1.95,
                        alpha: 0.66 + lum * 0.34,
                        delay: rand(0, 0.85),
                        duration: rand(1.9, 2.85),
                        sprite: sprite,
                        lastX: 0,
                        lastY: 0,
                        hasPrev: false
                    });
                }
            }

            this.particles = particles;
            this._rebuildTargets();
        }

        /* Recompute targets when the layout moves (resize). */
        _rebuildTargets() {
            if (!this.particles.length) return;
            const rect = this.frame.getBoundingClientRect();
            const origin = this.canvas.getBoundingClientRect();
            const cols = Math.round(Math.sqrt(this.particles.length * (rect.width / Math.max(1, rect.height))));
            const rows = Math.ceil(this.particles.length / Math.max(1, cols));
            let i = 0;
            for (let r = 0; r < rows && i < this.particles.length; r++) {
                for (let c = 0; c < cols && i < this.particles.length; c++, i++) {
                    const fx = (c + 0.5) / cols;
                    const fy = (r + 0.5) / rows;
                    this.particles[i].tx = (rect.left - origin.left) + fx * rect.width;
                    this.particles[i].ty = (rect.top - origin.top) + fy * rect.height;
                }
            }
        }

        /* ---------------------------------------------------------- */
        _startAnimation() {
            this.state = 'running';
            this.startedAt = performance.now();
            this.lastFrame = this.startedAt;
            this.settleAt = 0;
            this.fadeOutAt = 0;
            this.frameTimes = [];

            if (this.canvas) this.canvas.classList.add('is-active');
            if (this.skipBtn) this.skipBtn.hidden = false;

            this._loop();
        }

        _loop() {
            if (this.state !== 'running') return;
            const now = performance.now();
            const dt = Math.min(0.05, (now - this.lastFrame) / 1000);
            this.lastFrame = now;

            this._monitorPerf(now);

            const elapsed = (now - this.startedAt) / 1000;

            if (this.settleAt === 0) {
                this._drawConverging(elapsed);
                const maxTime = this._maxParticleTime();
                if (elapsed >= maxTime) {
                    this.settleAt = now;
                    this._drawSettled();
                }
            } else if (this.fadeOutAt === 0) {
                if (now - this.settleAt > 620) {
                    this.fadeOutAt = now;
                    this._beginFinalReveal();
                }
            }

            if (this.fadeOutAt === 0) {
                this.rafId = requestAnimationFrame(() => this._loop());
            }
        }

        _maxParticleTime() {
            let max = 0;
            for (let i = 0; i < this.particles.length; i++) {
                const t = this.particles[i].delay + this.particles[i].duration;
                if (t > max) max = t;
            }
            return max;
        }

        _monitorPerf(now) {
            this.frameTimes.push(now);
            if (this.frameTimes.length > 45) this.frameTimes.shift();
            if (this.frameTimes.length < 45) return;
            const span = this.frameTimes[44] - this.frameTimes[0];
            if (span <= 0) return;
            const fps = 44000 / span;
            if (fps < 36 && this.quality > 0.5) {
                this.quality = 0.5;
                this.particles = this.particles.filter(function (_, i) { return i % 2 === 0; });
                this.frameTimes.length = 0;
            }
        }

        /* --- converging phase --------------------------------------- */
        /*  Position of a particle at a given normalised progress.      */
        _position(p, t) {
            if (t < 0) t = 0;
            if (t > 1) t = 1;
            const e = easeOutQuint(t);
            let x = lerp(p.sx, p.tx, e);
            let y = lerp(p.sy, p.ty, e);

            /* swirling convergence */
            const arc = Math.sin(Math.PI * t) * p.swirl * (1 - t * 0.35);
            x += p.px * arc;
            y += p.py * arc;

            /* damped settle wobble */
            const q = 1 - t;
            const wob = Math.sin(t * 19 + p.phase) * p.wobble * q * q * q * q;
            x += p.px * wob;
            y += p.py * wob;
            return [x, y];
        }

        _drawConverging(elapsed) {
            const ctx = this.ctx;
            ctx.clearRect(0, 0, this.viewW, this.viewH);
            ctx.globalCompositeOperation = 'source-over';

            const parts = this.particles;
            for (let i = 0; i < parts.length; i++) {
                const p = parts[i];
                const t = (elapsed - p.delay) / p.duration;
                if (t <= 0) continue;

                const pos = this._position(p, t > 1 ? 1 : t);
                const sprite = p.sprite.canvas;
                const size = p.size * 2.7;

                /* a soft comet tail, echoing where the particle just was */
                if (p.hasPrev) {
                    const tx = pos[0] - (pos[0] - p.lastX) * 5;
                    const ty = pos[1] - (pos[1] - p.lastY) * 5;
                    const ts = size * 0.72;
                    ctx.globalAlpha = p.alpha * 0.28;
                    ctx.drawImage(sprite, tx - ts / 2, ty - ts / 2, ts, ts);
                }
                p.lastX = pos[0];
                p.lastY = pos[1];
                p.hasPrev = true;

                ctx.globalAlpha = p.alpha;
                ctx.drawImage(sprite, pos[0] - size / 2, pos[1] - size / 2, size, size);
            }
            ctx.globalAlpha = 1;
        }

        /* --- crisp settled frame ------------------------------------ */
        _drawSettled() {
            const ctx = this.ctx;
            ctx.clearRect(0, 0, this.viewW, this.viewH);
            ctx.globalCompositeOperation = 'source-over';
            const now = performance.now() * 0.001;
            for (let i = 0; i < this.particles.length; i++) {
                const p = this.particles[i];
                const x = p.tx + Math.sin(now * 0.9 + p.phase) * 0.5;
                const y = p.ty + Math.cos(now * 0.75 + p.phase * 1.7) * 0.5;
                const size = p.size * 2.5;
                ctx.globalAlpha = p.alpha;
                ctx.drawImage(p.sprite.canvas, x - size / 2, y - size / 2, size, size);
            }
            ctx.globalAlpha = 1;
        }

        /* --- hand over to the real photograph ------------------------ */
        _beginFinalReveal() {
            if (this.canvas) this.canvas.classList.remove('is-active');
            if (this.frame) {
                this.frame.classList.add('is-revealed');
                window.setTimeout(() => this.frame.classList.add('is-settled'), 60);
            }
            this._revealCopy();
            if (this.skipBtn) this.skipBtn.hidden = true;
            if (this.replayBtn) this.replayBtn.hidden = false;
            this.state = 'revealed';

            /* the particles fade out via CSS while the photo fades in */
            window.setTimeout(() => {
                this._clear();
                this.rafId = null;
            }, 700);
        }

        _revealCopy() {
            if (!this.copy) return;
            this.copy.classList.add('is-revealed');
        }

        /* --- graceful fallback when pixels cannot be sampled ---------- */
        _softReveal() {
            if (this.canvas) this.canvas.classList.remove('is-active');
            if (this.frame) {
                this.frame.classList.add('is-revealed');
                window.setTimeout(() => this.frame.classList.add('is-settled'), 60);
            }
            this._revealCopy();
            if (this.replayBtn) this.replayBtn.hidden = false;
            this.state = 'revealed';
        }

        _settleImmediately() {
            if (this.frame) {
                this.frame.classList.add('is-revealed');
                this.frame.classList.add('is-settled');
            }
            this._revealCopy();
            if (this.replayBtn) this.replayBtn.hidden = false;
            this.state = 'revealed';
        }

        _fail(message) {
            this.state = 'failed';
            if (this.loader) this.loader.hidden = true;
            if (this.canvas) this.canvas.classList.remove('is-active');
            if (this.statePanel) {
                this.statePanel.hidden = false;
                const text = $('.state-panel__text', this.statePanel);
                if (text && message) text.textContent = message;
            }
            /* never leave the visitor stuck: still open the celebration */
            this._revealCopy();
            Toast.show(message || 'The portrait could not be loaded.');
        }

        skip() {
            if (this.state === 'running' || this.state === 'loading') {
                if (this.rafId) cancelAnimationFrame(this.rafId);
                this.rafId = null;
                this._clear();
                this._beginFinalReveal();
            }
        }

        replay() {
            if (this.rafId) cancelAnimationFrame(this.rafId);
            this.rafId = null;
            this.state = 'idle';
            this._clear();
            this.start();
        }

        _clear() {
            if (!this.ctx) return;
            this.ctx.clearRect(0, 0, this.viewW, this.viewH);
        }
    }

    /* ================================================================== *
     *  ORBIT GALLERY
     *  A true 3D ring: photographs orbit a luminous core, depth-sorted
     *  by the browser, billboarded so every frame stays readable.
     * ================================================================== */
    class OrbitGallery {
        constructor(options) {
            this.opts = options || {};
            this.stage = this.opts.stage;
            this.ring = this.opts.ring;
            this.countEl = this.opts.countEl;
            this.toggleBtn = this.opts.toggleBtn;
            this.lightbox = this.opts.lightbox;

            this.photos = [];
            this.nodes = [];
            this.spin = -18;
            this.velocity = 0;
            this.autoRotate = true;
            this.autoSpeed = 5.2;          /* degrees per second */
            this.dragging = false;
            this.dragMoved = 0;
            this.hovering = false;
            this.lastPointerX = 0;
            this.lastPointerTime = 0;
            this.rafId = null;
            this.lastTick = 0;
            this.lightboxOpen = false;
            this.R = 200;
            this.FW = 180;
            this.ELL = 0.5;
            this.PERSP = 1200;
        }

        init(photos) {
            this.photos = photos || [];
            if (!this.stage || !this.ring) return;

            this._build();
            this._measure();
            this._bindDrag();
            this._bindLightbox();
            this._bindToggle();
            this._buildTrail();

            window.addEventListener('resize', () => {
                this._measure();
                this._buildTrail();
            }, { passive: true });

            this.lastTick = performance.now();
            this._tick();
        }

        /* ---------------------------------------------------------- */
        _build() {
            this.ring.innerHTML = '';

            /* the true orbit path (drawn as a dotted trail) */
            this.trail = document.createElement('div');
            this.trail.className = 'orbit-trail';
            this.ring.appendChild(this.trail);

            /* luminous core */
            const core = document.createElement('div');
            core.className = 'orbit-core';
            core.innerHTML =
                '<span class="orbit-core__halo"></span>' +
                '<span class="orbit-core__frame"><img id="orbit-core-image" alt="Swarali" /></span>';
            this.ring.appendChild(core);
            this.coreImage = $('#orbit-core-image', this.ring);

            if (!this.photos.length) {
                const empty = document.createElement('p');
                empty.className = 'orbit-empty';
                empty.textContent = 'No memories are configured yet — check the image manifest.';
                this.stage.appendChild(empty);
                if (this.countEl) this.countEl.textContent = '0 memories';
                return;
            }

            this.photos.forEach((photo, i) => {
                const node = document.createElement('figure');
                node.className = 'orbit-photo';
                node.setAttribute('data-index', String(i));
                node.setAttribute('tabindex', '0');
                node.setAttribute('role', 'button');
                node.setAttribute('aria-label', 'Enlarge ' + (photo.name || 'memory ' + (i + 1)));

                const frame = document.createElement('div');
                frame.className = 'orbit-photo__frame';

                const img = document.createElement('img');
                img.src = photo.url;
                img.alt = photo.name || 'Memory ' + (i + 1);
                img.loading = i < 2 ? 'eager' : 'lazy';
                img.decoding = 'async';
                img.addEventListener('error', function () {
                    Toast.show('A memory photograph could not be loaded.');
                });
                img.addEventListener('load', function () {
                    /* keep the frame proportions natural — no cropping */
                    frame.style.aspectRatio = this.naturalWidth + ' / ' + this.naturalHeight;
                });

                const shade = document.createElement('span');
                shade.className = 'orbit-photo__shade';
                const sheen = document.createElement('span');
                sheen.className = 'orbit-photo__sheen';

                frame.appendChild(img);
                frame.appendChild(shade);
                frame.appendChild(sheen);
                node.appendChild(frame);
                this.ring.appendChild(node);
                this.nodes.push(node);
            });

            if (this.countEl) {
                this.countEl.textContent = this.photos.length + (this.photos.length === 1 ? ' memory' : ' memories');
            }
        }

        /* ---------------------------------------------------------- */
        _measure() {
            const probe = document.createElement('div');
            probe.style.cssText =
                'position:absolute;visibility:hidden;pointer-events:none;left:0;top:0;' +
                'width:var(--orbit-r);height:var(--orbit-frame);';
            this.stage.appendChild(probe);
            const r = probe.getBoundingClientRect();
            this.R = r.width || 200;
            this.FW = r.height || 180;
            this.stage.removeChild(probe);

            const rootStyle = getComputedStyle(document.documentElement);
            this.ELL = parseFloat(rootStyle.getPropertyValue('--orbit-ell')) || 0.5;
            this.PERSP = parseFloat(getComputedStyle(this.stage).perspective) || 1200;
        }

        /* --- project a ring point to screen space -------------------- */
        _project(phi) {
            const w = this.stage.clientWidth;
            const h = this.stage.clientHeight;
            const x = Math.sin(phi) * this.R;
            const z = Math.cos(phi) * this.R;
            const y = Math.cos(phi) * this.R * this.ELL;
            const s = this.PERSP / (this.PERSP - z);
            const ox = w * 0.5, oy = h * 0.46;
            const cx = w * 0.5, cy = h * 0.5;
            return [ox + (cx - ox) + x * s, oy + (cy - oy) + y * s];
        }

        _buildTrail() {
            if (!this.trail) return;
            this.trail.innerHTML = '';
            const count = 90;
            const frag = document.createDocumentFragment();
            for (let i = 0; i < count; i++) {
                const phi = (i / count) * Math.PI * 2;
                const p = this._project(phi);
                const dot = document.createElement('span');
                dot.className = 'orbit-trail__dot';
                const depth = (Math.cos(phi) + 1) / 2;
                dot.style.left = p[0].toFixed(1) + 'px';
                dot.style.top = p[1].toFixed(1) + 'px';
                dot.style.opacity = (0.10 + depth * 0.5).toFixed(3);
                dot.style.setProperty('--s', (0.6 + depth * 0.9).toFixed(2));
                frag.appendChild(dot);
            }
            this.trail.appendChild(frag);
        }

        /* ---------------------------------------------------------- */
        _bindDrag() {
            const stage = this.stage;

            const down = (x) => {
                this.dragging = true;
                this.dragMoved = 0;
                this.lastPointerX = x;
                this.lastPointerTime = performance.now();
                this.velocity = 0;
                stage.classList.add('is-dragging');
            };

            const move = (x) => {
                if (!this.dragging) return;
                const delta = x - this.lastPointerX;
                this.lastPointerX = x;
                this.dragMoved += Math.abs(delta);
                this.spin += delta * 0.32;
                const now = performance.now();
                const dt = Math.max(8, now - this.lastPointerTime) / 1000;
                this.lastPointerTime = now;
                this.velocity = (delta * 0.32) / dt;
            };

            const up = () => {
                if (!this.dragging) return;
                this.dragging = false;
                stage.classList.remove('is-dragging');
            };

            stage.addEventListener('pointerdown', (e) => {
                if (e.button !== undefined && e.button !== 0) return;
                if (e.target.closest && e.target.closest('button, a')) return;
                down(e.clientX);
            });
            stage.addEventListener('pointermove', (e) => { move(e.clientX); });
            window.addEventListener('pointerup', up);
            window.addEventListener('pointercancel', up);

            /* hovering a photograph stills the orbit, so it can be read
               and clicked without fighting the movement */
            stage.addEventListener('pointerover', (e) => {
                const node = e.target.closest ? e.target.closest('.orbit-photo') : null;
                this.hovering = !!node;
            });
            stage.addEventListener('pointerout', (e) => {
                const node = e.target.closest ? e.target.closest('.orbit-photo') : null;
                const to = e.relatedTarget;
                if (node && to && node.contains(to)) return;
                this.hovering = false;
            });

            /* tap to enlarge */
            stage.addEventListener('click', (e) => {
                const node = e.target.closest ? e.target.closest('.orbit-photo') : null;
                if (!node) return;
                if (this.dragMoved > 8) return;
                this.openLightbox(parseInt(node.getAttribute('data-index'), 10) || 0);
            });

            stage.addEventListener('keydown', (e) => {
                const node = e.target.closest ? e.target.closest('.orbit-photo') : null;
                if (!node) return;
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    this.openLightbox(parseInt(node.getAttribute('data-index'), 10) || 0);
                }
            });

            /* swipe support for touch devices */
            let touchX = 0;
            let touchY = 0;
            stage.addEventListener('touchstart', function (e) {
                if (!e.touches.length) return;
                touchX = e.touches[0].clientX;
                touchY = e.touches[0].clientY;
            }, { passive: true });
            stage.addEventListener('touchend', function (e) {
                if (!e.changedTouches.length) return;
                const dx = e.changedTouches[0].clientX - touchX;
                const dy = e.changedTouches[0].clientY - touchY;
                if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy)) {
                    const node = document.querySelector('.orbit-photo.is-front');
                    if (node) {
                        const idx = parseInt(node.getAttribute('data-index'), 10) || 0;
                        this.openLightbox(idx);
                    }
                }
            }.bind(this), { passive: true });
        }

        _bindToggle() {
            if (!this.toggleBtn) return;
            this.toggleBtn.addEventListener('click', () => {
                this.autoRotate = !this.autoRotate;
                this.toggleBtn.classList.toggle('is-paused', !this.autoRotate);
                this.toggleBtn.setAttribute('aria-pressed', String(!this.autoRotate));
                this.toggleBtn.setAttribute('aria-label', this.autoRotate ? 'Pause the orbit' : 'Resume the orbit');
                const label = $('.orbit-hud__label', this.toggleBtn);
                if (label) label.textContent = this.autoRotate ? 'Pause orbit' : 'Resume orbit';
            });
        }

        /* ---------------------------------------------------------- */
        _tick() {
            const now = performance.now();
            const dt = Math.min(0.05, (now - this.lastTick) / 1000);
            this.lastTick = now;

            if (!this.dragging) {
                const paused = !this.autoRotate || this.lightboxOpen || this.hovering;
                if (paused) {
                    /* glide to a complete stop */
                    this.velocity *= Math.pow(0.86, dt * 60);
                    if (Math.abs(this.velocity) < 0.25) this.velocity = 0;
                } else {
                    const friction = Math.pow(0.94, dt * 60);
                    this.velocity = this.velocity * friction + this.autoSpeed * (1 - friction);
                }
                this.spin += this.velocity * dt;
            }

            this._applyPositions();
            this.rafId = requestAnimationFrame(() => this._tick());
        }

        _applyPositions() {
            if (!this.nodes.length) return;
            const n = this.nodes.length;
            const step = 360 / n;
            const maxDist = Math.max(this.R * 2, 1);

            for (let i = 0; i < n; i++) {
                const node = this.nodes[i];
                const a = (this.spin + i * step) * Math.PI / 180;
                const x = Math.sin(a) * this.R;
                const z = Math.cos(a) * this.R;
                const y = Math.cos(a) * this.R * this.ELL;

                node.style.transform =
                    'translate(-50%, -50%) rotateY(' + a.toFixed(5) + 'rad) translateY(' +
                    y.toFixed(2) + 'px) translateZ(' + this.R.toFixed(2) + 'px) rotateY(' +
                    (-a).toFixed(5) + 'rad)';

                const depth = (z / this.R + 1) / 2;              /* 0 far → 1 near */
                node.style.setProperty('--depth', ((1 - depth) * 0.72).toFixed(3));
                node.style.opacity = (0.6 + depth * 0.4).toFixed(3);
                node.classList.toggle('is-front', depth > 0.9);
            }
            void maxDist;
        }

        /* ---------------------------------------------------------- */
        /*  LIGHTBOX                                                     */
        /* ---------------------------------------------------------- */
        _bindLightbox() {
            const lb = this.lightbox;
            if (!lb) return;
            this.lbImage = $('.lightbox__figure img', lb);
            this.lbCaption = $('.lightbox__caption', lb);
            this.lbIndexLabel = $('[data-lb-index]', lb);
            this.lbTitle = $('[data-lb-title]', lb);
            this.lbClose = $('.lightbox__btn--close', lb);
            this.lbPrev = $('.lightbox__btn--prev', lb);
            this.lbNext = $('.lightbox__btn--next', lb);
            this.lbIndex = 0;
            this.lastFocus = null;

            if (this.lbClose) this.lbClose.addEventListener('click', () => this.closeLightbox());
            if (this.lbPrev) this.lbPrev.addEventListener('click', () => this.stepLightbox(-1));
            if (this.lbNext) this.lbNext.addEventListener('click', () => this.stepLightbox(1));

            lb.addEventListener('click', (e) => {
                if (e.target === lb) this.closeLightbox();
            });

            document.addEventListener('keydown', (e) => {
                if (!this.lightboxOpen) return;
                if (e.key === 'Escape') { e.preventDefault(); this.closeLightbox(); }
                else if (e.key === 'ArrowLeft') { e.preventDefault(); this.stepLightbox(-1); }
                else if (e.key === 'ArrowRight') { e.preventDefault(); this.stepLightbox(1); }
                else if (e.key === 'Tab') this._trapFocus(e);
            });

            /* swipe between photos */
            let sx = 0, sy = 0;
            lb.addEventListener('touchstart', (e) => {
                if (!e.touches.length) return;
                sx = e.touches[0].clientX; sy = e.touches[0].clientY;
            }, { passive: true });
            lb.addEventListener('touchend', (e) => {
                if (!e.changedTouches.length) return;
                const dx = e.changedTouches[0].clientX - sx;
                const dy = e.changedTouches[0].clientY - sy;
                if (Math.abs(dx) > 55 && Math.abs(dx) > Math.abs(dy)) this.stepLightbox(dx < 0 ? 1 : -1);
            }, { passive: true });
        }

        _trapFocus(e) {
            const lb = this.lightbox;
            const focusables = $$('button', lb);
            if (!focusables.length) return;
            const first = focusables[0];
            const last = focusables[focusables.length - 1];
            if (e.shiftKey && document.activeElement === first) {
                e.preventDefault(); last.focus();
            } else if (!e.shiftKey && document.activeElement === last) {
                e.preventDefault(); first.focus();
            }
        }

        openLightbox(index) {
            const lb = this.lightbox;
            if (!lb || !this.photos.length) return;
            this.lastFocus = document.activeElement;
            this.lbIndex = (index + this.photos.length) % this.photos.length;
            this._renderLightbox();
            lb.classList.add('is-open');
            lb.setAttribute('aria-hidden', 'false');
            this.lightboxOpen = true;
            document.body.style.overflow = 'hidden';
            if (this.lbClose) window.setTimeout(() => this.lbClose.focus(), 60);
        }

        closeLightbox() {
            const lb = this.lightbox;
            if (!lb) return;
            lb.classList.remove('is-open');
            lb.setAttribute('aria-hidden', 'true');
            this.lightboxOpen = false;
            document.body.style.overflow = '';
            if (this.lastFocus && this.lastFocus.focus) this.lastFocus.focus();
        }

        stepLightbox(delta) {
            if (!this.lightboxOpen || !this.photos.length) return;
            this.lbIndex = (this.lbIndex + delta + this.photos.length) % this.photos.length;
            this._renderLightbox();
        }

        _renderLightbox() {
            const photo = this.photos[this.lbIndex];
            if (!photo) return;
            if (this.lbImage) {
                this.lbImage.src = photo.url;
                this.lbImage.alt = photo.name || 'Memory ' + (this.lbIndex + 1);
            }
            if (this.lbTitle) this.lbTitle.textContent = photo.name || 'Memory ' + (this.lbIndex + 1);
            if (this.lbIndexLabel) {
                this.lbIndexLabel.textContent =
                    String(this.lbIndex + 1).padStart(2, '0') + ' / ' +
                    String(this.photos.length).padStart(2, '0');
            }
            if (this.lbCaption) {
                const total = this.photos.length;
                this.lbCaption.setAttribute('aria-live', 'polite');
            }
        }
    }

    /* ================================================================== *
     *  LETTER PAGE
     * ================================================================== */
    class LetterPage {
        constructor(options) {
            this.opts = options || {};
            this.key = 'swaraa.letter.v1';
        }

        init() {
            this._restore();
            this._bindEditable();
            this._observeReveals();
        }

        _restore() {
            let saved = null;
            try {
                saved = JSON.parse(window.localStorage.getItem(this.key) || 'null');
            } catch (err) {
                saved = null;
            }
            if (!saved) return;
            if (saved.name) {
                const target = $('[data-editable="name"]');
                if (target) target.textContent = saved.name;
            }
            if (saved.body) {
                const target = $('[data-editable="body"]');
                if (target) target.innerHTML = saved.body;
            }
        }

        _persist() {
            const nameEl = $('[data-editable="name"]');
            const bodyEl = $('[data-editable="body"]');
            const payload = {};
            if (nameEl) payload.name = nameEl.textContent.trim();
            if (bodyEl) payload.body = bodyEl.innerHTML;
            try {
                window.localStorage.setItem(this.key, JSON.stringify(payload));
            } catch (err) {
                /* private mode — edits simply won't persist */
            }
        }

        _bindEditable() {
            const nameEl = $('[data-editable="name"]');
            const bodyEl = $('[data-editable="body"]');

            [nameEl, bodyEl].forEach((el) => {
                if (!el) return;
                el.addEventListener('blur', () => this._persist());
                el.addEventListener('keydown', (e) => {
                    if (e.key === 'Escape') el.blur();
                });
            });

            const reset = $('[data-letter-reset]');
            if (reset) {
                reset.addEventListener('click', (e) => {
                    e.preventDefault();
                    try { window.localStorage.removeItem(this.key); } catch (err) {}
                    window.location.reload();
                });
            }
        }

        _observeReveals() {
            const items = $$('[data-reveal]');
            if (!items.length) return;

            if (!('IntersectionObserver' in window)) {
                items.forEach((el) => el.classList.add('is-revealed'));
                return;
            }

            const io = new IntersectionObserver((entries) => {
                entries.forEach((entry) => {
                    if (!entry.isIntersecting) return;
                    const el = entry.target;
                    const group = el.getAttribute('data-reveal-group');
                    if (group) {
                        const siblings = $$('[data-reveal-group="' + group + '"]');
                        const idx = siblings.indexOf(el);
                        el.style.setProperty('--reveal-delay', (idx * 120) + 'ms');
                    }
                    void el.offsetWidth; /* flush the delay before revealing */
                    el.classList.add('is-revealed');
                    io.unobserve(el);
                });
            }, { rootMargin: '0px 0px -8% 0px', threshold: 0.12 });

            items.forEach((el) => io.observe(el));
        }
    }

    /* ================================================================== *
     *  BOOT
     * ================================================================== */
    async function boot() {
        await Manifest.load();

        /* --- intro page ------------------------------------------- */
        const canvas = $('#particle-canvas');
        if (canvas) {
            const reveal = new PortraitReveal({
                canvas: canvas,
                frame: $('#portrait-frame'),
                image: $('#final-portrait'),
                loader: $('#portrait-loader'),
                statePanel: $('#portrait-state'),
                copy: $('#hero-copy'),
                skipBtn: $('#skip-animation'),
                replayBtn: $('#replay-particle'),
                retryBtn: $('#portrait-retry'),
                source: PREFIX + Manifest.data.portrait
            });
            reveal.init();
        }

        /* --- memories page ---------------------------------------- */
        const stage = $('#orbit-stage');
        if (stage) {
            const photos = Manifest.data.memories.map((path, i) => ({
                id: 'memory-' + (i + 1),
                url: PREFIX + path,
                name: 'Memory ' + String(i + 1).padStart(2, '0'),
                type: 'memory'
            }));

            const orbit = new OrbitGallery({
                stage: stage,
                ring: $('#orbit-ring'),
                countEl: $('#photo-count'),
                toggleBtn: $('#orbit-toggle'),
                lightbox: $('#lightbox')
            });
            orbit.init(photos);

            const core = $('#orbit-core-image');
            if (core) {
                core.src = PREFIX + Manifest.data.portrait;
                core.addEventListener('error', function () {
                    Toast.show('The centre portrait could not be loaded.');
                });
            }
        }

        /* --- letter page ------------------------------------------ */
        if ($('[data-editable]')) {
            new LetterPage().init();
        }

        /* --- generic scroll reveals (all pages) -------------------- */
        const reveals = $$('[data-reveal]:not([data-reveal-bound])');
        if (reveals.length && 'IntersectionObserver' in window) {
            const io = new IntersectionObserver((entries) => {
                entries.forEach((entry) => {
                    if (!entry.isIntersecting) return;
                    entry.target.classList.add('is-revealed');
                    io.unobserve(entry.target);
                });
            }, { threshold: 0.1, rootMargin: '0px 0px -6% 0px' });
            reveals.forEach((el) => {
                el.setAttribute('data-reveal-bound', '1');
                io.observe(el);
            });
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot, { once: true });
    } else {
        boot();
    }
})();
