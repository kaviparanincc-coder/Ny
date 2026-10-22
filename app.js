import * as S from './store.js';
import * as L from './logic.js';
import * as D from './dates.js';
import { icon } from './icons.js';
import {
  $, h, bool, announce, toast, openDialog, closeDialog, initDialogs, fillSheet, confirmDialog,
  enableDrag, downloadText, shareText,
} from './ui-kit.js';
import { isNative, requestNativePermission, syncNativeReminders } from './native.js';

const today = () => D.toKey(new Date());
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

// ------------------------------------------------------------------ UI state
const ui = {
  calMonth: null,           // {y, m}
  selected: null,           // selected calendar date key
  filter: 'open',
  query: '',
  reorder: false,
  attentionAll: false,
  importError: null,
  snapshot: null,
  deferredPrompt: null,
  sw: { supported: 'serviceWorker' in navigator, registered: false, controlled: false, ready: null, cached: null, expected: null, version: null, error: null },
  updateWaiting: null,
};
let route = { view: 'today', sub: null };
let lastRouteKey = '';
let lastRenderedDay = today();

const NAV = [
  { id: 'today', label: 'Today', icon: 'today' },
  { id: 'calendar', label: 'Calendar', icon: 'calendar' },
  { id: 'all', label: 'All tasks', icon: 'list' },
  { id: 'more', label: 'More', icon: 'more' },
];
const MORE_TITLES = { backup: 'Backup & restore', reminders: 'Reminders', appearance: 'Appearance', install: 'Install & offline', about: 'About & privacy' };

// ------------------------------------------------------------------ routing
function parseHash() {
  const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  const view = NAV.some((n) => n.id === parts[0]) ? parts[0] : 'today';
  const r = { view, sub: null };
  if (view === 'more' && MORE_TITLES[parts[1]]) r.sub = parts[1];
  if (view === 'all' && L.FILTERS.includes(parts[1])) ui.filter = parts[1];
  return r;
}
function go(path) {
  if (location.hash !== path) location.hash = path;
  route = parseHash();
  render(); // render now; the hashchange event that follows just re-renders the same view
}
window.addEventListener('hashchange', () => { route = parseHash(); render(); });

// ------------------------------------------------------------------ theme
function applyTheme() {
  const t = S.getSettings().theme;
  if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t; else delete document.documentElement.dataset.theme;
  const bg = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
  $('#theme-color').setAttribute('content', bg || '#FAF7F2');
}
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);

// ------------------------------------------------------------------ formatting helpers
const PRIORITY_ORDER = L.PRIORITIES;

function priorityChip(p) {
  return h('span', { class: `chip p-${p}` }, h('span', { class: `shape ${p}`, 'aria-hidden': 'true' }), L.PRIORITY_LABEL[p], h('span', { class: 'sr-only' }, ' priority'));
}

function whenInfo(t, now, showDate) {
  const time = t.dueTime ? D.formatTime(t.dueTime) : null;
  if (t.done) {
    const when = t.completedAt ? `Completed ${D.formatShort(D.toKey(new Date(t.completedAt)), now)}` : 'Completed';
    return { text: when, overdue: false };
  }
  if (!t.dueDate) return { text: 'No date', overdue: false };
  const n = D.diffDays(now, t.dueDate);
  let text;
  if (!showDate) text = time || '';
  else if (n < 0) text = `Overdue by ${plural(-n, 'day')} · ${D.formatShort(t.dueDate, now)}`;
  else if (n === 0) text = 'Today';
  else if (n === 1) text = 'Tomorrow';
  else if (n <= 7) text = `${D.formatShort(t.dueDate, now)} · in ${n} days`;
  else text = D.formatShort(t.dueDate, now);
  if (showDate && time) text += ` · ${time}`;
  return { text, overdue: n < 0 };
}

// ------------------------------------------------------------------ actions
async function safe(fn, failMsg = 'Something went wrong.') {
  try { return await fn(); } catch (err) {
    toast(`${failMsg} ${err && err.message ? err.message : ''}`.trim(), { timeout: 8000 });
    return undefined;
  }
}

async function toggleDone(id, { fromSheet = false } = {}) {
  const cur = S.getTask(id);
  if (!cur) return;
  const res = await safe(() => S.setTaskDone(id, !cur.done), 'Could not save the change.');
  if (!res) return;
  if (fromSheet) closeDialog($('#sheet'));
  const msg = res.after.done ? 'Marked complete' : 'Reopened';
  announce(`${res.after.title}: ${msg}`);
  toast(msg, { action: { label: 'Undo', fn: () => safe(() => S.restoreTasks([res.before]), 'Could not undo.') } });
}

async function removeTask(id) {
  const t = S.getTask(id);
  if (!t) return;
  const ok = await confirmDialog({ title: 'Delete this task?', message: `“${t.title}” will be deleted. You will have a few seconds to undo.`, confirmLabel: 'Delete', danger: true });
  if (!ok) return;
  const removed = await safe(() => S.deleteTask(id), 'Could not delete the task.');
  if (!removed) return;
  closeDialog($('#sheet'));
  toast('Task deleted', { timeout: 8000, action: { label: 'Undo', fn: () => safe(() => S.restoreTasks([removed]), 'Could not undo.') } });
}

async function moveTask(id, delta, groupIds) {
  const next = L.moveInList(groupIds, id, delta);
  if (next.join() === groupIds.join()) return;
  const t = S.getTask(id);
  await safe(() => S.reorder(next), 'Could not save the new order.');
  announce(`${t ? t.title : 'Task'} moved to position ${next.indexOf(id) + 1} of ${next.length}`);
}

async function commitDragOrder(ids, movedId) {
  const t = S.getTask(movedId);
  await safe(() => S.reorder(ids), 'Could not save the new order.');
  announce(`${t ? t.title : 'Task'} moved to position ${ids.indexOf(movedId) + 1} of ${ids.length}`);
}

