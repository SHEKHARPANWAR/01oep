/**
 * TeamTrack Dashboard — app.js
 * Connects to a published Google Sheet CSV and renders a live dashboard.
 * No server, no build step, no auth — pure client-side.
 *
 * HOW IT WORKS:
 *  1. On first load, a setup modal prompts for the Google Sheet CSV URL.
 *  2. The URL is saved to localStorage. The sheet is fetched and parsed.
 *  3. Data is re-fetched every REFRESH_INTERVAL ms automatically.
 *  4. All charts, tables, and cards rebuild from the fresh data on each fetch.
 */

'use strict';

// ═══════════════════════════════════════════════════════
// CONFIG
// ═══════════════════════════════════════════════════════
const REFRESH_INTERVAL = 60_000;   // Re-fetch every 60 seconds
const ROWS_PER_PAGE    = 20;       // Rows per page in tables

// ── Column name aliases — add variants your sheet might use
const COL = {
  team:       ['team name', 'team', 'department'],
  task:       ['task name', 'task', 'activity'],
  budget:     ['budget', 'allocated budget', 'total budget'],
  expense:    ['expense', 'actual expense', 'spent', 'amount spent'],
  remaining:  ['remaining budget', 'remaining', 'balance'],
  status:     ['task status', 'status'],
  assignee:   ['assigned to', 'employee', 'assignee', 'member'],
  startDate:  ['start date', 'start'],
  dueDate:    ['due date', 'deadline', 'due'],
  remarks:    ['remarks', 'notes', 'comment', 'comments'],
  updated:    ['last updated', 'updated', 'modified'],
};

// ── Chart color palette
const PALETTE = [
  '#2D9CDB', '#27AE60', '#F2994A', '#EB5757',
  '#9B51E0', '#56CCF2', '#F2C94C', '#6FCF97',
];

// ═══════════════════════════════════════════════════════
// STATE
// ═══════════════════════════════════════════════════════
let allRows        = [];   // Raw parsed rows (objects)
let filteredRows   = [];   // After search + filter
let charts         = {};   // Chart.js instances
let refreshTimer   = null;
let tasksPage      = 1;
let expensesPage   = 1;
let tasksSortCol   = '';
let tasksSortDir   = 'asc';
let expSortCol     = '';
let expSortDir     = 'asc';
let headerMap      = {};   // normalizedHeader → original header

// ═══════════════════════════════════════════════════════
// UTILITIES
// ═══════════════════════════════════════════════════════
function fmt(n) {
  if (n == null || n === '' || isNaN(n)) return '—';
  const abs = Math.abs(n);
  if (abs >= 1_00_00_000) return '₹' + (n / 1_00_00_000).toFixed(2) + 'Cr';
  if (abs >= 1_00_000)    return '₹' + (n / 1_00_000).toFixed(2)    + 'L';
  if (abs >= 1_000)       return '₹' + (n / 1_000).toFixed(1)       + 'K';
  return '₹' + Number(n).toLocaleString('en-IN');
}

function fmtFull(n) {
  if (n == null || isNaN(n)) return '—';
  return '₹' + Number(n).toLocaleString('en-IN');
}

function parseNum(v) {
  if (v == null || v === '') return 0;
  const n = parseFloat(String(v).replace(/[₹,\s]/g, ''));
  return isNaN(n) ? 0 : n;
}

function fmtDate(s) {
  if (!s || s.trim() === '') return '—';
  const d = new Date(s);
  if (isNaN(d.getTime())) return s;
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}

function normKey(s) {
  return String(s).toLowerCase().trim();
}

function getVal(row, fieldKey) {
  const aliases = COL[fieldKey] || [];
  for (const alias of aliases) {
    const orig = headerMap[alias];
    if (orig && row[orig] !== undefined) {
      return row[orig];
    }
  }
  return '';
}

function statusBadge(s) {
  const v = String(s || '').toLowerCase().trim();
  if (!v || v === '—') return `<span class="badge badge-grey">—</span>`;
  if (v.includes('complet') || v === 'done') return `<span class="badge badge-green">${s}</span>`;
  if (v.includes('progress') || v.includes('active') || v.includes('ongoing'))
    return `<span class="badge badge-blue">${s}</span>`;
  if (v.includes('hold') || v.includes('pause') || v.includes('pending'))
    return `<span class="badge badge-amber">${s}</span>`;
  if (v.includes('cancel') || v.includes('delay') || v.includes('overdue'))
    return `<span class="badge badge-red">${s}</span>`;
  return `<span class="badge badge-grey">${s}</span>`;
}

function usageColor(pct) {
  if (pct >= 90) return '#EB5757';
  if (pct >= 70) return '#F2994A';
  return '#27AE60';
}

function showToast(msg, type = 'info') {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = `toast toast-${type} show`;
  setTimeout(() => { t.className = 'toast'; }, 3500);
}

