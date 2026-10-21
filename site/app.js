/* Model Observatory — no framework and no client-side data collection.
 * Everything shown here comes from the historical snapshots saved by Actions.
 */
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const fmt = v => v == null || !Number.isFinite(v) ? '—' : Math.trunc(v).toLocaleString('en-US');
  const compact = v => v == null || !Number.isFinite(v) ? '—' : new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 2 }).format(v);
  const signed = v => v == null ? '—' : `${v > 0 ? '+' : ''}${fmt(v)}`;
  const tone = v => v == null ? '' : v < 0 ? 'neg' : v > 0 ? 'pos' : '';
  const snapshotMap = new Map();
  const colors = ['#9faeff', '#70e2c7', '#ffbd86'];
  const state = { latest: null, history: null, snapshots: [], metric: 'all_time', range: '30', compare: [], model: null };

  function getDateShift(day, minusDays) {
    const dt = new Date(`${day}T00:00:00Z`);
    dt.setUTCDate(dt.getUTCDate() - minusDays);
    return dt.toISOString().slice(0, 10);
  }
  function modelSeries(id, metric, range = 'all') {
    const source = range === 'all' ? state.snapshots : state.snapshots.slice(-Number(range));
    return source.flatMap(s => {
      const point = s.models?.[id];
      if (!point) return [];
      const val = point[metric === 'all_time' ? 0 : 1];
      return Number.isFinite(val) ? [{ date: s.date, value: val }] : [];
    });
  }
  function totalSeries(metric, range = 'all') {
    const source = range === 'all' ? state.snapshots : state.snapshots.slice(-Number(range));
    return source.map(s => {
      let sum = 0, known = 0;
      Object.values(s.models || {}).forEach(point => {
        const v = point[metric === 'all_time' ? 0 : 1];
        if (Number.isFinite(v)) { sum += v; known++; }
      });
      return known ? { date: s.date, value: sum } : null;
    }).filter(Boolean);
  }
  function pairDelta(id, newer, older) {
    if (!newer || !older) return null;
    const n = newer.models?.[id]?.[0], p = older.models?.[id]?.[0];
    return Number.isFinite(n) && Number.isFinite(p) ? n - p : null;
  }
  function netChange(a, b) {
    if (!a || !b) return null;
    let sum = 0, counted = 0, negative = 0;
    for (const id of Object.keys(a.models || {})) {
      const val = pairDelta(id, a, b);
      if (val === null) continue;
      sum += val;
      counted++;
      if (val < 0) negative++;
    }
    return { value: counted ? sum : null, compared: counted, revised: negative };
  }
  function delta(id, days) {
    const latest = state.snapshots.at(-1);
    if (!latest) return null;
    const baseline = days === 'prev' ? state.snapshots.at(-2) : snapshotMap.get(getDateShift(latest.date, days));
    return pairDelta(id, latest, baseline);
  }
  function localState() {
    const m = state.latest.models || [];
    return m.map(model => ({...model, d1:delta(model.id, 'prev'), d7:delta(model.id, 7), d30:delta(model.id,30)}));
  }
  function dayLabel(day) { return day ? day.slice(5).replace('-', '/') : '—'; }
  function stateMessage(message, type = 'error') {
    const el = $('errorBanner');
    el.textContent = message;
    el.classList.remove('hidden');
    if (type === 'info') el.style.background = '#1e3047';
  }
  function showToast(message) {
    const div = document.createElement('div');
    div.className = 'notice';
    div.style.cssText = 'position:fixed;z-index:40;right:20px;bottom:18px;max-width:360px;box-shadow:0 12px 40px #0008;';
    div.textContent = message;
    document.body.append(div);
    setTimeout(() => div.remove(), 3300);
  }

  // Render a self-contained responsive SVG chart with SVG title-based tooltips.
  function lineChart(node, lines, opts={}) {
    const entries = lines.filter(s => s.points.length);
    if (!entries.length) { node.innerHTML = '<div class="chart-empty">尚无可绘制的历史快照。首次采集后开始积累数据。</div>'; return; }
    const W=840, H=280, left=83, right=23, top=19, bottom=41, plotW=W-left-right, plotH=H-top-bottom;
    const days = [...new Set(entries.flatMap(s=>s.points.map(p=>p.date)))].sort();
    const allValues=entries.flatMap(s=>s.points.map(p=>p.value));
    const lo = Math.min(...allValues), hi=Math.max(...allValues);
    const pad = Math.max(1, (hi-lo)*0.14, Math.abs(hi)*0.025);
    const ymin = opts.includeZero ? Math.min(0,lo) : Math.max(0,lo-pad);
    const ymax = hi+pad;
    const denom = ymax-ymin || 1;
    const xOf = day => left+(days.length===1 ? plotW/2 : plotW*days.indexOf(day)/(days.length-1));
    const yOf = value => top+plotH*(1-(value-ymin)/denom);
    const grids=Array.from({length:5},(_,i)=>{
      const val=ymin+(ymax-ymin)*i/4;
      const y=yOf(val);
      return `<line class="svg-grid" x1="${left}" y1="${y}" x2="${W-right}" y2="${y}"/><text class="svg-axis" x="${left-12}" y="${y+4}" text-anchor="end">${esc(compact(val))}</text>`;
    }).join('');
    const xIndexes=days.length===1?[0]:[0,Math.floor((days.length-1)/3),Math.floor(2*(days.length-1)/3),days.length-1];
    const labels=[...new Set(xIndexes)].map(i=>`<text class="svg-label" x="${xOf(days[i])}" y="${H-11}" text-anchor="middle">${dayLabel(days[i])}</text>`).join('');
    const seriesSvg=entries.map((s,i)=>{
      const color=s.color||colors[i%colors.length];
      const points=s.points.map(p=>[xOf(p.date),yOf(p.value)]);
      const poly=points.map(([x,y])=>`${x.toFixed(2)},${y.toFixed(2)}`).join(' ');
      const escapedName=esc(s.name);
      let area='';
      if (opts.area && i===0 && points.length>1) {
        const xy=points.map(([x,y])=>`${x},${y}`).join(' ');
        area=`<polygon points="${points[0][0]},${top+plotH} ${xy} ${points.at(-1)[0]},${top+plotH}" fill="${color}" opacity=".07"/>`;
      }
      const dots=points.length < 20 ? points.map(([x,y],index)=>`<circle cx="${x}" cy="${y}" r="3.5" fill="${color}" stroke="#142037" stroke-width="2"><title>${escapedName} · ${s.points[index].date} · ${fmt(s.points[index].value)}</title></circle>`).join('') : '';
      const hoverPoints=s.points.map((p,index)=>`<circle cx="${points[index][0]}" cy="${points[index][1]}" r="11" fill="transparent"><title>${escapedName} · ${p.date} · ${fmt(p.value)}</title></circle>`).join('');
      return `${area}<polyline fill="none" stroke="${color}" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round" points="${poly}"/>${dots}${hoverPoints}`;
    }).join('');
    node.innerHTML=`<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="${esc(opts.label||'下载量趋势图')}">${grids}${seriesSvg}${labels}</svg>`;
  }
  function barChart(node) {
    const snaps=state.snapshots.slice(-16);
    if (snaps.length<2) { node.innerHTML='<div class="chart-empty">至少需要两天的快照，才能计算相邻快照的净变化。</div>'; return; }
    const points=[];
    for (let i=1;i<snaps.length;i++) {
      const change=netChange(snaps[i],snaps[i-1]);
      points.push({date:snaps[i].date, previous:snaps[i-1].date, value:change?.value, revised:change?.revised||0});
    }
    if (!points.some(p=>p.value!==null)) { node.innerHTML='<div class="chart-empty">暂无可比较的有效累计字段。</div>';return; }
    const W=840,H=170,L=75,R=20,T=15,B=30, pW=W-L-R,pH=H-T-B;
    const values=points.map(p=>p.value).filter(Number.isFinite);
    const min=Math.min(0,...values),max=Math.max(0,...values),ymin=min*1.14 || -1,ymax=max*1.14 || 1;
    const y=v=>T+pH*(ymax-v)/(ymax-ymin);
    const gap=pW/points.length, barW=Math.min(gap*.56,35);
    const bars=points.map((p,i)=>{
      if(p.value===null) return '';
      const x=L+gap*i+(gap-barW)/2,yv=y(p.value),yz=y(0);
      const color=p.value<0?'#f19b9d':'#76d9c5';
      return `<rect x="${x}" y="${Math.min(yv,yz)}" width="${barW}" height="${Math.max(2,Math.abs(yv-yz))}" rx="2.5" fill="${color}" opacity=".83"><title>${p.previous} → ${p.date} : ${signed(p.value)}${p.revised?`；${p.revised} 个模型累计值下降`:''}</title></rect><text class="svg-label" x="${x+barW/2}" y="${H-8}" text-anchor="middle">${dayLabel(p.date)}</text>`;
    }).join('');
    node.innerHTML=`<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="相邻快照净增量柱状图"><line x1="${L}" y1="${y(0)}" x2="${W-R}" y2="${y(0)}" stroke="#53627b" stroke-width="1.5"/>${[min,max].map(v=>`<text class="svg-axis" x="${L-9}" y="${y(v)+3}" text-anchor="end">${compact(v)}</text>`).join('')}${bars}</svg>`;
    $('deltaPeriod').textContent=`${points[0]?.previous||'—'} — ${points.at(-1)?.date||'—'}`;
  }

  function renderSummary(){
    const models=state.latest.models;
    const all=models.filter(m=>Number.isFinite(m.all_time));
    const rolling=models.filter(m=>Number.isFinite(m.last_30d));
    const lifetime=all.reduce((n,m)=>n+m.all_time,0);
    const r30=rolling.reduce((n,m)=>n+m.last_30d,0);
    const latest=state.snapshots.at(-1), prev=state.snapshots.at(-2);
    const net=netChange(latest,prev);
    $('statModels').textContent=fmt(models.length);
    $('statLifetime').textContent=all.length?compact(lifetime):'—';
    $('statLifetime').title=all.length?fmt(lifetime):'无累计数据';
    $('statLifetimeSub').textContent=all.length!==models.length?`已知 ${all.length}/${models.length} 个模型的累计值`:'全部当前公开模型累计之和';
    $('statRolling').textContent=rolling.length?compact(r30):'—';
    $('statRolling').title=fmt(r30);
    $('statDelta').textContent=net?.value===null || !net ? '—' : signed(net.value);
    $('statDelta').classList.toggle('neg',Boolean(net?.value<0));
    $('statDeltaSub').textContent=prev?`可比 ${net?.compared||0} 个模型 · 自 ${prev.date} 起`:'需要至少两天快照';
    $('lastSync').textContent=state.latest.captured_at?.replace('T',' ').slice(0,16)||'—';
    $('snapshotCount').textContent=fmt(state.snapshots.length);
    $('snapshotDate').textContent=`最新快照 ${state.latest.date} UTC`;
    const age=Math.max(0,(Date.now()-new Date(state.latest.captured_at).getTime())/86400000);
    $('freshLed').className='status-led '+(age<=2?'good':'warn');
    $('freshLabel').textContent=age<=2?'自动采集正常':`数据已过期 ${Math.floor(age)} 天`;
    const prevNeg=net?.revised||0;
    $('correctionBadge').textContent=prevNeg?`${prevNeg} 个模型累计值下降 · 请核查`:'未检测到累计值下降';
    $('correctionBadge').classList.toggle('warn',prevNeg>0);
    $('modelCountBadge').textContent=fmt(models.length);
  }
  function renderOverall(){
    const metric=state.metric;
    $('overallLegend').textContent=metric==='all_time'?'历史累计下载 · 各日当时公开模型之和':'滚动30天下载 · 各日当时公开模型之和';
    lineChart($('overallChart'),[{name:metric==='all_time'?'历史累计':'滚动30天',points:totalSeries(metric,state.range),color:'#9faeff'}],{area:true,label:'模型总体下载趋势'});
    barChart($('deltaChart'));
  }
  function renderTop(){
    const top=[...state.latest.models].filter(m=>m.last_30d!==null).sort((a,b)=>(b.last_30d??0)-(a.last_30d??0)).slice(0,6);
    if (!top.length) { $('topModels').innerHTML='<div class="chart-empty">暂无滚动 30 天数据</div>';return; }
    const max=top[0].last_30d||1;
    $('topModels').innerHTML=top.map((m,i)=>`<div class="top-item"><span class="rank-index">${String(i+1).padStart(2,'0')}</span><div><div class="rank-model"><span class="rank-name" title="${esc(m.id)}">${esc(m.id.split('/').slice(1).join('/'))}</span></div><div class="rank-progress"><span style="width:${(m.last_30d/max*100).toFixed(1)}%"></span></div></div><span class="rank-number" title="${fmt(m.last_30d)}">${compact(m.last_30d)}</span></div>`).join('');
  }
  function renderTable(){
    const search=$('modelSearch').value.trim().toLowerCase();
    const sort=$('sortModel').value;
    const onlyNeg=$('onlyAnomalies').checked;
    let rows=localState().filter(m=>(!search||m.id.toLowerCase().includes(search))&&(!onlyNeg||m.d1<0));
    if(sort==='name') rows.sort((a,b)=>a.id.localeCompare(b.id));
    else rows.sort((a,b)=>{
      const av=a[sort]??-Infinity,bv=b[sort]??-Infinity;
      return bv-av || a.id.localeCompare(b.id);
    });
    $('tableCount').textContent=`${fmt(rows.length)} / ${fmt(state.latest.models.length)} MODELS`;
    $('modelRows').innerHTML=rows.length?rows.map(m=>{
      const stateName=m.all_time==null?'累计缺失':m.d1<0?'统计修正?':m.d1==null?'待积累':'正常';
      const stateClass=m.all_time==null?'missing':m.d1<0?'alert':m.d1==null?'new':'';
      const checked=state.compare.includes(m.id)?'checked':'';
      return `<tr><td><button class="model-link" data-detail="${esc(m.id)}" title="查看 ${esc(m.id)} 的历史"><span class="model-square">${esc(m.id.split('/').at(-1).slice(0,1).toUpperCase())}</span><span class="model-title">${esc(m.id.split('/').slice(1).join('/'))}</span></button></td><td class="align-right">${fmt(m.all_time)}</td><td class="align-right">${fmt(m.last_30d)}</td><td class="align-right ${tone(m.d1)}">${signed(m.d1)}</td><td class="align-right ${tone(m.d7)}">${signed(m.d7)}</td><td class="align-right ${tone(m.d30)}">${signed(m.d30)}</td><td><span class="state ${stateClass}">${stateName}</span></td><td class="compare-col"><input type="checkbox" class="compare-check" data-compare="${esc(m.id)}" aria-label="对比 ${esc(m.id)}" ${checked}></td></tr>`;
    }).join(''):'<tr><td colspan="8" class="no-rows">没有符合条件的模型</td></tr>';
  }
  function renderCompare(){
    $('compareSelected').innerHTML=state.compare.length?state.compare.map((id,i)=>`<div class="compare-pill"><span class="compare-dot" style="background:${colors[i]}"></span>${esc(id.split('/').slice(1).join('/'))}</div>`).join(''):'<span class="muted micro">尚未选择模型，在上方表格中勾选即可对比。</span>';
    lineChart($('compareChart'),state.compare.map((id,i)=>({name:id,points:modelSeries(id,'all_time',state.range),color:colors[i]})),{label:'所选模型历史累计下载对比'});
  }
  function renderDetail(){
    const id=state.model;
    if(!id) return;
    const model=state.latest.models.find(m=>m.id===id);
    if (!model) return;
    $('detailTitle').textContent=model.id.split('/').slice(1).join('/');
    $('detailID').textContent=model.id;
    const d1=delta(id,'prev'),d7=delta(id,7),d30=delta(id,30);
    $('detailContents').innerHTML=`<div class="detail-metrics"><div class="detail-stat"><span>历史累计下载</span><strong>${fmt(model.all_time)}</strong></div><div class="detail-stat"><span>滚动 30 天</span><strong>${fmt(model.last_30d)}</strong></div><div class="detail-stat"><span>上次变化</span><strong class="${tone(d1)}">${signed(d1)}</strong></div><div class="detail-stat"><span>7日净变化</span><strong class="${tone(d7)}">${signed(d7)}</strong></div></div><div class="detail-chart-title">历史累计下载</div><p class="detail-note">同一模型的累计下载计数；如有下降，说明存在统计回调、重算或其他异常。</p><div id="detailChartAll" class="chart-area" style="height:225px"></div><div class="detail-section"><div class="detail-chart-title">滚动 30 天下载量</div><p class="detail-note">该曲线可以正常回落，不应解释为历史下载被取消。</p><div id="detailChartRolling" class="chart-area" style="height:225px"></div></div><div class="detail-section"><div class="detail-chart-title">最近快照</div><div class="detail-note">30日净变：<b class="${tone(d30)}">${signed(d30)}</b> · 点开曲线可查各采集日期的具体数字</div><table class="history-table"><thead><tr><th>UTC 日期</th><th class="align-right">累计</th><th class="align-right">滚动30天</th><th class="align-right">相邻净变化</th></tr></thead><tbody id="detailTable"></tbody></table></div><a class="detail-action" href="https://huggingface.co/${encodeURI(id)}" target="_blank" rel="noopener noreferrer">前往 Hugging Face 模型主页 ↗</a>`;
    lineChart($('detailChartAll'),[{name:id,points:modelSeries(id,'all_time'),color:'#9faeff'}],{area:true,label:'该模型累计下载趋势'});
    lineChart($('detailChartRolling'),[{name:id,points:modelSeries(id,'last_30d'),color:'#72dcc7'}],{area:true,label:'该模型滚动30天趋势'});
    const existing=state.snapshots.filter(s=>s.models?.[id]).slice(-15).reverse();
    $('detailTable').innerHTML=existing.map(s=>{
      const index=state.snapshots.indexOf(s);
      const v=pairDelta(id,s,state.snapshots[index-1]);
      const cur=s.models[id];
      return `<tr><td>${s.date}</td><td class="align-right">${fmt(cur[0])}</td><td class="align-right">${fmt(cur[1])}</td><td class="align-right ${tone(v)}">${signed(v)}</td></tr>`;
    }).join('');
  }
  function openDetail(id){
    if (!state.latest.models.some(m=>m.id===id)) return;
    state.model=id;
    $('detailOverlay').classList.remove('hidden');
    $('detailOverlay').setAttribute('aria-hidden','false');
    document.body.style.overflow='hidden';
    renderDetail();
    $('closeDetail').focus();
  }
  function closeDetail(){state.model=null;$('detailOverlay').classList.add('hidden');$('detailOverlay').setAttribute('aria-hidden','true');document.body.style.overflow='';}
  function csvEscape(v){return `"${String(v??'').replace(/"/g,'""')}"`;}
  function download(name,content,type){
    const url=URL.createObjectURL(new Blob([content],{type}));
    const a=document.createElement('a');a.href=url;a.download=name;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
  }
  function exportCsv(){
    const header=['model_id','downloads_all_time','downloads_rolling_30d','change_since_previous_snapshot','change_7d','change_30d','likes','pipeline','date_utc','huggingface_url'];
    const rows=localState().map(m=>[m.id,m.all_time,m.last_30d,m.d1,m.d7,m.d30,m.likes,m.pipeline,state.latest.date,`https://huggingface.co/${m.id}`]);
    download(`gatilin-models-${state.latest.date||'latest'}.csv`,'\uFEFF'+[header,...rows].map(r=>r.map(csvEscape).join(',')).join('\r\n'),'text/csv;charset=utf-8');
  }
  function bind(){
    document.querySelectorAll('[data-metric]').forEach(btn=>btn.addEventListener('click',()=>{
      state.metric=btn.dataset.metric;
      document.querySelectorAll('[data-metric]').forEach(b=>b.classList.toggle('active',b===btn));
      renderOverall();
    }));
    document.querySelectorAll('[data-range]').forEach(btn=>btn.addEventListener('click',()=>{
      state.range=btn.dataset.range;
      document.querySelectorAll('[data-range]').forEach(b=>b.classList.toggle('active',b===btn));
      renderOverall();renderCompare();
    }));
    $('modelSearch').addEventListener('input',renderTable);
    $('sortModel').addEventListener('change',renderTable);
    $('onlyAnomalies').addEventListener('change',renderTable);
    $('modelRows').addEventListener('click',e=>{
      const button=e.target.closest('button[data-detail]');
      if(button)openDetail(button.dataset.detail);
    });
    $('modelRows').addEventListener('change',e=>{
      const box=e.target.closest('input[data-compare]');
      if(!box)return;
      const id=box.dataset.compare;
      if(box.checked&&state.compare.length>=3){box.checked=false;showToast('最多同时比较 3 个模型，请先取消其他模型。');return;}
      state.compare=box.checked?[...state.compare,id]:state.compare.filter(v=>v!==id);
      renderCompare();
    });
    $('clearCompare').onclick=()=>{state.compare=[];renderTable();renderCompare();};
    $('exportCSV').onclick=exportCsv;
    $('exportJSON').onclick=()=>download('gatilin-hf-download-history.json',JSON.stringify(state.history,null,2),'application/json;charset=utf-8');
    $('closeDetail').onclick=closeDetail;
    $('closeOverlayBg').onclick=closeDetail;
    document.addEventListener('keydown',e=>{if(e.key==='Escape'&&state.model)closeDetail();});
    document.querySelectorAll('.navlinks a').forEach(el=>el.addEventListener('click',()=>{
      document.querySelectorAll('.navlinks a').forEach(a=>a.classList.toggle('active',a===el));
    }));
  }
  async function boot(){
    bind();
    try {
      const [latestResponse,historyResponse]=await Promise.all([
        fetch('./data/latest.json',{cache:'no-store'}),fetch('./data/history.json',{cache:'no-store'})
      ]);
      if(!latestResponse.ok||!historyResponse.ok)throw Error(`HTTP ${latestResponse.status} / ${historyResponse.status}`);
      const [latest,history]=await Promise.all([latestResponse.json(),historyResponse.json()]);
      if(latest.schema_version!==1||history.schema_version!==1||latest.author!==history.author||!Array.isArray(latest.models)||!Array.isArray(history.snapshots))throw Error('下载数据格式不兼容');
      state.latest=latest;state.history=history;
      state.snapshots=[...history.snapshots].sort((a,b)=>a.date.localeCompare(b.date));
      state.snapshots.forEach(s=>snapshotMap.set(s.date,s));
      if(!latest.models.length){$('emptyBanner').classList.remove('hidden');return;}
      if(!latest.captured_at)throw Error('缺少更新时间信息');
      renderSummary();renderOverall();renderTop();renderTable();renderCompare();
    }catch(err){
      $('freshLabel').textContent='数据读取失败';
      stateMessage('页面可以加载，但读取历史 JSON 失败：'+err.message+'。请检查 GitHub Actions 是否成功完成采集与部署。');
    }
  }
  boot();
})();
