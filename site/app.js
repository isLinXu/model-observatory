/* Model Observatory — application entry point.
 * Wires the layers together: binds events, loads data, triggers renders.
 * All behaviour lives in format.js / charts.js / data.js / render.js / theme.js.
 */
(() => {
  'use strict';

  const $ = id => document.getElementById(id);
  const { fmt, signed, tone, timestamp } = MO.format;
  const data = MO.data;
  const render = MO.render;

  function csvEscape(value) {
    return `"${String(value ?? '').replace(/"/g, '""')}"`;
  }

  function download(name, content, type) {
    const url = URL.createObjectURL(new Blob([content], { type }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = name;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function exportModelCsv() {
    const header = ['model_id', 'downloads_all_time', 'downloads_rolling_30d', 'change_since_previous_snapshot',
      'change_7d', 'change_30d', 'likes', 'pipeline', 'date_utc', 'huggingface_url'];
    const rows = data.localModels().map(model => [
      model.id, model.all_time, model.last_30d, model.d1, model.d7, model.d30, model.likes,
      model.pipeline, data.state.latest.date, `https://huggingface.co/${model.id}`
    ]);
    download(`gatilin-models-${data.state.latest.date || 'latest'}.csv`,
      '\uFEFF' + [header, ...rows].map(row => row.map(csvEscape).join(',')).join('\r\n'),
      'text/csv;charset=utf-8');
  }

  function exportDatasetCsv() {
    const header = ['dataset_id', 'downloads_all_time', 'downloads_rolling_30d', 'change_since_previous_snapshot',
      'change_7d', 'change_30d', 'likes', 'modality', 'languages', 'date_utc', 'huggingface_url'];
    const rows = data.localDatasets().map(item => [
      item.id, item.all_time, item.last_30d, item.d1, item.d7, item.d30, item.likes,
      (item.modality || []).join('|'), (item.languages || []).join('|'),
      data.state.latest.date, `https://huggingface.co/datasets/${item.id}`
    ]);
    download(`gatilin-datasets-${data.state.latest.date || 'latest'}.csv`,
      '\uFEFF' + [header, ...rows].map(row => row.map(csvEscape).join(',')).join('\r\n'),
      'text/csv;charset=utf-8');
  }

  function exportSocialCsv() {
    const header = ['platform', 'handle', 'followers', 'following', 'posts', 'likes',
      'change_since_previous_snapshot', 'status', 'updated_at', 'url'];
    const rows = (data.state.social?.sources || []).map(source => [
      source.label, source.handle, source.followers, source.following, source.posts, source.likes,
      data.socialDelta(source.id), source.status, source.updated_at, source.url
    ]);
    download(`gatilin-social-${data.state.social?.captured_at?.slice(0, 10) || 'latest'}.csv`,
      '\uFEFF' + [header, ...rows].map(row => row.map(csvEscape).join(',')).join('\r\n'),
      'text/csv;charset=utf-8');
  }

  /**
   * Manual refresh of the GitHub board. The site is static, so this re-reads
   * the deployed snapshot with the cache bypassed. To collect fresh upstream
   * data, run the "Sync Hugging Face & deploy Pages" workflow manually.
   */
  async function refreshGitHub() {
    const button = $('githubRefresh');
    const original = button.textContent;
    button.disabled = true;
    button.textContent = '↻ 刷新中…';
    try {
      const latest = await data.reloadGitHub();
      render.renderGitHub();
      const captured = latest?.captured_at;
      render.showToast(captured
        ? `已刷新至最新发布的快照（${timestamp(captured)} UTC）。若需重新采集上游数据，请在 Actions 中手动运行同步工作流。`
        : '已刷新 GitHub 快照。');
    } catch (error) {
      render.showToast('刷新失败：' + error.message + '。当前仍显示上一次成功的数据。');
    } finally {
      button.disabled = false;
      button.textContent = original;
    }
  }

  function exportGitHubCsv() {
    const header = ['full_name', 'name', 'url', 'stars', 'forks', 'language', 'updated_at',
      'pushed_at', 'is_fork', 'archived', 'description'];
    const rows = data.githubRepositories().map(repo => [
      repo.full_name, repo.name, repo.url, repo.stars, repo.forks, repo.language,
      repo.updated_at, repo.pushed_at, repo.is_fork, repo.archived, repo.description
    ]);
    download(`gatilin-github-repos-${data.state.github?.captured_at?.slice(0, 10) || 'latest'}.csv`,
      '\uFEFF' + [header, ...rows].map(row => row.map(csvEscape).join(',')).join('\r\n'),
      'text/csv;charset=utf-8');
  }

  function openDetail(id) {
    if (!data.state.latest.models.some(model => model.id === id)) return;
    data.state.model = id;
    $('detailOverlay').classList.remove('hidden');
    $('detailOverlay').setAttribute('aria-hidden', 'false');
    document.body.style.overflow = 'hidden';
    render.renderDetail();
    $('closeDetail').focus();
  }

  function closeDetail() {
    data.state.model = null;
    $('detailOverlay').classList.add('hidden');
    $('detailOverlay').setAttribute('aria-hidden', 'true');
    document.body.style.overflow = '';
  }

  /** Toggle a platform in the social filter. Clicking the active chip resets to all. */
  function toggleSocialPlatform(id) {
    const current = data.state.socialPlatforms;
    if (id === 'all') {
      data.state.socialPlatforms = 'all';
    } else if (current === 'all') {
      data.state.socialPlatforms = id;
    } else {
      const selected = current.split(',');
      data.state.socialPlatforms = selected.includes(id)
        ? (selected.length === 1 ? 'all' : selected.filter(item => item !== id).join(','))
        : [...selected, id].join(',');
    }
    render.renderSocial();
  }

  function bind() {
    document.querySelectorAll('[data-metric]').forEach(button => button.addEventListener('click', () => {
      data.state.metric = button.dataset.metric;
      document.querySelectorAll('[data-metric]').forEach(item => item.classList.toggle('active', item === button));
      render.renderOverall();
    }));

    document.querySelectorAll('[data-range]').forEach(button => button.addEventListener('click', () => {
      data.state.range = button.dataset.range;
      document.querySelectorAll('[data-range]').forEach(item => item.classList.toggle('active', item === button));
      render.renderOverall();
      render.renderCompare();
    }));

    document.querySelectorAll('[data-dataset-metric]').forEach(button => button.addEventListener('click', () => {
      data.state.datasetMetric = button.dataset.datasetMetric;
      document.querySelectorAll('[data-dataset-metric]').forEach(item => item.classList.toggle('active', item === button));
      render.renderDatasetChart();
    }));

    document.querySelectorAll('[data-dataset-range]').forEach(button => button.addEventListener('click', () => {
      data.state.datasetRange = button.dataset.datasetRange;
      document.querySelectorAll('[data-dataset-range]').forEach(item => item.classList.toggle('active', item === button));
      render.renderDatasetChart();
    }));

    $('modelSearch').addEventListener('input', render.renderTable);
    $('sortModel').addEventListener('change', render.renderTable);
    $('onlyAnomalies').addEventListener('change', render.renderTable);
    $('modelRows').addEventListener('click', event => {
      const button = event.target.closest('button[data-detail]');
      if (button) openDetail(button.dataset.detail);
    });
    $('modelRows').addEventListener('change', event => {
      const box = event.target.closest('input[data-compare]');
      if (!box) return;
      const id = box.dataset.compare;
      if (box.checked && data.state.compare.length >= 3) {
        box.checked = false;
        render.showToast('最多同时比较 3 个模型，请先取消其他模型。');
        return;
      }
      data.state.compare = box.checked
        ? [...data.state.compare, id]
        : data.state.compare.filter(item => item !== id);
      render.renderCompare();
    });
    $('clearCompare').onclick = () => {
      data.state.compare = [];
      render.renderTable();
      render.renderCompare();
    };

    $('exportCSV').onclick = exportModelCsv;
    $('exportJSON').onclick = () =>
      download('gatilin-hf-download-history.json', JSON.stringify(data.state.history, null, 2), 'application/json;charset=utf-8');
    $('exportDatasetCSV').onclick = exportDatasetCsv;
    $('exportDatasetJSON').onclick = () =>
      download('gatilin-hf-dataset-history.json', JSON.stringify({
        author: data.state.latest.author,
        date: data.state.latest.date,
        snapshots: data.state.snapshots.map(snapshot => ({ date: snapshot.date, datasets: snapshot.datasets || {} }))
      }, null, 2), 'application/json;charset=utf-8');
    $('exportSocialCSV').onclick = exportSocialCsv;
    $('exportGitHubCSV').onclick = exportGitHubCsv;

    $('datasetSearch').addEventListener('input', render.renderDatasetTable);
    $('sortDataset').addEventListener('change', render.renderDatasetTable);
    $('paperSearch').addEventListener('input', render.renderPapers);

    // Social section: platform filter, range filter and view switch.
    $('socialPlatformFilter').addEventListener('click', event => {
      const chip = event.target.closest('[data-platform]');
      if (chip) toggleSocialPlatform(chip.dataset.platform);
    });
    document.querySelectorAll('[data-social-range]').forEach(button => button.addEventListener('click', () => {
      data.state.socialRange = button.dataset.socialRange;
      document.querySelectorAll('[data-social-range]').forEach(item => item.classList.toggle('active', item === button));
      render.renderSocialChart();
    }));
    document.querySelectorAll('[data-social-view]').forEach(button => button.addEventListener('click', () => {
      data.state.socialView = button.dataset.socialView;
      render.renderSocial();
    }));

    // GitHub board: search, sort, language filter, paging and manual refresh.
    $('githubSearch').addEventListener('input', event => {
      data.state.githubSearch = event.target.value;
      data.state.githubPage = 1;
      render.renderGitHubTable();
    });
    $('sortGithub').addEventListener('change', event => {
      data.state.githubSort = event.target.value;
      data.state.githubPage = 1;
      render.renderGitHubTable();
    });
    $('filterGithubLanguage').addEventListener('change', event => {
      data.state.githubLanguage = event.target.value;
      data.state.githubPage = 1;
      render.renderGitHubTable();
    });
    // Fork scope: "仅自有" matches the repository count GitHub shows on the
    // profile page; "含 Fork" lists every public repository.
    document.querySelectorAll('[data-github-forks]').forEach(button => {
      button.addEventListener('click', () => {
        const scope = button.dataset.githubForks;
        if (data.state.githubForks === scope) return;
        data.state.githubForks = scope;
        data.state.githubPage = 1;
        document.querySelectorAll('[data-github-forks]').forEach(item =>
          item.classList.toggle('active', item === button));
        render.renderGitHub();
      });
    });
    $('githubPrevPage').addEventListener('click', () => {
      data.state.githubPage = Math.max(1, data.state.githubPage - 1);
      render.renderGitHubTable();
    });
    $('githubNextPage').addEventListener('click', () => {
      data.state.githubPage += 1;
      render.renderGitHubTable();
    });
    $('githubRefresh').addEventListener('click', refreshGitHub);

    $('closeDetail').onclick = closeDetail;
    $('closeOverlayBg').onclick = closeDetail;
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape' && data.state.model) closeDetail();
    });
    document.querySelectorAll('.navlinks a').forEach(link => link.addEventListener('click', () => {
      document.querySelectorAll('.navlinks a').forEach(item => item.classList.toggle('active', item === link));
    }));
  }

  function renderAll() {
    render.renderSummary();
    render.renderOverall();
    render.renderTop();
    render.renderTable();
    render.renderCompare();
    render.renderDatasetSummary();
    render.renderDatasetChart();
    render.renderTopDatasets();
    render.renderDatasetTable();
    render.renderScholar();
    render.renderPapers();
    render.renderSocial();
    render.renderGitHub();
  }

  async function boot() {
    MO.theme.init();
    bind();
    try {
      await data.loadAll();
      if (!data.state.latest.models.length) $('emptyBanner').classList.remove('hidden');
      renderAll();
    } catch (error) {
      $('freshLabel').textContent = '数据读取失败';
      render.stateMessage('页面可以加载，但读取历史 JSON 失败：' + error.message +
        '。请检查 GitHub Actions 是否成功完成采集与部署。');
      // Secondary panels still render so a partial failure is visible, not blank.
      try { render.renderSocial(); } catch (secondaryError) { console.error(secondaryError); }
      try { render.renderGitHub(); } catch (secondaryError) { console.error(secondaryError); }
    }
  }

  boot();
})();
