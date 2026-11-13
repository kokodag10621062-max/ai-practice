// 협력사 점검 웹 프로그램 - 서버
// 국세청 사업자등록 상태조회 + 조달청 부정당제재 조회를 대신 호출합니다.
// 인증키는 브라우저로 보내지 않고 서버에서만 사용합니다.

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT) || 3100;
const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');

// ---------- 인증키 읽기 ----------
// 1) 환경변수 DATA_GO_KR_KEY  2) ../.env 의 DATA_GO_KR_KEY=  3) ../.env.txt (같은 형식 또는 키 한 줄)
function loadKey() {
  if (process.env.DATA_GO_KR_KEY) return process.env.DATA_GO_KR_KEY.trim();
  const parent = path.join(ROOT, '..');
  for (const name of ['.env', '.env.txt']) {
    const file = path.join(parent, name);
    if (!fs.existsSync(file)) continue;
    const lines = fs.readFileSync(file, 'utf8').replace(/^﻿/, '').split(/\r?\n/);
    for (const line of lines) {
      const m = line.match(/^\s*DATA_GO_KR_KEY\s*=\s*(.+?)\s*$/);
      if (m) return m[1].replace(/^['"]|['"]$/g, '');
    }
    // 변수명 없이 키만 한 줄 적혀 있는 경우
    const bare = lines.map((l) => l.trim()).filter(Boolean);
    if (bare.length === 1 && /^[A-Za-z0-9%+/=]{20,}$/.test(bare[0])) return bare[0];
  }
  return null;
}

const RAW_KEY = loadKey();
if (!RAW_KEY) {
  console.error('[오류] DATA_GO_KR_KEY 를 찾지 못했습니다. ai-practice/.env 에 DATA_GO_KR_KEY=키값 을 적어 주세요.');
  process.exit(1);
}
// 인코딩된 키(%포함)는 그대로, 디코딩 키는 URL 인코딩해서 사용
const KEY = RAW_KEY.includes('%') ? RAW_KEY : encodeURIComponent(RAW_KEY);

// ---------- 공통 유틸 ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchWithTimeout(url, options = {}, ms = 20000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...options, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

// 오류 메시지에 키가 섞여 나가지 않도록 정리
function cleanError(e) {
  let msg = e && e.name === 'AbortError' ? '응답 시간 초과' : String((e && e.message) || e);
  if (e && e.cause) msg += ` (${e.cause.code || e.cause.message || e.cause})`;
  return msg.split(KEY).join('***').split(RAW_KEY).join('***').slice(0, 200);
}

async function withRetry(fn, tries = 3) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      if (e && e.noRetry) break;
      await sleep(500 * (i + 1));
    }
  }
  throw last;
}

// ---------- 국세청: 사업자등록 상태조회 (최대 100건씩) ----------
async function ntsStatus(bnos) {
  const url = `https://api.odcloud.kr/api/nts-businessman/v1/status?serviceKey=${KEY}&returnType=JSON`;
  const res = await fetchWithTimeout(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ b_no: bnos }),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`국세청 응답 형식 오류 (HTTP ${res.status})`);
  }
  if (!res.ok || json.status_code !== 'OK') {
    const err = new Error(`국세청 오류: ${json.msg || json.status_code || 'HTTP ' + res.status}`);
    if (res.status === 401) err.noRetry = true;
    throw err;
  }
  return json.data || [];
}

async function checkNts(bnos) {
  const out = new Map();
  for (let i = 0; i < bnos.length; i += 100) {
    const chunk = bnos.slice(i, i + 100);
    try {
      const data = await withRetry(() => ntsStatus(chunk));
      const byNo = new Map(data.map((d) => [d.b_no, d]));
      for (const b of chunk) {
        const d = byNo.get(b);
        if (!d) {
          out.set(b, { ok: false, error: '국세청 응답에 해당 번호 없음' });
        } else if (!d.b_stt_cd) {
          // 국세청에 등록되지 않은 번호 (조회는 성공)
          out.set(b, { ok: true, code: '', status: '미등록', taxType: d.tax_type || '', endDate: '' });
        } else {
          out.set(b, {
            ok: true,
            code: d.b_stt_cd, // 01 계속, 02 휴업, 03 폐업
            status: d.b_stt,
            taxType: d.tax_type,
            endDate: d.end_dt ? `${d.end_dt.slice(0, 4)}-${d.end_dt.slice(4, 6)}-${d.end_dt.slice(6, 8)}` : '',
          });
        }
      }
    } catch (e) {
      for (const b of chunk) out.set(b, { ok: false, error: cleanError(e) });
    }
  }
  return out;
}