// ------------------------------------------------------------------ task rows
function taskRow(t, o = {}) {
  const now = today();
  const w = whenInfo(t, now, o.showDate);
  const meta = h('span', { class: 't-meta' },
    priorityChip(t.priority),
    o.chip ? h('span', { class: `chip status-${o.chip.kind}` }, o.chip.text) : null,
    w.text ? h('span', { class: `when${w.overdue ? ' overdue' : ''}` }, w.text) : null,
    t.notes ? h('span', { class: 'chip plain' }, icon('note', 12), 'Notes') : null);
  const li = h('li', { class: `task p-${t.priority}${t.done ? ' done' : ''}`, 'data-id': t.id },
    h('button', { class: 'check', type: 'button', role: 'checkbox', 'aria-checked': bool(t.done), 'aria-label': t.title, 'data-key': `check:${t.id}`, on: { click: () => toggleDone(t.id) } },
      h('span', { class: 'box' }, icon('check', 16))),
    h('button', { class: 'body', type: 'button', 'data-key': `open:${t.id}`, on: { click: () => openDetail(t.id) } },
      h('span', { class: 't-title' }, t.title), meta));
  if (o.group) {
    const ids = o.group.map((x) => x.id);
    const i = ids.indexOf(t.id);
    if (o.reorderButtons) {
      const mv = (delta, name, ic) => h('button', {
        class: 'icon-btn', type: 'button', 'aria-label': `Move ${t.title} ${name}`, 'aria-disabled': bool(i + delta < 0 || i + delta >= ids.length),
        'data-key': `${name}:${t.id}`, on: { click: () => moveTask(t.id, delta, ids) },
      }, icon(ic, 22));
      li.append(h('span', { class: 'movers' }, mv(-1, 'up', 'up'), mv(1, 'down', 'down')));
    } else if (ids.length > 1) {
      li.append(h('button', {
        class: 'handle', type: 'button', 'data-key': `handle:${t.id}`,
        'aria-label': `Reorder ${t.title}. Position ${i + 1} of ${ids.length}. Drag, or press arrow up or arrow down to move.`,
        on: { keydown: (e) => {
          if (e.key === 'ArrowUp' || e.key === 'ArrowDown') { e.preventDefault(); moveTask(t.id, e.key === 'ArrowUp' ? -1 : 1, ids); }
        } },
      }, icon('grip', 22)));
    }
  }
  return li;
}

function taskList(tasks, opts = {}) {
  const ul = h('ul', { class: 'tasklist', role: 'list' }, tasks.map((t) => taskRow(t, opts(t))));
  return ul;
}

function emptyState({ iconName = 'today', title, text, action }) {
  return h('div', { class: 'empty card' }, icon(iconName, 40), h('h3', null, title), text ? h('p', null, text) : null,
    action ? h('button', { class: 'btn primary', type: 'button', on: { click: action.fn } }, icon('plus', 20), action.label) : null);
}

// ------------------------------------------------------------------ TODAY view
function backupNudge() {
  const s = S.getSettings();
  const tasks = S.getTasks();
  if (!tasks.length) return null;
  if (s.backupNudgeSnoozedUntil && s.backupNudgeSnoozedUntil > new Date().toISOString()) return null;
  const DAY = 86400000;
  const oldest = tasks.reduce((m, t) => (t.createdAt < m ? t.createdAt : m), tasks[0].createdAt);
  let text = null;
  if (!s.lastBackupAt) {
    if (Date.now() - Date.parse(oldest) >= 3 * DAY) text = 'You have not saved a backup yet. Your tasks live only on this device.';
  } else if (Date.now() - Date.parse(s.lastBackupAt) >= 30 * DAY) {
    text = `Your last backup was ${Math.floor((Date.now() - Date.parse(s.lastBackupAt)) / DAY)} days ago.`;
  }
  if (!text) return null;
  return h('div', { class: 'banner warn', role: 'region', 'aria-label': 'Backup reminder' }, icon('archive', 22),
    h('div', { class: 'grow' }, h('strong', null, 'Back up your tasks'), h('p', { class: 'small' }, text)),
    h('div', { class: 'btn-row' },
      h('button', { class: 'btn', type: 'button', on: { click: () => go('#/more/backup') } }, 'Back up'),
      h('button', { class: 'btn text', type: 'button', on: { click: () => S.updateSettings({ backupNudgeSnoozedUntil: new Date(Date.now() + 7 * DAY).toISOString() }) } }, 'Later')));
}

function systemBanners() {
  const out = [];
  if (S.status.volatile) {
    out.push(h('div', { class: 'banner error', role: 'alert' }, icon('alert', 22), h('div', { class: 'grow' },
      h('strong', null, 'Tasks are not being saved'),
      h('p', { class: 'small' }, `This browser mode cannot store data${S.status.storageError ? ` (${S.status.storageError})` : ''}. Anything you add will be lost when you close the app. Open My Assistant in a normal Chrome window, or export a backup before closing.`))));
  }
  if (S.status.migrationError) {
    out.push(h('div', { class: 'banner warn', role: 'alert' }, icon('alert', 22), h('div', { class: 'grow' }, h('p', { class: 'small' }, S.status.migrationError))));
  }
  return out;
}

function viewToday() {
  const now = today();
  const all = S.getTasks();
  const list = L.tasksForDate(all, now);
  const prog = L.todayProgress(list);
  const root = h('div');
  root.append(...systemBanners());
  const nudge = backupNudge();
  if (nudge) root.append(nudge);

  const progressText = !prog.total ? 'Nothing scheduled for today'
    : prog.done === prog.total ? `All ${prog.total} done` : `${prog.done} of ${prog.total} done`;
  root.append(h('section', { class: 'section datehead', 'aria-label': 'Today summary' },
    h('h2', null, D.formatLong(now)),
    h('p', { class: 'progress-text' }, progressText),
    prog.total ? h('div', { class: 'progress', role: 'progressbar', 'aria-label': 'Today progress', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(prog.pct) }, h('span', { style: `width:${prog.pct}%` })) : null));

  // quick add
  const quick = h('input', { type: 'text', 'data-key': 'quick', placeholder: 'Add a task for today', 'aria-label': 'Quick add a task for today', maxlength: '200', enterkeyhint: 'done', autocomplete: 'off' });
  root.append(h('form', { class: 'quickadd', on: { submit: async (e) => {
    e.preventDefault();
    const title = quick.value.trim();
    if (!title) { quick.focus(); return; }
    const t = await safe(() => S.addTask({ title, dueDate: now, priority: 'medium' }), 'Could not add the task.');
    if (t) announce(`Added ${t.title} to today`);
  } } }, quick, h('button', { class: 'btn primary', type: 'submit' }, 'Add')));

  // today's tasks (manual order)
  const sec = h('section', { class: 'section', 'aria-labelledby': 'h-today' });
  sec.append(h('div', { class: 'section-head' }, h('h2', { id: 'h-today' }, "Today's tasks", prog.total ? h('span', { class: 'count' }, prog.total) : null),
    list.length > 1 ? h('button', { class: 'btn text', type: 'button', 'aria-pressed': bool(ui.reorder), on: { click: () => { ui.reorder = !ui.reorder; render(); } } }, ui.reorder ? 'Done' : 'Reorder') : null));
  if (!list.length) {
    sec.append(emptyState({ title: 'Nothing planned for today', text: 'Add a task for today, or look at what is coming up.', action: { label: 'Add task', fn: () => openTaskForm({ dueDate: now }) } }));
  } else {
    const ul = taskList(list, () => ({ group: list, reorderButtons: ui.reorder }));
    if (list.length > 1 && !ui.reorder) enableDrag(ul, commitDragOrder);
    sec.append(ul);
    if (list.length > 1) sec.append(h('p', { class: 'hint' }, ui.reorder ? 'Use the arrows to move a task. Your order is saved automatically.' : 'Drag the handle, or tap Reorder. Your order is never changed automatically.'));
  }
  root.append(sec);

  // needs attention
  const att = L.attentionItems(all, now);
  if (att.length) {
    const shown = ui.attentionAll ? att : att.slice(0, 5);
    const s2 = h('section', { class: 'section', 'aria-labelledby': 'h-att' });
    s2.append(h('div', { class: 'section-head' }, h('h2', { id: 'h-att' }, 'Needs attention', h('span', { class: 'count' }, att.length))));
    const kinds = new Map(shown.map((i) => [i.task.id, i.kind]));
    s2.append(taskList(shown.map((i) => i.task), (t) => ({ showDate: true, chip: kinds.get(t.id) === 'soon' ? { kind: 'soon', text: 'Due soon' } : null })));
    if (att.length > 5) s2.append(h('button', { class: 'btn text', type: 'button', on: { click: () => { ui.attentionAll = !ui.attentionAll; render(); } } }, ui.attentionAll ? 'Show fewer' : `Show all ${att.length}`));
    root.append(s2);
  }

  // upcoming preview
  const up = L.upcomingPreview(all, now, new Set(att.map((i) => i.task.id)), 3);
  if (up.length) {
    const s3 = h('section', { class: 'section', 'aria-labelledby': 'h-up' });
    s3.append(h('div', { class: 'section-head' }, h('h2', { id: 'h-up' }, 'Coming up'),
      h('button', { class: 'btn text', type: 'button', on: { click: () => go('#/all/upcoming') } }, 'View all')));
    s3.append(taskList(up, () => ({ showDate: true })));
    root.append(s3);
  }
  return root;
}

