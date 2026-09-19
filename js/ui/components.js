import { Theme } from '../theme.js';
import { PostureZone, LeanSide } from '../models.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

// MARK: - Tiny DOM helpers

export function h(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  applyAttrs(node, attrs);
  appendAll(node, children);
  return node;
}

export function svg(tag, attrs = {}, children = []) {
  const node = document.createElementNS(SVG_NS, tag);
  applyAttrs(node, attrs);
  appendAll(node, children);
  return node;
}

function applyAttrs(node, attrs) {
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') node.setAttribute('class', value);
    else if (key === 'text') node.textContent = value;
    else if (key === 'html') node.innerHTML = value;
    else if (key === 'style' && typeof value === 'object') Object.assign(node.style, value);
    else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else node.setAttribute(key, value === true ? '' : value);
  }
}

function appendAll(node, children) {
  const list = Array.isArray(children) ? children : [children];
  for (const child of list) {
    if (child === null || child === undefined || child === false) continue;
    node.append(typeof child === 'string' || typeof child === 'number' ? String(child) : child);
  }
}

/** The rounded grey panel every section on the home screen sits in. */
export function card({ title, subtitle, className = '' }, children = []) {
  const heading = title
    ? h('div', { class: 'card-heading' }, [
      h('h2', { class: 'card-title', text: title }),
      subtitle ? h('p', { class: 'card-subtitle', text: subtitle }) : null,
    ])
    : null;
  return h('section', { class: `card ${className}`.trim() }, [heading, ...children]);
}

export function icon(pathData, size = 16, extraClass = '') {
  return svg('svg', {
    viewBox: '0 0 24 24', width: size, height: size,
    'aria-hidden': 'true', class: `inline-icon ${extraClass}`.trim(),
  }, [svg('path', { fill: 'currentColor', 'fill-rule': 'evenodd', d: pathData })]);
}

export const Icons = {
  check: 'M9.6 16.6 5 12l1.4-1.4 3.2 3.2 8-8L19 7.2z',
  chevron: 'M8.8 4.4 16.4 12l-7.6 7.6-1.8-1.8L12.8 12 7 6.2z',
  person: 'M12 7a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm-5 4.5A4.5 4.5 0 0 1 11.5 7h1A4.5 4.5 0 0 1 17 11.5V23H7Z',
  signal: 'M3.3 4.7 4.7 3.3l16 16-1.4 1.4-3.6-3.6A9 9 0 0 1 12 18a9 9 0 0 1-6.4-2.6l1.4-1.4A7 7 0 0 0 12 16c.7 0 1.4-.1 2-.4l-1.6-1.6H12a3 3 0 0 1-3-3v-.4ZM12 6a9 9 0 0 1 6.4 2.6L17 10a7 7 0 0 0-8.6-1.1L6.9 7.4A9 9 0 0 1 12 6Z',
  // Outline plus a filled level bar, so it still reads as a battery at 13px.
  battery: 'M3 8h13a2.5 2.5 0 0 1 2.5 2.5v3A2.5 2.5 0 0 1 16 16H3a2.5 2.5 0 0 1-2.5-2.5v-3A2.5 2.5 0 0 1 3 8Z'
    + 'm0 1.5A1 1 0 0 0 2 10.5v3a1 1 0 0 0 1 1h13a1 1 0 0 0 1-1v-3a1 1 0 0 0-1-1Z'
    + 'M4 10.6h6.5v2.8H4Z M20 10.4h1.6v3.2H20Z',
};

// MARK: - Arc geometry
// SVG shares SwiftUI's y-down convention, so the angles carry over unchanged:
// 180 is left, 270 is straight up, 360 is right.

function pointOn(cx, cy, r, degrees) {
  const radians = (degrees * Math.PI) / 180;
  return { x: cx + r * Math.cos(radians), y: cy + r * Math.sin(radians) };
}

export function arcPath(cx, cy, r, from, to) {
  const start = pointOn(cx, cy, r, from);
  const end = pointOn(cx, cy, r, to);
  const large = Math.abs(to - from) > 180 ? 1 : 0;
  const sweep = to > from ? 1 : 0;
  return `M ${start.x.toFixed(2)} ${start.y.toFixed(2)} A ${r} ${r} 0 ${large} ${sweep} ${end.x.toFixed(2)} ${end.y.toFixed(2)}`;
}

/**
 * The inverted-U gauge over the silhouette. `angle` is degrees away from the
 * calibrated upright posture — a distance, with no direction in it.
 *
 * The knob rests at the top — upright — and travels the way you lean: right
 * along the arc for a right lean, left for a left one, with the trail drawn
 * from the top out to it. Distance from the top is how far you have leaned.
 *
 * It began as a one-directional dial reading 0 to max, which on a posture
 * device sitting beside a card called "Left or Right?" was read as a heading
 * no matter how it was labelled — first travelling left as the angle grew,
 * then rightward for both directions. Neither could be right, because the
 * number driving it had no direction in it. Now the position carries the
 * direction and the label carries the distance.
 */
