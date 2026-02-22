"""
IETT Canlı Takip - Backend Proxy
Gerçek veri: https://iett.rednexie.workers.dev
Durak GPS: IBB SOAP GetDurak_json (paralel)
Yol geometrisi: OSRM public API (router.project-osrm.org)
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

PORT = 3000
WORKERS_BASE = 'https://iett.rednexie.workers.dev'
IBB_SOAP_BASE = 'https://api.ibb.gov.tr/iett'
OSRM_BASE = 'https://router.project-osrm.org'

# In-memory Cache structure
cache = {}
CACHE_TTL = 86400   # 24 hours for static data (stops, routes)
BUS_POS_TTL = 45   # 45 sec for vehicle positions
ROUTE_CHUNK = 80   # OSRM max waypoints per request


def http_get(url, timeout=10, extra_headers=None):
    headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json, text/javascript, */*; q=0.01',
        'X-Requested-With': 'XMLHttpRequest',
    }
    if extra_headers:
        headers.update(extra_headers)
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read().decode('utf-8')


def http_post_json(url, data, timeout=10):
    body = json.dumps(data).encode('utf-8')
    req = urllib.request.Request(url, data=body, headers={
        'User-Agent': 'Mozilla/5.0',
        'Content-Type': 'application/json',
        'Accept': 'application/json',
    })
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read().decode('utf-8')


def soap_post(url, soap_action, xml_body, timeout=10):
    body = xml_body.encode('utf-8')
    req = urllib.request.Request(url, data=body, headers={
        'Content-Type': 'text/xml; charset=utf-8',
        'SOAPAction': f'"{soap_action}"',
        'User-Agent': 'Mozilla/5.0',
    })
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read().decode('utf-8')


def parse_soap_json(xml_string, method):
    try:
        start_tag = f'<{method}Result>'
        end_tag = f'</{method}Result>'
        start_idx = xml_string.find(start_tag)
        if start_idx == -1:
            return []
        start_idx += len(start_tag)
        end_idx = xml_string.find(end_tag, start_idx)
        payload = html_module.unescape(xml_string[start_idx:end_idx])
        if payload.strip():
            return json.loads(payload)
        return []
    except Exception as e:
        print(f"SOAP parse error: {e}")
        return []


def get_all_lines():
    """IBB SOAP üzerinden tüm hat listesini çek"""
    now = time.time()
    if 'hatlar' in cache and now - cache['hatlar']['ts'] < CACHE_TTL:
        return cache['hatlar']['data']

    xml_body = '''<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
  xmlns:xsd="http://www.w3.org/2001/XMLSchema"
  xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <GetHat_json xmlns="http://tempuri.org/"><HatKodu></HatKodu></GetHat_json>
  </soap:Body>
</soap:Envelope>'''

    try:
        xml = soap_post(
            f'{IBB_SOAP_BASE}/UlasimAnaVeri/HatDurakGuzergah.asmx',
            'http://tempuri.org/GetHat_json',
            xml_body
        )
        raw = parse_soap_json(xml, 'GetHat_json')
        data = []
        for h in raw:
            kod = h.get('SHATKODU') or h.get('SHPIETT') or ''
            adi = h.get('SHATADI') or h.get('SHAT_ADI') or ''
            if kod:
                data.append({'SHPIETT': kod, 'SHAT_ADI': adi})
        cache['hatlar'] = {'data': data, 'ts': now}
        print(f"Hat listesi alındı: {len(data)} hat")
        return data
    except Exception as e:
        print(f"Hat listesi hatası: {e}")
        return cache.get('hatlar', {}).get('data', [])


def get_all_stops():
    """IBB SOAP üzerinden tüm durak listesini çek ve cache'le"""
    now = time.time()
    if 'duraklar_all' in cache and now - cache['duraklar_all']['ts'] < CACHE_TTL:
        return cache['duraklar_all']['data']

    xml_body = '''<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
  xmlns:xsd="http://www.w3.org/2001/XMLSchema"
  xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <GetDurak_json xmlns="http://tempuri.org/"><DurakKodu></DurakKodu></GetDurak_json>
  </soap:Body>
</soap:Envelope>'''

    try:
        xml = soap_post(
            f'{IBB_SOAP_BASE}/UlasimAnaVeri/HatDurakGuzergah.asmx',
            'http://tempuri.org/GetDurak_json',
            xml_body,
            timeout=30
        )
        raw = parse_soap_json(xml, 'GetDurak_json')
        data = []
        for d in raw:
            kod = str(d.get('SDURAKKODU', d.get('DURAKKODU', '')))
            adi = d.get('SDURAKADI', d.get('DURAKADI', ''))
            ilce = d.get('SILCEADI', d.get('ILCEADI', ''))
            coord = d.get('KOORDINAT', '')
            lat, lon = 0, 0
            m = re.search(r'POINT\s*\(([0-9.]+)\s+([0-9.]+)\)', coord)
            if m:
                lon, lat = float(m.group(1)), float(m.group(2))
            yon = d.get('SYON', '')
            if kod:
                data.append({'kod': kod, 'adi': adi, 'ilce': ilce, 'lat': lat, 'lon': lon, 'yon': yon})
        cache['duraklar_all'] = {'data': data, 'ts': now}
        print(f"Durak veritabanı yüklendi: {len(data)} durak")
        return data
    except Exception as e:
        print(f"Durak veritabanı hatası: {e}")
        return cache.get('duraklar_all', {}).get('data', [])


