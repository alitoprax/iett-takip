"""
IETT Canlı Takip - Backend Proxy (Flask-Vercel Compatible)
"""
import json
import time
import re
import html as html_module
import urllib.parse
import urllib.request
import os
from flask import Flask, request, jsonify

app = Flask(__name__)
PORT = int(os.environ.get('PORT', 3000))
WORKERS_BASE = 'https://iett.rednexie.workers.dev'
IBB_SOAP_BASE = 'https://api.ibb.gov.tr/iett'

# In-memory Cache
cache = {}
CACHE_TTL = 86400
BUS_POS_TTL = 45

print("IETT Python Backend Başlatıldı")

def http_get(url, timeout=10, extra_headers=None):
    headers = {'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'}
    if extra_headers: headers.update(extra_headers)
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read().decode('utf-8')

def soap_post(url, soap_action, xml_body, timeout=10):
    req = urllib.request.Request(url, data=xml_body.encode('utf-8'), headers={
        'Content-Type': 'text/xml; charset=utf-8',
        'SOAPAction': f'"{soap_action}"'
    })
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read().decode('utf-8')

def parse_soap_json(xml_string, method):
    try:
        tag = f'{method}Result'
        m = re.search(f'<{tag}>(.*?)</{tag}>', xml_string, re.DOTALL)
        if m:
            payload = html_module.unescape(m.group(1))
            return json.loads(payload)
        return []
    except: return []

def get_all_lines():
    now = time.time()
    if 'hatlar' in cache and now - cache['hatlar']['ts'] < CACHE_TTL: return cache['hatlar']['data']
    xml = '<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><GetHat_json xmlns="http://tempuri.org/"><HatKodu></HatKodu></GetHat_json></soap:Body></soap:Envelope>'
    try:
        res = soap_post(f'{IBB_SOAP_BASE}/UlasimAnaVeri/HatDurakGuzergah.asmx', 'http://tempuri.org/GetHat_json', xml)
        data = [{'SHPIETT': h.get('SHATKODU') or h.get('SHPIETT'), 'SHAT_ADI': h.get('SHATADI') or h.get('SHAT_ADI')} for h in parse_soap_json(res, 'GetHat_json') if h.get('SHATKODU') or h.get('SHPIETT')]
        cache['hatlar'] = {'data': data, 'ts': now}
        return data
    except: return []

def get_all_stops():
    now = time.time()
    if 'duraklar_all' in cache and now - cache['duraklar_all']['ts'] < CACHE_TTL: return cache['duraklar_all']['data']
    xml = '<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><GetDurak_json xmlns="http://tempuri.org/"><DurakKodu></DurakKodu></GetDurak_json></soap:Body></soap:Envelope>'
    try:
        res = soap_post(f'{IBB_SOAP_BASE}/UlasimAnaVeri/HatDurakGuzergah.asmx', 'http://tempuri.org/GetDurak_json', xml, timeout=30)
        data = []
        for d in parse_soap_json(res, 'GetDurak_json'):
            kod = str(d.get('SDURAKKODU', d.get('DURAKKODU', '')))
            m = re.search(r'POINT\s*\(([0-9.]+)\s+([0-9.]+)\)', d.get('KOORDINAT', ''))
            if kod: data.append({'kod': kod, 'adi': d.get('SDURAKADI', d.get('DURAKADI', '')), 'lat': float(m.group(2)) if m else 0, 'lon': float(m.group(1)) if m else 0, 'yon': d.get('SYON', '')})
        cache['duraklar_all'] = {'data': data, 'ts': now}
        print(f"Durak veritabanı yüklendi: {len(data)} durak")
        return data
    except Exception as e:
        print(f"Durak yükleme hatası: {e}")
        return []

@app.route('/api/hatlar')
def api_hatlar(): return jsonify(get_all_lines())

@app.route('/api/hat-ara')
def api_hat_ara():
    q = request.args.get('q', '')
    return http_get(f'{WORKERS_BASE}/api/line-suggestions?q={urllib.parse.quote(q)}'), 200, {'Content-Type': 'application/json'}

@app.route('/api/durak-ara')
def api_durak_ara():
    q = request.args.get('q', '').lower()
    stops = get_all_stops()
    return jsonify([s for s in stops if q in s['kod'].lower() or q in s['adi'].lower()][:15])

@app.route('/api/guzergah/<hat>')
def api_guzergah(hat):
    try:
        html = http_get(f'{WORKERS_BASE}/api/route-stations?hatkod={urllib.parse.quote(hat)}&langid=1')
        def parse(b): return [{'sira': int(m[2]), 'kod': m[0], 'adi': urllib.parse.unquote_plus(m[1])} for m in re.findall(r'dkod=(\d+)[^"]*stationname=([^"&]+)[^>]*>.*?<p>(\d+)\.', b, re.DOTALL)]
        g_m, d_m = re.search(r'KALKIŞ(.*?)class="col-md-6', html, re.DOTALL), re.search(r'KALKIŞ.*?class="col-md-6(.*)', html, re.DOTALL)
        g, d = parse(g_m.group(1) if g_m else ''), parse(d_m.group(1) if d_m else '')
        all_stops = {s['kod']: s for s in get_all_stops()}
        for s in g+d:
            if s['kod'] in all_stops: s.update({'lat': all_stops[s['kod']]['lat'], 'lon': all_stops[s['kod']]['lon']})
        return jsonify({'duraklar': {'G': g, 'D': d}, 'routeLine': {'G': [], 'D': []}})
    except: return jsonify({'duraklar': {'G': [], 'D': []}})

@app.route('/api/otobus-konum/<hat>')
def api_otobus_konum(hat):
    # This is a simplified proxy to the worker for now
    data = http_get(f'{WORKERS_BASE}/line-vehicles?line={hat}')
    return data, 200, {'Content-Type': 'application/json'}

@app.route('/api/durak-detay/<code>')
def api_durak_detay(code):
    stops = get_all_stops()
    sinfo = next((s for s in stops if s['kod'] == code), None)
    return jsonify({'durak': sinfo, 'gelenler': []})

@app.route('/api/health')
def health(): return "OK"

# Note: Static serving is handled by vercel.json rewrites now.
# This prevents path ENOENT issues in Vercel.

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=PORT)
