const express = require('express');
const cors = require('cors');
const axios = require('axios');
const xml2js = require('xml2js');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(process.cwd(), 'public')));

// ============================================================
// Configuration & Cache
// ============================================================
const WORKERS_BASE = 'https://iett.rednexie.workers.dev';
const IBB_BASE = 'https://api.ibb.gov.tr/iett';
const OSRM_BASE = 'https://router.project-osrm.org';

const cache = {
  hatlar: { data: null, timestamp: 0 },
  duraklar_all: { data: null, timestamp: 0 }
};

const CACHE_TTL = 24 * 60 * 60 * 1000;

// ============================================================
// Helpers
// ============================================================
async function soapRequest(url, namespace, method, params = {}) {
  let paramXml = '';
  for (const [key, value] of Object.entries(params)) {
    paramXml += `<${key}>${value}</${key}>`;
  }
  const envelope = `<?xml version="1.0" encoding="utf-8"?>
<soap12:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:soap12="http://www.w3.org/2003/05/soap-envelope">
  <soap12:Body><${method} xmlns="${namespace}">${paramXml}</${method}></soap12:Body>
</soap12:Envelope>`;

  const response = await axios.post(url, envelope, {
    headers: { 'Content-Type': 'application/soap+xml; charset=utf-8' },
    timeout: 10000,
  });
  return await xml2js.parseStringPromise(response.data, { explicitArray: false, ignoreAttrs: true });
}

function extractResult(parsed, method) {
  try {
    const body = parsed['soap:Envelope']?.['soap:Body'] || parsed['soap12:Envelope']?.['soap12:Body'] || parsed[Object.keys(parsed)[0]]['soap:Body'] || parsed[Object.keys(parsed)[0]]['soap12:Body'];
    const res = body[`${method}Response`][`${method}Result` || `${method}Response`];
    return res;
  } catch (e) { return null; }
}

async function getAllStops() {
  if (cache.duraklar_all.data && Date.now() - cache.duraklar_all.timestamp < CACHE_TTL) return cache.duraklar_all.data;
  try {
    const p = await soapRequest(`${IBB_BASE}/UlasimAnaVeri/HatDurakGuzergah.asmx`, 'http://tempuri.org/', 'GetDurak_json');
    const r = extractResult(p, 'GetDurak_json');
    const raw = typeof r === 'string' ? JSON.parse(r) : [];
    const data = raw.map(d => {
      let lat = 0, lon = 0;
      const m = (d.KOORDINAT || '').match(/POINT\s*\(([0-9.]+)\s+([0-9.]+)\)/);
      if (m) { lon = parseFloat(m[1]); lat = parseFloat(m[2]); }
      return { kod: String(d.SDURAKKODU || d.DURAKKODU || ''), adi: d.SDURAKADI || d.DURAKADI || '', lat, lon, yon: d.SYON || '' };
    });
    cache.duraklar_all = { data, timestamp: Date.now() };
    return data;
  } catch (e) { return []; }
}

// ============================================================
// API Endpoints
// ============================================================

app.get('/api/hat-ara', async (req, res) => {
  const q = (req.query.q || '').toLowerCase();
  try {
    const r = await axios.get(`${WORKERS_BASE}/api/line-suggestions?q=${encodeURIComponent(q)}`);
    res.json(r.data);
  } catch (e) { res.json([]); }
});

app.get('/api/durak-ara', async (req, res) => {
  const q = (req.query.q || '').toLowerCase();
  const all = await getAllStops();
  res.json(all.filter(s => s.kod.includes(q) || s.adi.toLowerCase().includes(q)).slice(0, 15));
});

app.get('/api/hatlar', async (req, res) => {
  try {
    const p = await soapRequest(`${IBB_BASE}/UlasimAnaVeri/HatDurakGuzergah.asmx`, 'http://tempuri.org/', 'GetHat_json');
    const r = extractResult(p, 'GetHat_json');
    res.json(JSON.parse(r).map(h => ({ SHPIETT: h.SHATKODU || h.SHPIETT, SHAT_ADI: h.SHATADI || h.SHAT_ADI })));
  } catch (e) { res.json([]); }
});