def get_line_schedules(hat_kodu):
    """Belirli bir hat için planlanan sefer saatlerini IBB SOAP API'den çeker."""
    cache_key = f'schedules_{hat_kodu}'
    now = time.time()
    if cache_key in cache and now - cache[cache_key]['ts'] < 43200:
        return cache[cache_key]['data']
        
    xml_body = f'''<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
  xmlns:xsd="http://www.w3.org/2001/XMLSchema"
  xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <GetPlanlananSeferSaati_json xmlns="http://tempuri.org/"><HatKodu>{hat_kodu}</HatKodu></GetPlanlananSeferSaati_json>
  </soap:Body>
</soap:Envelope>'''

    try:
        xml = soap_post(
            f'{IBB_SOAP_BASE}/UlasimAnaVeri/PlanlananSeferSaati.asmx',
            'http://tempuri.org/GetPlanlananSeferSaati_json',
            xml_body,
            timeout=15
        )
        raw = parse_soap_json(xml, 'GetPlanlananSeferSaati_json')
        
        structured_data = {'I': {'G': [], 'D': []}, 'C': {'G': [], 'D': []}, 'P': {'G': [], 'D': []}}
        for s in raw:
            day_type = s.get('SGUNTIPI', '')
            direction = s.get('SYON', '')
            time_val = s.get('DT', '')
            if day_type in structured_data and direction in structured_data[day_type]:
                structured_data[day_type][direction].append({'v': s.get('SGUZERAH', ''), 't': time_val})
        for dt in structured_data.values():
            for dir_list in dt.values():
                dir_list.sort(key=lambda x: x['t'])
        cache[cache_key] = {'data': structured_data, 'ts': now}
        return structured_data
    except Exception as e:
        print(f"[{hat_kodu}] Sefer saatleri alınamadı: {e}")
        return cache.get(cache_key, {}).get('data', {})

def search_stops(query_str):
    stops = get_all_stops()
    if not stops: return []
    q = query_str.lower().strip()
    results = []
    for s in stops:
        if q in s['kod'].lower() or q in s['adi'].lower():
            results.append(s)
            if len(results) >= 15: break
    return results

import math
def haversine_distance(lat1, lon1, lat2, lon2):
    R = 6371000
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    delta_phi, delta_lambda = math.radians(lat2-lat1), math.radians(lon2-lon1)
    a = math.sin(delta_phi/2)**2 + math.cos(phi1)*math.cos(phi2)*math.sin(delta_lambda/2)**2
    return R * 2 * math.atan2(math.sqrt(a), math.sqrt(1-a))

