const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

// ---------- Tabs ----------
$$('.tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    $$('.tab-btn').forEach((b) => b.classList.remove('active'));
    $$('.tab-panel').forEach((p) => p.classList.remove('active'));
    btn.classList.add('active');
    $(`#tab-${btn.dataset.tab}`).classList.add('active');
    if (btn.dataset.tab === 'leads') loadLeads();
    if (btn.dataset.tab === 'sequence') loadSequence();
    if (btn.dataset.tab === 'settings') loadSettings();
    if (btn.dataset.tab === 'logs') loadLogs();
  });
});

function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) +
    ' ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

// ---------- Leads ----------
async function loadLeads() {
  const res = await fetch('/api/leads');
  const leads = await res.json();
  const body = $('#leadsBody');
  if (leads.length === 0) {
    body.innerHTML = `<tr><td colspan="7" style="text-align:center;color:#6b7280;padding:24px">No leads yet — upload a CSV or add one manually.</td></tr>`;
    return;
  }
  body.innerHTML = leads
    .slice()
    .reverse()
    .map((l) => `
      <tr>
        <td>${escapeHtml(l.name || '—')}</td>
        <td>${escapeHtml(l.company || '—')}</td>
        <td>${escapeHtml(l.email)}</td>
        <td><span class="status-pill status-${l.status}">${l.status}</span></td>
        <td>${l.currentStage} / 5</td>
        <td>${l.status === 'active' ? fmtDate(l.nextSendAt) : '—'}</td>
        <td class="row-actions">
          ${l.status === 'active' ? `<button onclick="leadAction('${l.id}','pause')">Pause</button>` : ''}
          ${l.status === 'paused' ? `<button onclick="leadAction('${l.id}','resume')">Resume</button>` : ''}
          ${l.status !== 'unsubscribed' ? `<button onclick="leadAction('${l.id}','mark-replied')">Mark replied</button>` : ''}
          <button class="danger" onclick="deleteLead('${l.id}')">Delete</button>
        </td>
      </tr>`)
    .join('');
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function leadAction(id, action) {
  await fetch(`/api/leads/${id}/${action}`, { method: 'POST' });
  loadLeads();
}

async function deleteLead(id) {
  if (!confirm('Delete this lead? This cannot be undone.')) return;
  await fetch(`/api/leads/${id}`, { method: 'DELETE' });
  loadLeads();
}

$('#btnShowAddLead').addEventListener('click', () => {
  $('#addLeadForm').style.display = $('#addLeadForm').style.display === 'none' ? 'block' : 'none';
});
$('#btnCancelLead').addEventListener('click', () => { $('#addLeadForm').style.display = 'none'; });

$('#btnSaveLead').addEventListener('click', async () => {
  const payload = {
    name: $('#f_name').value.trim(),
    company: $('#f_company').value.trim(),
    email: $('#f_email').value.trim(),
    phone: $('#f_phone').value.trim(),
    website: $('#f_website').value.trim(),
  };
  if (!payload.email) return alert('Email is required.');
  const res = await fetch('/api/leads', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await res.json();
  if (!res.ok) return alert(data.error || 'Failed to add lead.');
  ['f_name', 'f_company', 'f_email', 'f_phone', 'f_website'].forEach((id) => ($(`#${id}`).value = ''));
  $('#addLeadForm').style.display = 'none';
  loadLeads();
});

$('#csvFile').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const formData = new FormData();
  formData.append('file', file);
  const res = await fetch('/api/leads/upload', { method: 'POST', body: formData });
  const data = await res.json();
  const box = $('#uploadResult');
  box.style.display = 'block';
  if (!res.ok) {
    box.textContent = data.error || 'Upload failed.';
  } else {
    box.textContent = `Added ${data.added} lead(s). Skipped ${data.skippedDuplicate} duplicate(s), ${data.skippedNoEmail} row(s) with no valid email. (${data.total} rows in file.)`;
  }
  e.target.value = '';
  loadLeads();
});

$('#btnRunScheduler').addEventListener('click', async () => {
  const res = await fetch('/api/scheduler/run', { method: 'POST' });
  const data = await res.json();
  alert(`Scheduler ran: ${data.processed} email(s) processed.`);
  loadLeads();
});