function setStatus(state, msg) {
  const dot   = document.getElementById('statusDot');
  const label = document.getElementById('statusLabel');
  const time  = document.getElementById('statusTime');
  dot.className   = `status-dot ${state}`;
  label.textContent = msg;
  const now = new Date();
  time.textContent = now.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
  document.getElementById('lastUpdated').textContent = 'Updated ' + time.textContent;
  document.getElementById('footerRefresh').textContent = 'Last refresh: ' + now.toLocaleString('en-IN');
}

// ═══════════════════════════════════════════════════════
// HEADER DETECTION
// Build a map: normKey(alias) → original column name in sheet
// ═══════════════════════════════════════════════════════
function buildHeaderMap(headers) {
  headerMap = {};
  for (const h of headers) {
    const nk = normKey(h);
    headerMap[nk] = h;
    // Also map all known aliases
    for (const [fieldKey, aliases] of Object.entries(COL)) {
      for (const alias of aliases) {
        if (nk === alias) {
          headerMap[alias] = h;
        }
      }
    }
  }
}

// ═══════════════════════════════════════════════════════
// GOOGLE SHEETS FETCH
// ═══════════════════════════════════════════════════════
async function fetchSheet(url) {
  const btn = document.getElementById('refreshBtn');
  btn.classList.add('spinning');
  setStatus('', 'Fetching…');

  try {
    // Add cache-busting so we always get fresh data
    const bust = `&t=${Date.now()}`;
    const fetchUrl = url.includes('?') ? url + bust : url + '?' + bust.slice(1);
    const res = await fetch(fetchUrl, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    const csv = await res.text();
    if (!csv || csv.trim().length < 10) throw new Error('Sheet appears empty.');

    const parsed = Papa.parse(csv, {
      header: true,
      skipEmptyLines: true,
      transformHeader: h => h.trim(),
    });

    if (!parsed.data || parsed.data.length === 0) throw new Error('No data rows found in sheet.');

    buildHeaderMap(parsed.meta.fields || []);
    allRows = parsed.data;

    populateFilters();
    applyFilters();
    setStatus('connected', `Connected — ${allRows.length} rows`);
    showToast(`✓ Loaded ${allRows.length} records`, 'success');
  } catch (err) {
    setStatus('error', 'Fetch failed');
    showToast(`❌ ${err.message}`, 'error');
    console.error('[TeamTrack] Fetch error:', err);
    if (allRows.length === 0) {
      // Show empty tables
      renderTasksTable([]);
      renderExpensesTable([]);
    }
  } finally {
    btn.classList.remove('spinning');
  }
}

// ═══════════════════════════════════════════════════════
// POPULATE FILTER DROPDOWNS
// ═══════════════════════════════════════════════════════
function populateFilters() {
  const teams    = [...new Set(allRows.map(r => getVal(r, 'team')).filter(Boolean))].sort();
  const statuses = [...new Set(allRows.map(r => getVal(r, 'status')).filter(Boolean))].sort();

  const teamSelects   = ['teamFilterOverview', 'teamFilterTasks', 'teamFilterExpenses'];
  const statusSelects = ['statusFilterOverview', 'statusFilterTasks'];

  teamSelects.forEach(id => {
    const sel = document.getElementById(id);
    const cur = sel.value;
    sel.innerHTML = '<option value="">All Teams</option>' +
      teams.map(t => `<option value="${t}">${t}</option>`).join('');
    sel.value = teams.includes(cur) ? cur : '';
  });

  statusSelects.forEach(id => {
    const sel = document.getElementById(id);
    const cur = sel.value;
    sel.innerHTML = '<option value="">All Statuses</option>' +
      statuses.map(s => `<option value="${s}">${s}</option>`).join('');
    sel.value = statuses.includes(cur) ? cur : '';
  });
}

// ═══════════════════════════════════════════════════════
// FILTERING + SEARCH
// ═══════════════════════════════════════════════════════
function applyFilters() {
  const q         = (document.getElementById('globalSearch').value || '').toLowerCase().trim();
  const teamOv    = document.getElementById('teamFilterOverview').value;
  const statOv    = document.getElementById('statusFilterOverview').value;
  const teamTasks = document.getElementById('teamFilterTasks').value;
  const statTasks = document.getElementById('statusFilterTasks').value;
  const dateStart = document.getElementById('dateFilterStart').value;
  const dateEnd   = document.getElementById('dateFilterEnd').value;
  const teamExp   = document.getElementById('teamFilterExpenses').value;

  // Determine active section to pick right filters
  const activeSection = document.querySelector('.section.active')?.id || 'overview';

  let teamF = '', statF = '';
  if (activeSection === 'overview') { teamF = teamOv; statF = statOv; }
  else if (activeSection === 'tasks') { teamF = teamTasks; statF = statTasks; }
  else if (activeSection === 'expenses') { teamF = teamExp; }

  filteredRows = allRows.filter(row => {
    const team     = getVal(row, 'team');
    const task     = getVal(row, 'task');
    const assignee = getVal(row, 'assignee');
    const status   = getVal(row, 'status');
    const due      = getVal(row, 'dueDate');

    if (teamF && team !== teamF) return false;
    if (statF && status !== statF) return false;

    if (dateStart && due) {
      if (new Date(due) < new Date(dateStart)) return false;
    }
    if (dateEnd && due) {
      if (new Date(due) > new Date(dateEnd)) return false;
    }

    if (q) {
      const haystack = [team, task, assignee, status].join(' ').toLowerCase();
      if (!haystack.includes(q)) return false;
    }

    return true;
  });

  tasksPage   = 1;
  expensesPage = 1;

  renderSummaryCards(filteredRows);
  renderTeamSummaryTable(filteredRows);
  renderTasksTable(filteredRows);
  renderExpensesTable(filteredRows);
  renderCharts(filteredRows);

  document.getElementById('taskCount').textContent =
    `${filteredRows.length} record${filteredRows.length !== 1 ? 's' : ''}`;
}

// ═══════════════════════════════════════════════════════
// SUMMARY CARDS
// ═══════════════════════════════════════════════════════
function renderSummaryCards(rows) {
  const totalBudget    = rows.reduce((s, r) => s + parseNum(getVal(r, 'budget')),   0);
  const totalExpense   = rows.reduce((s, r) => s + parseNum(getVal(r, 'expense')),  0);
  const totalRemaining = rows.reduce((s, r) => s + parseNum(getVal(r, 'remaining')), 0);

  // If "remaining" column not present, calculate it
  const calcRemaining  = totalBudget - totalExpense;
  const rem = totalRemaining || calcRemaining;

  const statuses   = rows.map(r => String(getVal(r, 'status')).toLowerCase());
  const active     = statuses.filter(s => s.includes('progress') || s.includes('active') || s.includes('ongoing')).length;
  const completed  = statuses.filter(s => s.includes('complet') || s === 'done').length;
  const teams      = new Set(rows.map(r => getVal(r, 'team')).filter(Boolean)).size;

  const expPct  = totalBudget ? Math.min(100, (totalExpense / totalBudget) * 100) : 0;
  const remPct  = totalBudget ? Math.min(100, (rem / totalBudget) * 100) : 0;
  const actPct  = rows.length  ? (active / rows.length) * 100 : 0;
  const doPct   = rows.length  ? (completed / rows.length) * 100 : 0;

  setText('totalBudget',    fmt(totalBudget));
  setText('totalExpense',   fmt(totalExpense));
  setText('totalRemaining', fmt(rem));
  setText('activeTasks',    active.toString());
  setText('completedTasks', completed.toString());
  setText('totalTeams',     teams.toString());

  setText('budgetMeta',    `${rows.length} total records`);
  setText('expenseMeta',   `${expPct.toFixed(1)}% of budget used`);
  setText('remainingMeta', `${remPct.toFixed(1)}% budget left`);
  setText('activeTasksMeta', `${rows.length} total tasks`);
  setText('completedMeta',  `${rows.length ? ((completed/rows.length)*100).toFixed(0) : 0}% completion rate`);
  setText('teamsMeta',      `Across ${rows.length} tasks`);

  // Animate bars (small delay so transition fires)
  setTimeout(() => {
    setBarWidth('expenseBar',   expPct);
    setBarWidth('remainingBar', remPct);
    setBarWidth('activeBar',    actPct);
    setBarWidth('completedBar', doPct);
  }, 50);
}

function setText(id, val) {
  const el = document.getElementById(id);
  if (el) el.textContent = val;
}

function setBarWidth(id, pct) {
  const el = document.getElementById(id);
  if (el) el.style.width = pct + '%';
}

// ═══════════════════════════════════════════════════════
// TEAM SUMMARY TABLE (Overview section)
// ═══════════════════════════════════════════════════════
function renderTeamSummaryTable(rows) {
  const tbody = document.getElementById('teamSummaryBody');

  const byTeam = {};
  for (const row of rows) {
    const t = getVal(row, 'team') || 'Unknown';
    if (!byTeam[t]) byTeam[t] = { budget: 0, expense: 0, remaining: 0, tasks: 0, completed: 0 };
    byTeam[t].budget    += parseNum(getVal(row, 'budget'));
    byTeam[t].expense   += parseNum(getVal(row, 'expense'));
    byTeam[t].remaining += parseNum(getVal(row, 'remaining')) || (parseNum(getVal(row, 'budget')) - parseNum(getVal(row, 'expense')));
    byTeam[t].tasks     += 1;
    const st = String(getVal(row, 'status')).toLowerCase();
    if (st.includes('complet') || st === 'done') byTeam[t].completed += 1;
  }

  const teams = Object.entries(byTeam).sort((a, b) => b[1].expense - a[1].expense);

  if (teams.length === 0) {
    tbody.innerHTML = `<tr><td colspan="7" class="empty-state">No data available</td></tr>`;
    return;
  }

  tbody.innerHTML = teams.map(([name, d]) => {
    const pct = d.budget ? Math.min(100, (d.expense / d.budget) * 100) : 0;
    const col = usageColor(pct);
    return `<tr>
      <td><strong>${name}</strong></td>
      <td class="amt">${fmt(d.budget)}</td>
      <td class="amt">${fmt(d.expense)}</td>
      <td class="amt ${d.remaining >= 0 ? 'amt-pos' : 'amt-neg'}">${fmt(d.remaining)}</td>
      <td>
        <div class="usage-cell">
          <div class="mini-bar">
            <div class="mini-bar-fill" style="width:${pct}%;background:${col}"></div>
          </div>
          <span class="mini-pct">${pct.toFixed(1)}%</span>
        </div>
      </td>
      <td>${d.tasks}</td>
      <td>${d.completed}</td>
    </tr>`;
  }).join('');
}

// ═══════════════════════════════════════════════════════
// TASKS TABLE
// ═══════════════════════════════════════════════════════
function renderTasksTable(rows) {
  const tbody     = document.getElementById('tasksBody');
  const footerEl  = document.getElementById('tasksPagination');

  let sorted = sortRows([...rows], tasksSortCol, tasksSortDir);

  if (sorted.length === 0) {
    tbody.innerHTML = `<tr><td colspan="9"><div class="empty-state">
      <strong>No tasks found</strong>
      <p>Try adjusting your search or filters.</p>
    </div></td></tr>`;
    footerEl.innerHTML = '';
    return;
  }

  const totalPages = Math.ceil(sorted.length / ROWS_PER_PAGE);
  const start      = (tasksPage - 1) * ROWS_PER_PAGE;
  const page       = sorted.slice(start, start + ROWS_PER_PAGE);

  tbody.innerHTML = page.map(row => {
    const budget   = parseNum(getVal(row, 'budget'));
    const expense  = parseNum(getVal(row, 'expense'));
    const rem      = parseNum(getVal(row, 'remaining')) || (budget - expense);
    const pct      = budget ? Math.min(100, (expense / budget) * 100) : 0;
    const col      = usageColor(pct);
    return `<tr>
      <td>${getVal(row, 'team') || '—'}</td>
      <td>${getVal(row, 'task') || '—'}</td>
      <td>${getVal(row, 'assignee') || '—'}</td>
      <td class="amt">${fmt(budget)}</td>
      <td>
        <div class="usage-cell">
          <div class="mini-bar"><div class="mini-bar-fill" style="width:${pct}%;background:${col}"></div></div>
          <span class="amt">${fmt(expense)}</span>
        </div>
      </td>
      <td class="amt ${rem >= 0 ? 'amt-pos' : 'amt-neg'}">${fmt(rem)}</td>
      <td>${statusBadge(getVal(row, 'status'))}</td>
      <td>${fmtDate(getVal(row, 'dueDate'))}</td>
      <td style="max-width:160px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis" title="${getVal(row, 'remarks')}">${getVal(row, 'remarks') || '—'}</td>
    </tr>`;
  }).join('');

  footerEl.innerHTML = paginationHTML(tasksPage, totalPages, sorted.length, 'tasks');
}

// ═══════════════════════════════════════════════════════
// EXPENSES TABLE
// ═══════════════════════════════════════════════════════
function renderExpensesTable(rows) {
  const tbody    = document.getElementById('expensesBody');
  const footerEl = document.getElementById('expensesPagination');

  let sorted = sortRows([...rows], expSortCol, expSortDir);

  if (sorted.length === 0) {
    tbody.innerHTML = `<tr><td colspan="9"><div class="empty-state">
      <strong>No records found</strong>
      <p>Try adjusting your filters.</p>
    </div></td></tr>`;
    footerEl.innerHTML = '';
    return;
  }

  const totalPages = Math.ceil(sorted.length / ROWS_PER_PAGE);
  const start      = (expensesPage - 1) * ROWS_PER_PAGE;
  const page       = sorted.slice(start, start + ROWS_PER_PAGE);

  tbody.innerHTML = page.map(row => {
    const budget  = parseNum(getVal(row, 'budget'));
    const expense = parseNum(getVal(row, 'expense'));
    const rem     = parseNum(getVal(row, 'remaining')) || (budget - expense);
    const pct     = budget ? Math.min(100, (expense / budget) * 100) : 0;
    const col     = usageColor(pct);
    return `<tr>
      <td>${getVal(row, 'team') || '—'}</td>
      <td>${getVal(row, 'task') || '—'}</td>
      <td>${getVal(row, 'assignee') || '—'}</td>
      <td class="amt">${fmtFull(budget)}</td>
      <td class="amt">${fmtFull(expense)}</td>
      <td class="amt ${rem >= 0 ? 'amt-pos' : 'amt-neg'}">${fmtFull(rem)}</td>
      <td>
        <div class="usage-cell">
          <div class="mini-bar"><div class="mini-bar-fill" style="width:${pct}%;background:${col}"></div></div>
          <span class="mini-pct">${pct.toFixed(1)}%</span>
        </div>
      </td>
      <td>${statusBadge(getVal(row, 'status'))}</td>
      <td>${fmtDate(getVal(row, 'updated'))}</td>
    </tr>`;
  }).join('');

  footerEl.innerHTML = paginationHTML(expensesPage, totalPages, sorted.length, 'expenses');
}

// ═══════════════════════════════════════════════════════
// SORTING
// ═══════════════════════════════════════════════════════
function sortRows(rows, col, dir) {
  if (!col) return rows;
  return rows.sort((a, b) => {
    let va, vb;
    if (col === 'budget')  { va = parseNum(getVal(a, 'budget'));  vb = parseNum(getVal(b, 'budget'));  }
    if (col === 'expense') { va = parseNum(getVal(a, 'expense')); vb = parseNum(getVal(b, 'expense')); }
    if (col === 'team')    { va = getVal(a, 'team');  vb = getVal(b, 'team');  }
    if (col === 'task')    { va = getVal(a, 'task');  vb = getVal(b, 'task');  }
    if (col === 'duedate') {
      va = new Date(getVal(a, 'dueDate') || 0).getTime();
      vb = new Date(getVal(b, 'dueDate') || 0).getTime();
    }
    if (typeof va === 'string') va = va.toLowerCase();
    if (typeof vb === 'string') vb = vb.toLowerCase();
    if (va < vb) return dir === 'asc' ? -1 :  1;
    if (va > vb) return dir === 'asc' ?  1 : -1;
    return 0;
  });
}

// ═══════════════════════════════════════════════════════
// PAGINATION HTML
// ═══════════════════════════════════════════════════════
function paginationHTML(page, total, count, table) {
  if (total <= 1) return `<span>${count} record${count !== 1 ? 's' : ''}</span>`;
  const start = (page - 1) * ROWS_PER_PAGE + 1;
  const end   = Math.min(page * ROWS_PER_PAGE, count);

  let pages = '';
  const range = 2;
  for (let i = 1; i <= total; i++) {
    if (i === 1 || i === total || (i >= page - range && i <= page + range)) {
      pages += `<button class="pag-btn ${i === page ? 'active' : ''}"
        onclick="goPage('${table}', ${i})">${i}</button>`;
    } else if (i === page - range - 1 || i === page + range + 1) {
      pages += `<span class="pag-btn" style="border:none;color:var(--text-muted)">…</span>`;
    }
  }

  return `
    <span>Showing ${start}–${end} of ${count} records</span>
    <div class="pagination-btns">
      <button class="pag-btn" onclick="goPage('${table}', ${page - 1})" ${page === 1 ? 'disabled' : ''}>‹</button>
      ${pages}
      <button class="pag-btn" onclick="goPage('${table}', ${page + 1})" ${page === total ? 'disabled' : ''}>›</button>
    </div>`;
}

window.goPage = function(table, page) {
  if (table === 'tasks') {
    tasksPage = page;
    renderTasksTable(filteredRows);
  } else {
    expensesPage = page;
    renderExpensesTable(filteredRows);
  }
  document.getElementById(table).scrollIntoView({ behavior: 'smooth', block: 'start' });
};

// ═══════════════════════════════════════════════════════
// CHARTS
// ═══════════════════════════════════════════════════════
const CHART_DEFAULTS = {
  color: '#7E8FA6',
  borderColor: 'rgba(255,255,255,0.06)',
  gridColor: 'rgba(255,255,255,0.05)',
  font: { family: 'Inter, sans-serif', size: 11 },
};

function destroyChart(key) {
  if (charts[key]) { charts[key].destroy(); delete charts[key]; }
}

function renderCharts(rows) {
  // ── Build team aggregates
  const byTeam = {};
  for (const row of rows) {
    const t = getVal(row, 'team') || 'Unknown';
    if (!byTeam[t]) byTeam[t] = { budget: 0, expense: 0 };
    byTeam[t].budget  += parseNum(getVal(row, 'budget'));
    byTeam[t].expense += parseNum(getVal(row, 'expense'));
  }
  const teams   = Object.keys(byTeam);
  const budgets = teams.map(t => byTeam[t].budget);
  const expenses= teams.map(t => byTeam[t].expense);

  // ── Status distribution
  const statusCount = {};
  for (const row of rows) {
    const s = getVal(row, 'status') || 'Unknown';
    statusCount[s] = (statusCount[s] || 0) + 1;
  }

  // ── Monthly expense
  const monthly = {};
  for (const row of rows) {
    const d = getVal(row, 'dueDate') || getVal(row, 'updated');
    if (!d) continue;
    const dt = new Date(d);
    if (isNaN(dt.getTime())) continue;
    const key = dt.toLocaleString('en-IN', { month: 'short', year: '2-digit' });
    monthly[key] = (monthly[key] || 0) + parseNum(getVal(row, 'expense'));
  }
  const monthKeys = Object.keys(monthly).sort((a, b) => new Date('1 ' + a) - new Date('1 ' + b));

  // ── Utilization %
  const utilPct = teams.map(t => byTeam[t].budget ? Math.min(100, (byTeam[t].expense / byTeam[t].budget) * 100) : 0);

  // Chart 1: Budget vs Expense (grouped bar)
  destroyChart('budgetExpense');
  const ctx1 = document.getElementById('budgetExpenseChart').getContext('2d');
  charts.budgetExpense = new Chart(ctx1, {
    type: 'bar',
    data: {
      labels: teams,
      datasets: [
        { label: 'Budget',  data: budgets,  backgroundColor: 'rgba(45,156,219,0.75)', borderRadius: 4 },
        { label: 'Expense', data: expenses, backgroundColor: 'rgba(235,87,87,0.75)',  borderRadius: 4 },
      ],
    },
    options: chartOptions({ yTickFmt: v => fmt(v) }),
  });

  // Chart 2: Status doughnut
  destroyChart('status');
  const ctx2 = document.getElementById('statusChart').getContext('2d');
  const statLabels = Object.keys(statusCount);
  charts.status = new Chart(ctx2, {
    type: 'doughnut',
    data: {
      labels: statLabels,
      datasets: [{
        data: statLabels.map(s => statusCount[s]),
        backgroundColor: PALETTE.slice(0, statLabels.length),
        borderWidth: 2,
        borderColor: '#1A2740',
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { position: 'bottom', labels: { color: CHART_DEFAULTS.color, font: CHART_DEFAULTS.font, padding: 12 } },
        tooltip: { bodyColor: '#fff', backgroundColor: '#1F3050', borderColor: CHART_DEFAULTS.borderColor, borderWidth: 1 },
      },
      cutout: '65%',
    },
  });

  // Chart 3: Monthly trend (line)
  destroyChart('monthly');
  const ctx3 = document.getElementById('monthlyChart').getContext('2d');
  charts.monthly = new Chart(ctx3, {
    type: 'line',
    data: {
      labels: monthKeys,
      datasets: [{
        label: 'Monthly Expense',
        data: monthKeys.map(k => monthly[k]),
        borderColor: '#2D9CDB',
        backgroundColor: 'rgba(45,156,219,0.1)',
        fill: true,
        tension: 0.4,
        pointBackgroundColor: '#2D9CDB',
        pointRadius: 4,
      }],
    },
    options: chartOptions({ yTickFmt: v => fmt(v) }),
  });

  // Chart 4: Utilization horizontal bar
  destroyChart('utilization');
  const ctx4 = document.getElementById('utilizationChart').getContext('2d');
  charts.utilization = new Chart(ctx4, {
    type: 'bar',
    data: {
      labels: teams,
      datasets: [{
        label: 'Budget Used (%)',
        data: utilPct,
        backgroundColor: utilPct.map(p => p >= 90 ? 'rgba(235,87,87,0.75)' : p >= 70 ? 'rgba(242,153,74,0.75)' : 'rgba(39,174,96,0.75)'),
        borderRadius: 4,
      }],
    },
    options: chartOptions({ yTickFmt: v => v + '%', max: 100 }),
  });
}

function chartOptions({ yTickFmt, max } = {}) {
  return {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: { labels: { color: CHART_DEFAULTS.color, font: CHART_DEFAULTS.font } },
      tooltip: {
        bodyColor: '#fff',
        backgroundColor: '#1F3050',
        borderColor: 'rgba(255,255,255,0.08)',
        borderWidth: 1,
      },
    },
    scales: {
      x: {
        ticks: { color: CHART_DEFAULTS.color, font: CHART_DEFAULTS.font },
        grid:  { color: CHART_DEFAULTS.gridColor },
      },
      y: {
        ticks: {
          color: CHART_DEFAULTS.color,
          font: CHART_DEFAULTS.font,
          callback: yTickFmt || (v => v),
        },
        grid:  { color: CHART_DEFAULTS.gridColor },
        ...(max !== undefined ? { max } : {}),
      },
    },
  };
}

// ═══════════════════════════════════════════════════════
// NAVIGATION
// ═══════════════════════════════════════════════════════
function showSection(id) {
  document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  const section = document.getElementById(id);
  if (section) section.classList.add('active');
  const navItem = document.querySelector(`.nav-item[data-section="${id}"]`);
  if (navItem) navItem.classList.add('active');

  // Re-apply filters when switching sections so the right filters apply
  if (allRows.length) applyFilters();

  // On mobile, close sidebar
  closeSidebar();
}

function closeSidebar() {
  document.getElementById('sidebar').classList.remove('open');
  document.getElementById('overlay').classList.remove('show');
}

// ═══════════════════════════════════════════════════════
// SETUP MODAL
// ═══════════════════════════════════════════════════════
const STORAGE_KEY_URL = 'teamtrack_sheet_url';

function showSetupModal() {
  const modal = document.getElementById('setupModal');
  const saved = localStorage.getItem(STORAGE_KEY_URL);
  if (saved) document.getElementById('sheetUrl').value = saved;
  modal.style.display = 'flex';
}

function hideSetupModal() {
  document.getElementById('setupModal').style.display = 'none';
}

// ═══════════════════════════════════════════════════════
// SAMPLE DATA LOADER (for demo/testing)
// ═══════════════════════════════════════════════════════
function loadSampleCSV(csv) {
  if (!csv || csv.trim().length < 10) {
    showToast('Please paste valid CSV data.', 'error');
    return;
  }
  const parsed = Papa.parse(csv.trim(), {
    header: true,
    skipEmptyLines: true,
    transformHeader: h => h.trim(),
  });
  if (!parsed.data || parsed.data.length === 0) {
    showToast('Could not parse the pasted CSV.', 'error');
    return;
  }
  buildHeaderMap(parsed.meta.fields || []);
  allRows = parsed.data;
  populateFilters();
  applyFilters();
  setStatus('connected', `Demo — ${allRows.length} rows`);
  showToast(`✓ Loaded ${allRows.length} demo records`, 'success');
  hideSetupModal();
}

// Built-in realistic sample data
const BUILT_IN_SAMPLE = `Team Name,Task Name,Budget,Expense,Remaining Budget,Task Status,Assigned To,Start Date,Due Date,Remarks,Last Updated
Alpha,Website Redesign,500000,320000,180000,In Progress,Rahul Sharma,2024-01-01,2024-03-31,On track,2024-02-15
Alpha,SEO Audit,150000,150000,0,Completed,Priya Mehta,2024-01-10,2024-02-10,Delivered on time,2024-02-10
Alpha,Content Strategy,80000,25000,55000,In Progress,Rahul Sharma,2024-02-01,2024-04-30,Awaiting review,2024-02-20
Beta,Mobile App Development,800000,450000,350000,In Progress,Vikram Nair,2024-01-15,2024-04-30,Delayed by 2 weeks,2024-02-20
Beta,QA Testing,200000,60000,140000,In Progress,Anita Rao,2024-02-15,2024-04-15,Running parallel,2024-02-18
Beta,UI/UX Design,120000,120000,0,Completed,Sneha Pillai,2024-01-05,2024-02-28,Approved,2024-02-28
Gamma,Server Migration,350000,280000,70000,In Progress,Arjun Singh,2024-01-20,2024-03-20,Risk: downtime window,2024-02-17
Gamma,Database Optimization,90000,90000,0,Completed,Meera Das,2024-01-25,2024-02-25,Completed ahead of schedule,2024-02-20
Gamma,Security Audit,120000,40000,80000,In Progress,Kiran Patel,2024-02-01,2024-03-31,Phase 1 done,2024-02-22
Delta,Marketing Campaign,600000,520000,80000,In Progress,Divya Iyer,2024-01-01,2024-03-31,Over budget risk,2024-02-19
Delta,Social Media,100000,100000,0,Completed,Ravi Kumar,2024-01-10,2024-02-10,High engagement,2024-02-10
Delta,Email Campaign,150000,45000,105000,On Hold,Pooja Verma,2024-02-05,2024-04-05,Paused for approval,2024-02-16
Epsilon,Product Research,250000,180000,70000,In Progress,Anil Gupta,2024-01-12,2024-03-12,Market analysis done,2024-02-14
Epsilon,Competitor Analysis,80000,80000,0,Completed,Neha Joshi,2024-01-20,2024-02-20,Report submitted,2024-02-20
Epsilon,Prototype Development,300000,120000,180000,In Progress,Sanjay Mishra,2024-02-01,2024-05-01,On schedule,2024-02-21
Zeta,HR Recruitment,180000,90000,90000,In Progress,Kavita Shah,2024-01-08,2024-03-08,5 positions filled,2024-02-15
Zeta,Training Program,250000,250000,0,Completed,Deepak Tiwari,2024-01-15,2024-02-15,All 20 employees trained,2024-02-15
Zeta,Performance Reviews,60000,15000,45000,In Progress,Sunita Nair,2024-02-10,2024-03-10,In progress,2024-02-18`;

// ═══════════════════════════════════════════════════════
// SORT CLICK HANDLERS (tables)
// ═══════════════════════════════════════════════════════
function attachSortHandlers(tableId, which) {
  const table = document.getElementById(tableId);
  if (!table) return;
  table.querySelectorAll('th.sortable').forEach(th => {
    th.addEventListener('click', () => {
      const col = th.dataset.col;
      let curCol = which === 'tasks' ? tasksSortCol : expSortCol;
      let curDir = which === 'tasks' ? tasksSortDir : expSortDir;
      if (curCol === col) {
        curDir = curDir === 'asc' ? 'desc' : 'asc';
      } else {
        curCol = col; curDir = 'asc';
      }
      if (which === 'tasks') { tasksSortCol = curCol; tasksSortDir = curDir; tasksPage = 1; }
      else                   { expSortCol   = curCol; expSortDir   = curDir; expensesPage = 1; }

      // Update header arrows
      table.querySelectorAll('th.sortable').forEach(h => {
        h.classList.remove('sort-asc', 'sort-desc');
        if (h.dataset.col === curCol) h.classList.add(curDir === 'asc' ? 'sort-asc' : 'sort-desc');
      });

      if (which === 'tasks') renderTasksTable(filteredRows);
      else renderExpensesTable(filteredRows);
    });
  });
}

// ═══════════════════════════════════════════════════════
// INIT
// ═══════════════════════════════════════════════════════
document.addEventListener('DOMContentLoaded', () => {

  // ── Sidebar / mobile nav
  document.getElementById('menuToggle').addEventListener('click', () => {
    document.getElementById('sidebar').classList.add('open');
    document.getElementById('overlay').classList.add('show');
  });
  document.getElementById('sidebarClose').addEventListener('click', closeSidebar);
  document.getElementById('overlay').addEventListener('click', closeSidebar);

  // ── Nav links
  document.querySelectorAll('.nav-item').forEach(item => {
    item.addEventListener('click', e => {
      e.preventDefault();
      showSection(item.dataset.section);
    });
  });

  // ── Global search
  const searchInput = document.getElementById('globalSearch');
  const searchClear = document.getElementById('searchClear');
  let searchTimer;
  searchInput.addEventListener('input', () => {
    searchClear.style.display = searchInput.value ? 'block' : 'none';
    clearTimeout(searchTimer);
    searchTimer = setTimeout(applyFilters, 300);
  });
  searchClear.addEventListener('click', () => {
    searchInput.value = '';
    searchClear.style.display = 'none';
    applyFilters();
  });

  // ── Filters
  ['teamFilterOverview','statusFilterOverview',
   'teamFilterTasks','statusFilterTasks',
   'dateFilterStart','dateFilterEnd',
   'teamFilterExpenses'].forEach(id => {
    document.getElementById(id)?.addEventListener('change', applyFilters);
  });

  document.getElementById('clearFilters')?.addEventListener('click', () => {
    document.getElementById('teamFilterTasks').value   = '';
    document.getElementById('statusFilterTasks').value = '';
    document.getElementById('dateFilterStart').value   = '';
    document.getElementById('dateFilterEnd').value     = '';
    applyFilters();
  });
  document.getElementById('clearFiltersExp')?.addEventListener('click', () => {
    document.getElementById('teamFilterExpenses').value = '';
    applyFilters();
  });

  // ── Sort handlers
  attachSortHandlers('tasksTable', 'tasks');
  attachSortHandlers('expensesTable', 'expenses');
  attachSortHandlers('teamSummaryTable', 'summary');

  // ── Refresh button
  document.getElementById('refreshBtn').addEventListener('click', () => {
    const url = localStorage.getItem(STORAGE_KEY_URL);
    if (url) fetchSheet(url);
    else showToast('No sheet URL configured. Click the setup button.', 'info');
  });

  // ── Setup modal
  document.getElementById('saveSheetUrl').addEventListener('click', () => {
    const url = document.getElementById('sheetUrl').value.trim();
    if (!url) { showToast('Please enter a URL.', 'error'); return; }
    if (!url.startsWith('https://docs.google.com/spreadsheets')) {
      showToast('URL should be a Google Sheets URL.', 'error'); return;
    }
    // Ensure CSV format
    let finalUrl = url;
    if (!finalUrl.includes('output=csv') && !finalUrl.includes('pub?')) {
      finalUrl = finalUrl.includes('?') ? finalUrl + '&output=csv' : finalUrl + '?output=csv';
    }
    localStorage.setItem(STORAGE_KEY_URL, finalUrl);
    hideSetupModal();
    fetchSheet(finalUrl);
    // Auto-refresh loop
    clearInterval(refreshTimer);
    refreshTimer = setInterval(() => fetchSheet(finalUrl), REFRESH_INTERVAL);
  });

  document.getElementById('loadSample').addEventListener('click', () => {
    const custom = document.getElementById('sampleData').value.trim();
    loadSampleCSV(custom || BUILT_IN_SAMPLE);
  });

  // ── Auto-start
  const savedUrl = localStorage.getItem(STORAGE_KEY_URL);
  if (savedUrl) {
    hideSetupModal();
    document.getElementById('setupModal').style.display = 'none';
    fetchSheet(savedUrl);
    refreshTimer = setInterval(() => fetchSheet(savedUrl), REFRESH_INTERVAL);
  } else {
    // No URL saved → show setup modal
    showSetupModal();
    // Load built-in sample in the background so the dashboard isn't empty
    setTimeout(() => {
      loadSampleCSV(BUILT_IN_SAMPLE);
      document.getElementById('setupModal').style.display = 'flex'; // keep modal open
    }, 300);
  }
});