def get_polyline_progress(polyline, lat, lon):
    if not polyline or len(polyline) < 2: return 0, 0
    min_dist, best_prog, current_prog = float('inf'), 0, 0
    for i in range(len(polyline) - 1):
        lat1, lon1 = polyline[i]
        lat2, lon2 = polyline[i+1]
        seg_len = haversine_distance(lat1, lon1, lat2, lon2)
        if seg_len == 0: continue
        d1, d2 = haversine_distance(lat, lon, lat1, lon1), haversine_distance(lat, lon, lat2, lon2)
        proj = (seg_len**2 + d1**2 - d2**2) / (2*seg_len) if seg_len > 0 else 0
        if proj < 0: dist, prog = d1, current_prog
        elif proj > seg_len: dist, prog = d2, current_prog + seg_len
        else: dist, prog = math.sqrt(max(0, d1**2 - proj**2)), current_prog + proj
        if dist < min_dist: min_dist, best_prog = dist, prog
        current_prog += seg_len
    return min_dist, best_prog

def get_stop_detail(durak_kodu):
    stops = get_all_stops()
    stop_info = next((s for s in stops if s['kod'] == str(durak_kodu)), None)
    if not stop_info or not stop_info.get('lat'): return {'error': 'Durak bulunamadı'}
    gelenler, checked_lines = [], set()
    for ck, cv in list(cache.items()):
        if ck.startswith('stations_') and 'data' in cv:
            hat_kodu = ck.replace('stations_', '')
            route_data = cv['data']
            route_lines = route_data.get('routeLine', {})
            for direction in ['G', 'D']:
                stops_list = route_data.get(direction, [])
                stop_idx = next((i for i, st in enumerate(stops_list) if str(st.get('kod', '')) == str(durak_kodu)), -1)
                if stop_idx != -1:
                    checked_lines.add(hat_kodu)
                    polyline = route_lines.get(direction, [])
                    vehicles = get_line_vehicles(hat_kodu)
                    for bus in [v for v in vehicles if v.get('dir') == direction or v.get('dir') is None]:
                        if bus.get('lat') and bus.get('lon'):
                            min_d, bus_stop_idx = float('inf'), -1
                            for sti, st_obj in enumerate(stops_list):
                                if not st_obj.get('lat'): continue
                                d = haversine_distance(bus['lat'], bus['lon'], st_obj['lat'], st_obj['lon'])
                                if d < min_d: min_d, bus_stop_idx = d, sti
                            if bus_stop_idx > stop_idx: continue
                            dist_m = min_d
                            for i in range(bus_stop_idx, stop_idx):
                                s1, s2 = stops_list[i], stops_list[i+1]
                                if s1.get('lat') and s2.get('lat'): dist_m += haversine_distance(s1['lat'], s1['lon'], s2['lat'], s2['lon'])
                            km = round(dist_m / 1000, 1)
                            dk = round(dist_m / 250.0)
                            if dk == 0 and dist_m > 50: dk = 1
                            gelenler.append({'hat': hat_kodu, 'kapino': bus.get('kapino', ''), 'eta_dk': dk, 'mesafe_km': km, 'yon': 'Gidiş' if direction == 'G' else 'Dönüş', 'yon_kod': direction, 'hedef': bus.get('direction', '')})
                    break
    gelenler.sort(key=lambda x: x.get('eta_dk', 999))
    return {'durak': stop_info, 'gelenler': gelenler[:20], 'kontrol_edilen_hat': len(checked_lines)}

def get_line_vehicles(hat_kodu):
    now = time.time()
    ck = f'vehicles_{hat_kodu}'
    if ck in cache and now - cache[ck]['ts'] < BUS_POS_TTL: return cache[ck]['data']
    try:
        resp = http_post_json(f'{WORKERS_BASE}/line-vehicles', {'line': hat_kodu})
        raw = json.loads(resp)
        vehicles = raw.get('vehicles', raw) if isinstance(raw, dict) else raw
        result = []
        for v in vehicles:
            gz = v.get('guzergah', '')
            parts = gz.split('_') if gz else []
            variant = parts[-1] if len(parts) >= 3 else ''
            dir_code = parts[-2] if len(parts) >= 3 else ('G' if '_G_' in gz else 'D' if '_D_' in gz else '')
            result.append({'kapino': v.get('vehicleDoorCode', ''), 'lon': float(v.get('lon', 0)), 'lat': float(v.get('lat', 0)), 'direction': v.get('direction', ''), 'guzergah': gz, 'dir': dir_code if dir_code else None, 'variant': variant})
        cache[ck] = {'data': result, 'ts': now}
        return result
    except: return cache.get(ck, {}).get('data', [])