// ------------------------------------------------------------------ CALENDAR view
function viewCalendar() {
  const now = today();
  if (!ui.calMonth) ui.calMonth = { y: Number(now.slice(0, 4)), m: Number(now.slice(5, 7)) - 1 };
  if (!ui.selected) ui.selected = now;
  const { y, m } = ui.calMonth;
  const ws = S.getSettings().weekStart;
  const map = L.tasksByDate(S.getTasks());
  const shiftTo = (delta) => {
    ui.calMonth = D.shiftMonth(ui.calMonth, delta);
    const { y: ny, m: nm } = ui.calMonth;
    ui.selected = (Number(now.slice(0, 4)) === ny && Number(now.slice(5, 7)) - 1 === nm) ? now : D.monthKey(ny, nm, 1);
    render();
  };

  const nav = h('div', { class: 'calnav' },
    h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Previous month', on: { click: () => shiftTo(-1) } }, icon('left')),
    h('h2', { 'aria-live': 'polite' }, D.formatMonth(y, m)),
    h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Next month', on: { click: () => shiftTo(1) } }, icon('right')),
    h('button', { class: 'btn', type: 'button', on: { click: () => { ui.calMonth = { y: Number(now.slice(0, 4)), m: Number(now.slice(5, 7)) - 1 }; ui.selected = now; render(); announce(`Showing today, ${D.formatLong(now)}`); } } }, 'Today'));

  const head = h('tr', null, D.weekdayLabels(ws, 'short').map((lab, i) => h('th', { scope: 'col', abbr: D.weekdayLabels(ws, 'long')[i] }, lab)));
  const body = D.calendarGrid(y, m, ws).map((row) => h('tr', null, row.map((cell) => {
    if (!cell) return h('td', { class: 'blank', 'aria-hidden': 'true' });
    const ind = L.dayIndicator(map.get(cell.key) || [], cell.key, now);
    const cls = `day${cell.key === now ? ' today' : ''}${cell.key === ui.selected ? ' selected' : ''}`;
    return h('td', null, h('button', {
      class: cls, type: 'button', 'aria-label': ind.label, 'aria-pressed': bool(cell.key === ui.selected), 'aria-current': cell.key === now ? 'date' : null,
      'data-key': `day:${cell.key}`, on: { click: () => { ui.selected = cell.key; render(); } },
    },
    h('span', { class: 'num', 'aria-hidden': 'true' }, cell.day),
    h('span', { class: 'dots', 'aria-hidden': 'true' }, ind.dots.map((d) => h('span', { class: `dot ${d.priority}${d.done ? ' done' : ''}` })), ind.extra ? `+${ind.extra}` : null),
    ind.overdue ? h('span', { class: 'od', 'aria-hidden': 'true' }, '!') : null));
  })));

  const legend = h('div', { class: 'legend', 'aria-label': 'Legend' },
    h('span', null, h('span', { class: 'dot high' }), 'High'),
    h('span', null, h('span', { class: 'dot medium' }), 'Medium'),
    h('span', null, h('span', { class: 'dot low' }), 'Low'),
    h('span', null, h('span', { class: 'dot high done' }), 'Completed'),
    h('span', null, h('span', { class: 'od' }, '!'), 'Overdue'));

  const grid = h('div', null, nav, h('table', { class: 'cal', role: 'grid', 'aria-label': D.formatMonth(y, m) }, h('thead', null, head), h('tbody', null, body)), legend);

  const dayTasks = map.get(ui.selected) || [];
  const detail = h('section', { 'aria-labelledby': 'h-day' },
    h('div', { class: 'dayhead' }, h('h2', { id: 'h-day' }, D.formatFull(ui.selected)),
      h('button', { class: 'btn', type: 'button', on: { click: () => openTaskForm({ dueDate: ui.selected }) } }, icon('plus', 18), 'Add')));
  if (dayTasks.length) detail.append(taskList(dayTasks, () => ({})));
  else detail.append(h('p', { class: 'muted', style: 'padding:4px 2px' }, ui.selected === now ? 'No tasks today.' : 'No tasks on this day.'));
  return h('div', { class: 'calwrap' }, grid, detail);
}

// ------------------------------------------------------------------ ALL TASKS view
const FILTER_LABEL = { all: 'All', open: 'Open', today: 'Today', upcoming: 'Upcoming', overdue: 'Overdue', unscheduled: 'Unscheduled', completed: 'Completed' };

function viewAll() {
  const root = h('div');
  const list = h('div', { id: 'all-list' });
  const bar = h('div', { class: 'filterbar', role: 'group', 'aria-label': 'Filter tasks' });
  const search = h('input', { type: 'search', 'aria-label': 'Search tasks by title or notes', placeholder: 'Search tasks', value: ui.query, enterkeyhint: 'search', autocomplete: 'off',
    on: { input: (e) => { ui.query = e.target.value; fill(); } } });

  function fill() {
    const now = today();
    const tasks = S.getTasks();
    const counts = L.countByFilter(tasks, now);
    bar.replaceChildren(...L.FILTERS.map((f) => h('button', {
      class: 'fchip', type: 'button', 'aria-pressed': bool(ui.filter === f), 'data-key': `filter:${f}`,
      on: { click: () => { ui.filter = f; history.replaceState(history.state, '', `#/all/${f}`); render(); } },
    }, FILTER_LABEL[f], h('span', { class: 'n' }, counts[f]))));
    const res = L.filterTasks(tasks, { filter: ui.filter, query: ui.query }, now);
    list.replaceChildren(
      h('p', { class: 'hint', style: 'margin:0 2px 8px', role: 'status' }, `${plural(res.length, 'task')}${ui.query.trim() ? ` matching “${ui.query.trim()}”` : ''}`),
      res.length ? taskList(res, () => ({ showDate: true })) : allEmpty());
  }
  function allEmpty() {
    if (ui.query.trim()) return emptyState({ iconName: 'search', title: 'No matches', text: `Nothing in “${FILTER_LABEL[ui.filter]}” matches “${ui.query.trim()}”. Try another filter.` });
    const add = { label: 'Add task', fn: () => openTaskForm({}) };
    const m = {
      all: ['No tasks yet', 'Tap Add task to create your first one.', add],
      open: ['No open tasks', 'You are all caught up.', add],
      today: ['Nothing due today', 'Tasks with today’s date will appear here.', add],
      upcoming: ['Nothing upcoming', 'Tasks with a future date will appear here.', add],
      overdue: ['Nothing overdue', 'Nice. No open task is past its date.', null],
      unscheduled: ['No unscheduled tasks', 'Open tasks without a date will appear here.', add],
      completed: ['Nothing completed yet', 'Finished tasks are kept here, and can be reopened.', null],
    }[ui.filter];
    return emptyState({ iconName: ui.filter === 'completed' ? 'done' : 'today', title: m[0], text: m[1], action: m[2] });
  }
  root.append(...systemBanners(), h('div', { class: 'searchbox' }, icon('search', 20), search), bar, list);
  fill();
  return root;
}

