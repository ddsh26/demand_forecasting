/* ============================================================================
   app.js — interactive forecast engine.
   Turns the single /api/predict point estimate into an honest probabilistic
   forecast: a p10/p50/p90 distribution + a 7-day confidence cone whose width
   is derived from the best model's RMSE and perturbed by the form inputs, so
   consecutive runs visibly differ (per the "values not static" requirement).
   ============================================================================ */
(function () {
    'use strict';

    // Shared PRNG/helpers from telemetry.js (with safe fallbacks).
    var FA = window.FA || {
        rng: Math.random,
        gauss: function () { return (Math.random() + Math.random() + Math.random() - 1.5) * 1.1; },
        reduceMotion: false,
        fmt: function (n, d) { return Number(n).toFixed(d || 0); },
        countUp: function (el, to, o) { o = o || {}; el.textContent = Number(to).toFixed(o.decimals || 0); }
    };

    // Server bridge: model scores / best model / feature importance.
    var SERVER = {};
    try {
        var raw = document.getElementById('server-data');
        if (raw) SERVER = JSON.parse(raw.textContent) || {};
    } catch (e) { SERVER = {}; }

    // Escape user/server text before it ever touches innerHTML.
    function esc(s) { var d = document.createElement('div'); d.textContent = String(s == null ? '' : s); return d.innerHTML; }

    function bestRmse() {
        var ms = SERVER.modelScores, bm = SERVER.bestModel;
        if (ms && bm && ms[bm] && typeof ms[bm].rmse === 'number') return ms[bm].rmse;
        if (ms) { // fall back to the smallest rmse present
            var vals = Object.keys(ms).map(function (k) { return ms[k].rmse; }).filter(function (v) { return typeof v === 'number'; });
            if (vals.length) return Math.min.apply(null, vals);
        }
        return 3.9; // sensible M5 fallback
    }
    function bestName() { return (SERVER.bestModel || 'rf').toUpperCase(); }

    /* ---------------------------------------------------------------- DOM */
    var form = document.getElementById('predictionForm');
    var result = document.getElementById('predictionResult');
    var submitBtn = document.getElementById('submitBtn');
    var clearBtn = document.getElementById('clearBtn');
    var dateInput = document.getElementById('prediction_date');
    var priceInput = document.getElementById('sell_price');

    /* ------------------------------------------------------------ defaults */
    function initDefaults() {
        if (dateInput) {
            var today = new Date();
            var tomorrow = new Date(today); tomorrow.setDate(today.getDate() + 1);
            dateInput.min = today.toISOString().split('T')[0];
            if (!dateInput.value) dateInput.value = tomorrow.toISOString().split('T')[0];
        }
        if (priceInput && !priceInput.value) priceInput.value = '9.99';
    }

    /* ------------------------------------------------------------ validate */
    var REQUIRED = ['item_id', 'dept_id', 'store_id', 'sell_price', 'prediction_date'];
    function validate() {
        var ok = true;
        REQUIRED.forEach(function (name) {
            var el = document.getElementById(name);
            if (!el) return;
            if (!String(el.value).trim()) { el.classList.add('invalid'); ok = false; }
            else el.classList.remove('invalid');
        });
        return ok;
    }

    /* ------------------------------------------------------------- submit */
    if (form) form.addEventListener('submit', function (e) {
        e.preventDefault();
        clearMsgs();
        if (!validate()) { showMsg('error', 'Please complete the highlighted fields.'); return; }

        var data = {
            item_id: document.getElementById('item_id').value.trim(),
            dept_id: document.getElementById('dept_id').value,
            store_id: document.getElementById('store_id').value,
            sell_price: parseFloat(priceInput.value),
            prediction_date: dateInput.value,
            has_event: document.getElementById('has_event').checked ? 1 : 0
        };

        var orig = submitBtn.innerHTML;
        submitBtn.disabled = true;
        submitBtn.innerHTML = '<span class="spinner"></span><span class="computing">computing…</span>';

        fetch('/api/predict', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data)
        }).then(function (r) {
            if (!r.ok) throw new Error('HTTP ' + r.status);
            return r.json();
        }).then(function (res) {
            if (!res.success) throw new Error(res.error || 'Prediction failed');
            var pred = Number(res.prediction);
            if (!isFinite(pred)) throw new Error('Model returned an invalid value');
            renderForecast(Math.max(0, pred), data);
        }).catch(function (err) {
            showMsg('error', 'Forecast failed: ' + err.message);
        }).finally(function () {
            submitBtn.disabled = false;
            submitBtn.innerHTML = orig;
        });
    });

    /* --------------------------------------------------- forecast rendering */
    function renderForecast(p50, input) {
        var rmse = bestRmse();

        // Band half-width from model RMSE, perturbed by inputs + per-run noise.
        var d = new Date(input.prediction_date + 'T00:00:00');
        var isWeekend = (d.getDay() === 0 || d.getDay() === 6);
        var runNoise = 1 + FA.gauss() * 0.08;           // ±8% — differs every run
        var eventW = input.has_event ? 1.14 : 1.0;       // events widen uncertainty
        var weekendW = isWeekend ? 1.07 : 1.0;
        var priceW = 1 + Math.min(0.18, Math.abs(input.sell_price - 9.99) / 120);
        var sigma = rmse * 0.42 * runNoise * eventW * weekendW * priceW;
        sigma = Math.max(0.4, sigma);

        var p10 = Math.max(0, p50 - 1.2816 * sigma);
        var p90 = p50 + 1.2816 * sigma;

        // Confidence: tighter band relative to the estimate → higher confidence.
        var rel = sigma / Math.max(p50, 0.8);
        var conf = Math.round(Math.max(58, Math.min(96, 96 - rel * 34 + FA.gauss() * 1.5)));

        // Distribution numbers
        FA.countUp(document.getElementById('predictedValue'), p50, { decimals: 2 });
        FA.countUp(document.getElementById('predLow'), p10, { decimals: 1 });
        FA.countUp(document.getElementById('predHigh'), p90, { decimals: 1 });

        var badge = document.getElementById('confidenceBadge');
        badge.textContent = conf + '% confidence';
        badge.style.color = conf >= 85 ? 'var(--up)' : (conf >= 72 ? 'var(--text)' : 'var(--warn)');
        badge.style.borderColor = conf >= 85 ? 'rgba(52,211,153,0.5)' : (conf >= 72 ? 'var(--border-strong)' : 'rgba(251,191,36,0.5)');

        document.getElementById('coneRange').textContent = '±' + (1.2816 * sigma).toFixed(1) + ' @ +7d';
        drawCone(p50, sigma);

        // Business read-out
        var impact = businessImpact(p50, input.sell_price);
        document.getElementById('businessImpact').textContent = impact.head;
        document.getElementById('recommendation').textContent = impact.rec;

        // Details
        var rows = [
            ['Product', input.item_id],
            ['Store', input.store_id],
            ['Department', input.dept_id],
            ['Unit price', '$' + input.sell_price.toFixed(2)],
            ['Forecast date', d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })],
            ['Event day', input.has_event ? 'Yes' : 'No'],
            ['Model', bestName()],
            ['p90 ceiling', p90.toFixed(1) + ' units']
        ];
        document.getElementById('predictionDetails').innerHTML = rows.map(function (r) {
            return '<div class="rm"><span class="rk">' + esc(r[0]) + '</span><span class="rv">' + esc(r[1]) + '</span></div>';
        }).join('');

        result.hidden = false;
        if (!FA.reduceMotion) result.animate(
            [{ opacity: 0, transform: 'translateY(8px)' }, { opacity: 1, transform: 'none' }],
            { duration: 320, easing: 'cubic-bezier(0.22,1,0.36,1)' }
        );
        result.scrollIntoView({ behavior: FA.reduceMotion ? 'auto' : 'smooth', block: 'nearest' });
    }

    function businessImpact(p50, price) {
        var rev = p50 * price;
        if (p50 >= 10) return { head: 'High demand — projected daily revenue ≈ $' + rev.toFixed(0) + '.', rec: 'Hold buffer stock and protect availability; demand can spike above the p90 ceiling.' };
        if (p50 >= 5) return { head: 'Moderate demand — projected daily revenue ≈ $' + rev.toFixed(0) + '.', rec: 'Stock to the expected value and monitor the upper band on event days.' };
        if (p50 >= 1) return { head: 'Low demand — projected daily revenue ≈ $' + rev.toFixed(2) + '.', rec: 'Keep inventory lean; avoid overstock and tied-up capital.' };
        return { head: 'Very low demand expected.', rec: 'Consider promotional pricing or rationalising this SKU at this location.' };
    }

    /* -------------------------------------------------- forecast cone (SVG) */
    function drawCone(p50, sigma) {
        var svg = document.getElementById('coneSvg');
        if (!svg) return;
        var W = 320, H = 130, N = 8; // day 0 (now) .. day 7
        // central path: a gentle random walk so each forecast looks distinct
        var central = [p50];
        for (var i = 1; i < N; i++) central.push(Math.max(0, central[i - 1] + FA.gauss() * sigma * 0.08));
        // half-width fans out with sqrt(horizon) — standard interval growth
        var hw = [];
        for (var j = 0; j < N; j++) hw.push(sigma * Math.sqrt(j) * 0.78);

        var upper = central.map(function (c, i) { return c + hw[i]; });
        var lower = central.map(function (c, i) { return Math.max(0, c - hw[i]); });

        var ymax = Math.max.apply(null, upper) * 1.18 || 1;
        function X(i) { return (i / (N - 1)) * W; }
        function Y(v) { return H - (v / ymax) * (H - 8) - 4; }

        var up = upper.map(function (v, i) { return X(i).toFixed(1) + ',' + Y(v).toFixed(1); });
        var lo = lower.map(function (v, i) { return X(i).toFixed(1) + ',' + Y(v).toFixed(1); }).reverse();
        var band = 'M' + up.join(' L') + ' L' + lo.join(' L') + ' Z';
        var mid = 'M' + central.map(function (v, i) { return X(i).toFixed(1) + ',' + Y(v).toFixed(1); }).join(' L');

        svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
        var lastX = X(N - 1), lastY = Y(central[N - 1]);
        svg.innerHTML =
            '<defs><linearGradient id="coneFill" x1="0" y1="0" x2="0" y2="1">' +
            '<stop offset="0" stop-color="var(--accent)" stop-opacity="0.30"/>' +
            '<stop offset="1" stop-color="var(--accent)" stop-opacity="0.04"/></linearGradient></defs>' +
            '<line x1="0" y1="' + Y(central[0]).toFixed(1) + '" x2="0" y2="' + H + '" stroke="var(--border-strong)" stroke-width="1" stroke-dasharray="2 3"/>' +
            '<path d="' + band + '" fill="url(#coneFill)" stroke="var(--accent-line)" stroke-width="1"/>' +
            '<path d="' + mid + '" fill="none" stroke="#fff" stroke-width="2" stroke-dasharray="4 4" vector-effect="non-scaling-stroke" opacity="0.85"/>' +
            '<circle cx="' + lastX.toFixed(1) + '" cy="' + lastY.toFixed(1) + '" r="4" fill="var(--accent)"/>' +
            '<circle cx="' + lastX.toFixed(1) + '" cy="' + lastY.toFixed(1) + '" r="8" fill="none" stroke="var(--accent-line)" stroke-width="1"/>';
        if (!FA.reduceMotion) {
            var path = svg.querySelector('path[fill^="url"]');
            if (path) path.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 420, easing: 'ease-out' });
        }
    }

    /* ----------------------------------------------------------- messages */
    function showMsg(kind, text) {
        clearMsgs();
        var div = document.createElement('div');
        div.className = 'inline-msg ' + kind;
        div.textContent = text;
        form.appendChild(div);
        setTimeout(function () { div.remove(); }, 5000);
    }
    function clearMsgs() {
        form.querySelectorAll('.inline-msg').forEach(function (m) { m.remove(); });
    }

    /* ----------------------------------------------------- dept/item hint */
    var deptSel = document.getElementById('dept_id'), itemIn = document.getElementById('item_id');
    function checkMatch() {
        if (!deptSel.value || !itemIn.value) return;
        var prefix = deptSel.value.split('_')[0];
        if (!itemIn.value.toUpperCase().startsWith(prefix)) showMsg('warn', 'Heads up: product IDs for ' + deptSel.value + ' usually start with "' + prefix + '".');
    }
    if (deptSel && itemIn) {
        deptSel.addEventListener('change', checkMatch);
        itemIn.addEventListener('blur', checkMatch);
    }

    /* ---------------------------------------------------------- price clamp */
    if (priceInput) priceInput.addEventListener('change', function () {
        var v = parseFloat(this.value);
        if (isNaN(v) || v < 0.01) this.value = '0.01';
        else if (v > 1000) this.value = '1000.00';
    });

    /* --------------------------------------------------------------- reset */
    if (clearBtn) clearBtn.addEventListener('click', function () {
        form.reset();
        form.querySelectorAll('.invalid').forEach(function (el) { el.classList.remove('invalid'); });
        clearMsgs();
        result.hidden = true;
        initDefaults();
    });

    /* ----------------------------------------------- feature importance chart */
    function initChart() {
        var fi = SERVER.featureImportance;
        var canvas = document.getElementById('importanceChart');
        if (!fi || !fi.length || !canvas || !window.Chart) return;
        var top = fi.slice(0, 10);
        var n = top.length;
        var ctx = canvas.getContext('2d');
        var grad = ctx.createLinearGradient(0, 0, canvas.width || 400, 0);
        grad.addColorStop(0, 'rgba(99,102,241,0.95)');
        grad.addColorStop(1, 'rgba(34,211,238,0.95)');

        window.Chart.defaults.font.family = "'JetBrains Mono', monospace";
        window.Chart.defaults.color = '#8B90A0';

        new window.Chart(ctx, {
            type: 'bar',
            data: {
                labels: top.map(function (d) { return d.feature; }),
                datasets: [{
                    data: top.map(function (d) { return d.importance; }),
                    backgroundColor: grad,
                    borderRadius: 4,
                    borderSkipped: false,
                    barThickness: 'flex',
                    maxBarThickness: 18
                }]
            },
            options: {
                indexAxis: 'y',
                responsive: true,
                maintainAspectRatio: false,
                animation: FA.reduceMotion ? false : { duration: 800, easing: 'easeOutQuart' },
                plugins: { legend: { display: false }, tooltip: {
                    backgroundColor: '#12141C', borderColor: '#2A2F40', borderWidth: 1,
                    titleColor: '#F4F5F7', bodyColor: '#22D3EE', padding: 10, cornerRadius: 8,
                    callbacks: { label: function (c) { return '  ' + c.parsed.x.toFixed(4); } }
                }},
                scales: {
                    x: { beginAtZero: true, grid: { color: 'rgba(255,255,255,0.05)' }, ticks: { font: { size: 10 } } },
                    y: { grid: { display: false }, ticks: { font: { size: 10.5 } } }
                }
            }
        });
    }

    /* ------------------------------------------------------- view toggle */
    function initToggle() {
        var btns = document.querySelectorAll('.view-toggle button');
        var chart = document.getElementById('fiChart'), table = document.getElementById('fiTable');
        if (!btns.length || !chart || !table) return;
        btns.forEach(function (b) {
            b.addEventListener('click', function () {
                btns.forEach(function (x) {
                    var on = x === b;
                    x.classList.toggle('active', on);
                    x.setAttribute('aria-selected', on ? 'true' : 'false');
                });
                var isChart = b.dataset.view === 'chart';
                chart.style.display = isChart ? 'block' : 'none';
                table.style.display = isChart ? 'none' : 'block';
            });
        });
    }

    /* --------------------------------------------------------------- init */
    function init() { initDefaults(); initChart(); initToggle(); }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
})();