def get_stop_coords_batch(codes):
    stops = get_all_stops()
    stop_dict = {str(s['kod']): s for s in stops}
    return {str(c): {'lat': stop_dict[str(c)]['lat'], 'lon': stop_dict[str(c)]['lon']} for c in codes if str(c) in stop_dict and stop_dict[str(c)].get('lat')}

def get_osrm_route(stop_latlngs):
    if len(stop_latlngs) < 2: return stop_latlngs
    all_coords = []
    for i in range(0, len(stop_latlngs), ROUTE_CHUNK-1):
        chunk = stop_latlngs[i:i + ROUTE_CHUNK]
        try:
            coord_str = ';'.join(f'{lon},{lat}' for lat, lon in chunk)
            resp = http_get(f'{OSRM_BASE}/route/v1/driving/{coord_str}?overview=full&geometries=geojson')
            data = json.loads(resp)
            if data.get('code') == 'Ok':
                pts = [[lat, lon] for lon, lat in data['routes'][0]['geometry']['coordinates']]
                all_coords.extend(pts if not all_coords else pts[1:])
        except: all_coords.extend([[lat, lon] for lat, lon in chunk])
    return all_coords

def get_iett_variant_stops(hat_kodu):
    ck, now = f'vstops_{hat_kodu}', time.time()
    if ck in cache and now - cache[ck]['ts'] < CACHE_TTL: return cache[ck]['data']
    try:
        extra = {'Referer': f"https://www.iett.istanbul/RouteDetail?hkod={hat_kodu}"}
        variants = json.loads(http_get(f"https://www.iett.istanbul/tr/RouteStation/GetAllRoute?rcode={urllib.parse.quote(hat_kodu)}", extra_headers=extra))
        results = {}
        for v in variants:
            v_code = v.get('GUZERGAH_GUZERGAH_KODU')
            if not v_code: continue
            detail = json.loads(http_get(f"https://www.iett.istanbul/tr/RouteStation/GetRoutePinV2?q={urllib.parse.quote(v_code)}", extra_headers=extra))
            if isinstance(detail, list): detail = detail[0]
            stops = [{'kod': s.get('stationCode', ''), 'adi': s.get('stationName', '').strip(), 'lat': float(s.get('lat', 0)), 'lon': float(s.get('lng', 0))} for s in detail.get('stationPlaces', [])]
            polyline = [[float(lat), float(lon)] for lon, lat in re.findall(r'([0-9.]+)\s+([0-9.]+)', detail.get('line', ''))]
            results[v_code] = {'label': v.get('GUZERGAH_ADI', v_code), 'stops': stops, 'polyline': polyline}
        cache[ck] = {'data': results, 'ts': now}
        return results
    except: return {}

