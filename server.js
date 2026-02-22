const express = require('express');
const cors = require('cors');
const axios = require('axios');
const xml2js = require('xml2js');
const path = require('path');

const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ============================================================
// Cache
// ============================================================
const cache = {
  hatlar: { data: null, timestamp: 0 },
};
const CACHE_TTL = 60 * 60 * 1000; // 1 saat

// ============================================================
// SOAP Helpers
// ============================================================
const IBB_BASE = 'https://api.ibb.gov.tr/iett';

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
    headers: {
      'Content-Type': 'application/soap+xml; charset=utf-8',
    },
    timeout: 30000,
  });
  const result = await xml2js.parseStringPromise(response.data, {
    explicitArray: false,
    ignoreAttrs: true,
  });
  return result;
}

function extractSoapResult(parsed, method) {
  try {
    const body = parsed['soap:Envelope']?.['soap:Body']
      || parsed['soap12:Envelope']?.['soap12:Body']
      || Object.values(parsed)[0]?.['soap:Body']
      || Object.values(parsed)[0]?.['soap12:Body'];

    if (!body) {
      // Tüm olası yapıları dene
      const envelope = Object.values(parsed)[0];
      const bodyKey = Object.keys(envelope).find(k => k.toLowerCase().includes('body'));
      if (bodyKey) {
        const b = envelope[bodyKey];
        const responseKey = `${method}Response`;
        const resultKey = `${method}Result`;
        if (b[responseKey]) {
          return b[responseKey][resultKey] || b[responseKey];
        }
      }
      return null;
    }

    const responseKey = `${method}Response`;
    const resultKey = `${method}Result`;
    return body[responseKey]?.[resultKey] || body[responseKey] || null;
  } catch (e) {
    console.error('SOAP parse error:', e.message);
    return null;
  }
}

// ============================================================
// API Endpoints
// ============================================================

// 1. Tüm Hat Listesi
app.get('/api/hatlar', async (req, res) => {
  try {
    // Cache kontrolü
    if (cache.hatlar.data && Date.now() - cache.hatlar.timestamp < CACHE_TTL) {
      return res.json(cache.hatlar.data);
    }

    const url = `${IBB_BASE}/UlasimAnaVeri/HatDurakGuzergah.asmx`;
    const namespace = 'http://tempuri.org/';
    const parsed = await soapRequest(url, namespace, 'GetHat_json');
    const result = extractSoapResult(parsed, 'GetHat_json');

    let hatlar = [];
    if (result) {
      try {
        hatlar = typeof result === 'string' ? JSON.parse(result) : result;
      } catch {
        hatlar = [];
      }
    }

    // Hatları düzenle
    const formatted = Array.isArray(hatlar) ? hatlar.map(h => ({
      SHPIETT: h.SHPIETT || h.HAT_NO || '',
      SHAT_ADI: h.SHAT_ADI || h.HAT_ADI || '',
      SGUZER: h.SGUZER || h.GUZERGAH || '',
      SHAH_ILK_: h.SHAH_ILK_ || h.ILKSEFER || '',
      SHAH_SON_: h.SHAH_SON_ || h.SONSEFER || '',
    })) : [];

    cache.hatlar = { data: formatted, timestamp: Date.now() };
    res.json(formatted);
  } catch (error) {
    console.error('Hat listesi hatası:', error.message);
    res.status(500).json({ error: 'Hat listesi alınamadı', detail: error.message });
  }
});

