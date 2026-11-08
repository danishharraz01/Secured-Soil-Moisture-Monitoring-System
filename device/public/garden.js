// Virtual Garden - live view of the simulated sensor node.
// State arrives over Server-Sent Events; all text is set with textContent (no innerHTML).
'use strict';

(() => {
  const $ = (id) => document.getElementById(id);
  const scene = $('scene');
  const slider = $('moisture-slider');
  const logEl = $('log');

  const MAX_MM = 50;
  const SOIL_BOTTOM = 402; // y of the soil bottom in the SVG
  const SOIL_RANGE = 120; // 0 -> 50 mm maps to 120 px of soil height
  const MAX_LOG = 150;

  let dragging = false;

  const clamp = (v) => Math.max(0, Math.min(MAX_MM, v));
  const yFor = (mm) => SOIL_BOTTOM - (clamp(mm) / MAX_MM) * SOIL_RANGE;
  const pct = (mm) => `${(clamp(mm) / MAX_MM) * 100}%`;

  // ---------------------------------------------------------------- render --
  function render(s) {
    $('device-id').textContent = `${s.deviceId} · simulated NodeMCU sensor node`;

    // Clock + day/night
    const t = new Date(s.simTime);
    $('sim-time').textContent = t.toLocaleString(undefined, {
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
    const dayNight = $('day-night');
    dayNight.textContent = s.daytime ? 'Day' : 'Night';
    dayNight.classList.toggle('night', !s.daytime);
    scene.classList.toggle('night', !s.daytime);

    // Link status
    const pill = $('link-pill');
    const link = {
      online: ['Server connected', 'ok', 'online'],
      connecting: ['Connecting…', '', 'connecting'],
      retrying: ['Server unreachable · retrying', 'warn', 'retrying'],
      disconnected: ['Wi-Fi off (simulated)', 'bad', 'offline'],
    }[s.link];
    pill.textContent = link[0];
    pill.className = `pill ${link[1]}`;
    pill.title = s.lastError ?? '';
    $('mcu-status').textContent = link[2];
    scene.classList.toggle('offline', s.link === 'disconnected');
    scene.classList.toggle('link-warn', s.link === 'retrying');

    // Moisture: probe bubble, soil water level, meter
    const mm = s.moistureMm;
    $('probe-text').textContent = `${mm.toFixed(1)} mm`;
    $('stat-moisture').textContent = mm.toFixed(1);
    const water = $('water-level');
    water.setAttribute('y', String(yFor(mm)));
    water.setAttribute('height', String(SOIL_BOTTOM - yFor(mm)));
    $('meter-fill').style.width = pct(mm);
    $('meter-low').style.left = pct(s.low);
    $('meter-high').style.left = pct(s.high);
    $('plant').classList.toggle('dry', mm < s.low);

    // Threshold lines (pump ON at <= low, OFF at >= high)
    for (const [line, label, value, text] of [
      ['line-low', 'label-low', s.low, `ON ≤ ${s.low} mm`],
      ['line-high', 'label-high', s.high, `OFF ≥ ${s.high} mm`],
    ]) {
      const y = yFor(value);
      $(line).setAttribute('y1', String(y));
      $(line).setAttribute('y2', String(y));
      $(label).setAttribute('y', String(y + 4));
      $(label).textContent = text;
    }
    $('stat-thresholds').textContent = `ON ≤ ${s.low} · OFF ≥ ${s.high} mm`;
    const src = $('stat-thr-src');
    src.textContent = s.thresholdsSource === 'server' ? 'signed by server' : 'default';
    src.className = s.thresholdsSource === 'server' ? 'tag ok' : 'tag';

    // Relay + pump
    scene.classList.toggle('pump-on', s.pumpOn);
    $('relay-state').textContent = s.pumpOn ? 'ON' : 'OFF';
    const pump = $('stat-pump');
    pump.textContent = s.pumpOn ? 'Watering' : 'Off';
    pump.className = s.pumpOn ? 'watering' : '';

    // PIR + LED
    scene.classList.toggle('motion', s.ledOn);
    const led = $('stat-led');
    led.textContent = s.ledOn ? 'Red · motion!' : 'Off';
    led.className = s.ledOn ? 'alert-text' : '';

    $('stat-water').textContent = `${s.waterTodayMl.toLocaleString()} ml`;
    $('stat-queue').textContent = String(s.queueLength);
    $('stat-counts').textContent = String(s.stats.sent);
    $('stat-errors').textContent = `${s.stats.rejected} · ${s.stats.failed}`;

    // Controls reflect the device state
    if (!dragging) {
      slider.value = String(mm);
      $('slider-out').textContent = `${mm.toFixed(1)} mm`;
    }
    $('toggle-disconnect').checked = s.link === 'disconnected';
    for (const btn of document.querySelectorAll('[data-speed]')) {
      btn.setAttribute('aria-pressed', String(btn.dataset.speed === s.speed));
    }
  }

  // ------------------------------------------------------------- event log --
  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function addLog(entry) {
    const li = el('li', `log-item ${entry.level} kind-${entry.kind}`);
    const time = new Date(entry.at).toLocaleTimeString(undefined, { hour12: false });
    li.append(el('span', 'log-time', time), el('span', 'log-kind', entry.kind));

    const body = el('div', 'log-body');
    body.append(el('span', 'log-msg', entry.message));
    if (entry.checks) {
      const c = entry.checks;
      const chips = el('span', 'checks');
      chips.append(
        el('span', 'check-chip', 'encrypted ✓'),
        el('span', 'check-chip', 'signed ✓'),
        el('span', `check-chip ${c.ok ? '' : 'bad'}`, `server ${c.server} ${c.ok ? '✓' : '✗'}`),
      );
      body.append(chips);
    }
    if (entry.detail) body.append(el('span', 'log-detail', entry.detail));
    li.append(body);

    logEl.prepend(li);
    while (logEl.children.length > MAX_LOG) logEl.lastElementChild.remove();
  }

  // ---------------------------------------------------------------- controls --
  async function control(path, body) {
    const errorEl = $('control-error');
    errorEl.textContent = '';
    try {
      const res = await fetch(`/api/control/${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        errorEl.textContent = data.error || `Request failed (${res.status})`;
      }
    } catch {
      errorEl.textContent = 'Device page is not reachable';
    }
  }

  slider.addEventListener('pointerdown', () => (dragging = true));
  slider.addEventListener('input', () => {
    dragging = true;
    $('slider-out').textContent = `${Number(slider.value).toFixed(1)} mm`;
  });
  slider.addEventListener('change', () => {
    dragging = false;
    void control('moisture', { value: Number(slider.value) });
  });
  $('btn-motion').addEventListener('click', () => void control('motion', {}));
  $('toggle-disconnect').addEventListener(
    'change',
    (e) => void control('disconnect', { enabled: e.target.checked }),
  );
  for (const btn of document.querySelectorAll('[data-speed]')) {
    btn.addEventListener('click', () => void control('speed', { speed: btn.dataset.speed }));
  }
  $('hide-readings').addEventListener('change', (e) =>
    logEl.classList.toggle('hide-readings', e.target.checked),
  );

  // ------------------------------------------------------------- live data --
  const events = new EventSource('/events');
  events.addEventListener('snapshot', (e) => {
    const data = JSON.parse(e.data);
    logEl.replaceChildren();
    for (const entry of data.log) addLog(entry);
    render(data.state);
  });
  events.addEventListener('state', (e) => render(JSON.parse(e.data)));
  events.addEventListener('log', (e) => addLog(JSON.parse(e.data)));
  events.addEventListener('error', () => {
    const pill = $('link-pill');
    pill.textContent = 'Device stopped';
    pill.className = 'pill bad';
  });
})();
