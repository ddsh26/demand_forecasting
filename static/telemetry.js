/* ============================================================================
   telemetry.js — the "live" layer.
   Every value is seeded from load time, so each page load is plausibly
   different (the "values are random, not static" requirement) while staying
   self-consistent within a session. Pure vanilla, no dependencies.
   Exposes window.FA for app.js (forecast cone) to reuse the same PRNG + helpers.
   ============================================================================ */
(function () {
    'use strict';

    var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    /* ---- Seeded PRNG (mulberry32) keyed off load time ---- */
    function mulberry32(a) {
        return function () {
            a |= 0; a = (a + 0x6D2B79F5) | 0;
            var t = Math.imul(a ^ (a >>> 15), 1 | a);
            t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
    }
    var seed = (Date.now() >>> 0) ^ 0x9E3779B9;
    var rng = mulberry32(seed);
    function gauss() { // standard normal via Box–Muller
        var u = 0, v = 0;
        while (u === 0) u = rng();
        while (v === 0) v = rng();
        return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    }
    function between(lo, hi) { return lo + rng() * (hi - lo); }

    /* ---- Number formatting (tabular-friendly) ---- */
    function fmt(n, decimals, commas) {
        if (!isFinite(n)) return '—';
        var s = Number(n).toFixed(decimals || 0);
        if (commas) {
            var parts = s.split('.');
            parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
            s = parts.join('.');
        }
        return s;
    }

    /* ---- Mean-reverting bounded random walk ---- */
    function makeWalk(lo, hi, start, vol) {
        var center = (lo + hi) / 2;
        var span = hi - lo;
        var v = (start === undefined) ? between(lo, hi) : start;
        return {
            get: function () { return v; },
            step: function () {
                v += (center - v) * 0.06 + gauss() * vol * span;
                if (v < lo) v = lo + Math.abs(gauss()) * span * 0.04;
                if (v > hi) v = hi - Math.abs(gauss()) * span * 0.04;
                return v;
            }
        };
    }

    /* ---- One-shot count-up animation ---- */
    function countUp(el, to, opts) {
        opts = opts || {};
        var dec = opts.decimals || 0, commas = !!opts.commas, dur = opts.duration || 900;
        var prefix = opts.prefix || '', suffix = opts.suffix || '';
        if (reduceMotion) { el.textContent = prefix + fmt(to, dec, commas) + suffix; return; }
        var start = performance.now();
        function frame(now) {
            var p = Math.min(1, (now - start) / dur);
            var e = 1 - Math.pow(2, -10 * p); // easeOutExpo
            el.textContent = prefix + fmt(to * e, dec, commas) + suffix;
            if (p < 1) requestAnimationFrame(frame);
            else el.textContent = prefix + fmt(to, dec, commas) + suffix;
        }
        requestAnimationFrame(frame);
    }

    /* Parse a server-rendered stat like "3,049" / "1,913 days" / "2.5 units" */
    function parseStat(text) {
        var m = String(text).trim().match(/^([\d.,]+)\s*(.*)$/);
        if (!m) return null;
        var raw = m[1];
        var decimals = (raw.split('.')[1] || '').length;
        return {
            value: parseFloat(raw.replace(/,/g, '')),
            commas: raw.indexOf(',') !== -1,
            decimals: decimals,
            suffix: m[2] ? ' ' + m[2] : ''
        };
    }

    /* ============================ SPARKLINES (inline SVG) ============================ */
    var SP_W = 320, SP_H = 100;
    var sparkId = 0;
    function makeSpark(svg, n, vol, opts) {
        opts = opts || {};
        var stroke = opts.stroke || 'var(--live)';
        var data = [];
        var w = makeWalk(0.12, 0.88, 0.5, vol || 0.05);
        for (var i = 0; i < n; i++) data.push(w.step());
        var id = 'spg' + (sparkId++);
        svg.setAttribute('viewBox', '0 0 ' + SP_W + ' ' + SP_H);
        var grad = '<defs><linearGradient id="' + id + '" x1="0" y1="0" x2="0" y2="1">' +
            '<stop offset="0" stop-color="' + stroke + '" stop-opacity="0.28"/>' +
            '<stop offset="1" stop-color="' + stroke + '" stop-opacity="0"/></linearGradient></defs>';

        function render() {
            var step = SP_W / (data.length - 1);
            var pts = data.map(function (d, i) {
                return (i * step).toFixed(1) + ',' + ((1 - d) * SP_H).toFixed(1);
            });
            var line = 'M' + pts.join(' L');
            var area = line + ' L' + SP_W + ',' + SP_H + ' L0,' + SP_H + ' Z';
            var lx = SP_W, ly = (1 - data[data.length - 1]) * SP_H;
            svg.innerHTML = grad +
                '<path d="' + area + '" fill="url(#' + id + ')"/>' +
                '<path d="' + line + '" fill="none" stroke="' + stroke + '" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/>' +
                '<circle cx="' + lx.toFixed(1) + '" cy="' + ly.toFixed(1) + '" r="3" fill="' + stroke + '"/>';
        }
        render();
        return {
            push: function () { data.push(w.step()); data.shift(); render(); }
        };
    }

    /* ============================ LIVE FIELD ENGINE ============================ */
    /* Each field has a target driven by a walk, and a displayed value that
       glides toward the target every frame so digits never snap. */
    var fields = [];
    function field(id, walk, conf) {
        var el = document.getElementById(id);
        if (!el) return;
        conf = conf || {};
        fields.push({
            el: el, walk: walk, disp: conf.start !== undefined ? conf.start : 0,
            dec: conf.decimals || 0, commas: !!conf.commas, prefix: conf.prefix || '', suffix: conf.suffix || ''
        });
    }
    function lerpFrame() {
        for (var i = 0; i < fields.length; i++) {
            var f = fields[i];
            f.disp += (f.walk.get() - f.disp) * 0.16;
            f.el.textContent = f.prefix + fmt(f.disp, f.dec, f.commas) + f.suffix;
        }
        rafId = requestAnimationFrame(lerpFrame);
    }
    var rafId = null, tickInt = null, sparkInt = null, secInt = null;

    /* ============================ DEMAND TICKER ============================ */
    var STORES = ['CA_1', 'CA_2', 'CA_3', 'CA_4', 'TX_1', 'TX_2', 'TX_3', 'WI_1', 'WI_2', 'WI_3'];
    var DEPTS = ['HOBBIES_1', 'HOBBIES_2', 'HOUSEHOLD_1', 'HOUSEHOLD_2', 'FOODS_1', 'FOODS_2', 'FOODS_3'];
    var tickEntries = [];
    function buildTicker() {
        var track = document.getElementById('tickerTrack');
        if (!track) return;
        var labels = STORES.concat(DEPTS);
        tickEntries = labels.map(function (label) {
            return { label: label, val: between(0.8, 6.5), delta: between(-4.5, 5.2) };
        });
        function entryHtml(e) {
            var up = e.delta >= 0;
            return '<span class="tick ' + (up ? 'up' : 'down') + '">' +
                '<span class="sym">' + e.label + '</span>' +
                '<span class="val">' + e.val.toFixed(2) + '</span>' +
                '<span class="delta"><span class="arrow">' + (up ? '▲' : '▼') + '</span> ' +
                (up ? '+' : '') + e.delta.toFixed(1) + '%</span></span>';
        }
        function render() {
            var html = tickEntries.map(entryHtml).join('');
            track.innerHTML = html + html; // duplicate for seamless -50% scroll
        }
        render();
        return function regen() {
            // nudge a few entries so the tape feels alive
            for (var k = 0; k < 3; k++) {
                var idx = Math.floor(rng() * tickEntries.length);
                var e = tickEntries[idx];
                e.val = Math.max(0.4, e.val + gauss() * 0.4);
                e.delta = Math.max(-7, Math.min(7, e.delta + gauss() * 1.2));
            }
            render();
        };
    }

    /* ============================ REVEAL + COUNT-UP ============================ */
    function hydrateCard(card) {
        if (card.dataset.hydrated) return;
        card.dataset.hydrated = '1';

        // KPI count-ups
        card.querySelectorAll('.kv[data-count] .cv').forEach(function (cv) {
            var p = parseStat(cv.textContent);
            if (!p) return;
            countUp(cv, p.value, { decimals: p.decimals, commas: p.commas, suffix: p.suffix });
            // mark live ones for continuous jitter
            if (cv.parentElement.hasAttribute('data-live')) {
                liveJitter(cv, p);
            }
        });

        // Model leaderboard: count up metric values + size gauge fills
        if (card.id === 'sec-performance') hydratePerformance(card);
    }

    function liveJitter(cv, p) {
        if (reduceMotion) return;
        var base = p.value;
        liveJitterFns.push(function () {
            var v = Math.max(0, base * (1 + gauss() * 0.012));
            cv.textContent = fmt(v, Math.max(p.decimals, 2), p.commas) + p.suffix;
        });
    }
    var liveJitterFns = [];

    function hydratePerformance(card) {
        var rows = Array.prototype.slice.call(card.querySelectorAll('.model-row'));
        if (!rows.length) return;
        ['mae', 'rmse'].forEach(function (metric) {
            var vals = rows.map(function (r) { return parseFloat(r.dataset[metric]); });
            var min = Math.min.apply(null, vals), max = Math.max.apply(null, vals);
            rows.forEach(function (r) {
                var fill = r.querySelector('.g-fill[data-metric="' + metric + '"]');
                if (!fill) return;
                var v = parseFloat(fill.dataset.val);
                // lower error → fuller bar; compress into a pleasant 55–96% band
                var norm = (max === min) ? 1 : (max - v) / (max - min);
                var pct = 55 + norm * 41;
                setTimeout(function () { fill.style.width = pct.toFixed(1) + '%'; }, 120);
            });
        });
        // count up the printed metric numbers
        card.querySelectorAll('.gauge .g-v').forEach(function (g) {
            var t = parseFloat(g.textContent);
            if (!isNaN(t)) countUp(g, t, { decimals: 4 });
        });
    }

    function setupReveal() {
        var cards = Array.prototype.slice.call(document.querySelectorAll('.reveal'));
        function revealAll() { cards.forEach(function (c) { c.classList.add('in'); hydrateCard(c); }); }
        if (reduceMotion || !('IntersectionObserver' in window)) { revealAll(); return; }
        document.documentElement.classList.add('reveal-on');
        var io = new IntersectionObserver(function (entries) {
            entries.forEach(function (e) {
                if (e.isIntersecting) {
                    e.target.classList.add('in');
                    hydrateCard(e.target);
                    io.unobserve(e.target);
                }
            });
        }, { threshold: 0.12, rootMargin: '0px 0px -40px 0px' });
        cards.forEach(function (c, i) { c.style.transitionDelay = (i * 55) + 'ms'; io.observe(c); });
        // Failsafe: content must never stay hidden if the observer doesn't fire.
        setTimeout(revealAll, 1600);
    }

    /* ============================ NAV SCROLL-SPY ============================ */
    function setupScrollSpy() {
        var links = Array.prototype.slice.call(document.querySelectorAll('.nav-link'));
        var map = links.map(function (l) {
            var id = l.getAttribute('href').slice(1);
            return { link: l, el: document.getElementById(id) };
        }).filter(function (m) { return m.el; });
        function onScroll() {
            var y = window.scrollY + 120, cur = map[0];
            map.forEach(function (m) { if (m.el.offsetTop <= y) cur = m; });
            links.forEach(function (l) { l.classList.remove('active'); });
            if (cur) cur.link.classList.add('active');
        }
        window.addEventListener('scroll', onScroll, { passive: true });
        onScroll();
    }

    /* ============================ CLOCKS ============================ */
    function pad(n) { return (n < 10 ? '0' : '') + n; }
    function setupClocks() {
        var hash = (seed >>> 8).toString(16).slice(-6).padStart(6, '0');
        var bh = document.getElementById('buildHash');
        if (bh) bh.textContent = 'm5·' + hash;
        var stamp = document.getElementById('renderStamp');
        if (stamp) {
            var d = new Date();
            stamp.textContent = pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
        }
        // uptime: pretend the engine has been up for a while, then count real time
        var startEpoch = Date.now() - Math.floor(between(40, 600)) * 60000;
        var ut = document.getElementById('uptime'), utf = document.getElementById('uptimeFoot');
        function tickClock() {
            var s = Math.floor((Date.now() - startEpoch) / 1000);
            var hh = Math.floor(s / 3600), mm = Math.floor((s % 3600) / 60), ss = s % 60;
            var t = pad(hh) + ':' + pad(mm) + ':' + pad(ss);
            if (ut) ut.textContent = t;
            if (utf) utf.textContent = t;
        }
        tickClock();
        secInt = setInterval(tickClock, 1000);
    }

    /* ============================ LIFECYCLE ============================ */
    var monSpark = null, regenTicker = null;

    function startLoops() {
        if (reduceMotion) return;
        if (!rafId) rafId = requestAnimationFrame(lerpFrame);
        if (!tickInt) tickInt = setInterval(function () {
            fields.forEach(function (f) { f.walk.step(); });
            liveJitterFns.forEach(function (fn) { fn(); });
            updateMonDelta();
            if (regenTicker && rng() < 0.6) regenTicker();
        }, 1600);
        if (!sparkInt && monSpark) sparkInt = setInterval(function () { monSpark.push(); }, 2200);
    }
    function stopLoops() {
        if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
        if (tickInt) { clearInterval(tickInt); tickInt = null; }
        if (sparkInt) { clearInterval(sparkInt); sparkInt = null; }
    }

    var monDeltaEl, monVolWalk;
    function updateMonDelta() {
        if (!monDeltaEl || !monVolWalk) return;
        var d = (monVolWalk.get() - 12000) / 12000 * 100 + gauss() * 0.6;
        var up = d >= 0;
        monDeltaEl.className = 'delta-chip ' + (up ? 'up' : 'down');
        monDeltaEl.textContent = (up ? '▲ +' : '▼ ') + Math.abs(d).toFixed(1) + '%';
    }

    function init() {
        setupClocks();
        setupReveal();
        setupScrollSpy();

        // Hero rail
        field('tmThroughput', makeWalk(120, 340, 210, 0.05), { decimals: 0, commas: true });
        field('tmLatency', makeWalk(38, 92, 58, 0.06), { decimals: 0 });
        field('tmSkus', makeWalk(2980, 3120, 3049, 0.02), { decimals: 0, commas: true });

        // Hero monitor
        monVolWalk = makeWalk(8200, 16800, 12400, 0.04);
        field('monVolume', monVolWalk, { decimals: 0, commas: true });
        field('monConf', makeWalk(97.6, 99.5, 98.7, 0.03), { decimals: 1 });
        field('monP95', makeWalk(74, 148, 96, 0.05), { decimals: 0 });
        field('monDrift', makeWalk(0.02, 0.74, 0.21, 0.05), { decimals: 2 });
        monDeltaEl = document.getElementById('monDelta');

        var sp = document.getElementById('monSpark');
        if (sp) monSpark = makeSpark(sp, 48, 0.05, { stroke: 'var(--live)' });

        regenTicker = buildTicker();

        if (reduceMotion) {
            // settle every live field on its first target, statically
            fields.forEach(function (f) { f.el.textContent = f.prefix + fmt(f.walk.get(), f.dec, f.commas) + f.suffix; });
            updateMonDelta();
        } else {
            startLoops();
        }

        document.addEventListener('visibilitychange', function () {
            if (document.hidden) stopLoops(); else startLoops();
        });
    }

    /* Expose for app.js (shared PRNG keeps the forecast cone in the same world) */
    window.FA = {
        rng: rng, gauss: gauss, between: between, reduceMotion: reduceMotion,
        fmt: fmt, countUp: countUp, makeWalk: makeWalk
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else { init(); }
})();