// 2. Hat Güzergahı
app.get('/api/guzergah/:hatKodu', async (req, res) => {
  try {
    const hatKodu = req.params.hatKodu;
    const url = `${IBB_BASE}/UlasimAnaVeri/HatDurakGuzergah.asmx`;
    const namespace = 'http://tempuri.org/';

    // Güzergah koordinatlarını al
    const parsedGuzergah = await soapRequest(url, namespace, 'GetHatCev  _json', { HatKodu: hatKodu });
    const guzergahResult = extractSoapResult(parsedGuzergah, 'GetHatCev  _json');

    let guzergah = [];
    if (guzergahResult) {
      try {
        guzergah = typeof guzergahResult === 'string' ? JSON.parse(guzergahResult) : guzergahResult;
      } catch { guzergah = []; }
    }

    // Durakları al
    const parsedDurak = await soapRequest(url, namespace, 'GetDurak_json', { HatKodu: hatKodu });
    const durakResult = extractSoapResult(parsedDurak, 'GetDurak_json');

    let duraklar = [];
    if (durakResult) {
      try {
        duraklar = typeof durakResult === 'string' ? JSON.parse(durakResult) : durakResult;
      } catch { duraklar = []; }
    }

    res.json({ guzergah, duraklar });
  } catch (error) {
    console.error('Güzergah hatası:', error.message);
    res.status(500).json({ error: 'Güzergah bilgisi alınamadı', detail: error.message });
  }
});

// 3. Hat Üzerindeki Otobüs Konumları (CANLI)
app.get('/api/otobus-konum/:hatKodu', async (req, res) => {
  try {
    const hatKodu = req.params.hatKodu;
    const url = `${IBB_BASE}/FiloDurak/FiloDurakSor662.asmx`;
    const namespace = 'http://tempuri.org/';

    const parsed = await soapRequest(url, namespace, 'GetHatOtoKonum_json', { HatNo: hatKodu });
    const result = extractSoapResult(parsed, 'GetHatOtoKonum_json');

    let otobusler = [];
    if (result) {
      try {
        otobusler = typeof result === 'string' ? JSON.parse(result) : result;
      } catch { otobusler = []; }
    }

    // Konum bilgilerini düzenle
    const formatted = Array.isArray(otobusler) ? otobusler.map(o => ({
      kapino: o.kapino || o.KAPINO || '',
      boylam: parseFloat(o.boylam || o.BOYLAM || 0),
      enlem: parseFloat(o.enlem || o.ENLEM || 0),
      hiz: parseFloat(o.hiz || o.HIZ || 0),
      yon: parseFloat(o.yon || o.YON || 0),
      plaka: o.plaka || o.PLAKA || '',
      hatNo: o.hatNo || o.HAT_NO || hatKodu,
      son_konum_zamani: o.son_konum_zamani || o.SON_KONUM_ZAMANI || '',
      yakinDurakKodu: o.yakinDurakKodu || o.YAKIN_DURAK_KODU || '',
      guzpiett: o.guzpiett || o.GUZPIETT || '',
      operator: o.operator || o.OPERATOR || '',
    })) : [];

    res.json({
      hatKodu,
      otobusler: formatted,
      toplamOtobus: formatted.length,
      guncellemeZamani: new Date().toISOString(),
    });
  } catch (error) {
    console.error('Otobüs konum hatası:', error.message);
    res.status(500).json({ error: 'Otobüs konumları alınamadı', detail: error.message });
  }
});

// 4. Durak detayı
app.get('/api/durak/:durakKodu', async (req, res) => {
  try {
    const durakKodu = req.params.durakKodu;
    const url = `${IBB_BASE}/FiloDurak/FiloDurakSor662.asmx`;
    const namespace = 'http://tempuri.org/';

    const parsed = await soapRequest(url, namespace, 'GetDurakDetay_json', { DurakKodu: durakKodu });
    const result = extractSoapResult(parsed, 'GetDurakDetay_json');

    let durak = null;
    if (result) {
      try {
        durak = typeof result === 'string' ? JSON.parse(result) : result;
      } catch { durak = null; }
    }

    res.json(durak);
  } catch (error) {
    console.error('Durak detay hatası:', error.message);
    res.status(500).json({ error: 'Durak detayı alınamadı', detail: error.message });
  }
});

// SPA fallback
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Export the app for Vercel
module.exports = app;

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`🚌 IETT Canlı Takip sunucusu http://localhost:${PORT} adresinde çalışıyor`);
  });
}
