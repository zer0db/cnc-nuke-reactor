// --- Backend endpoint config (easy to change) ---
const API_BASE = (window.REACTOR_API_BASE || '/').replace(/\/+$/, '/');
const ENDPOINTS = {
    state: `${API_BASE}api/state`,
    action: `${API_BASE}api/action`,
    events: `${API_BASE}events`
};

// ReactorStatus flags must match the backend
const ReactorStatus = {
    None: 0,
    TempLow: 1 << 0,
    Overheat: 1 << 1,
    OutputLow: 1 << 2,
    OutputHigh: 1 << 3,
    FuelLow: 1 << 4,
    FuelOut: 1 << 5,
    Meltdown: 1 << 6,
    Scram: 1 << 7,
};

// sensible defaults for scales (backend may change in future)
const DEFAULTS = {
    MAX_TEMP: 1000,
    MAX_POWER_OUTPUT: 5000
};

// --- UI Controller ---
document.addEventListener('DOMContentLoaded', () => {
    // Remote state (populated via /api/state and SSE /events)
    let state = null;

    const ui = {
        reactorPanel: document.querySelector('.reactor-panel'),
        powerButton: document.getElementById('power-button'),
        refuelButton: document.getElementById('refuel-button'),
        autoSwitch: document.getElementById('auto-control-switch'),
        fissionNeedle: document.querySelector('#fission-rate-gauge .gauge-needle'),
        fissionValue: document.getElementById('fission-rate-value'),
        fissionSlider: document.getElementById('fission-rate-slider'),
        turbineNeedle: document.querySelector('#turbine-output-gauge .gauge-needle'),
        turbineValue: document.getElementById('turbine-output-value'),
        turbineSlider: document.getElementById('turbine-output-slider'),
        tempValue: document.getElementById('temp-value'),
        powerLoad: document.getElementById('power-load'),
        powerOutput: document.getElementById('power-output'),
        graphCanvas: document.getElementById('history-graph'),
        graphTooltip: document.getElementById('graph-tooltip'),
        tempScale: document.getElementById('temp-scale'),
        powerScale: document.getElementById('power-scale'),
        criticalHeat: document.getElementById('critical-heat'),
        criticalOutput: document.getElementById('critical-output'),
        statusLights: {
            [ReactorStatus.TempLow]: document.getElementById('status-temp-low'),
            [ReactorStatus.Overheat]: document.getElementById('status-overheat'),
            [ReactorStatus.OutputLow]: document.getElementById('status-output-low'),
            [ReactorStatus.OutputHigh]: document.getElementById('status-output-high'),
            [ReactorStatus.FuelLow]: document.getElementById('status-fuel-low'),
            [ReactorStatus.FuelOut]: document.getElementById('status-fuel-out'),
            [ReactorStatus.Meltdown]: document.getElementById('status-meltdown'),
            [ReactorStatus.Scram]: document.getElementById('status-scram'),
        }
    };

    const graphCtx = ui.graphCanvas.getContext('2d');
    let graphHistory = [];
    const MAX_HISTORY = 200;

    // --- Wobble Animation Variables ---
    let lastFissionRate = 0;
    let lastTurbineOutput = 0;
    let fissionWobble = 0;
    let turbineWobble = 0;
    const WOBBLE_FACTOR = 10;
    const WOBBLE_DECAY = 0.9;

    function createTicks(gaugeBody) {
        const ticksContainer = gaugeBody.querySelector('.gauge-ticks');
        ticksContainer.innerHTML = '';
        for (let i = 0; i <= 10; i++) {
            const angle = -90 + (i * 18);
            const tickWrapper = document.createElement('div');
            tickWrapper.style.cssText = `position:absolute; left:0; top:0; width:200px; height:100px; transform: rotate(${angle}deg); transform-origin: 100px 100px;`;
            const tick = document.createElement('div');
            const isMajor = i % 5 === 0;
            tick.style.cssText = `position:absolute; left:99.5px; top:0; width:1px; height:${isMajor ? '10px' : '5px'}; background-color: ${isMajor ? 'var(--text-color)' : 'var(--text-dark)'};`;
            tickWrapper.appendChild(tick);
            ticksContainer.appendChild(tickWrapper);
            if (i % 2 === 0) {
               const label = document.createElement('div');
               label.className = 'tick-label';
               label.textContent = i * 10;
               const labelAngleRad = angle * (Math.PI / 180);
               const radius = 85;
               const x = 100 + radius * Math.sin(labelAngleRad);
               const y = 100 - radius * Math.cos(labelAngleRad);
               label.style.left = `${x}px`;
               label.style.top = `${y}px`;
               label.style.transform = 'translate(-50%, -50%)';
               ticksContainer.appendChild(label);
            }
        }
    }
    createTicks(document.getElementById('fission-rate-gauge'));
    createTicks(document.getElementById('turbine-output-gauge'));

    function populateScales() {
        const tempScaleDiv = ui.tempScale;
        const powerScaleDiv = ui.powerScale;
        tempScaleDiv.innerHTML = '';
        powerScaleDiv.innerHTML = '';

        const maxTemp = (state && typeof state.temperature === 'number') ? Math.max(state.temperature, DEFAULTS.MAX_TEMP) : DEFAULTS.MAX_TEMP;
        const maxPower = DEFAULTS.MAX_POWER_OUTPUT;

        const numLabels = 5;
        for(let i = 0; i < numLabels; i++) {
            // Temperature Scale (left)
            const tempLabel = document.createElement('div');
            const tempValue = Math.round(maxTemp * (1 - (i / (numLabels - 1))));
            tempLabel.textContent = `${tempValue}C`;
            tempScaleDiv.appendChild(tempLabel);

            // Power Scale (right)
            const powerLabel = document.createElement('div');
            const powerValue = (maxPower * 0.75) * (1 - (i / (numLabels - 1)));
            powerLabel.textContent = `${(powerValue/1000).toFixed(1)}MW`;
            powerScaleDiv.appendChild(powerLabel);
        }
    }
    populateScales();

    // --- Helpers ---
    function hasStatus(st, flag) {
        return st && (st.status & flag) !== 0;
    }

    async function sendAction(type, value = 0) {
        try {
            await fetch(ENDPOINTS.action, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ type, value })
            });
        } catch (err) {
            // silent fail (network issues) — UI will update from SSE when available
            console.error('action send error', err);
        }
    }

    // --- Wire UI controls to backend actions ---
    ui.powerButton.addEventListener('click', () => {
        if (!state) return;
        sendAction(state.isPoweredOn ? 'powerOff' : 'powerOn');
    });
    ui.refuelButton.addEventListener('click', () => sendAction('refuel'));
    ui.autoSwitch.addEventListener('click', () => sendAction('toggleAuto'));
    // throttle slider sends
    let fissionTimer = null;
    ui.fissionSlider.addEventListener('input', (e) => {
        ui.fissionValue.textContent = Number(e.target.value).toFixed(0);
        clearTimeout(fissionTimer);
        fissionTimer = setTimeout(() => sendAction('setFissionRate', parseFloat(e.target.value)), 120);
    });
    let turbineTimer = null;
    ui.turbineSlider.addEventListener('input', (e) => {
        ui.turbineValue.textContent = Number(e.target.value).toFixed(0);
        clearTimeout(turbineTimer);
        turbineTimer = setTimeout(() => sendAction('setTurbineOutput', parseFloat(e.target.value)), 120);
    });
    ui.statusLights[ReactorStatus.Meltdown].addEventListener('click', () => sendAction('scram'));

    // --- SSE for live state updates ---
    function connectSSE() {
        try {
            const es = new EventSource(ENDPOINTS.events);
            es.onmessage = (ev) => {
                try {
                    const s = JSON.parse(ev.data);
                    applyState(s);
                } catch (e) {
                    console.error('invalid SSE payload', e);
                }
            };
            es.onerror = (err) => {
                // EventSource will auto-reconnect; log for debugging
                console.warn('SSE error', err);
            };
        } catch (err) {
            console.error('EventSource not supported or failed', err);
        }
    }

    function applyState(newState) {
        state = newState;
        // ensure sliders/controls reflect current server state
        if (state) {
            // ui.fissionSlider.value = state.fissionRate;
            // ui.turbineSlider.value = state.turbineOutput;
            populateScales();
        }
        updateUI(state);
    }

    // initial fetch of state
    (async function fetchInitial() {
        try {
            const res = await fetch(ENDPOINTS.state);
            if (res.ok) {
                const s = await res.json();
                applyState(s);
            }
        } catch (e) {
            console.error('failed fetching initial state', e);
        }
        connectSSE();
    })();

    // --- Load spike / game loop ---
    let lastTime = 0;
    let baseLoad = (state && state.powerLoad) || 1000; // fallback
    const spikeState = {
        isActive: false,
        startTime: 0,
        duration: 5000,
        magnitude: 1000,
        nextSpikeTime: 0
    };
    function scheduleNextSpike(currentTime) {
        const randomInterval = Math.random() * 5000 + 10000; // 10-15s
        spikeState.nextSpikeTime = currentTime + randomInterval;
    }
    scheduleNextSpike(performance.now());

    let lastSentLoad = baseLoad;

    function gameLoop(currentTime) {
        if (!lastTime) lastTime = currentTime;
        const deltaTime = (currentTime - lastTime) / 1000;
        lastTime = currentTime;

        // // Baseline load random walk
        // const loadDelta = Math.floor(Math.random() * 25) - 12;
        // baseLoad += loadDelta;
        // if (baseLoad > 2200) baseLoad = 2100;
        // if (baseLoad < 750) baseLoad = 800;

        // // Spike logic
        // let spikeValue = 0;
        // if (!spikeState.isActive && currentTime >= spikeState.nextSpikeTime) {
        //     spikeState.isActive = true;
        //     spikeState.startTime = currentTime;
        //     scheduleNextSpike(currentTime);
        // }
        // if (spikeState.isActive) {
        //     const elapsed = currentTime - spikeState.startTime;
        //     if (elapsed >= spikeState.duration) {
        //         spikeState.isActive = false;
        //     } else {
        //         const decayFactor = 1 - (elapsed / spikeState.duration);
        //         spikeValue = spikeState.magnitude * decayFactor;
        //     }
        // }

        // const finalLoad = Math.round(baseLoad + spikeValue);

        // // send to backend only when changed sufficiently
        // if (Math.abs(finalLoad - lastSentLoad) > 1) {
        //     sendAction('setPowerLoad', finalLoad);
        //     lastSentLoad = finalLoad;
        // }

        // animate wobble even if we wait for SSE for numeric updates
        animateAndDraw();

        requestAnimationFrame(gameLoop);
    }

    function updateUI(st) {
        if (!st) return;

        // Meltdown Shake
        ui.reactorPanel.classList.toggle('shake', hasStatus(st, ReactorStatus.Meltdown));

        ui.powerButton.classList.toggle('on', st.isPoweredOn);
        ui.autoSwitch.classList.toggle('on', st.isAutoControl);

        // Needle Wobble Logic uses last known values
        const fissionDelta = Math.abs(st.fissionRate - lastFissionRate);
        if (fissionDelta > 0.5) fissionWobble += fissionDelta * WOBBLE_FACTOR;
        const currentFissionWobble = (Math.random() - 0.5) * fissionWobble;

        const turbineDelta = Math.abs(st.turbineOutput - lastTurbineOutput);
        if (turbineDelta > 0.5) turbineWobble += turbineDelta * WOBBLE_FACTOR;
        const currentTurbineWobble = (Math.random() - 0.5) * turbineWobble;

        fissionWobble *= WOBBLE_DECAY;
        turbineWobble *= WOBBLE_DECAY;
        if (Math.abs(fissionWobble) < 0.1) fissionWobble = 0;
        if (Math.abs(turbineWobble) < 0.1) turbineWobble = 0;

        ui.fissionNeedle.style.transform = `rotate(${-90 + st.fissionRate * 1.8 + currentFissionWobble}deg)`;
        if (document.activeElement !== ui.fissionSlider) {
             ui.fissionValue.textContent = st.fissionRate.toFixed(0);
             ui.fissionSlider.value = st.fissionRate;
        }
        ui.fissionSlider.disabled = st.isAutoControl;

        ui.turbineNeedle.style.transform = `rotate(${-90 + st.turbineOutput * 1.8 + currentTurbineWobble}deg)`;
        if (document.activeElement !== ui.turbineSlider) {
            ui.turbineValue.textContent = st.turbineOutput.toFixed(0);
            ui.turbineSlider.value = st.turbineOutput;
        }
        ui.turbineSlider.disabled = st.isAutoControl;

        lastFissionRate = st.fissionRate;
        lastTurbineOutput = st.turbineOutput;

        ui.tempValue.textContent = `${st.temperature.toFixed(0)}°C`;
        ui.powerLoad.textContent = `${st.powerLoad.toFixed(0)} KW`;
        ui.powerOutput.textContent = `${st.powerOutput.toFixed(0)} KW`;

        for (const [statusEnum, element] of Object.entries(ui.statusLights)) {
            element.classList.toggle('active', hasStatus(st, parseInt(statusEnum)));
        }

        const isCritOutput = hasStatus(st, ReactorStatus.OutputLow) || hasStatus(st, ReactorStatus.OutputHigh);
        const isCritHeat = hasStatus(st, ReactorStatus.Overheat) || hasStatus(st, ReactorStatus.Meltdown);
        ui.criticalHeat.classList.toggle('active', isCritHeat);
        ui.criticalOutput.classList.toggle('active', isCritOutput);

        graphHistory.push({
            temp: st.temperature,
            load: st.powerLoad,
            output: st.powerOutput
        });
        if (graphHistory.length > MAX_HISTORY) graphHistory.shift();
    }

    function animateAndDraw() {
        const canvas = ui.graphCanvas;
        const ctx = graphCtx;
        canvas.width = canvas.clientWidth;
        canvas.height = canvas.clientHeight;

        ctx.clearRect(0, 0, canvas.width, canvas.height);

        if (graphHistory.length < 2) return;

        const maxTemp = DEFAULTS.MAX_TEMP;
        const maxPower = DEFAULTS.MAX_POWER_OUTPUT;

        function drawLine(dataKey, color, maxVal) {
            ctx.strokeStyle = color;
            ctx.lineWidth = 1.5;
            ctx.beginPath();
            for (let i = 0; i < graphHistory.length; i++) {
                const point = graphHistory[i];
                const x = (i / (MAX_HISTORY - 1)) * canvas.width;
                const y = canvas.height - (point[dataKey] / maxVal) * canvas.height;
                if (i === 0) ctx.moveTo(x, y);
                else ctx.lineTo(x, y);
            }
            ctx.stroke();
        }

        drawLine('temp', 'yellow', maxTemp);
        drawLine('load', 'blue', maxPower);
        drawLine('output', 'green', maxPower);
    }

    // Tooltip Logic
    ui.graphCanvas.addEventListener('mousemove', (e) => {
        const rect = ui.graphCanvas.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const index = Math.floor((x / rect.width) * graphHistory.length);

        if (index >= 0 && index < graphHistory.length) {
            const dataPoint = graphHistory[index];
            ui.graphTooltip.style.display = 'block';
            ui.graphTooltip.style.left = `${x + 10}px`;
            ui.graphTooltip.style.top = `${e.clientY - rect.top}px`;
            ui.graphTooltip.innerHTML = `
                Temp: ${dataPoint.temp.toFixed(0)}°C<br>
                Load: ${dataPoint.load.toFixed(0)} KW<br>
                Output: ${dataPoint.output.toFixed(0)} KW
            `;
        }
    });
    ui.graphCanvas.addEventListener('mouseout', () => {
        ui.graphTooltip.style.display = 'none';
    });

    // start loop & initial UI
    requestAnimationFrame(gameLoop);
});