// ------------------------------------------------------------------ MORE view + sub screens
function viewMore() {
  if (route.sub) return ({ backup: subBackup, reminders: subReminders, appearance: subAppearance, install: subInstall, about: subAbout })[route.sub]();
  const s = S.getSettings();
  const tasks = S.getTasks();
  const done = tasks.filter((t) => t.done).length;
  const item = (ic, title, sub, fn, key) => h('button', { class: 'menu-item', type: 'button', 'data-key': key, on: { click: fn } },
    icon(ic, 24), h('span', { class: 'grow' }, title, h('small', null, sub)), icon('right', 20, 'chev'));
  const backupSub = s.lastBackupAt ? `Last backup ${D.formatDateTimeStamp(s.lastBackupAt)}` : 'Not backed up yet';
  const swSub = ui.sw.ready ? 'Ready to work offline' : 'Install and offline status';
  return h('div', null, ...systemBanners(), h('div', { class: 'menu' },
    item('done', 'Completed tasks', `${plural(done, 'task')} kept for reference`, () => go('#/all/completed'), 'm:completed'),
    item('archive', 'Backup & restore', backupSub, () => go('#/more/backup'), 'm:backup'),
    item('bell', 'Reminders', s.reminders ? 'On' : 'Off', () => go('#/more/reminders'), 'm:reminders'),
    item('contrast', 'Appearance', `${{ system: 'Follows your phone', light: 'Light', dark: 'Dark' }[s.theme]} · week starts ${s.weekStart ? 'Monday' : 'Sunday'}`, () => go('#/more/appearance'), 'm:appearance'),
    item('phone', 'Install & offline', swSub, () => go('#/more/install'), 'm:install'),
    item('info', 'About & privacy', `Version ${S.APP_VERSION}`, () => go('#/more/about'), 'm:about')));
}

function download(kind) {
  const tasks = S.getTasks();
  const stamp = D.toKey(new Date());
  if (kind === 'json') {
    downloadText(`my-assistant-backup-${stamp}.json`, L.createBackup(tasks, new Date(), S.APP_VERSION), 'application/json');
    S.markBackedUp(tasks.length);
    toast(`Backup saved with ${plural(tasks.length, 'task')}. Keep the file somewhere safe.`);
  } else {
    downloadText(`my-assistant-tasks-${stamp}.csv`, L.toCSV(tasks), 'text/csv;charset=utf-8');
    toast('Spreadsheet (CSV) exported. It is for reading only; use the JSON backup to restore.');
  }
}

async function shareBackup() {
  const tasks = S.getTasks();
  try {
    const ok = await shareText(`my-assistant-backup-${D.toKey(new Date())}.json`, L.createBackup(tasks, new Date(), S.APP_VERSION), 'application/json');
    if (ok) { await S.markBackedUp(tasks.length); toast('Backup shared.'); } else toast('Sharing files is not supported here. Use Export backup instead.');
  } catch (err) { if (err && err.name !== 'AbortError') toast('Could not share the backup.'); }
}

async function handleBackupFile(file) {
  ui.importError = null;
  if (!file) return;
  try {
    if (file.size > 50 * 1024 * 1024) throw new Error('This file is far too large to be a My Assistant backup.');
    const text = await file.text();
    const parsed = L.parseBackup(text);
    openImportSheet(file.name, parsed);
  } catch (err) {
    ui.importError = `“${file.name}” could not be imported. ${err.message} Your current tasks were not changed.`;
    render();
    announce(ui.importError);
  }
}

function openImportSheet(name, parsed) {
  const now = today();
  const sum = L.summarize(parsed.tasks, now);
  const cur = S.getTasks().length;
  const sheet = $('#sheet');
  const doMerge = async () => {
    const r = await safe(() => S.importMerge(parsed.tasks), 'Import failed; nothing was changed.');
    if (!r) return;
    closeDialog(sheet);
    await refreshSnapshot();
    toast(`Merged: ${r.added} added, ${r.updated} updated, ${r.unchanged} already up to date.`, { timeout: 8000, action: r.added + r.updated ? { label: 'Undo', fn: undoImport } : null });
  };
  const doReplace = async () => {
    const ok = await confirmDialog({ title: 'Replace all tasks?', message: `All ${plural(cur, 'current task')} will be replaced by the ${plural(parsed.tasks.length, 'task')} in this backup. A safety copy of your current tasks is kept so you can undo.`, confirmLabel: 'Replace all', danger: true });
    if (!ok) return;
    const n = await safe(() => S.importReplace(parsed.tasks), 'Import failed; nothing was changed.');
    if (n === undefined) return;
    closeDialog(sheet);
    await refreshSnapshot();
    toast(`Replaced with ${plural(n, 'task')}.`, { timeout: 8000, action: { label: 'Undo', fn: undoImport } });
  };
  fillSheet(sheet, {
    title: 'Import backup',
    body: [
      h('p', { class: 'small muted' }, name),
      h('div', { class: 'card panel', style: 'margin:8px 0 12px' },
        h('h3', null, plural(sum.total, 'task')),
        h('p', { class: 'small muted' }, `${sum.open} open · ${sum.done} completed${sum.overdue ? ` · ${sum.overdue} overdue` : ''}`),
        parsed.exportedAt ? h('p', { class: 'small muted' }, `Exported ${D.formatDateTimeStamp(parsed.exportedAt)}`) : null,
        parsed.source === 'legacy' ? h('p', { class: 'small muted' }, 'From an earlier version of the app; it will be converted.') : null),
      parsed.warnings.length ? h('div', { class: 'banner warn' }, icon('alert', 20), h('ul', { class: 'list-plain small' }, parsed.warnings.map((w) => h('li', null, w)))) : null,
      h('p', null, h('strong', null, 'Merge'), ' adds tasks that are not here yet. If a task exists in both, the most recently edited copy is kept. Nothing is deleted.'),
      h('p', { style: 'margin-top:8px' }, h('strong', null, 'Replace'), ` swaps all ${plural(cur, 'current task')} for the backup (with confirmation).`),
    ],
    foot: [h('button', { class: 'btn outline-danger', type: 'button', on: { click: doReplace } }, 'Replace all…'), h('button', { class: 'btn primary', type: 'button', on: { click: doMerge } }, 'Merge')],
  });
  openDialog(sheet);
}

