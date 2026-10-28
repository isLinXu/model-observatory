/* Model Observatory — chart primitives.
 * Each function renders a self-contained responsive SVG into a container.
 * Colours come from CSS custom properties (see style.css) so every chart
 * follows the active theme, light or dark, without re-rendering.
 */
window.MO = window.MO || {};

MO.charts = (() => {
  'use strict';

  const { esc, fmt, compact, countCN, dayLabel } = MO.format;

  const PALETTE = ['var(--chart-1)', 'var(--chart-2)', 'var(--chart-3)', 'var(--chart-4)', 'var(--chart-5)'];
  const colorAt = index => PALETTE[index % PALETTE.length];

  function empty(node, message) {
    node.innerHTML = `<div class="chart-empty">${esc(message)}</div>`;
  }

  /**
   * Multi-series line chart with SVG title tooltips.
   * opts: { label, area, includeZero, yFormatter, xLabels }
   */
  function line(node, series, opts = {}) {
    const entries = series.filter(item => item.points && item.points.length);
    if (!entries.length) {
      empty(node, opts.emptyText || '尚无可绘制的历史快照。首次采集后开始积累数据。');
      return;
    }
    const W = 840, H = 280, left = 83, right = 23, top = 19, bottom = 41;
    const plotW = W - left - right, plotH = H - top - bottom;
    const days = [...new Set(entries.flatMap(item => item.points.map(point => point.date)))].sort();
    const allValues = entries.flatMap(item => item.points.map(point => point.value));
    const lo = Math.min(...allValues), hi = Math.max(...allValues);
    const pad = Math.max(1, (hi - lo) * 0.14, Math.abs(hi) * 0.025);
    const ymin = opts.includeZero ? Math.min(0, lo) : Math.max(0, lo - pad);
    const ymax = hi + pad;
    const denom = ymax - ymin || 1;
    const xOf = day => left + (days.length === 1 ? plotW / 2 : plotW * days.indexOf(day) / (days.length - 1));
    const yOf = value => top + plotH * (1 - (value - ymin) / denom);
    const yFormat = opts.yFormatter || compact;

    const grids = Array.from({ length: 5 }, (_, index) => {
      const value = ymin + (ymax - ymin) * index / 4;
      const y = yOf(value);
      return `<line class="svg-grid" x1="${left}" y1="${y}" x2="${W - right}" y2="${y}"/>` +
        `<text class="svg-axis" x="${left - 12}" y="${y + 4}" text-anchor="end">${esc(yFormat(value))}</text>`;
    }).join('');

    const xIndexes = days.length === 1
      ? [0]
      : [...new Set([0, Math.floor((days.length - 1) / 3), Math.floor(2 * (days.length - 1) / 3), days.length - 1])];
    const labels = xIndexes.map(index =>
      `<text class="svg-label" x="${xOf(days[index])}" y="${H - 11}" text-anchor="middle">${esc(dayLabel(days[index]))}</text>`
    ).join('');

    // Generate unique gradient IDs for area fills
    const gradientId = `grad-${Math.random().toString(36).slice(2, 9)}`;

    const seriesSvg = entries.map((item, index) => {
      const color = item.color || colorAt(index);
      const points = item.points.map(point => [xOf(point.date), yOf(point.value)]);

      // Create smooth cubic bezier path
      let path = '';
      if (points.length > 1) {
        path = `M ${points[0][0]},${points[0][1]}`;
        for (let i = 1; i < points.length; i++) {
          const prev = points[i - 1];
          const curr = points[i];
          const dx = (curr[0] - prev[0]) / 3;
          path += ` C ${prev[0] + dx},${prev[1]} ${curr[0] - dx},${curr[1]} ${curr[0]},${curr[1]}`;
        }
      }

      const name = esc(item.name);
      let area = '';
      if (opts.area && index === 0 && points.length > 1) {
        // Create gradient definition for this series
        const gradientDef = `<defs><linearGradient id="${gradientId}" x1="0%" y1="0%" x2="0%" y2="100%">
          <stop offset="0%" style="stop-color:${color};stop-opacity:0.25"/>
          <stop offset="100%" style="stop-color:${color};stop-opacity:0.02"/>
        </linearGradient></defs>`;

        // Smooth area path
        let areaPath = `M ${points[0][0]},${top + plotH} L ${points[0][0]},${points[0][1]}`;
        for (let i = 1; i < points.length; i++) {
          const prev = points[i - 1];
          const curr = points[i];
          const dx = (curr[0] - prev[0]) / 3;
          areaPath += ` C ${prev[0] + dx},${prev[1]} ${curr[0] - dx},${curr[1]} ${curr[0]},${curr[1]}`;
        }
        areaPath += ` L ${points.at(-1)[0]},${top + plotH} Z`;
        area = `${gradientDef}<path d="${areaPath}" fill="url(#${gradientId})"/>`;
      }

      const dots = points.length < 20
        ? points.map(([x, y], position) =>
          `<circle class="svg-dot" cx="${x}" cy="${y}" r="3.5" fill="${color}"><title>${name} · ${esc(item.points[position].date)} · ${esc(fmt(item.points[position].value))}</title></circle>`
        ).join('')
        : '';
      const hover = item.points.map((point, position) =>
        `<circle cx="${points[position][0]}" cy="${points[position][1]}" r="11" fill="transparent"><title>${name} · ${esc(point.date)} · ${esc(fmt(point.value))}</title></circle>`
      ).join('');
      return `${area}<path fill="none" stroke="${color}" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round" d="${path}"/>${dots}${hover}`;
    }).join('');

    node.innerHTML = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="${esc(opts.label || '趋势图')}">${grids}${seriesSvg}${labels}</svg>`;
  }

  /** Bar chart of the change between two adjacent snapshots. */
  function delta(node, points, opts = {}) {
    if (!points || points.length < 1) {
      empty(node, opts.emptyText || '至少需要两天的快照，才能计算相邻快照的净变化。');
      return;
    }
    const W = 840, H = 170, left = 75, right = 20, top = 15, bottom = 30;
    const plotW = W - left - right, plotH = H - top - bottom;
    const values = points.map(point => point.value).filter(Number.isFinite);
    if (!values.length) {
      empty(node, '暂无可比较的有效累计字段。');
      return;
    }
    const min = Math.min(0, ...values), max = Math.max(0, ...values);
    const ymin = min * 1.14 || -1, ymax = max * 1.14 || 1;
    const yOf = value => top + plotH * (ymax - value) / (ymax - ymin);
    const gap = plotW / points.length, barW = Math.min(gap * 0.56, 35);
    const bars = points.map((point, index) => {
      if (point.value === null) return '';
      const x = left + gap * index + (gap - barW) / 2;
      const yValue = yOf(point.value), yZero = yOf(0);
      const isNeg = point.value < 0;
      const color = isNeg ? 'var(--chart-neg)' : 'var(--chart-pos)';
      const barTop = Math.min(yValue, yZero);
      const barHeight = Math.max(2, Math.abs(yValue - yZero));
      // Rounded rect: only round the outer edge (top for positive, bottom for negative)
      const r = Math.min(4, barW / 2, barHeight / 2);
      let rectPath;
      if (isNeg) {
        rectPath = `M${x},${barTop} h${barW} v${barHeight - r} q0,${r} ${-r},${r} h${-(barW - 2 * r)} q${-r},0 ${-r},${-r} v${-(barHeight - r)} Z`;
      } else {
        rectPath = `M${x},${barTop + r} q0,${-r} ${r},${-r} h${barW - 2 * r} q${r},0 ${r},${r} v${barHeight - r} h${-barW} Z`;
      }
      return `<path d="${rectPath}" fill="${color}" opacity=".85">` +
        `<title>${esc(point.previous)} → ${esc(point.date)} : ${esc(fmt(point.value))}${point.revised ? `；${point.revised} 个模型累计值下降` : ''}</title></path>` +
        `<text class="svg-label" x="${x + barW / 2}" y="${H - 8}" text-anchor="middle">${esc(dayLabel(point.date))}</text>`;
    }).join('');
    const axis = `<line class="svg-zero" x1="${left}" y1="${yOf(0)}" x2="${W - right}" y2="${yOf(0)}"/>` +
      [min, max].map(value => `<text class="svg-axis" x="${left - 9}" y="${yOf(value) + 3}" text-anchor="end">${esc(compact(value))}</text>`).join('');
    node.innerHTML = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="相邻快照净增量柱状图">${axis}${bars}</svg>`;
  }

  /** Bar chart of citations grouped by publication year. */
  function yearBars(node, rows, opts = {}) {
    if (!rows || !rows.length) {
      empty(node, opts.emptyText || '暂无逐年引用数据。');
      return;
    }
    const W = 840, H = 273, left = 68, right = 20, top = 26, bottom = 38;
    const plotW = W - left - right, plotH = H - top - bottom;
    const max = Math.max(...rows.map(row => row.citations || 0), 1);
    const gap = plotW / rows.length, barW = Math.min(gap * 0.46, 62);
    const gradientId = `ybar-${Math.random().toString(36).slice(2, 9)}`;
    const grid = [0, 0.5, 1].map(fraction => {
      const y = top + plotH * (1 - fraction);
      return `<line class="svg-grid" x1="${left}" y1="${y}" x2="${W - right}" y2="${y}"/>` +
        `<text class="svg-axis" x="${left - 10}" y="${y + 4}" text-anchor="end">${esc(compact(max * fraction))}</text>`;
    }).join('');
    const defs = `<defs><linearGradient id="${gradientId}" x1="0%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%" style="stop-color:var(--chart-1);stop-opacity:0.95"/>
      <stop offset="100%" style="stop-color:var(--chart-1);stop-opacity:0.65"/>
    </linearGradient></defs>`;
    const bars = rows.map((row, index) => {
      const height = Math.max(3, plotH * ((row.citations || 0) / max));
      const x = left + gap * index + (gap - barW) / 2, y = top + plotH - height;
      const r = Math.min(4, barW / 2, height / 2);
      const barPath = `M${x},${y + r} q0,${-r} ${r},${-r} h${barW - 2 * r} q${r},0 ${r},${r} v${height - r} h${-barW} Z`;
      return `<path d="${barPath}" fill="url(#${gradientId})">` +
        `<title>${esc(row.year)} 年 · ${esc(fmt(row.citations))} 次引用</title></path>` +
        `<text class="svg-label" x="${x + barW / 2}" y="${y - 8}" text-anchor="middle">${esc(compact(row.citations))}</text>` +
        `<text class="svg-label" x="${x + barW / 2}" y="${H - 14}" text-anchor="middle">${esc(row.year)}</text>`;
    }).join('');
    node.innerHTML = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="逐年引用量柱状图">${defs}${grid}${bars}</svg>`;
  }

  /**
   * Horizontal ranking bars, used for the repository language board.
   * rows: [{ label, value, color, note }]
   */
  function ranking(node, rows, opts = {}) {
    if (!rows || !rows.length) {
      empty(node, opts.emptyText || '暂无粉丝数据。');
      return;
    }
    const max = Math.max(...rows.map(row => Number(row.value) || 0), 1);
    const total = rows.reduce((sum, row) => sum + (Number(row.value) || 0), 0);
    node.innerHTML = rows.map((row, index) => {
      const value = Number(row.value) || 0;
      const share = total ? (value / total * 100) : 0;
      const barColor = row.color || colorAt(index);
      return `<div class="rank-item">` +
        `<span class="rank-index">${String(index + 1).padStart(2, '0')}</span>` +
        `<div class="rank-body">` +
        `<div class="rank-head"><span class="rank-name" title="${esc(row.label)}">${esc(row.label)}</span>` +
        `<span class="rank-share">${esc(share.toFixed(1))}%</span></div>` +
        `<div class="rank-progress"><span style="width:${(value / max * 100).toFixed(1)}%;background:linear-gradient(90deg, ${barColor}, color-mix(in srgb, ${barColor} 70%, white))"></span></div>` +
        (row.note ? `<div class="rank-note">${esc(row.note)}</div>` : '') +
        `</div>` +
        `<span class="rank-number" title="${esc(fmt(value))}">${esc(countCN(value))}</span>` +
        `</div>`;
    }).join('');
  }

  return { line, delta, yearBars, ranking, colorAt, PALETTE };
})();