// ---------- 조달청: 부정당제재업체 조회 (1건씩) ----------
async function pps(bno) {
  const items = [];
  let page = 1;
  let total = 0;
  do {
    const url =
      `https://apis.data.go.kr/1230000/ao/UsrInfoService02/getUnptRsttCorpInfo02` +
      `?serviceKey=${KEY}&numOfRows=100&pageNo=${page}&type=json&inqryDiv=1&bizno=${bno}`;
    const res = await fetchWithTimeout(url);
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error(`조달청 응답 형식 오류 (HTTP ${res.status})`);
    }
    if (json.OpenAPI_ServiceResponse) {
      const h = json.OpenAPI_ServiceResponse.cmmMsgHeader || {};
      const err = new Error(`조달청 오류: ${h.returnAuthMsg || h.errMsg || 'HTTP ' + res.status}`);
      if (['30', '31', '32', '12', '20', '22'].includes(String(h.returnReasonCode))) err.noRetry = true;
      throw err;
    }
    const header = json.response && json.response.header;
    if (!header || header.resultCode !== '00') {
      throw new Error(`조달청 오류: ${(header && header.resultMsg) || 'HTTP ' + res.status}`);
    }
    const body = json.response.body || {};
    total = Number(body.totalCount || 0);
    let list = body.items || [];
    if (!Array.isArray(list)) list = list.item ? [].concat(list.item) : [list];
    items.push(...list);
    page++;
  } while (items.length < total && page <= 10);
  return { total, items };
}

async function checkPps(bnos, concurrency = 4) {
  const out = new Map();
  let idx = 0;
  async function worker() {
    while (idx < bnos.length) {
      const b = bnos[idx++];
      try {
        const { total, items } = await withRetry(() => pps(b));
        out.set(b, {
          ok: true,
          count: total,
          corpName: items[0] ? items[0].corpNm : '',
          items: items.map((it) => ({
            institution: it.insttNm,
            start: it.rsttBgnDate,
            end: it.rsttEndDate,
            law: it.lawordNm,
            reason: it.enfcPrvNm || it.lawordArtclClauseCdNm || '',
            progress: it.rsttProgrsNm,
          })),
        });
      } catch (e) {
        out.set(b, { ok: false, error: cleanError(e) });
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, bnos.length) }, worker));
  return out;
}

// ---------- HTTP 서버 ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
const STATIC = {
  '/': path.join(PUBLIC, 'index.html'),
  '/app.js': path.join(PUBLIC, 'app.js'),
  '/style.css': path.join(PUBLIC, 'style.css'),
  '/vendor/xlsx.full.min.js': path.join(ROOT, 'node_modules', 'xlsx', 'dist', 'xlsx.full.min.js'),
};

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

function readBody(req, limit = 1e6) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('요청이 너무 큽니다'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (req.method === 'POST' && url.pathname === '/api/check') {
      const { bnos } = JSON.parse((await readBody(req)) || '{}');
      if (!Array.isArray(bnos) || bnos.length === 0) return send(res, 400, { error: '사업자등록번호 목록이 비어 있습니다.' });
      if (bnos.length > 200) return send(res, 400, { error: '한 번에 200건까지 요청할 수 있습니다.' });
      const list = [...new Set(bnos.map((b) => String(b).replace(/\D/g, '')).filter((b) => b.length === 10))];
      const [nts, pp] = await Promise.all([checkNts(list), checkPps(list)]);
      const results = {};
      for (const b of list) results[b] = { nts: nts.get(b), pps: pp.get(b) };
      return send(res, 200, { checkedAt: new Date().toISOString(), results });
    }

    if (req.method === 'GET' && STATIC[url.pathname]) {
      const file = STATIC[url.pathname];
      return send(res, 200, fs.readFileSync(file), MIME[path.extname(file)] || 'application/octet-stream');
    }

    send(res, 404, { error: 'Not found' });
  } catch (e) {
    send(res, 500, { error: cleanError(e) });
  }
});

server.listen(PORT, () => {
  console.log(`협력사 점검 서버 실행 중: http://localhost:${PORT}`);
});