// ---------- Sequence ----------
async function loadSequence() {
  const res = await fetch('/api/sequence');
  const steps = await res.json();
  $('#sequenceList').innerHTML = steps
    .map(
      (s) => `
      <div class="seq-step" data-step="${s.stepNumber}">
        <div class="seq-step-head">
          <strong>Step ${s.stepNumber}</strong>
          <div class="delay-input">
            <label class="switch-row" style="margin-right:14px">
              <input type="checkbox" class="s-enabled" ${s.enabled ? 'checked' : ''} />
              <span>Enabled</span>
            </label>
            Send
            <input type="number" min="0" class="s-delay" value="${s.delayDays}" />
            day(s) after previous step
          </div>
        </div>
        <label class="small-label">Subject</label>
        <input class="s-subject" value="${escapeHtml(s.subject)}" />
        <label class="small-label" style="margin-top:8px">Body</label>
        <textarea class="s-body">${escapeHtml(s.body)}</textarea>
        <div class="actions" style="margin-top:10px">
          <button class="btn" onclick="saveStep(${s.stepNumber})">Save</button>
          <button class="btn secondary" onclick="previewStep(${s.stepNumber})">Preview</button>
        </div>
        <div class="preview-box" style="display:none"></div>
      </div>`
    )
    .join('');
}

async function saveStep(stepNumber) {
  const el = document.querySelector(`.seq-step[data-step="${stepNumber}"]`);
  const payload = {
    subject: el.querySelector('.s-subject').value,
    body: el.querySelector('.s-body').value,
    delayDays: Number(el.querySelector('.s-delay').value),
    enabled: el.querySelector('.s-enabled').checked,
  };
  await fetch(`/api/sequence/${stepNumber}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  alert(`Step ${stepNumber} saved.`);
}

async function previewStep(stepNumber) {
  const el = document.querySelector(`.seq-step[data-step="${stepNumber}"]`);
  // preview whatever is currently typed, not just the saved version
  const subject = el.querySelector('.s-subject').value;
  const body = el.querySelector('.s-body').value;
  const res = await fetch('/api/sequence/preview', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ stepNumber, sample: {} }),
  });
  const rendered = await res.json();
  const box = el.querySelector('.preview-box');
  box.style.display = 'block';
  box.textContent = `Subject: ${rendered.subject}\n\n${rendered.body}`;
}

// ---------- Settings ----------
async function loadSettings() {
  const res = await fetch('/api/settings');
  const s = await res.json();
  $('#dryRunToggle').checked = s.dryRun;
  $('#s_fromName').value = s.fromName || '';
  $('#s_fromEmail').value = s.fromEmail || '';
  $('#s_appUrl').value = s.appUrl || '';
  $('#resendStatus').textContent = s.resendConfigured
    ? 'Resend API key detected — real sends are possible when dry run is off.'
    : 'No RESEND_API_KEY set — the app will stay in dry-run behavior regardless of the toggle above.';
  updateBadge(s.dryRun);
}

function updateBadge(dryRun) {
  const badge = $('#dryRunBadge');
  badge.textContent = dryRun ? 'DRY RUN' : 'LIVE SENDING';
  badge.className = 'badge' + (dryRun ? '' : ' live');
}

$('#btnSaveSettings').addEventListener('click', async () => {
  const payload = {
    dryRun: $('#dryRunToggle').checked,
    fromName: $('#s_fromName').value.trim(),
    fromEmail: $('#s_fromEmail').value.trim(),
    appUrl: $('#s_appUrl').value.trim(),
  };
  await fetch('/api/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  updateBadge(payload.dryRun);
  alert('Settings saved.');
});

$('#btnTestSend').addEventListener('click', async () => {
  const to = $('#testTo').value.trim();
  if (!to) return alert('Enter an email to send the test to.');
  const force = $('#testForce').checked;
  const res = await fetch('/api/settings/test-send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ to, force }),
  });
  const data = await res.json();
  $('#testResult').textContent = `Result: ${data.status}${data.error ? ' — ' + data.error : ''}`;
});

// ---------- Logs ----------
async function loadLogs() {
  const res = await fetch('/api/logs');
  const logs = await res.json();
  $('#logsBody').innerHTML = logs
    .map(
      (l) => `<tr>
        <td>${fmtDate(l.sentAt)}</td>
        <td>${escapeHtml(l.leadEmail || '')}</td>
        <td>${l.stepNumber}</td>
        <td>${escapeHtml(l.subject)}</td>
        <td><span class="status-pill status-${l.status === 'sent' ? 'active' : l.status === 'dry_run' ? 'completed' : 'unsubscribed'}">${l.status}</span></td>
        <td>${escapeHtml(l.error || '')}</td>
      </tr>`
    )
    .join('') || `<tr><td colspan="6" style="text-align:center;color:#6b7280;padding:24px">No sends yet.</td></tr>`;
}

// initial load
loadLeads();
loadSettings();
