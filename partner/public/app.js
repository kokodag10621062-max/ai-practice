// 협력사 점검 - 화면 로직
const $ = (s) => document.querySelector(s);
const FAIL = '조회 실패';
const BATCH = 20; // 서버에 한 번에 보내는 건수 (진행률 표시용)

let rows = [];      // { no, raw, bno, name, valid, nts, pps }
let filter = 'all';
let checkedAt = null;

// ---------- 파일 읽기 ----------
const fileInput = $('#file');
const drop = $('#drop');
fileInput.addEventListener('change', () => fileInput.files[0] && handleFile(fileInput.files[0]));
['dragover', 'dragenter'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
drop.addEventListener('drop', (e) => e.dataTransfer.files[0] && handleFile(e.dataTransfer.files[0]));

const digits = (v) => String(v ?? '').replace(/\D/g, '');
const fmtBno = (b) => (b.length === 10 ? `${b.slice(0, 3)}-${b.slice(3, 5)}-${b.slice(5)}` : b);

async function handleFile(file) {
  try {
    const wb = XLSX.read(await file.arrayBuffer(), { type: 'array' });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const grid = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: '' });
    const parsed = parseGrid(grid);
    if (!parsed.length) {
      alertBox(`'${file.name}'에서 사업자등록번호를 찾지 못했습니다. '사업자등록번호' 제목의 열을 만들어 주세요.`);
      return;
    }
    rows = parsed;
    const valid = rows.filter((r) => r.valid).length;
    const fi = $('#fileInfo');
    fi.hidden = false;
    fi.textContent = `${file.name} · ${rows.length}건 읽음 (조회 대상 ${valid}건${rows.length - valid ? `, 형식 오류 ${rows.length - valid}건` : ''})`;
    await runCheck(rows.filter((r) => r.valid));
  } catch (e) {
    alertBox('파일을 읽지 못했습니다: ' + e.message);
  } finally {
    fileInput.value = '';
  }
}

function alertBox(msg) {
  const fi = $('#fileInfo');
  fi.hidden = false;
  fi.innerHTML = `<span class="badge b-warn">확인</span> ${escapeHtml(msg)}`;
}

function parseGrid(grid) {
  grid = grid.filter((r) => r.some((c) => String(c).trim() !== ''));
  if (!grid.length) return [];
  const header = grid[0].map((c) => String(c).replace(/\s/g, ''));
  let bCol = header.findIndex((h) => /사업자|등록번호|bizno|b_no/i.test(h));
  let nCol = header.findIndex((h) => /업체|상호|회사|거래처|협력사|기업명/.test(h) && !/번호/.test(h));
  let start = 1;
  if (bCol < 0) {
    // 제목 행이 없으면 10자리 숫자가 가장 많은 열을 사용
    const counts = [];
    grid.forEach((r) => r.forEach((c, i) => { if (digits(c).length === 10) counts[i] = (counts[i] || 0) + 1; }));
    bCol = counts.reduce((best, n, i) => (n > (counts[best] || 0) ? i : best), -1);
    if (bCol < 0) return [];
    start = digits(grid[0][bCol]).length === 10 ? 0 : 1;
  }
  const out = [];
  for (let i = start; i < grid.length; i++) {
    const raw = String(grid[i][bCol] ?? '').trim();
    if (!raw) continue;
    const bno = digits(raw);
    out.push({
      no: out.length + 1,
      raw,
      bno,
      name: nCol >= 0 ? String(grid[i][nCol] ?? '').trim() : '',
      valid: bno.length === 10,
      nts: null,
      pps: null,
    });
  }
  return out;
}

