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
  duraklar_all: { data: null, timestamp: 0 },
  generic: {} // general purpose cache
};

const CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours for static data
const BUS_POS_TTL = 20 * 1000; // 20 seconds for vehicle positions

// ============================================================
// Helpers
// ============================================================
function buildSoapEnvelope(namespace, method, params = {}) {
  let paramXml = '';
  for (const [key, value] of Object.entries(params)) {
    paramXml += `<${key}>${value}</${key}>`;
  }
  return `<?xml version="1.0" encoding="utf-8"?>
<soap12:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
  xmlns:xsd="http://www.w3.org/2001/XMLSchema"
  xmlns:soap12="http://www.w3.org/2003/05/soap-envelope">
  <soap12:Body>
    <${method} xmlns="${namespace}">
      ${paramXml}
    </${method}>
  </soap12:Body>
</soap12:Envelope>`;
}

async function soapRequest(url, namespace, method, params = {}) {
  const envelope = buildSoapEnvelope(namespace, method, params);
  const response = await axios.post(url, envelope, {
    headers: { 'Content-Type': 'application/soap+xml; charset=utf-8' },
    timeout: 15000,
  });
  const result = await xml2js.parseStringPromise(response.data, {
    explicitArray: false,
    ignoreAttrs: true,
  });
  return result;
}

function extractSoapResult(parsed, method) {
  try {
    const envelope = Object.values(parsed)[0];
    const body = envelope['soap:Body'] || envelope['soap12:Body'] || envelope['Body'];
    const responseKey = `${method}Response`;
    const resultKey = `${method}Result`;
    return body[responseKey]?.[resultKey] || body[responseKey] || null;
  } catch (e) { return null; }
}

function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

// ============================================================
// Core Logic Functions
// ============================================================

async function getAllLines() {
  if (cache.hatlar.data && Date.now() - cache.hatlar.timestamp < CACHE_TTL) return cache.hatlar.data;
  try {
    const url = `${IBB_BASE}/UlasimAnaVeri/HatDurakGuzergah.asmx`;
    const parsed = await soapRequest(url, 'http://tempuri.org/', 'GetHat_json');
    const result = extractSoapResult(parsed, 'GetHat_json');
    let raw = typeof result === 'string' ? JSON.parse(result) : (result || []);
    const data = raw.map(h => ({
      SHPIETT: h.SHATKODU || h.SHPIETT || '',
      SHAT_ADI: h.SHATADI || h.SHAT_ADI || ''
    })).filter(h => h.SHPIETT);
    cache.hatlar = { data, timestamp: Date.now() };
    return data;
  } catch (e) { return cache.hatlar.data || []; }
}

async function getAllStops() {
  if (cache.duraklar_all.data && Date.now() - cache.duraklar_all.timestamp < CACHE_TTL) return cache.duraklar_all.data;
  try {
    const url = `${IBB_BASE}/UlasimAnaVeri/HatDurakGuzergah.asmx`;
    const parsed = await soapRequest(url, 'http://tempuri.org/', 'GetDurak_json');
    const result = extractSoapResult(parsed, 'GetDurak_json');
    let raw = typeof result === 'string' ? JSON.parse(result) : (result || []);
    const data = raw.map(d => {
      let lat = 0, lon = 0;
      const coord = d.KOORDINAT || '';
      const m = coord.match(/POINT\s*\(([0-9.]+)\s+([0-9.]+)\)/);
      if (m) { lon = parseFloat(m[1]); lat = parseFloat(m[2]); }
      return {
        kod: String(d.SDURAKKODU || d.DURAKKODU || ''),
        adi: d.SDURAKADI || d.DURAKADI || '',
        lat, lon,
        yon: d.SYON || ''
      };
    }).filter(d => d.kod);
    cache.duraklar_all = { data, timestamp: Date.now() };
    return data;
  } catch (e) { return cache.duraklar_all.data || []; }
}

// ============================================================
// API Endpoints
// ============================================================

// Arama: Hatlar
app.get('/api/hat-ara', async (req, res) => {
  const q = (req.query.q || '').toLowerCase();
  try {
    const resp = await axios.get(`${WORKERS_BASE}/api/line-suggestions?q=${encodeURIComponent(q)}`);
    res.json(resp.data);
  } catch (e) {
    const all = await getAllLines();
    const filtered = all.filter(h => h.SHPIETT.toLowerCase().includes(q) || h.SHAT_ADI.toLowerCase().includes(q)).slice(0, 10);
    res.json(filtered);
  }
});

// Arama: Duraklar
app.get('/api/durak-ara', async (req, res) => {
  const q = (req.query.q || '').toLowerCase();
  const allStops = await getAllStops();
  const filtered = allStops.filter(s => s.kod.toLowerCase().includes(q) || s.adi.toLowerCase().includes(q)).slice(0, 15);
  res.json(filtered);
});

// Hat Listesi (Tümü)
app.get('/api/hatlar', async (req, res) => {
  const data = await getAllLines();
  res.json(data);
});

