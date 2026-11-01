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

  /**
   * Colour for cluster index `index` out of `total` clusters. The five themed
   * variables cover the first clusters; the rest get an even hue spread so
   * neighbouring wall blocks stay distinguishable in both themes.
   */
  function starColor(index, total) {
    if (index < PALETTE.length) return PALETTE[index];
    const span = Math.max(1, total - PALETTE.length);
    return `hsl(${Math.round((index - PALETTE.length) * 360 / span)}, 58%, 55%)`;
  }

  /**
   * Star wall: one cell per starred repository, laid out row-major so the whole
   * list stays one dense grid. Clusters are contiguous runs, so their colour is
   * the boundary marker; only geometry is emitted and the hover readout resolves
   * the cell from `data-i`, which keeps thousands of cells cheap.
   */
  function starWall(node, model, opts = {}) {
    if (!model || !model.groups || !model.groups.length) {
      empty(node, opts.emptyText || '等待 star 明细：滚动到本节会自动读取，也可以手动重试。');
      return;
    }
    const pitch = 15;
    // 'all' means no cluster is selected, so nothing may be dimmed.
    const active = opts.activeCluster && opts.activeCluster !== 'all' ? opts.activeCluster : null;
    const cols = Math.max(12, Math.min(140, Math.ceil(Math.sqrt(model.total * 2.8))));
    const rows = Math.ceil(model.total / cols);
    const groups = model.groups.map((group, index) => {
      const cells = model.cells.slice(group.start, group.start + group.count).map((cell, position) => {
        const i = group.start + position;
        const size = 9 + Math.min(4, Math.round(Math.log10(1 + (cell.stars || 0)) * 1.5));
        const x = (i % cols) * pitch + (pitch - size) / 2;
        const y = Math.floor(i / cols) * pitch + (pitch - size) / 2;
        return `<rect data-i="${i}" x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${size}" height="${size}"/>`;
      }).join('');
      return `<g fill="${starColor(index, model.groups.length)}" data-cluster="${esc(group.id)}"` +
        `${active && active !== group.id ? ' opacity=".22"' : ''}>` +
        `${cells}<title>${esc(group.label)} · ${esc(fmt(group.count))} 个仓库</title></g>`;
    }).join('');
    node.innerHTML = `<svg class="star-wall" viewBox="0 0 ${cols * pitch} ${rows * pitch}" role="img" ` +
      `aria-label="${esc(opts.label || 'star 星星墙：每个格子是一个 star 的仓库')}">${groups}</svg>`;
  }

  /**
   * Cluster relation graph on concentric rings: languages innermost, then topics,
   * then owners. Edges are the co-occurrence weights the collector published.
   */
  function starGraph(node, graph, opts = {}) {
    const nodes = graph && graph.nodes;
    if (!nodes || !nodes.length) {
      empty(node, opts.emptyText || '等待 star 快照中的聚类节点。');
      return;
    }
    const W = 840, H = 440, cx = W / 2, cy = H / 2 + 6;
    const ringOf = { language: 74, topic: 146, owner: 196 };
    const maxRepos = Math.max(...nodes.map(item => item.repos || 0), 1);
    const radius = node => 5 + Math.sqrt((node.repos || 0) / maxRepos) * 17;
    // Published rank order is by repository count, so the colour index stays
    // stable for a snapshot and matches the legend chips one for one.
    const rankOf = new Map(nodes.map((node, index) => [node.id, index]));
    const placed = new Map();
    ['language', 'topic', 'owner'].forEach(type => {
      const ring = nodes.filter(node => node.type === type);
      if (!ring.length) return;
      const r = ringOf[type] ?? 146;
      ring.forEach((node, index) => {
        const angle = (index / ring.length) * Math.PI * 2 - Math.PI / 2;
        placed.set(node.id, { ...node, x: cx + r * Math.cos(angle), y: cy + r * Math.sin(angle), r: radius(node) });
      });
    });
    const maxWeight = Math.max(...(graph.edges || []).map(edge => edge.w || 0), 1);
    const edges = (graph.edges || []).map(edge => {
      const a = placed.get(edge.a), b = placed.get(edge.b);
      if (!a || !b) return '';
      const strength = (edge.w || 0) / maxWeight;
      return `<line class="star-edge" x1="${a.x.toFixed(1)}" y1="${a.y.toFixed(1)}" x2="${b.x.toFixed(1)}" y2="${b.y.toFixed(1)}" ` +
        `stroke-width="${(0.5 + strength * 2.6).toFixed(2)}" opacity="${(0.14 + strength * 0.42).toFixed(2)}">` +
        `<title>${esc(a.label)} ↔ ${esc(b.label)} · ${esc(fmt(edge.w))} 个共同仓库</title></line>`;
    }).join('');
    const circles = [...placed.values()].map(node =>
      `<circle class="star-node" data-cluster="${esc(node.id)}" cx="${node.x.toFixed(1)}" cy="${node.y.toFixed(1)}" ` +
      `r="${node.r.toFixed(1)}" fill="${starColor(rankOf.get(node.id) || 0, nodes.length)}">` +
      `<title>${esc(node.label)} · ${esc(node.type)} · ${esc(fmt(node.repos))} 个归属 / ${esc(fmt(node.appears))} 次出现</title></circle>` +
      (node.repos / maxRepos > 0.16
        ? `<text class="svg-label star-node-label" x="${node.x.toFixed(1)}" y="${(node.y - node.r - 5).toFixed(1)}" text-anchor="middle">${esc(node.label)}</text>`
        : '')).join('');
    node.innerHTML = `<svg class="star-graph" viewBox="0 0 ${W} ${H}" role="img" ` +
      `aria-label="${esc(opts.label || 'star 聚类关系图')}">${edges}${circles}</svg>`;
  }

  return { line, delta, yearBars, ranking, starWall, starGraph, starColor, colorAt, PALETTE };
})();
