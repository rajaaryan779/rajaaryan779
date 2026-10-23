const $app = document.getElementById('app');
let me = null;
let view = 'dashboard';

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && path !== '/api/login') { me = null; render(); throw new Error('Signed out'); }
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

// Element helper: children are always text nodes or elements, never HTML, so user data cannot inject markup.
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (v !== false && v != null) el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  return el;
}

const money = (minor, cur) => new Intl.NumberFormat('en-IN', { style: 'currency', currency: cur }).format(minor / 100);
const field = (label, input) => h('label', {}, label, input);

function form(fields, submitLabel, onSubmit) {
  const err = h('div', { class: 'err', role: 'alert' });
  const f = h('form', { class: 'grid', onsubmit: async (e) => {
    e.preventDefault(); err.textContent = '';
    try { await onSubmit(Object.fromEntries(new FormData(f))); } catch (x) { err.textContent = x.message; }
  } }, fields, h('button', { class: 'btn', type: 'submit' }, submitLabel));
  return h('div', {}, f, err);
}

function authView() {
  let signup = false;
  const box = h('div', { class: 'card auth' });
  const draw = () => {
    box.replaceChildren(
      h('h1', {}, 'ChaseUp'),
      h('p', { class: 'muted' }, 'Know who owes you, and chase them politely.'),
      form([
        signup && field('Your name', h('input', { name: 'name', required: true })),
        signup && field('Business name', h('input', { name: 'business_name', required: true })),
        signup && field('Currency', h('input', { name: 'currency', value: 'INR', maxlength: 3 })),
        field('Email', h('input', { name: 'email', type: 'email', required: true })),
        field('Password', h('input', { name: 'password', type: 'password', minlength: 8, required: true })),
      ], signup ? 'Create account' : 'Sign in', async (d) => {
        await api('POST', signup ? '/api/signup' : '/api/login', d);
        await boot();
      }),
      h('p', {}, h('button', { class: 'btn ghost sm', onclick: () => { signup = !signup; draw(); } },
        signup ? 'I have an account' : 'New here? Create an account')),
    );
  };
  draw();
  return box;
}

async function dashboardView() {
  const d = await api('GET', '/api/dashboard');
  const stat = (k, v, cls = '') => h('div', { class: 'stat' }, h('div', { class: 'k' }, k), h('div', { class: `v ${cls}` }, v));
  return h('div', {},
    h('div', { class: 'stats' },
      stat('Outstanding', money(d.outstanding_minor, d.currency)),
      stat(`Overdue (${d.overdue_count})`, money(d.overdue_minor, d.currency), d.overdue_minor ? 'bad' : ''),
      stat('Collected this month', money(d.collected_month_minor, d.currency), 'good')),
    h('div', { class: 'card' }, h('h3', {}, 'Chase these first'),
      d.needs_chase.length ? invoiceTable(d.needs_chase, d.currency) : h('p', { class: 'muted' }, 'Nothing overdue. Nice.')));
}

function invoiceTable(rows, cur) {
  return h('div', { class: 'scroll' }, h('table', {},
    h('thead', {}, h('tr', {}, ['Invoice', 'Client', 'Amount', 'Due', 'Status', 'Chased', ''].map((t) => h('th', {}, t)))),
    h('tbody', {}, rows.map((i) => h('tr', {},
      h('td', {}, i.number), h('td', {}, i.client_name),
      h('td', {}, money(i.amount_minor, cur)), h('td', {}, i.due_on),
      h('td', {}, i.status === 'open' && i.days_overdue
        ? h('span', { class: 'pill bad' }, `${i.days_overdue}d overdue`) : h('span', { class: 'pill' }, i.status)),
      h('td', {}, i.reminders_sent),
      h('td', {}, i.status === 'open' && h('div', { class: 'row' },
        h('button', { class: 'btn sm', onclick: () => openReminder(i) }, 'Remind'),
        h('button', { class: 'btn sm ghost', onclick: async () => { await api('POST', `/api/invoices/${i.id}/paid`); render(); } }, 'Paid'),
        h('button', { class: 'btn sm ghost', onclick: async () => { if (confirm('Void this invoice?')) { await api('POST', `/api/invoices/${i.id}/void`); render(); } } }, 'Void'))))))));
}