app.get('/api/guzergah/:hatKodu', async (req, res) => {
  const h = req.params.hatKodu;
  try {
    const r = await axios.get(`${WORKERS_BASE}/api/route-stations?hatkod=${encodeURIComponent(h)}&langid=1`);
    const matches = [...r.data.matchAll(/dkod=(\d+)[^"]*stationname=([^"&]+)[^>]*>.*?<p>(\d+)\.\s*([^<]+)/g)];
    const stops = matches.map(m => ({ sira: parseInt(m[3]), kod: m[1], adi: decodeURIComponent(m[2].replace(/\+/g, ' ')) }));
    const all = await getAllStops();
    const map = {}; all.forEach(s => map[s.kod] = s);
    const half = Math.floor(stops.length / 2);
    res.json({ duraklar: { G: stops.slice(0, half).map(s => ({ ...s, ...map[s.kod] })), D: stops.slice(half).map(s => ({ ...s, ...map[s.kod] })) }, routeLine: { G: [], D: [] } });
  } catch (e) { res.json({ duraklar: { G: [], D: [] } }); }
});

app.get('/api/otobus-konum/:hatKodu', async (req, res) => {
  try {
    const r = await axios.post(`${WORKERS_BASE}/line-vehicles`, { line: req.params.hatKodu });
    const raw = r.data.vehicles || r.data || [];
    const otobusler = raw.map(v => ({
      kapino: v.vehicleDoorCode || v.KAPINO || '',
      lon: parseFloat(v.lon || 0), lat: parseFloat(v.lat || 0),
      dir: (v.guzergah || '').includes('_G_') ? 'G' : (v.guzergah || '').includes('_D_') ? 'D' : null,
      variant: (v.guzergah || '').split('_').pop() || '',
      direction: v.direction || ''
    }));
    const variants = {};
    otobusler.forEach(v => {
      const k = `${v.dir}_${v.variant}`;
      if (!variants[k]) variants[k] = { dir: v.dir, variant: v.variant, count: 0, label: v.direction };
      variants[k].count++;
    });
    res.json({ otobusler, varyantlar: Object.values(variants) });
  } catch (e) { res.json({ otobusler: [] }); }
});

app.get('/api/durak-detay/:kod', async (req, res) => {
  try {
    const all = await getAllStops();
    const stop = all.find(s => s.kod === req.params.kod);
    const p = await soapRequest(`${IBB_BASE}/FiloDurak/FiloDurakSor662.asmx`, 'http://tempuri.org/', 'GetDurakDetay_json', { DurakKodu: req.params.kod });
    const r = extractResult(p, 'GetDurakDetay_json');
    const raw = typeof r === 'string' ? JSON.parse(r) : [];
    const gelenler = (Array.isArray(raw) ? raw : []).map(g => ({ hat: g.HATKODU, kapino: g.KAPINO, eta_dk: parseInt(g.KALANSURE), mesafe_km: parseInt(g.KALANMESAFE) / 1000, yon: g.YON }));
    res.json({ durak: stop, gelenler: gelenler.sort((a, b) => a.eta_dk - b.eta_dk) });
  } catch (e) { res.json({ gelenler: [] }); }
});

app.get('/api/sefer-saatleri/:hatKodu', async (req, res) => {
  try {
    const p = await soapRequest(`${IBB_BASE}/UlasimAnaVeri/PlanlananSeferSaati.asmx`, 'http://tempuri.org/', 'GetPlanlananSeferSaati_json', { HatKodu: req.params.hatKodu });
    const r = JSON.parse(extractResult(p, 'GetPlanlananSeferSaati_json') || '[]');
    const s = { I: { G: [], D: [] }, C: { G: [], D: [] }, P: { G: [], D: [] } };
    r.forEach(x => { if (s[x.SGUNTIPI] && s[x.SGUNTIPI][x.SYON]) s[x.SGUNTIPI][x.SYON].push({ t: x.DT, v: x.SGUZERAH }); });
    res.json(s);
  } catch (e) { res.json({}); }
});

app.get('/api/line-variants/:hatKodu', async (req, res) => {
  res.json([]); // Simplified for now
});

app.get('/api/osrm-traffic/:hatKodu/:dir', async (req, res) => {
  res.json({ segments: [] }); // Simplified for now
});

app.get('*', (req, res) => res.sendFile(path.join(process.cwd(), 'public', 'index.html')));

module.exports = app;
if (require.main === module) app.listen(PORT);