async function undoImport() {
  const n = await safe(() => S.undoImport(), 'Could not undo the import.');
  if (n !== undefined) { await refreshSnapshot(); toast(`Restored ${plural(n, 'task')} from before the import.`); }
}

async function refreshSnapshot() {
  try { ui.snapshot = await S.getImportSnapshot(); } catch { ui.snapshot = null; }
  render();
}

function subBackup() {
  const s = S.getSettings();
  const tasks = S.getTasks();
  const fileInput = h('input', { type: 'file', accept: '.json,application/json,text/plain', class: 'sr-only', tabindex: '-1', id: 'file-in', on: { change: (e) => { const f = e.target.files[0]; e.target.value = ''; handleBackupFile(f); } } });
  const canShare = typeof navigator.canShare === 'function' && typeof File === 'function' && navigator.canShare({ files: [new File(['x'], 'x.json', { type: 'application/json' })] });
  if (ui.snapshot === null && !ui._snapAsked) { ui._snapAsked = true; refreshSnapshot(); }
  return h('div', { class: 'stack' },
    h('div', { class: 'card panel' },
      h('h3', null, 'Your data is stored on this device only'),
      h('p', { class: 'small muted' }, 'There is no account and no cloud copy. If you clear the app’s data, uninstall it, or lose the phone, your tasks go with it. Save a backup file somewhere safe (Google Drive, email to yourself, a computer) and repeat now and then.'),
      h('p', { class: 'small', style: 'margin-top:10px' }, s.lastBackupAt ? `Last backup: ${D.formatDateTimeStamp(s.lastBackupAt)} (${plural(s.lastBackupCount ?? 0, 'task')})` : h('strong', null, 'You have not exported a backup yet.'))),
    h('div', { class: 'card panel' },
      h('h3', null, 'Back up'),
      h('p', { class: 'small muted', style: 'margin-bottom:12px' }, `${plural(tasks.length, 'task')} including completed ones, with dates, priorities and your manual order.`),
      h('div', { class: 'btn-row' },
        h('button', { class: 'btn primary', type: 'button', id: 'btn-export-json', on: { click: () => download('json') } }, icon('download', 20), 'Export backup (JSON)'),
        canShare ? h('button', { class: 'btn', type: 'button', on: { click: shareBackup } }, icon('share', 20), 'Share…') : null,
        h('button', { class: 'btn', type: 'button', id: 'btn-export-csv', on: { click: () => download('csv') } }, icon('download', 20), 'Spreadsheet (CSV)'))),
    h('div', { class: 'card panel' },
      h('h3', null, 'Restore'),
      h('p', { class: 'small muted', style: 'margin-bottom:12px' }, 'Choose a backup file. It is checked first; nothing changes until you pick Merge or Replace.'),
      ui.importError ? h('div', { class: 'banner error', role: 'alert' }, icon('alert', 20), h('p', { class: 'grow small', id: 'import-error' }, ui.importError)) : null,
      h('button', { class: 'btn', type: 'button', id: 'btn-import', on: { click: () => fileInput.click() } }, icon('upload', 20), 'Choose backup file'),
      fileInput,
      ui.snapshot ? h('div', { style: 'margin-top:14px' }, h('p', { class: 'small muted' }, `Before the last import you had ${plural(ui.snapshot.tasks.length, 'task')} (${D.formatDateTimeStamp(ui.snapshot.at)}).`),
        h('button', { class: 'btn', type: 'button', style: 'margin-top:8px', on: { click: undoImport } }, icon('undo', 20), 'Undo last import')) : null),
    h('div', { class: 'card panel' },
      h('h3', null, 'Delete all data'),
      h('p', { class: 'small muted', style: 'margin-bottom:12px' }, 'Permanently removes every task from this device. Export a backup first.'),
      h('button', { class: 'btn outline-danger', type: 'button', on: { click: deleteEverything } }, icon('trash', 20), 'Delete all data…')));
}

async function deleteEverything() {
  const n = S.getTasks().length;
  const ok = await confirmDialog({ title: 'Delete ALL data?', message: `This permanently deletes all ${plural(n, 'task')} on this device, including completed ones. It cannot be undone. Export a backup first if you might want them back.`, confirmLabel: 'Delete everything', danger: true, typeToConfirm: 'DELETE' });
  if (!ok) return;
  await safe(() => S.deleteAllData(), 'Could not delete the data.');
  ui.snapshot = null;
  toast('All tasks deleted.');
}

// ---- reminders
const notifSupported = () => 'Notification' in window && 'serviceWorker' in navigator;

function subReminders() {
  const s = S.getSettings();
  const perm = notifSupported() ? Notification.permission : 'unsupported';
  const permText = { granted: 'Notifications are allowed.', denied: 'Notifications are blocked for this site. Allow them in Chrome’s site settings to receive alerts.', default: 'Notifications have not been requested yet.', unsupported: 'This browser does not support notifications.' }[perm];
  return h('div', { class: 'stack' },
    h('div', { class: 'card panel' },
      h('h3', null, 'How reminders work'),
      h('p', { class: 'small' }, 'Tasks with a due date always show as Today, Needs attention or Overdue when you open the app. That works every time.'),
      h('p', { class: 'small' }, 'If you give a task a time and turn reminders on, the app shows an alert at that time while it is open, or recently running in the background.'),
      h('p', { class: 'small muted' }, 'Limit: a web app cannot guarantee exact alarms when it is closed. Android may pause or stop it to save battery, so a reminder can arrive late or not at all. Do not rely on it for anything critical.' + (isNative() ? '' : ' The optional Android app build (see README) can schedule real system notifications.'))),
    h('div', { class: 'card' },
      h('div', { class: 'status-line' }, icon('bell', 22, s.reminders ? 'ok' : ''), h('div', { class: 'grow' }, h('strong', null, s.reminders ? 'Reminders are on' : 'Reminders are off'), h('p', { class: 'small muted' }, permText))),
      h('div', { class: 'panel btn-row' },
        h('button', { class: `btn ${s.reminders ? '' : 'primary'}`, type: 'button', id: 'btn-reminders', on: { click: toggleReminders } }, s.reminders ? 'Turn off reminders' : 'Turn on reminders'),
        s.reminders && perm === 'granted' ? h('button', { class: 'btn', type: 'button', on: { click: () => fireNotification('Test reminder', 'If you can see this, notifications work on this device.', 'test') } }, 'Send a test') : null)));
}

