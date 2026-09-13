import { h, createPostureArc, silhouette, icon, Icons } from './components.js';
import { openSheet } from './sheet.js';
import { ALIGNProtocol } from '../protocol.js';

/** Seconds of readings averaged into the baseline. */
const MEASURE_SECONDS = 3;

/**
 * Records the user's upright posture, which every later reading is measured
 * against.
 */
export function openCalibration({ device, posture }) {
  let phase = { name: 'intro' };
  let samples = [];
  let timer = null;
  let problem = '';

  const arc = createPostureArc({ width: 130, arcHeight: 62, lineWidth: 14, showKnob: false });
  const overlay = h('div', { class: 'calibration-overlay' });

  const stage = h('div', { class: 'calibration-stage' }, [
    h('div', { class: 'calibration-stage-art' }, [arc.el, silhouette(60)]),
    overlay,
  ]);
  stage.querySelector('.gauge-arc').style.width = '130px';

  const title = h('h3', { class: 'calibration-title' });
  const detail = h('p', { class: 'calibration-detail' });
  const status = h('p', { class: 'calibration-status' });

  const button = h('button', {
    type: 'button', class: 'pill-button pill-button--wide', onClick: primaryAction,
  });

  const body = h('div', {
    style: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '20px', width: '100%' },
  }, [
    stage,
    h('div', { class: 'calibration-copy' }, [title, detail]),
    h('div', { class: 'stage-actions' }, [button]),
    status,
  ]);

  let unsubscribe = () => {};

  const sheet = openSheet({
    title: 'Calibration',
    closeLabel: 'Close',
    centered: true,
    body,
    onClose: () => {
      clearInterval(timer);
      unsubscribe();
    },
  });

  unsubscribe = device.subscribe(render);

  function render() {
    overlay.replaceChildren();
    if (phase.name === 'counting') overlay.textContent = String(phase.value);
    if (phase.name === 'done') overlay.append(icon(Icons.check, 62));

    title.textContent = {
      intro: 'Sit up straight',
      counting: 'Hold still',
      measuring: 'Measuring…',
      done: "You're calibrated",
    }[phase.name];

    detail.textContent = {
      intro: 'Wear ALIGN, sit or stand in your best upright posture, then start. This becomes the baseline for your back.',
      counting: 'Keep your back in its upright position.',
      measuring: 'Averaging your upright angle.',
      done: 'Every angle from now on is measured against this posture. Recalibrate any time from Settings.',
    }[phase.name];

    button.textContent = {
      intro: 'Start Calibration',
      counting: 'Measuring…',
      measuring: 'Measuring…',
      done: 'Done',
    }[phase.name];

    const canStart = phase.name === 'intro' ? device.isUsable : phase.name === 'done';
    button.disabled = !canStart;

    // Say what went wrong, rather than dropping silently back to the start.
    if (!device.isUsable) status.textContent = device.label;
    else status.textContent = problem;
  }

  function primaryAction() {
    if (phase.name === 'intro') beginCountdown();
    else if (phase.name === 'done') finishAndClose();
  }

  function beginCountdown() {
    samples = [];
    problem = '';
    let remaining = 3;
    phase = { name: 'counting', value: remaining };
    render();

    clearInterval(timer);
    timer = setInterval(() => {
      remaining -= 1;
      if (remaining > 0) {
        phase = { name: 'counting', value: remaining };
        render();
      } else {
        clearInterval(timer);
        measure();
      }
    }, 1000);
  }

  function measure() {
    phase = { name: 'measuring' };
    samples = [];
    render();

    let elapsed = 0;
    clearInterval(timer);
    timer = setInterval(() => {
      elapsed += 0.2;
      if (device.latest) samples.push(device.latest);
      if (elapsed < MEASURE_SECONDS) return;
      clearInterval(timer);
      finish();
    }, 200);
  }

  function finish() {
    if (samples.length === 0) {
      // Connected, but nothing arrived in the measuring window — the baseline
      // would be meaningless, so don't record one.
      problem = device.isDemo
        ? 'No readings came through. Try again.'
        : `No readings arrived from ${device.deviceName ?? 'the device'} during those 3 seconds. `
          + 'Check it is still powered and connected, then try again.';
      phase = { name: 'intro' };
      render();
      return;
    }

    const pitch = samples.reduce((total, reading) => total + reading.pitch, 0) / samples.length;
    const roll = samples.reduce((total, reading) => total + reading.roll, 0) / samples.length;

    posture.calibrate({ pitch, roll, battery: device.battery, timestamp: new Date() });
    device.send(ALIGNProtocol.Command.calibrate);
    device.send(ALIGNProtocol.Command.testBuzz);

    phase = { name: 'done' };
    render();
  }

  function finishAndClose() {
    sheet.close(); // onClose stops the timer and the device subscription
  }

  render();
}