// Hat Güzergahı
app.get('/api/guzergah/:hatKodu', async (req, res) => {
  const hatKodu = req.params.hatKodu;
  try {
    const resp = await axios.get(`${WORKERS_BASE}/api/route-stations?hatkod=${encodeURIComponent(hatKodu)}&langid=1`);
    const html = resp.data;

    // Basit bir regex ile HTML'den durakları ayıklayalım (Python'daki mantık)
    const items = [...html.matchAll(/dkod=(\d+)[^"]*stationname=([^"&]+)[^>]*>.*?<p>(\d+)\.\s*([^<]+)/g)];
    const stops = items.map(m => ({
      sira: parseInt(m[3]),
      kod: m[1],
      adi: decodeURIComponent(m[2].replace(/\+/g, ' '))
    }));

    // Durak GPS verilerini ekle
    const allStops = await getAllStops();
    const stopMap = {};
    allStops.forEach(s => stopMap[s.kod] = s);

    const half = Math.floor(stops.length / 2);
    const gidis = stops.slice(0, half).map(s => ({ ...s, ...(stopMap[s.kod] || {}) }));
    const donus = stops.slice(half).map(s => ({ ...s, ...(stopMap[s.kod] || {}) }));

    res.json({
      duraklar: { G: gidis, D: donus },
      routeLine: { G: [], D: [] }, // OSRM geometry opsiyonel
      bilgi: { hatKodu }
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Canlı Otobüs Konumları
app.get('/api/otobus-konum/:hatKodu', async (req, res) => {
  const hatKodu = req.params.hatKodu;
  try {
    const resp = await axios.post(`${WORKERS_BASE}/line-vehicles`, { line: hatKodu });
    const raw = resp.data.vehicles || resp.data;
    const otobusler = raw.map(v => {
      const gz = v.guzergah || '';
      const parts = gz.split('_');
      return {
        kapino: v.vehicleDoorCode || '',
        lon: parseFloat(v.lon || 0),
        lat: parseFloat(v.lat || 0),
        direction: v.direction || '',
        dir: parts.includes('G') ? 'G' : parts.includes('D') ? 'D' : null,
        variant: parts[parts.length - 1] || ''
      };
    });

    // Varyantları grupla
    const variants = {};
    otobusler.forEach(v => {
      const key = `${v.dir}_${v.variant}`;
      if (!variants[key]) variants[key] = { dir: v.dir, variant: v.variant, count: 0, label: v.direction };
      variants[key].count++;
    });

    res.json({
      hatKodu,
      otobusler,
      toplamOtobus: otobusler.length,
      varyantlar: Object.values(variants)
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Durak Detayı & ETA (En Kritik Kısım)
app.get('/api/durak-detay/:durakKodu', async (req, res) => {
  const durakKodu = req.params.durakKodu;
  const allStops = await getAllStops();
  const stopInfo = allStops.find(s => s.kod === durakKodu);

  if (!stopInfo) return res.status(404).json({ error: 'Durak bulunamadı' });

  try {
    // IETT resmi "Yaklaşan Otobüsler" API'sini dene
    const url = `${IBB_BASE}/FiloDurak/FiloDurakSor662.asmx`;
    const parsed = await soapRequest(url, 'http://tempuri.org/', 'GetDurakDetay_json', { DurakKodu: durakKodu });
    const result = extractSoapResult(parsed, 'GetDurakDetay_json');
    const gelenlerRaw = typeof result === 'string' ? JSON.parse(result) : (result || []);

    const gelenler = (Array.isArray(gelenlerRaw) ? gelenlerRaw : []).map(g => ({
      hat: g.HATKODU || '',
      kapino: g.KAPINO || '',
      eta_dk: parseInt(g.KALANSURE) || 0,
      mesafe_km: (parseInt(g.KALANMESAFE) || 0) / 1000,
      yon: g.YON || ''
    }));

    res.json({
      durak: stopInfo,
      gelenler: gelenler.sort((a, b) => a.eta_dk - b.eta_dk)
    });
  } catch (e) {
    res.json({ durak: stopInfo, gelenler: [], error: 'Canlı veri alınamadı' });
  }
});

// Sefer Saatleri
app.get('/api/sefer-saatleri/:hatKodu', async (req, res) => {
  const hatKodu = req.params.hatKodu;
  try {
    const url = `${IBB_BASE}/UlasimAnaVeri/PlanlananSeferSaati.asmx`;
    const parsed = await soapRequest(url, 'http://tempuri.org/', 'GetPlanlananSeferSaati_json', { HatKodu: hatKodu });
    const result = extractSoapResult(parsed, 'GetPlanlananSeferSaati_json');
    const raw = typeof result === 'string' ? JSON.parse(result) : (result || []);

    const structured = { I: { G: [], D: [] }, C: { G: [], D: [] }, P: { G: [], D: [] } };
    raw.forEach(s => {
      const day = s.SGUNTIPI; // I, C, P
      const dir = s.SYON; // G, D
      if (structured[day] && structured[day][dir]) {
        structured[day][dir].push({ t: s.DT, v: s.SGUZERAH });
      }
    });
    res.json(structured);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Fallback for SPA
app.get('*', (req, res) => {
  res.sendFile(path.join(process.cwd(), 'public', 'index.html'));
});

module.exports = app;

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`🚌 IETT Sunucusu Port ${PORT} üzerinde aktif`);
    getAllStops(); // Pre-cache stops
  });
}