async function toggleReminders() {
  const s = S.getSettings();
  if (s.reminders) { await safe(() => S.updateSettings({ reminders: false }), 'Could not save the setting.'); syncNativeReminders(S.getTasks(), false); return; }
  await safe(() => S.updateSettings({ reminders: true }), 'Could not save the setting.');
  if (isNative()) await requestNativePermission();
  else if (notifSupported() && Notification.permission === 'default') {
    try { await Notification.requestPermission(); } catch { /* ignore */ }
  }
  syncNativeReminders(S.getTasks(), true);
  render();
  tickReminders();
}

async function fireNotification(title, body, tag) {
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    if (reg && Notification.permission === 'granted') await reg.showNotification(title, { body, tag, icon: 'icon-192.png', badge: 'icon-192.png', data: { url: './' } });
  } catch { /* in-app toast still shown by caller */ }
}

let notifiedCache = null;
async function tickReminders() {
  const s = S.getSettings();
  if (!s.reminders || document.hidden) return;
  try {
    if (!notifiedCache) notifiedCache = (await S.getMeta('notified')) || {};
    const due = L.dueReminders(S.getTasks(), new Date(), notifiedCache);
    if (!due.length) return;
    for (const { task, key } of due) notifiedCache[key] = Date.now();
    const cutoff = Date.now() - 3 * 86400000;
    for (const k of Object.keys(notifiedCache)) if (notifiedCache[k] < cutoff) delete notifiedCache[k];
    await S.setMeta('notified', notifiedCache);
    for (const { task } of due) {
      toast(`Due now: ${task.title}`, { timeout: 0, action: { label: 'Open', fn: () => openDetail(task.id) } });
      fireNotification(task.title, `Due ${D.formatTime(task.dueTime)}`, task.id);
    }
  } catch { /* reminders are best-effort */ }
}

// ---- appearance
function radioGroup(name, value, options, onChange, label) {
  return h('fieldset', { style: 'border:0;padding:0;margin:0' }, h('legend', { class: 'label', style: 'font-size:.8125rem;font-weight:650;color:var(--muted);margin-bottom:6px;padding:0' }, label),
    h('div', { class: 'segmented' }, options.map(([v, text]) => h('label', null,
      h('input', { type: 'radio', name, value: String(v), checked: String(v) === String(value), on: { change: () => onChange(v) } }),
      h('span', { class: 'seg' }, text)))));
}

function subAppearance() {
  const s = S.getSettings();
  return h('div', { class: 'card panel stack' },
    radioGroup('theme', s.theme, [['system', 'System'], ['light', 'Light'], ['dark', 'Dark']], (v) => S.updateSettings({ theme: v }), 'Theme'),
    radioGroup('weekStart', s.weekStart, [[0, 'Sunday'], [1, 'Monday']], (v) => S.updateSettings({ weekStart: Number(v) }), 'Calendar week starts on'));
}

// ---- install & offline
const isStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

function subInstall() {
  const sw = ui.sw;
  let offline;
  if (!sw.supported) offline = ['bad', 'alert', 'Offline mode is not available', 'This browser does not support service workers.'];
  else if (sw.error) offline = ['bad', 'alert', 'Offline setup failed', sw.error];
  else if (sw.ready) offline = ['ok', 'check', 'Ready to work offline', `All ${sw.cached} app files are saved on this device${sw.version ? ` (version ${sw.version})` : ''}.`];
  else offline = ['warnc', 'clock', 'Getting ready for offline use…', 'Keep the app open while it saves its files. This needs a connection once. (Service workers only run on HTTPS or localhost.)'];
  const persisted = S.status.persisted;
  const checkUpdate = async () => {
    try {
      const reg = await navigator.serviceWorker.getRegistration();
      if (!reg) { toast('Updates are not available here.'); return; }
      await reg.update();
      setTimeout(() => { if (!ui.updateWaiting) toast('You have the latest version.'); }, 1500);
    } catch { toast('Could not check for updates. Are you offline?'); }
  };
  const installBlock = isStandalone()
    ? h('div', { class: 'status-line' }, icon('check', 22, 'ok'), h('div', null, h('strong', null, 'Running as an installed app'), h('p', { class: 'small muted' }, 'No browser bar is shown when you launch it from the home screen icon.')))
    : h('div', { class: 'status-line' }, icon('phone', 22), h('div', { class: 'grow' }, h('strong', null, 'Install on your phone'),
      ui.deferredPrompt
        ? h('div', null, h('p', { class: 'small muted' }, 'Add My Assistant to your home screen so it opens like an app, without the browser bar.'), h('button', { class: 'btn primary', type: 'button', id: 'btn-install', style: 'margin-top:10px', on: { click: promptInstall } }, 'Install app'))
        : h('div', null, h('p', { class: 'small muted' }, 'Chrome did not offer an install prompt (it only does so on HTTPS pages, once the app is ready, and not if it is already installed). To install manually in Chrome on Android:'),
          h('ol', { class: 'list-plain small' }, h('li', null, 'Open this page in Chrome.'), h('li', null, 'Tap the ⋮ menu at the top right.'), h('li', null, 'Tap “Install app” (or “Add to Home screen”).'), h('li', null, 'Open My Assistant from the new home screen icon.')),
          h('p', { class: 'small muted', style: 'margin-top:8px' }, 'Opened in a normal browser tab, the address bar will always be visible. Installing a web app is not the same as installing an APK.'))));
  return h('div', { class: 'stack' },
    h('div', { class: 'card' },
      h('div', { class: 'status-line' }, icon(offline[1], 22, offline[0]), h('div', { class: 'grow' }, h('strong', { id: 'offline-status' }, offline[2]), h('p', { class: 'small muted' }, offline[3]))),
      installBlock,
      h('div', { class: 'status-line' }, icon('archive', 22, persisted ? 'ok' : 'warnc'), h('div', { class: 'grow' }, h('strong', null, persisted ? 'Storage is protected' : 'Storage is not guaranteed'),
        h('p', { class: 'small muted' }, persisted ? 'The browser will not clear your tasks to free up space. You can still lose them by clearing app data or uninstalling.' : 'The browser may clear this app’s data if the phone runs very low on space (rare). Installing the app helps. Keep a backup.'))),
      h('div', { class: 'panel btn-row' }, h('button', { class: 'btn', type: 'button', on: { click: checkUpdate } }, icon('refresh', 20), 'Check for updates'))),
    h('div', { class: 'card panel' },
      h('h3', null, 'About updates'),
      h('p', { class: 'small muted' }, 'When a new version is available you will be asked before it is applied. Updating never touches your tasks.')));
}

async function promptInstall() {
  const p = ui.deferredPrompt;
  if (!p) return;
  ui.deferredPrompt = null;
  try { await p.prompt(); await p.userChoice; } catch { /* dismissed */ }
  render();
}

