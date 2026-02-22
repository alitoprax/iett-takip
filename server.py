"""
IETT Canlı Takip - Backend Proxy (Flask-Vercel Compatible)
"""
import json
import time
import re
import html as html_module
import threading
import urllib.parse
import urllib.request
import os
from flask import Flask, request, jsonify, send_from_directory

app = Flask(__name__)
PORT = int(os.environ.get('PORT', 3000))
WORKERS_BASE = 'https://iett.rednexie.workers.dev'
IBB_SOAP_BASE = 'https://api.ibb.gov.tr/iett'
OSRM_BASE = 'https://router.project-osrm.org'

# Absolute path for public directory
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
PUBLIC_DIR = os.path.join(BASE_DIR, 'public')

# In-memory Cache
cache = {}
CACHE_TTL = 86400
BUS_POS_TTL = 45
ROUTE_CHUNK = 80

def http_get(url, timeout=10, extra_headers=None):
    headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, Gecko) Chrome/120.0.0.0 Safari/537.36',
    }
    if extra_headers: headers.update(extra_headers)
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read().decode('utf-8')

def http_post_json(url, data, timeout=10):
    body = json.dumps(data).encode('utf-8')
    req = urllib.request.Request(url, data=body, headers={'Content-Type': 'application/json'})
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
    xml = '''<?xml version="1.0" encoding="utf-8"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><GetHat_json xmlns="http://tempuri.org/"><HatKodu></HatKodu></GetHat_json></soap:Body></soap:Envelope>'''
    try:
        res = soap_post(f'{IBB_SOAP_BASE}/UlasimAnaVeri/HatDurakGuzergah.asmx', 'http://tempuri.org/GetHat_json', xml)
        data = [{'SHPIETT': h.get('SHATKODU') or h.get('SHPIETT'), 'SHAT_ADI': h.get('SHATADI') or h.get('SHAT_ADI')} for h in parse_soap_json(res, 'GetHat_json') if h.get('SHATKODU') or h.get('SHPIETT')]
        cache['hatlar'] = {'data': data, 'ts': now}
        return data
    except: return cache.get('hatlar', {}).get('data', [])

def get_all_stops():
    now = time.time()
    if 'duraklar_all' in cache and now - cache['duraklar_all']['ts'] < CACHE_TTL: return cache['duraklar_all']['data']
    xml = '''<?xml version="1.0" encoding="utf-8"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><GetDurak_json xmlns="http://tempuri.org/"><DurakKodu></DurakKodu></GetDurak_json></soap:Body></soap:Envelope>'''
    try:
        res = soap_post(f'{IBB_SOAP_BASE}/UlasimAnaVeri/HatDurakGuzergah.asmx', 'http://tempuri.org/GetDurak_json', xml, timeout=30)
        data = []
        for d in parse_soap_json(res, 'GetDurak_json'):
            kod = str(d.get('SDURAKKODU', d.get('DURAKKODU', '')))
            m = re.search(r'POINT\s*\(([0-9.]+)\s+([0-9.]+)\)', d.get('KOORDINAT', ''))
            if kod: data.append({'kod': kod, 'adi': d.get('SDURAKADI', d.get('DURAKADI', '')), 'lat': float(m.group(2)) if m else 0, 'lon': float(m.group(1)) if m else 0, 'yon': d.get('SYON', '')})
        cache['duraklar_all'] = {'data': data, 'ts': now}
        return data
    except: return cache.get('duraklar_all', {}).get('data', [])

import math
def haversine(lat1, lon1, lat2, lon2):
    R = 6371000
    phi1, phi2, dphi, dlon = math.radians(lat1), math.radians(lat2), math.radians(lat2-lat1), math.radians(lon2-lon1)
    a = math.sin(dphi/2)**2 + math.cos(phi1)*math.cos(phi2)*math.sin(dlon/2)**2
    return R * 2 * math.asin(math.sqrt(a))