const ARC_START = 180;    // left end of the arc
const ARC_CENTRE = 270;   // straight up — upright, and where the knob rests
const ARC_END = 360;      // right end

export function createPostureArc({
  width = 300, arcHeight = 92, lineWidth = 18, maxAngle = 45, showKnob = true,
} = {}) {
  const knobRadius = (lineWidth + 12) / 2;
  // The knob overshoots the top of the arc and the angle label sits above it,
  // so the canvas is taller than the arc; the round caps need room at the
  // bottom too, or the ends of the track get sliced off.
  const headroom = showKnob ? knobRadius + 16 : 0;
  const footroom = lineWidth / 2;
  const height = headroom + arcHeight + footroom;

  const cx = width / 2;
  const cy = headroom + arcHeight;
  const r = Math.min(width / 2, arcHeight) - lineWidth / 2;

  const track = svg('path', {
    d: arcPath(cx, cy, r, 180, 360),
    fill: 'none',
    'stroke-width': lineWidth,
    'stroke-linecap': 'round',
    stroke: Theme.zoneGood,
    opacity: 0.32,
  });

  // Only colour is left to CSS. Position is eased in JS below, because the
  // browser cannot be told to interpolate *along the arc*.
  const travelled = svg('path', {
    d: '', fill: 'none', 'stroke-width': lineWidth, 'stroke-linecap': 'round',
    stroke: Theme.zoneGood,
    style: { transition: 'stroke .35s linear' },
  });

  const knob = svg('circle', {
    r: knobRadius, fill: '#FFFFFF', stroke: Theme.zoneGood, 'stroke-width': 2.5,
    cx, cy: cy - r,
    style: { transition: 'stroke .35s linear' },
  });

  const label = svg('text', {
    x: cx, y: cy - r - knobRadius - 10,
    'text-anchor': 'middle', 'dominant-baseline': 'middle',
    fill: Theme.ink, 'font-size': 13, 'font-weight': 600,
  });

  const el = svg('svg', {
    class: 'gauge-arc',
    viewBox: `0 0 ${width} ${height}`,
    role: 'img',
  }, showKnob ? [track, travelled, knob, label] : [track]);

  /**
   * Position is eased here rather than by CSS.
   *
   * A CSS transition on cx and cy interpolates the two independently, which
   * walks the knob along a straight chord through the inside of the arc — it
   * visibly leaves the track on every move. The fill made it worse: WebKit
   * doesn't animate the `d` attribute, so the arc snapped to the new value
   * while the knob was still 350ms behind, and the two were permanently out of
   * step. Readings arrive every 100ms against a 350ms transition, so the knob
   * never settled at all.
   *
   * Easing one number — the angle — and recomputing the point from it every
   * frame keeps the knob exactly on the circle by construction, and keeps the
   * fill pinned to it because both are drawn from the same value.
   */
  let targetAngle = 0;
  let shownAngle = 0;
  /** Signed lean in degrees: negative is left, positive is right. */
  let targetLean = 0;
  let shownLean = 0;
  let zoneNow = PostureZone.good;
  let frame = null;

  /** Fraction of the remaining distance closed per frame. */
  const EASING = 0.22;
  /** Below this the move isn't visible, so stop rather than loop forever. */
  const SETTLED = 0.05;

  const reduceMotion = typeof matchMedia === 'function'
    && matchMedia('(prefers-reduced-motion: reduce)').matches;

  function draw() {
    // Position is the *signed* lean, so the knob sits at the top when upright
    // and travels the way you actually lean. The label and colour stay with
    // the total distance from upright, which is what "bad posture" is measured
    // on — slouching forward is just as bad with no lean in it at all.
    const offset = Math.min(Math.max(shownLean / maxAngle, -1), 1);
    const knobDegrees = ARC_CENTRE + offset * (ARC_END - ARC_CENTRE);

    track.setAttribute('stroke', zoneNow.color);
    if (!showKnob) return;

    travelled.setAttribute('stroke', zoneNow.color);
    // The trail runs from upright to wherever you are, in whichever direction.
    travelled.setAttribute('d', Math.abs(offset) > 0.02
      ? arcPath(cx, cy, r, ARC_CENTRE, knobDegrees)
      : '');

    const point = pointOn(cx, cy, r, knobDegrees);
    knob.setAttribute('cx', point.x.toFixed(2));
    knob.setAttribute('cy', point.y.toFixed(2));
    knob.setAttribute('stroke', zoneNow.color);

    // The label rides the knob, and at either end of a full sweep that would
    // hang it off the side of the canvas and clip the text.
    const margin = 30;
    label.setAttribute('x', Math.min(Math.max(point.x, margin), width - margin).toFixed(2));
    label.setAttribute('y', (point.y - knobRadius - 10).toFixed(2));
    label.textContent = `${Math.round(shownAngle)}° off`;
    el.setAttribute('aria-label', `${Math.round(shownAngle)} degrees from upright`);
  }

  function tick() {
    frame = null;
    const angleLeft = targetAngle - shownAngle;
    const leanLeft = targetLean - shownLean;
    const settled = Math.abs(angleLeft) <= SETTLED && Math.abs(leanLeft) <= SETTLED;

    if (settled) {
      shownAngle = targetAngle;
      shownLean = targetLean;
    } else {
      shownAngle += angleLeft * EASING;
      shownLean += leanLeft * EASING;
      frame = requestAnimationFrame(tick);
    }
    draw();
  }

  /**
   * @param {number} angle How far from upright, always positive.
   * @param {object} zone Which posture band that falls in.
   * @param {number} lean Signed roll: negative leans left, positive right.
   */
  function update(angle, zone, lean = 0) {
    targetAngle = Number.isFinite(angle) ? angle : 0;
    targetLean = Number.isFinite(lean) ? lean : 0;
    zoneNow = zone;

    if (reduceMotion || !showKnob) {
      shownAngle = targetAngle;
      shownLean = targetLean;
      draw();
      return;
    }
    if (frame === null) frame = requestAnimationFrame(tick);
  }

  shownAngle = 0;
  shownLean = 0;
  draw();
  return { el, update };
}