function subAbout() {
  return h('div', { class: 'stack' },
    h('div', { class: 'card panel' },
      h('h3', null, 'My Assistant'),
      h('p', { class: 'small muted' }, `Version ${S.APP_VERSION}. A personal task manager that works offline.`)),
    h('div', { class: 'card panel' },
      h('h3', null, 'Privacy'),
      h('ul', { class: 'list-plain small' },
        h('li', null, 'No account, no login, no cloud sync, no analytics.'),
        h('li', null, 'The app makes no network requests while you use it. Its code, icons and fonts are all stored on your device.'),
        h('li', null, 'Your tasks are saved in this device’s browser storage (IndexedDB). Nobody else can see them, and nobody else can recover them.'),
        h('li', null, 'Back up regularly from Backup & restore.'))));
}

// ------------------------------------------------------------------ sheets: add/edit + detail
function openTaskForm({ task = null, dueDate = null } = {}) {
  const sheet = $('#sheet');
  const editing = !!task;
  const now = today();
  const tomorrow = D.addDays(now, 1);
  const title = h('input', { type: 'text', id: 'f-title', maxlength: '200', value: task ? task.title : '', placeholder: 'What needs doing?', autocomplete: 'off', enterkeyhint: 'done', 'aria-describedby': 'f-title-err', 'aria-required': 'true', autofocus: !editing });
  const titleErr = h('p', { class: 'field-error', id: 'f-title-err', hidden: true, role: 'alert' }, 'Please enter a title.');
  const date = h('input', { type: 'date', id: 'f-date', value: task ? task.dueDate || '' : dueDate || '', 'aria-label': 'Due date' });
  const time = h('input', { type: 'time', id: 'f-time', value: task && task.dueTime ? task.dueTime : '', 'aria-label': 'Due time', disabled: !date.value });
  const notes = h('textarea', { id: 'f-notes', maxlength: '5000', placeholder: 'Optional notes', 'aria-label': 'Notes' });
  notes.value = task ? task.notes : '';
  const chips = [['none', 'No date', ''], ['today', 'Today', now], ['tomorrow', 'Tomorrow', tomorrow]].map(([id, label, val]) => h('button', { class: 'fchip', type: 'button', 'data-chip': id, on: { click: () => { date.value = val; sync(); } } }, label));
  function sync() {
    const v = date.value;
    chips.forEach((c) => c.setAttribute('aria-pressed', bool((c.dataset.chip === 'none' && !v) || (c.dataset.chip === 'today' && v === now) || (c.dataset.chip === 'tomorrow' && v === tomorrow))));
    time.disabled = !v;
    if (!v) time.value = '';
  }
  date.addEventListener('input', sync);
  sync();
  const prio = task ? task.priority : 'medium';
  const prioGroup = h('div', { class: 'segmented', role: 'radiogroup', 'aria-label': 'Priority' }, L.PRIORITIES.map((p) => h('label', null,
    h('input', { type: 'radio', name: 'priority', value: p, checked: p === prio }),
    h('span', { class: `seg p-${p}` }, h('span', { class: `shape ${p}`, 'aria-hidden': 'true' }), L.PRIORITY_LABEL[p]))));

  const form = h('form', { id: 'task-form', novalidate: true, on: { submit: async (e) => {
    e.preventDefault();
    const t = title.value.trim();
    if (!t) { title.setAttribute('aria-invalid', 'true'); titleErr.hidden = false; title.focus(); return; }
    const fields = { title: t, notes: notes.value, dueDate: date.value || null, dueTime: date.value && time.value ? time.value : null, priority: prioGroup.querySelector('input:checked').value };
    const saved = await safe(() => (editing ? S.editTask(task.id, fields) : S.addTask(fields)), 'Could not save the task.');
    if (!saved) return;
    closeDialog(sheet);
    const name = editing ? saved.after.title : saved.title;
    announce(`${editing ? 'Saved' : 'Added'} ${name}`);
    toast(editing ? 'Task saved' : 'Task added');
  } } },
  h('label', { class: 'field' }, h('span', { class: 'label' }, 'Title'), title, titleErr),
  h('div', { class: 'field' }, h('span', { class: 'label' }, 'Due date'), h('div', { class: 'datechips' }, chips), date),
  h('div', { class: 'field' }, h('span', { class: 'label' }, 'Priority'), prioGroup),
  h('details', { class: 'disclosure', open: !!(task && (task.notes || task.dueTime)) },
    h('summary', null, 'Time and notes'),
    h('label', { class: 'field' }, h('span', { class: 'label' }, 'Time (optional, needs a date)'), time),
    h('label', { class: 'field' }, h('span', { class: 'label' }, 'Notes'), notes)));
  title.addEventListener('input', () => { if (title.value.trim()) { title.removeAttribute('aria-invalid'); titleErr.hidden = true; } });

  fillSheet(sheet, {
    title: editing ? 'Edit task' : 'New task', body: form, closeLabel: 'Cancel',
    foot: [h('button', { class: 'btn', type: 'button', on: { click: () => closeDialog(sheet) } }, 'Cancel'), h('button', { class: 'btn primary', type: 'submit', form: 'task-form', id: 'btn-save-task' }, editing ? 'Save' : 'Add task')],
  });
  openDialog(sheet);
  if (!editing) title.focus();
}

function openDetail(id) {
  const t = S.getTask(id);
  if (!t) return;
  const sheet = $('#sheet');
  const now = today();
  const w = whenInfo(t, now, true);
  const group = t.dueDate ? L.tasksForDate(S.getTasks(), t.dueDate) : [];
  const ids = group.map((x) => x.id);
  const pos = ids.indexOf(id);
  const reorderBlock = group.length > 1 ? h('div', { class: 'detail-row' }, icon('list', 20),
    h('div', { class: 'grow' }, h('div', { class: 'small muted' }, `Position ${pos + 1} of ${group.length} on this day`),
      h('div', { class: 'btn-row', style: 'margin-top:6px' },
        h('button', { class: 'btn', type: 'button', 'aria-disabled': bool(pos === 0), on: { click: async () => { if (pos > 0) { await moveTask(id, -1, ids); openDetail(id); } } } }, icon('up', 18), 'Move up'),
        h('button', { class: 'btn', type: 'button', 'aria-disabled': bool(pos === group.length - 1), on: { click: async () => { if (pos < group.length - 1) { await moveTask(id, 1, ids); openDetail(id); } } } }, icon('down', 18), 'Move down')))) : null;
  const dueLine = t.dueDate ? `${D.formatFull(t.dueDate)}${t.dueTime ? ` at ${D.formatTime(t.dueTime)}` : ''}` : 'No due date';
  fillSheet(sheet, {
    title: t.title,
    body: [
      h('div', { class: 'detail-meta' }, priorityChip(t.priority),
        t.done ? h('span', { class: 'chip plain' }, icon('check', 12), w.text) : (w.overdue ? h('span', { class: 'chip status-overdue' }, w.text.split(' · ')[0]) : null)),
      h('div', { class: 'detail-row' }, icon('calendar', 20), h('div', null, dueLine, t.dueDate && !t.done ? h('div', { class: 'small muted' }, w.text.replace(/ · \d.*$/, '')) : null)),
      t.notes ? h('div', { class: 'detail-row' }, icon('note', 20), h('div', { class: 'detail-notes grow' }, t.notes)) : null,
      reorderBlock,
      h('p', { class: 'small muted', style: 'margin-top:8px' }, `Created ${D.formatDateTimeStamp(t.createdAt)}${t.updatedAt !== t.createdAt ? ` · edited ${D.formatDateTimeStamp(t.updatedAt)}` : ''}${t.completedAt ? ` · completed ${D.formatDateTimeStamp(t.completedAt)}` : ''}`),
    ],
    foot: [
      h('button', { class: 'btn outline-danger', type: 'button', id: 'btn-delete', on: { click: () => removeTask(id) } }, icon('trash', 18), 'Delete'),
      h('button', { class: 'btn', type: 'button', id: 'btn-edit', on: { click: () => openTaskForm({ task: t }) } }, icon('edit', 18), 'Edit'),
      h('button', { class: 'btn primary', type: 'button', id: 'btn-toggle', on: { click: () => toggleDone(id, { fromSheet: true }) } }, icon(t.done ? 'undo' : 'check', 18), t.done ? 'Reopen' : 'Complete'),
    ],
  });
  openDialog(sheet);
}