def get_line_vehicles(hat_kodu):
    now = time.time()
    ck = f'vehicles_{hat_kodu}'
    if ck in cache and now - cache[ck]['ts'] < BUS_POS_TTL: return cache[ck]['data']
    try:
        raw = json.loads(http_post_json(f'{WORKERS_BASE}/line-vehicles', {'line': hat_kodu}))
        vlist = raw.get('vehicles', raw) if isinstance(raw, dict) else raw
        res = []
        for v in vlist:
            gz = v.get('guzergah', '')
            parts = gz.split('_')
            res.append({
                'kapino': v.get('vehicleDoorCode', ''),
                'lon': float(v.get('lon', 0)), 'lat': float(v.get('lat', 0)),
                'direction': v.get('direction', ''),
                'dir': parts[-2] if len(parts) >= 2 else ( 'G' if '_G_' in gz else 'D' if '_D_' in gz else None ),
                'variant': parts[-1] if len(parts) >= 1 else ''
            })
        cache[ck] = {'data': res, 'ts': now}
        return res
    except: return []

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
    now = time.time()
    if f'stats_{hat}' in cache and now - cache[f'stats_{hat}']['ts'] < 86400: return jsonify(cache[f'stats_{hat}']['data'])
    try:
        html = http_get(f'{WORKERS_BASE}/api/route-stations?hatkod={urllib.parse.quote(hat)}&langid=1')
        def parse(b): return [{'sira': int(m[2]), 'kod': m[0], 'adi': urllib.parse.unquote_plus(m[1])} for m in re.findall(r'dkod=(\d+)[^"]*stationname=([^"&]+)[^>]*>.*?<p>(\d+)\.', b, re.DOTALL)]
        g_m, d_m = re.search(r'KALKIŞ(.*?)class="col-md-6', html, re.DOTALL), re.search(r'KALKIŞ.*?class="col-md-6(.*)', html, re.DOTALL)
        g, d = parse(g_m.group(1) if g_m else ''), parse(d_m.group(1) if d_m else '')
        all_stops = {s['kod']: s for s in get_all_stops()}
        for s in g+d:
            if s['kod'] in all_stops: s.update({'lat': all_stops[s['kod']]['lat'], 'lon': all_stops[s['kod']]['lon']})
        res = {'duraklar': {'G': g, 'D': d}, 'routeLine': {'G': [], 'D': []}}
        cache[f'stats_{hat}'] = {'data': res, 'ts': now}
        return jsonify(res)
    except: return jsonify({'duraklar': {'G': [], 'D': []}})

@app.route('/api/otobus-konum/<hat>')
def api_otobus_konum(hat):
    otobusler = get_line_vehicles(hat)
    vmap = {}
    for v in otobusler:
        k = f"{v['dir']}_{v['variant']}"
        if k not in vmap: vmap[k] = {'dir': v['dir'], 'variant': v['variant'], 'label': v['direction'], 'count': 0}
        vmap[k]['count'] += 1
    return jsonify({'otobusler': otobusler, 'varyantlar': list(vmap.values())})

@app.route('/api/durak-detay/<code>')
def api_durak_detay(code):
    stops = get_all_stops()
    sinfo = next((s for s in stops if s['kod'] == code), None)
    return jsonify({'durak': sinfo, 'gelenler': []}) # Simple for 404 fix

@app.route('/api/sefer-saatleri/<hat>')
def api_sefer_saatleri(hat): return jsonify({})

@app.route('/', defaults={'path': ''})
@app.route('/<path:path>')
def serve(path):
    if path.startswith('api/'): return jsonify({'error': 'Not Found'}), 404
    if not path or path in ['index.html', 'mobile', 'mobil']:
        return send_from_directory(PUBLIC_DIR, 'index.html')
    if os.path.exists(os.path.join(PUBLIC_DIR, path)):
        return send_from_directory(PUBLIC_DIR, path)
    return send_from_directory(PUBLIC_DIR, 'index.html')

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=PORT)