// ---------- 조회 ----------
async function runCheck(targets) {
  const list = [...new Set(targets.map((r) => r.bno))];
  $('#progressBox').hidden = false;
  $('#resultBox').hidden = false;
  setButtons(true);
  let done = 0;
  updateProgress(done, list.length);
  render();

  for (let i = 0; i < list.length; i += BATCH) {
    const chunk = list.slice(i, i + BATCH);
    let results = {};
    try {
      const res = await fetch('/api/check', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bnos: chunk }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
      results = json.results;
      checkedAt = new Date(json.checkedAt);
    } catch (e) {
      const err = { ok: false, error: '서버 연결 실패: ' + e.message };
      chunk.forEach((b) => (results[b] = { nts: err, pps: err }));
    }
    for (const r of rows) {
      if (results[r.bno]) {
        r.nts = results[r.bno].nts || { ok: false, error: '응답 없음' };
        r.pps = results[r.bno].pps || { ok: false, error: '응답 없음' };
      }
    }
    done += chunk.length;
    updateProgress(done, list.length);
    render();
  }
  setButtons(false);
  $('#progressText').textContent = `조회 완료 · ${checkedAt ? checkedAt.toLocaleString('ko-KR') : ''}`;
}

function updateProgress(done, total) {
  $('#bar').style.width = total ? `${(done / total) * 100}%` : '100%';
  $('#progressText').textContent = `조회 중… ${done} / ${total}건`;
}

function setButtons(busy) {
  $('#downloadBtn').disabled = busy;
  $('#retryBtn').disabled = busy;
}

$('#retryBtn').addEventListener('click', () => {
  const failed = rows.filter((r) => r.valid && ((r.nts && !r.nts.ok) || (r.pps && !r.pps.ok)));
  if (failed.length) runCheck(failed);
});

// ---------- 판정 ----------
function verdict(r) {
  if (!r.valid) return { key: 'fail', label: '형식 오류', cls: 'b-fail' };
  if (!r.nts || !r.pps) return { key: 'pending', label: '조회 중', cls: 'b-fail' };
  const failed = !r.nts.ok || !r.pps.ok;
  const bad = (r.nts.ok && r.nts.code !== '01') || (r.pps.ok && r.pps.count > 0);
  if (bad) return { key: 'warn', label: failed ? '주의 (일부 조회 실패)' : '주의', cls: 'b-warn' };
  if (failed) return { key: 'fail', label: '확인 필요', cls: 'b-fail' };
  return { key: 'ok', label: '정상', cls: 'b-ok' };
}

function ntsText(n) {
  if (!n) return '';
  if (!n.ok) return FAIL;
  return n.status || '미등록';
}
function ntsBadge(n) {
  if (!n) return '<span class="muted">…</span>';
  if (!n.ok) return `<span class="badge b-fail">${FAIL}</span><span class="err">${escapeHtml(n.error)}</span>`;
  const cls = n.code === '01' ? 'b-ok' : n.code === '02' ? 'b-caution' : 'b-warn';
  return `<span class="badge ${cls}">${escapeHtml(n.status || '미등록')}</span>`;
}
function ppsText(p) {
  if (!p) return '';
  if (!p.ok) return FAIL;
  return `${p.count}건`;
}
function ppsBadge(p) {
  if (!p) return '<span class="muted">…</span>';
  if (!p.ok) return `<span class="badge b-fail">${FAIL}</span><span class="err">${escapeHtml(p.error)}</span>`;
  return `<span class="badge ${p.count ? 'b-warn' : 'b-ok'}">${p.count}건</span>`;
}
function ppsDetail(p) {
  if (!p || !p.ok || !p.items.length) return '';
  return p.items
    .map((it) => `${it.progress && it.progress !== '제재' ? `[${it.progress}] ` : ''}${it.institution} · ${it.start}~${it.end} · ${it.reason}`)
    .join('\n');
}

// ---------- 표 ----------
$('#filters').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  filter = b.dataset.f;
  document.querySelectorAll('#filters button').forEach((x) => x.classList.toggle('on', x === b));
  render();
});