/** The grey seated figure the gauge arcs over. */
export function silhouette(size = 74) {
  const head = size * 0.42;
  const gap = size * 0.06;
  return svg('svg', {
    viewBox: `0 0 ${size} ${size}`, width: size, height: size,
    class: 'gauge-figure', 'aria-hidden': 'true',
  }, [
    svg('circle', { cx: size / 2, cy: head / 2, r: head / 2, fill: Theme.silhouette }),
    svg('rect', {
      x: 0, y: head + gap, width: size, height: size - head - gap,
      rx: size * 0.14, fill: Theme.silhouette,
    }),
  ]);
}

/**
 * The arch in the "Left or Right?" card.
 *
 * One soft band rather than two coloured halves — an elliptical annulus with
 * the four foot corners rounded, the inner pair more heavily than the outer,
 * which is what gives the shape its melted look. Which way the wearer leans is
 * carried by the labels; the percentages sit underneath.
 */
export function leanArc(bias, width = 300, height = 76) {
  const hasData = bias.sampleCount > 0;

  const cx = width / 2;
  const baseY = 68;        // where the feet stand
  const outerRx = 72;
  const outerRy = 56;
  const thickness = 25;
  const cornerOuter = 5;   // rounding on the outside of each foot
  const cornerInner = 10;  // …and on the inside, where it melts more

  // Both arches stop short of the baseline by their corner radius; the corners
  // bridge the gap.
  const outerY = baseY - cornerOuter;
  const innerY = baseY - cornerInner;
  const innerRx = outerRx - thickness;
  // Sized so the band is `thickness` deep at the crown as well as at the feet.
  const innerRy = innerY - (outerY - outerRy + thickness);

  const outerL = cx - outerRx;
  const outerR = cx + outerRx;
  const innerL = cx - innerRx;
  const innerR = cx + innerRx;

  const band = svg('path', {
    d: [
      `M ${outerL} ${outerY}`,
      `A ${cornerOuter} ${cornerOuter} 0 0 0 ${outerL + cornerOuter} ${baseY}`,
      `L ${innerL - cornerInner} ${baseY}`,
      `A ${cornerInner} ${cornerInner} 0 0 0 ${innerL} ${innerY}`,
      `A ${innerRx} ${innerRy} 0 0 1 ${innerR} ${innerY}`,
      `A ${cornerInner} ${cornerInner} 0 0 0 ${innerR + cornerInner} ${baseY}`,
      `L ${outerR - cornerOuter} ${baseY}`,
      `A ${cornerOuter} ${cornerOuter} 0 0 0 ${outerR} ${outerY}`,
      `A ${outerRx} ${outerRy} 0 0 0 ${outerL} ${outerY}`,
      'Z',
    ].join(' '),
    fill: hasData ? Theme.greenPale : Theme.track,
    opacity: hasData ? 1 : 0.35,
  });

  const caption = (side, x, text) => svg('text', {
    x,
    y: 37,
    'text-anchor': 'middle',
    'dominant-baseline': 'middle',
    fill: hasData && bias.dominant === side ? Theme.green : Theme.inkMuted,
    'font-size': 13.5,
    'font-weight': 700,
  }, [text]);

  return svg('svg', {
    class: 'lean-arc', viewBox: `0 0 ${width} ${height}`, 'aria-hidden': 'true',
  }, [
    band,
    caption(LeanSide.left, cx - 42, 'Left'),
    caption(LeanSide.right, cx + 42, 'Right'),
  ]);
}