async function openReminder(inv) {
  const d = await api('POST', `/api/invoices/${inv.id}/reminder/draft`, {});
  const subject = h('input', { value: d.subject });
  const body = h('textarea', {}, d.body);
  const err = h('div', { class: 'err' });
  const dlg = h('dialog', {},
    h('h3', {}, `Reminder to ${inv.client_name}`),
    h('p', { class: 'muted' }, `Tone: ${d.tone} · ${d.source === 'ai' ? 'AI-polished' : 'template'}`),
    field('Subject', subject), field('Message', body), err,
    h('div', { class: 'row' },
      h('button', { class: 'btn', onclick: async () => {
        try {
          await api('POST', `/api/invoices/${inv.id}/reminder/log`, { tone: d.tone, subject: subject.value, body: body.value });
          location.href = `mailto:${encodeURIComponent(d.to)}?subject=${encodeURIComponent(subject.value)}&body=${encodeURIComponent(body.value)}`;
          dlg.close(); render();
        } catch (x) { err.textContent = x.message; }
      } }, 'Open in email app & log it'),
      h('button', { class: 'btn ghost', onclick: () => dlg.close() }, 'Cancel')));
  dlg.addEventListener('close', () => dlg.remove());
  document.body.append(dlg); dlg.showModal();
}

async function invoicesView() {
  const [invoices, clients] = await Promise.all([api('GET', '/api/invoices'), api('GET', '/api/clients')]);
  const today = new Date().toISOString().slice(0, 10);
  return h('div', {},
    h('div', { class: 'card' }, h('h3', {}, 'New invoice'),
      clients.length ? form([
        field('Client', h('select', { name: 'client_id' }, clients.map((c) => h('option', { value: c.id }, c.name)))),
        field('Number', h('input', { name: 'number', required: true })),
        field(`Amount (${me.currency})`, h('input', { name: 'amount', type: 'number', step: '0.01', min: '0.01', required: true })),
        field('Due date', h('input', { name: 'due_on', type: 'date', required: true, value: today })),
      ], 'Add invoice', async (d) => { await api('POST', '/api/invoices', { ...d, client_id: Number(d.client_id), amount: Number(d.amount) }); render(); })
        : h('p', { class: 'muted' }, 'Add a client first.')),
    h('div', { class: 'card' }, h('h3', {}, 'All invoices'),
      invoices.length ? invoiceTable(invoices, me.currency) : h('p', { class: 'muted' }, 'No invoices yet.')));
}

async function clientsView() {
  const clients = await api('GET', '/api/clients');
  return h('div', {},
    h('div', { class: 'card' }, h('h3', {}, 'New client'),
      form([field('Name', h('input', { name: 'name', required: true })), field('Billing email', h('input', { name: 'email', type: 'email' }))],
        'Add client', async (d) => { await api('POST', '/api/clients', d); render(); })),
    h('div', { class: 'card' }, h('h3', {}, 'Clients'),
      clients.length ? h('table', {}, h('thead', {}, h('tr', {}, ['Name', 'Email', 'Outstanding', ''].map((t) => h('th', {}, t)))),
        h('tbody', {}, clients.map((c) => h('tr', {}, h('td', {}, c.name), h('td', {}, c.email || '—'),
          h('td', {}, money(c.outstanding_minor, me.currency)),
          h('td', {}, h('button', { class: 'btn sm ghost', onclick: async () => {
            try { await api('DELETE', `/api/clients/${c.id}`); render(); } catch (x) { alert(x.message); }
          } }, 'Delete'))))))
        : h('p', { class: 'muted' }, 'No clients yet.')));
}

const views = { dashboard: dashboardView, invoices: invoicesView, clients: clientsView };

async function render() {
  if (!me) { $app.replaceChildren(authView()); return; }
  const nav = h('nav', {}, Object.keys(views).map((v) =>
    h('button', { class: v === view ? 'on' : '', onclick: () => { view = v; render(); } }, v[0].toUpperCase() + v.slice(1))));
  const header = h('header', {}, h('span', { class: 'brand' }, 'ChaseUp'), nav,
    h('span', { class: 'muted' }, me.business_name),
    h('button', { class: 'btn ghost sm', onclick: async () => { await api('POST', '/api/logout', {}); me = null; render(); } }, 'Sign out'));
  const main = h('main', {});
  $app.replaceChildren(header, main);
  try { main.replaceChildren(await views[view]()); } catch (x) { if (me) main.replaceChildren(h('p', { class: 'err' }, x.message)); }
}

async function boot() {
  try { me = await api('GET', '/api/me'); } catch { me = null; }
  render();
}
boot();