function render() {
  const tbody = $('#table tbody');
  const shown = rows.filter((r) => filter === 'all' || verdict(r).key === filter);
  tbody.innerHTML = shown
    .map((r) => {
      const v = verdict(r);
      const name = r.name || (r.pps && r.pps.ok && r.pps.corpName) || '';
      const n = r.valid ? r.nts : null;
      return `<tr>
        <td class="num">${r.no}</td>
        <td class="num">${escapeHtml(r.valid ? fmtBno(r.bno) : r.raw)}</td>
        <td>${escapeHtml(name)}</td>
        <td>${r.valid ? ntsBadge(r.nts) : '<span class="badge b-fail">형식 오류</span>'}</td>
        <td>${n && n.ok ? escapeHtml(n.taxType) : ''}</td>
        <td class="num">${n && n.ok ? escapeHtml(n.endDate) : ''}</td>
        <td>${r.valid ? ppsBadge(r.pps) : ''}</td>
        <td class="detail">${escapeHtml(ppsDetail(r.pps)).split('\n').map((l) => (l ? `<div>${l}</div>` : '')).join('')}</td>
        <td><span class="badge ${v.cls}">${v.label}</span></td>
      </tr>`;
    })
    .join('');
  if (!shown.length) tbody.innerHTML = '<tr><td colspan="9" class="muted">해당하는 업체가 없습니다.</td></tr>';
  renderSummary();
}

function renderSummary() {
  const c = { all: rows.length, ok: 0, warn: 0, fail: 0, closed: 0, sanc: 0 };
  for (const r of rows) {
    const k = verdict(r).key;
    if (c[k] !== undefined) c[k]++;
    if (r.nts && r.nts.ok && r.nts.code !== '01') c.closed++;
    if (r.pps && r.pps.ok && r.pps.count > 0) c.sanc++;
  }
  $('#summary').innerHTML = [
    ['전체', c.all], ['정상', c.ok], ['주의', c.warn], ['휴·폐업·미등록', c.closed], ['부정당제재', c.sanc], ['조회 실패·형식 오류', c.fail],
  ].map(([l, n]) => `<div class="stat"><b>${n}</b><span>${l}</span></div>`).join('');
  const hasFail = rows.some((r) => r.valid && ((r.nts && !r.nts.ok) || (r.pps && !r.pps.ok)));
  $('#retryBtn').hidden = !hasFail;
}

// ---------- 엑셀 내려받기 ----------
$('#downloadBtn').addEventListener('click', () => {
  const data = rows.map((r) => {
    const n = r.valid ? r.nts : null;
    const p = r.valid ? r.pps : null;
    return {
      No: r.no,
      사업자등록번호: r.valid ? fmtBno(r.bno) : r.raw,
      업체명: r.name || (p && p.ok && p.corpName) || '',
      '사업자 상태': r.valid ? ntsText(n) : '형식 오류',
      과세유형: n && n.ok ? n.taxType : '',
      폐업일: n && n.ok ? n.endDate : '',
      부정당제재: r.valid ? ppsText(p) : '',
      '제재 내용': ppsDetail(p),
      종합: verdict(r).label,
      '실패 사유': [n && !n.ok ? '국세청: ' + n.error : '', p && !p.ok ? '조달청: ' + p.error : ''].filter(Boolean).join(' / '),
    };
  });
  const ws = XLSX.utils.json_to_sheet(data);
  ws['!cols'] = [6, 15, 28, 12, 22, 12, 11, 60, 18, 40].map((w) => ({ wch: w }));
  const info = XLSX.utils.aoa_to_sheet([
    ['조회 일시', checkedAt ? checkedAt.toLocaleString('ko-KR') : ''],
    ['사업자 상태 출처', '국세청 사업자등록정보 진위확인 및 상태조회 서비스 (공공데이터포털)'],
    ['부정당제재 출처', '조달청 나라장터 사용자정보 서비스 - 부정당제재업체정보조회 (조회 시점 효력 있는 제재만 제공)'],
    ['조회 실패', 'API 오류·시간 초과로 확인하지 못한 건. 0건(제재 없음 확인)과 다름'],
  ]);
  info['!cols'] = [{ wch: 18 }, { wch: 90 }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, '점검결과');
  XLSX.utils.book_append_sheet(wb, info, '조회정보');
  const d = checkedAt || new Date();
  const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  XLSX.writeFile(wb, `협력사점검_${stamp}.xlsx`);
});

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