def get_route_stations(hat_kodu):
    ck, now = f'stations_{hat_kodu}', time.time()
    if ck in cache and now - cache[ck]['ts'] < CACHE_TTL: return cache[ck]['data']
    try:
        html = http_get(f'{WORKERS_BASE}/api/route-stations?hatkod={urllib.parse.quote(hat_kodu)}&langid=1')
        def parse(block):
            return [{'sira': int(idx), 'kod': dkod, 'adi': urllib.parse.unquote_plus(sname.strip()) or pname.strip()} for dkod, sname, idx, pname in re.findall(r'dkod=(\d+)[^"]*stationname=([^"&]+)[^>]*>.*?<p>(\d+)\.\s*([^<]+)', block, re.DOTALL)]
        g_match = re.search(r'KALKIŞ(.*?)class="col-md-6', html, re.DOTALL)
        d_match = re.search(r'KALKIŞ.*?class="col-md-6(.*)', html, re.DOTALL)
        gidis = parse(g_match.group(1) if g_match else html[:len(html)//2])
        donus = parse(d_match.group(1) if d_match else html[len(html)//2:])
        coords = get_stop_coords_batch(list({s['kod'] for s in gidis + donus}))
        for s in gidis + donus:
            if s['kod'] in coords: s['lat'], s['lon'] = coords[s['kod']]['lat'], coords[s['kod']]['lon']
        data = {'G': gidis, 'D': donus, 'routeLine': {'G': get_osrm_route([(s['lat'], s['lon']) for s in gidis if s.get('lat')]), 'D': get_osrm_route([(s['lat'], s['lon']) for s in donus if s.get('lat')])}}
        cache[ck] = {'data': data, 'ts': now}
        return data
    except: return {'G': [], 'D': [], 'routeLine': {'G': [], 'D': []}}

def get_line_info(hat_kodu):
    try: return json.loads(http_post_json(f'{WORKERS_BASE}/line-information', {'line': hat_kodu}))
    except: return {}

app = Flask(__name__, static_folder='public')

@app.route('/api/hatlar')
def api_hatlar(): return jsonify(get_all_lines())

@app.route('/api/guzergah/<hat_kodu>')
def api_guzergah(hat_kodu):
    stations = get_route_stations(hat_kodu)
    return jsonify({'duraklar': {'G': stations['G'], 'D': stations['D']}, 'routeLine': stations.get('routeLine', {'G': [], 'D': []}), 'bilgi': get_line_info(hat_kodu)})

@app.route('/api/otobus-konum/<hat_kodu>')
def api_otobus_konum(hat_kodu):
    otobusler = get_line_vehicles(hat_kodu)
    variants = {}
    for v in otobusler:
        key = f"{v['dir']}_{v['variant']}" if v.get('variant') else v['dir']
        if key not in variants: variants[key] = {'dir': v['dir'], 'variant': v.get('variant', ''), 'label': v.get('direction', key), 'count': 0}
        variants[key]['count'] += 1
    return jsonify({'hatKodu': hat_kodu, 'otobusler': otobusler, 'toplamOtobus': len(otobusler), 'zaman': time.strftime('%H:%M:%S'), 'varyantlar': list(variants.values())})

@app.route('/api/hat-ara')
def api_hat_ara():
    q = request.args.get('q', '')
    return http_get(f'{WORKERS_BASE}/api/line-suggestions?q={urllib.parse.quote(q)}'), 200, {'Content-Type': 'application/json'}

@app.route('/api/durak-ara')
def api_durak_ara(): return jsonify(search_stops(request.args.get('q', '')))

@app.route('/api/durak-detay/<durak_kodu>')
def api_durak_detay(durak_kodu): return jsonify(get_stop_detail(durak_kodu))

@app.route('/api/sefer-saatleri/<hat_kodu>')
def api_sefer_saatleri(hat_kodu): return jsonify(get_line_schedules(hat_kodu))

@app.route('/api/line-variants/<hat_kodu>')
def api_line_variants(hat_kodu):
    all_v = get_iett_variant_stops(hat_kodu)
    return jsonify([{'variant': k, 'label': v.get('label', '')} for k, v in all_v.items()])

@app.route('/api/variant-stops/<hat_kodu>/<variant>')
def api_variant_stops(hat_kodu, variant):
    return jsonify(get_iett_variant_stops(hat_kodu).get(variant, {'stops': [], 'polyline': []}))

@app.route('/', defaults={'path': ''})
@app.route('/<path:path>')
def serve_index(path):
    if not path or path in ['mobile', 'mobil', 'index.html']: return send_from_directory('public', 'mobile.html')
    if os.path.exists(os.path.join('public', path)): return send_from_directory('public', path)
    return send_from_directory('public', 'mobile.html')

if __name__ == '__main__':
    threading.Thread(target=get_all_stops, daemon=True).start()
    app.run(host='0.0.0.0', port=PORT)