/**
 * Progress line chart. Drawn by hand rather than pulled from a charting
 * library so the site stays dependency-free and works offline.
 */
export function angleChart(days, { maxAngle = 40, width = 300, height = 96, intraday = false } = {}) {
  const bands = [PostureZone.bad, PostureZone.poor, PostureZone.fair, PostureZone.good];

  const grid = [];
  for (let index = 0; index <= bands.length; index += 1) {
    const y = (height * index) / bands.length;
    grid.push(svg('line', {
      x1: 0, x2: width, y1: y, y2: y, stroke: Theme.hairline, 'stroke-width': 1,
    }));
  }

  const points = [];
  if (days.length > 1) {
    // Inset by the dot radius so the first and last markers aren't sliced in
    // half by the edge of the plot.
    const inset = 4;
    const stepX = (width - inset * 2) / (days.length - 1);
    days.forEach((day, index) => {
      if (!day.hasData) return;
      const clamped = Math.min(day.averageAngle, maxAngle);
      points.push({ x: inset + index * stepX, y: height - (clamped / maxAngle) * height });
    });
  }

  const line = points.length >= 2
    ? svg('polyline', {
      points: points.map((point) => `${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(' '),
      fill: 'none', stroke: Theme.green, 'stroke-width': 2,
      'stroke-linecap': 'round', 'stroke-linejoin': 'round',
    })
    : null;

  // A day's worth of buckets is far too many markers to read; past this the
  // line alone carries the shape.
  const dots = points.length > 24 ? [] : points.map((point) => svg('circle', {
    cx: point.x.toFixed(1), cy: point.y.toFixed(1), r: 3, fill: Theme.green,
  }));

  const plot = h('div', { class: 'chart-plot' }, [
    svg('svg', {
      viewBox: `0 0 ${width} ${height}`, role: 'img',
      'aria-label': intraday
        ? 'Posture angle through the day'
        : 'Average posture angle per day',
    }, [...grid, line, ...dots]),
  ]);

  const bandLabels = h('div', { class: 'chart-bands', 'aria-hidden': 'true' },
    bands.map((band) => h('div', { class: 'chart-band', text: band.bandLabel })));

  return h('div', {}, [
    h('div', { class: 'chart' }, [plot, bandLabels]),
    h('div', { class: 'chart-axis' }, xLabels(days, intraday).map((text) => h('span', { text }))),
  ]);
}

function xLabels(days, intraday = false) {
  if (days.length === 0) return [];
  const first = days[0].day;
  const last = days[days.length - 1].day;

  // Buckets within one day get a clock, not a calendar.
  if (intraday) {
    const clock = (date) => date.toLocaleTimeString(undefined, { hour: 'numeric' });
    return [clock(first), clock(days[Math.floor(days.length / 2)].day), clock(last)];
  }

  if (days.length > 20) {
    const months = [];
    for (const day of days) {
      const name = day.day.toLocaleDateString(undefined, { month: 'short' }).toUpperCase();
      if (!months.includes(name)) months.push(name);
    }
    // Straddles a month boundary — label the months, as in the design.
    if (months.length > 1) return months;
  }

  const format = days.length <= 7
    ? (date) => date.toLocaleDateString(undefined, { weekday: 'short' })
    : (date) => date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

  const middle = days[Math.floor(days.length / 2)].day;
  return [format(first), format(middle), format(last)];
}

/** The capsule selector used for Battery and Buzz Adjustment in Settings. */
export function segmentedPill({
  options,
  label,
  selection,
  onSelect = null,
  trackColor = '#FFFFFF',
  knobColor = Theme.greenSoft,
  selectedTextColor = Theme.green,
  textColor = Theme.inkMuted,
  ariaLabel,
}) {
  const slot = 100 / Math.max(options.length, 1);
  const index = options.indexOf(selection);

  const knob = h('div', {
    class: 'segmented-knob',
    style: {
      width: `${slot}%`,
      background: knobColor,
      transform: `translateX(${index * 100}%)`,
      display: index < 0 ? 'none' : 'block',
    },
  });

  const buttons = options.map((option) => h('button', {
    type: 'button',
    class: 'segmented-option',
    disabled: onSelect === null,
    'aria-pressed': onSelect ? String(option === selection) : null,
    style: { color: option === selection ? selectedTextColor : textColor },
    text: label(option),
    onClick: onSelect ? () => onSelect(option) : null,
  }));

  return h('div', {
    class: `segmented ${onSelect ? '' : 'segmented--readonly'}`.trim(),
    style: { background: trackColor },
    role: 'group',
    'aria-label': ariaLabel,
  }, [knob, ...buttons]);
}