// ------------------------------------------------------------------ render
const VIEW_TITLE = { today: 'Today', calendar: 'Calendar', all: 'All tasks', more: 'More' };

function renderNav() {
  $('#nav').replaceChildren(...NAV.map((n) => h('button', {
    class: 'navbtn', type: 'button', 'data-nav': n.id, 'aria-current': route.view === n.id ? 'page' : null,
    on: { click: () => go(`#/${n.id}`) },
  }, h('span', { class: 'pill' }, icon(n.icon, 24)), h('span', null, n.label))));
}

function render() {
  if (!S.getSettings()) return;
  const routeKey = `${route.view}/${route.sub || ''}`;
  const changed = routeKey !== lastRouteKey;
  const prevFocus = document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.key : null;
  const scrollY = window.scrollY;
  lastRenderedDay = today();

  const builders = { today: viewToday, calendar: viewCalendar, all: viewAll, more: viewMore };
  $('#view').replaceChildren(builders[route.view]());

  const sub = route.view === 'more' && route.sub;
  $('#title').textContent = sub ? MORE_TITLES[route.sub] : VIEW_TITLE[route.view];
  const back = $('#back');
  back.hidden = !sub;
  if (sub && !back.firstChild) { back.append(icon('left')); back.setAttribute('aria-label', 'Back to More'); }
  document.title = `${sub ? MORE_TITLES[route.sub] : VIEW_TITLE[route.view]} · My Assistant`;
  renderNav();

  const fab = $('#fab');
  fab.hidden = route.view === 'more';
  if (!fab.firstChild) fab.append(icon('plus', 24), h('span', null, 'Add task'));

  if (changed) { window.scrollTo(0, 0); lastRouteKey = routeKey; if (route.view !== 'today') ui.reorder = false; }
  else window.scrollTo(0, scrollY);
  if (prevFocus) {
    const el = $(`#view [data-key="${CSS.escape(prevFocus)}"]`);
    if (el && el !== document.activeElement) el.focus({ preventScroll: true });
  }
}

// ------------------------------------------------------------------ PWA: service worker, install, updates
async function askSw(cmd) {
  try {
    const reg = await navigator.serviceWorker.ready;
    const worker = reg.active;
    if (!worker) return null;
    return await new Promise((resolve) => {
      const ch = new MessageChannel();
      ch.port1.onmessage = (e) => resolve(e.data);
      worker.postMessage({ type: cmd }, [ch.port2]);
      setTimeout(() => resolve(null), 2500);
    });
  } catch { return null; }
}

async function refreshSwStatus() {
  const st = await askSw('STATUS');
  if (st) Object.assign(ui.sw, { ready: st.complete, cached: st.cached, expected: st.expected, version: st.version });
  ui.sw.controlled = !!navigator.serviceWorker.controller;
  if (route.view === 'more') render();
}

function showUpdateToast(worker) {
  ui.updateWaiting = worker;
  toast('A new version of My Assistant is ready. Your tasks are not affected.', { timeout: 0, action: { label: 'Update now', fn: () => worker.postMessage({ type: 'SKIP_WAITING' }) } });
}

async function setupServiceWorker() {
  if (!ui.sw.supported) return;
  try {
    const reg = await navigator.serviceWorker.register('sw.js');
    ui.sw.registered = true;
    if (reg.waiting && navigator.serviceWorker.controller) showUpdateToast(reg.waiting);
    reg.addEventListener('updatefound', () => {
      const nw = reg.installing;
      if (!nw) return;
      nw.addEventListener('statechange', () => {
        if (nw.state === 'installed' && navigator.serviceWorker.controller) showUpdateToast(nw);
      });
    });
    let reloading = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (reloading) return;
      if (ui.updateWaiting) { reloading = true; location.reload(); } else refreshSwStatus();
    });
    await refreshSwStatus();
  } catch (err) {
    ui.sw.error = `The service worker could not start (${err.message}).`;
  }
}

window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); ui.deferredPrompt = e; if (route.view === 'more') render(); });
window.addEventListener('appinstalled', () => { ui.deferredPrompt = null; toast('My Assistant was installed.'); render(); });

// ------------------------------------------------------------------ boot
function scheduleMidnight() {
  const n = new Date();
  const next = new Date(n.getFullYear(), n.getMonth(), n.getDate() + 1, 0, 0, 2);
  setTimeout(() => { ui.calMonth = null; ui.selected = null; render(); scheduleMidnight(); }, next - n);
}

async function boot() {
  initDialogs($('#sheet'), $('#confirm'));
  $('#fab').addEventListener('click', () => {
    const dueDate = route.view === 'today' ? today() : route.view === 'calendar' ? ui.selected : null;
    openTaskForm({ dueDate });
  });
  $('#back').addEventListener('click', () => go('#/more'));
  window.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft' && e.altKey) $('#back').click();
  });

  await S.init();
  S.subscribe(() => { applyTheme(); render(); syncNativeReminders(S.getTasks(), S.getSettings().reminders); });
  route = parseHash();
  applyTheme();
  render();

  if (S.status.migration && S.status.migration.count) {
    toast(`Imported ${plural(S.status.migration.count, 'task')} from the earlier version of the app.`, { timeout: 8000 });
  }
  const params = new URLSearchParams(location.search);
  if (params.get('action') === 'add') {
    history.replaceState(history.state, '', location.pathname + location.hash);
    openTaskForm({ dueDate: today() });
  }

  scheduleMidnight();
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    if (today() !== lastRenderedDay) { ui.calMonth = null; ui.selected = null; }
    render();
    tickReminders();
  });
  setInterval(tickReminders, 30000);
  setTimeout(tickReminders, 1500);
  setupServiceWorker();
}

boot().catch((err) => {
  console.error(err);
  $('#view').replaceChildren(h('div', { class: 'banner error', role: 'alert' }, icon('alert', 22), h('div', { class: 'grow' }, h('strong', null, 'The app could not start'), h('p', { class: 'small' }, String(err && err.message ? err.message : err)))));
});
