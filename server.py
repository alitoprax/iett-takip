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
from http.server import SimpleHTTPRequestHandler, HTTPServer

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
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
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

        return cache.get('duraklar_all', {}).get('data', [])


def get_line_schedules(hat_kodu):
    """Belirli bir hat için planlanan sefer saatlerini IBB SOAP API'den çeker."""
    cache_key = f'schedules_{hat_kodu}'
    now = time.time()
    # Timetables rarely change intraday, cache for 12 hours
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
        
        # Group by direction and day type
        structured_data = {'I': {'G': [], 'D': []}, 'C': {'G': [], 'D': []}, 'P': {'G': [], 'D': []}}
        
        for s in raw:
            day_type = s.get('SGUNTIPI', '') # I (İş), C (Ct), P (Paz)
            direction = s.get('SYON', '') # G or D
            time_val = s.get('DT', '')
            if day_type in structured_data and direction in structured_data[day_type]:
                structured_data[day_type][direction].append({
                    'v': s.get('SGUZERAH', ''), # variant
                    't': time_val
                })
        
        # Sort times
        for dt in structured_data.values():
            for dir_list in dt.values():
                dir_list.sort(key=lambda x: x['t'])
                
        cache[cache_key] = {'data': structured_data, 'ts': now}
        return structured_data
    except Exception as e:
        print(f"[{hat_kodu}] Sefer saatleri alınamadı: {e}")
        return cache.get(cache_key, {}).get('data', {})

def search_stops(query_str):
    """Durak adı veya kodu ile arama"""
    stops = get_all_stops()
    if not stops:
        return []
    q = query_str.lower().strip()
    results = []
    for s in stops:
        if q in s['kod'].lower() or q in s['adi'].lower():
            results.append(s)
            if len(results) >= 15:
                break
    return results


import math

def haversine_distance(lat1, lon1, lat2, lon2):
    R = 6371000  # radius of Earth in meters
    phi1 = math.radians(lat1)
    phi2 = math.radians(lat2)
    delta_phi = math.radians(lat2 - lat1)
    delta_lambda = math.radians(lon2 - lon1)
    a = math.sin(delta_phi / 2.0) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(delta_lambda / 2.0) ** 2
    c = 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))
    return R * c

def get_polyline_progress(polyline, lat, lon):
    """
    Returns (closest_dist_meters, progress_meters_from_start)
    polyline is a list of [lat, lon]
    """
    if not polyline or len(polyline) < 2:
        return 0, 0
    
    min_dist = float('inf')
    best_prog = 0
    current_prog = 0
    
    for i in range(len(polyline) - 1):
        lat1, lon1 = polyline[i]
        lat2, lon2 = polyline[i+1]
        
        seg_len = haversine_distance(lat1, lon1, lat2, lon2)
        if seg_len == 0:
            continue
            
        d1 = haversine_distance(lat, lon, lat1, lon1)
        d2 = haversine_distance(lat, lon, lat2, lon2)
        
        b = seg_len
        c = d1
        a = d2
        if b > 0:
            proj = (b*b + c*c - a*a) / (2*b)
        else:
            proj = 0
            
        if proj < 0:
            dist = d1
            prog = current_prog
        elif proj > b:
            dist = d2
            prog = current_prog + b
        else:
            dist = math.sqrt(max(0, c*c - proj*proj))
            prog = current_prog + proj
            
        if dist < min_dist:
            min_dist = dist
            best_prog = prog
            
        current_prog += seg_len
        
    return min_dist, best_prog

def get_osrm_eta(from_lat, from_lon, to_lat, to_lon):
    """OSRM ile iki nokta arası tahmini süre (saniye cinsinden)"""
    try:
        url = f'{OSRM_BASE}/route/v1/driving/{from_lon},{from_lat};{to_lon},{to_lat}?overview=false'
        resp = http_get(url, timeout=8)
        data = json.loads(resp)
        if data.get('code') == 'Ok' and data.get('routes'):
            route = data['routes'][0]
            return {
                'duration': route.get('duration', 0),  # seconds
                'distance': route.get('distance', 0),   # meters
            }
    except Exception:
        pass
    return None

# bus_memory kapino -> {'prog': float, 'ts': timestamp}
bus_memory = {}

def get_stop_detail(durak_kodu):
    """Durağa yaklaşan otobüsleri ve ETA'ları hesapla (Gelişmiş Polyline Filtresi ile)"""
    stops = get_all_stops()
    stop_info = None
    for s in stops:
        if s['kod'] == str(durak_kodu):
            stop_info = s
            break
    if not stop_info or not stop_info.get('lat'):
        return {'error': 'Durak bulunamadı'}

    gelenler = []
    checked_lines = set()

    for ck, cv in list(cache.items()):
        if ck.startswith('stations_') and 'data' in cv:
            hat_kodu = ck.replace('stations_', '')
            route_data = cv['data']
            route_lines = route_data.get('routeLine', {})
            
            for direction in ['G', 'D']:
                stops_list = route_data.get(direction, [])
                
                # Check if this stop is in this direction's stop list
                stop_idx_in_list = -1
                for i, st in enumerate(stops_list):
                    if str(st.get('kod', '')) == str(durak_kodu):
                        stop_idx_in_list = i
                        break
                        
                if stop_idx_in_list != -1:
                    checked_lines.add(hat_kodu)
                    polyline = route_lines.get(direction, [])
                    
                    # Calculate stop progress along polyline
                    stop_dist, stop_prog = get_polyline_progress(polyline, stop_info['lat'], stop_info['lon'])
                    
                    vehicles = get_line_vehicles(hat_kodu)
                    dir_vehicles = [v for v in vehicles if v.get('dir') == direction or v.get('dir') is None]
                    
                    for bus in dir_vehicles:
                        if bus.get('lat') and bus.get('lon'):
                            kapino = bus.get('kapino', '')
                            
                            # Find closest stop directly, ignoring polyline snaps
                            min_dist = float('inf')
                            bus_stop_idx = -1
                            for sti, st_obj in enumerate(stops_list):
                                if not st_obj.get('lat'): continue
                                d = haversine_distance(bus['lat'], bus['lon'], st_obj['lat'], st_obj['lon'])
                                if d < min_dist:
                                    min_dist = d
                                    bus_stop_idx = sti
                            
                            # Memory cleanup & state tracking (prevents backward snapping on stops)
                            now = time.time()
                            if len(bus_memory) > 10000:
                                stale = [k for k, v in bus_memory.items() if now - v['ts'] > 7200]
                                for k in stale:
                                    del bus_memory[k]

                            if kapino:
                                last_state = bus_memory.get(kapino)
                                if last_state:
                                    last_idx = last_state['prog']
                                    # If bus seems to jump backward slightly, hold it at its last known stop
                                    if bus_stop_idx < last_idx and (last_idx - bus_stop_idx) < 20 and (now - last_state['ts']) < 3600:
                                        bus_stop_idx = last_idx
                                
                                bus_memory[kapino] = {'prog': bus_stop_idx, 'ts': now}
                            
                            print(f"[DEBUG] Line {hat_kodu} Stop {durak_kodu} idx: {stop_idx_in_list}, Bus {kapino} idx: {bus_stop_idx}")
                            
                            # Filter passed buses
                            if bus_stop_idx > stop_idx_in_list:

                                continue
                                
                            # Calculate distance in meters by summing the physical distance between sequence stops
                            dist_meters = min_dist
                            for i in range(bus_stop_idx, stop_idx_in_list):
                                s1 = stops_list[i]
                                s2 = stops_list[i+1]
                                if s1.get('lat') and s2.get('lat'):
                                    dist_meters += haversine_distance(s1['lat'], s1['lon'], s2['lat'], s2['lon'])

                            km = round(dist_meters / 1000, 1)

                            # Istanbul IETT avg system speed is ~15-18 km/h.
                            # 15 km/h = 250 meters / minute
                            dk = round(dist_meters / 250.0)

                            if dk == 0 and dist_meters > 50:
                                dk = 1

                            gelenler.append({
                                'hat': hat_kodu,
                                'kapino': kapino,
                                'eta_dk': dk,
                                'mesafe_km': km,
                                'yon': 'Gidiş' if direction == 'G' else 'Dönüş',
                                'yon_kod': direction,
                                'hedef': bus.get('direction', '')
                            })
                    break  # Found stop in this direction, no need to check further

    # Sort by ETA
    gelenler.sort(key=lambda x: x.get('eta_dk', 999))

    return {
        'durak': stop_info,
        'gelenler': gelenler[:20],  # Max 20 results
        'kontrol_edilen_hat': len(checked_lines),
    }


def get_osrm_traffic_segments(hat_kodu, direction):
    """OSRM annotations ile güzergah hız segmentleri"""
    ck = f'stations_{hat_kodu}'
    if ck not in cache:
        return {'segments': []}

    route_data = cache[ck]['data']
    stops = route_data.get(direction, [])
    pts = [(s['lat'], s['lon']) for s in stops if s.get('lat') and s.get('lon')]
    if len(pts) < 2:
        return {'segments': []}

    # Use max 25 points to keep OSRM fast
    if len(pts) > 25:
        step = len(pts) / 25
        pts = [pts[int(i * step)] for i in range(25)] + [pts[-1]]

    try:
        coord_str = ';'.join(f'{lon},{lat}' for lat, lon in pts)
        url = f'{OSRM_BASE}/route/v1/driving/{coord_str}?overview=full&geometries=geojson&annotations=speed,duration,distance'
        resp = http_get(url, timeout=15)
        data = json.loads(resp)

        if data.get('code') != 'Ok' or not data.get('routes'):
            return {'segments': []}

        route = data['routes'][0]
        legs = route.get('legs', [])
        geom = route['geometry']['coordinates']  # [lon, lat] pairs

        segments = []
        coord_idx = 0
        for leg in legs:
            ann = leg.get('annotation', {})
            speeds = ann.get('speed', [])
            distances = ann.get('distance', [])
            durations = ann.get('duration', [])

            for i, speed in enumerate(speeds):
                speed_kmh = speed * 3.6  # m/s to km/h
                # Traffic color
                if speed_kmh >= 30:
                    color = '#22c55e'  # green — flowing
                elif speed_kmh >= 15:
                    color = '#f59e0b'  # amber — slow
                else:
                    color = '#ef4444'  # red — congested

                if coord_idx + 1 < len(geom):
                    segments.append({
                        'from': [geom[coord_idx][1], geom[coord_idx][0]],  # [lat, lon]
                        'to': [geom[coord_idx + 1][1], geom[coord_idx + 1][0]],
                        'speed_kmh': round(speed_kmh, 1),
                        'color': color,
                        'distance': distances[i] if i < len(distances) else 0,
                        'duration': durations[i] if i < len(durations) else 0,
                    })
                coord_idx += 1

        return {'segments': segments, 'toplam_segment': len(segments)}
    except Exception as e:
        print(f"OSRM traffic hatası: {e}")
        return {'segments': []}


def get_line_vehicles(hat_kodu):
    """Gerçek zamanlı otobüs konumları + guzergah sub-route tespiti"""
    now = time.time()
    ck = f'vehicles_{hat_kodu}'
    if ck in cache and now - cache[ck]['ts'] < BUS_POS_TTL:
        return cache[ck]['data']

    try:
        resp = http_post_json(f'{WORKERS_BASE}/line-vehicles', {'line': hat_kodu})
        raw = json.loads(resp)
        vehicles = raw.get('vehicles', raw) if isinstance(raw, dict) else raw
        result = []
        for v in vehicles:
            gz = v.get('guzergah', '')
            # Parse sub-route variant: 500T_G_G0 → variant='G0', dir='G'
            parts = gz.split('_') if gz else []
            variant = parts[-1] if len(parts) >= 3 else ''
            dir_code = parts[-2] if len(parts) >= 3 else ('G' if '_G_' in gz else 'D' if '_D_' in gz else '')
            result.append({
                'kapino': v.get('vehicleDoorCode', ''),
                'lon': float(v.get('lon', 0)),
                'lat': float(v.get('lat', 0)),
                'direction': v.get('direction', ''),
                'guzergah': gz,
                'dir': dir_code if dir_code else None,
                'variant': variant,
            })
        cache[ck] = {'data': result, 'ts': now}
        return result
    except Exception as e:
        print(f"Araç konum hatası ({hat_kodu}): {e}")
        return cache.get(ck, {}).get('data', [])


def get_stop_coords_batch(codes):
    """Bellekteki duraklar listesinden hızlıca GPS koordinatlarını çeker (API'yi yormamak için)"""
    results = {}
    stops = get_all_stops()
    stop_dict = {str(s['kod']): s for s in stops}
    
    for code in codes:
        code_str = str(code)
        if code_str in stop_dict and stop_dict[code_str].get('lat'):
            results[code_str] = {
                'lat': stop_dict[code_str]['lat'],
                'lon': stop_dict[code_str]['lon']
            }
            
    # print(f"  GPS koordinat (Local Cache): {len(results)}/{len(codes)} durak")
    return results


def get_osrm_route(stop_latlngs):
    """
    OSRM public API ile gerçek yola göre polyline al.
    stop_latlngs: [(lat, lon), ...]  sıralı durak koordinatları
    Returns: [(lat, lon), ...] yol boyunca koordinatlar
    """
    if len(stop_latlngs) < 2:
        return stop_latlngs

    all_coords = []

    # OSRM has a limit, split into overlapping chunks
    chunk_size = ROUTE_CHUNK
    chunks = []
    i = 0
    while i < len(stop_latlngs):
        chunk = stop_latlngs[i:i + chunk_size]
        chunks.append(chunk)
        i += chunk_size - 1  # overlap by 1 to chain

    for ci, chunk in enumerate(chunks):
        try:
            coord_str = ';'.join(f'{lon},{lat}' for lat, lon in chunk)
            url = f'{OSRM_BASE}/route/v1/driving/{coord_str}?overview=full&geometries=geojson&steps=false'
            resp = http_get(url, timeout=15)
            data = json.loads(resp)
            if data.get('code') == 'Ok' and data.get('routes'):
                geom_coords = data['routes'][0]['geometry']['coordinates']
                # OSRM returns [lon, lat] format
                route_pts = [[lat, lon] for lon, lat in geom_coords]
                if ci == 0:
                    all_coords.extend(route_pts)
                else:
                    all_coords.extend(route_pts[1:])  # skip first pt (already in prev chunk)
        except Exception as e:
            print(f"OSRM hata (chunk {ci}): {e}")
            # Fallback: use straight lines for this chunk
            for lat, lon in chunk:
                all_coords.append([lat, lon])

    return all_coords


def get_iett_variant_stops(hat_kodu):
    """
    iett.istanbul JSON API'lerini kullanarak varyantlı durak listelerini çeker.
    Döner: { variant_code: { 'label': '...', 'stops': [...], 'polyline': [...] } }
    """
    cache_key = f'vstops_{hat_kodu}'
    now = time.time()
    if cache_key in cache and now - cache[cache_key]['ts'] < CACHE_TTL:
        return cache[cache_key]['data']

    try:
        referer = f"https://www.iett.istanbul/RouteDetail?hkod={hat_kodu}"
        extra = {'Referer': referer}
        
        # 1. Varyant listesini çek
        variants_raw_text = http_get(
            f"https://www.iett.istanbul/tr/RouteStation/GetAllRoute?rcode={urllib.parse.quote(hat_kodu)}",
            timeout=10,
            extra_headers=extra
        )
        variants_raw = json.loads(variants_raw_text)
        
        results = {}
        for v in variants_raw:
            v_code = v.get('GUZERGAH_GUZERGAH_KODU')
            v_name = v.get('GUZERGAH_ADI', v_code)
            if not v_code: continue
            
            # 2. Her varyant için durak ve geometri verisini çek
            v_detail_text = http_get(
                f"https://www.iett.istanbul/tr/RouteStation/GetRoutePinV2?q={urllib.parse.quote(v_code)}",
                timeout=10,
                extra_headers=extra
            )
            v_detail = json.loads(v_detail_text)
            if isinstance(v_detail, list) and v_detail:
                v_detail = v_detail[0]
            
            if not isinstance(v_detail, dict):
                continue
            
            stops = []
            for s in v_detail.get('stationPlaces', []):
                stops.append({
                    'kod': s.get('stationCode', ''), # Bazı API'lerde stationCode yoksa bile adi/lat/lon var
                    'adi': s.get('stationName', '').strip(),
                    'lat': float(s.get('lat', 0)),
                    'lon': float(s.get('lng', 0))
                })
            
            # WKT LINESTRING parse et
            polyline = []
            line_wkt = v_detail.get('line', '')
            if line_wkt:
                # LINESTRING (lon lat, lon lat, ...)
                coords = re.findall(r'([0-9.]+)\s+([0-9.]+)', line_wkt)
                for lon, lat in coords:
                    polyline.append([float(lat), float(lon)])
            
            results[v_code] = {
                'label': v_name,
                'stops': stops,
                'polyline': polyline
            }
            
        cache[cache_key] = {'data': results, 'ts': now}
        return results
    except Exception as e:
        print(f"IETT Variant API error ({hat_kodu}): {e}")
        return {}



def get_route_stations(hat_kodu):
    """Güzergah durakları - HTML + GPS koordinatları + OSRM yol geometrisi"""
    now = time.time()
    ck = f'stations_{hat_kodu}'
    if ck in cache and now - cache[ck]['ts'] < CACHE_TTL:
        return cache[ck]['data']

    try:
        html_content = http_get(
            f'{WORKERS_BASE}/api/route-stations?hatkod={urllib.parse.quote(hat_kodu)}&hatstart=x&hatend=y&langid=1'
        )
        gidis_match = re.search(r'col-md-6 col-12.*?line-pass-header.*?KALKIŞ(.*?)class="col-md-6', html_content, re.DOTALL)
        donus_match = re.search(r'col-md-6 col-12.*?line-pass-header.*?KALKIŞ.*?class="col-md-6(.*)', html_content, re.DOTALL)

        def parse_stops_from_block(block):
            stops = []
            items = re.findall(r'dkod=(\d+)[^"]*stationname=([^"&]+)[^>]*>.*?<p>(\d+)\.\s*([^<]+)', block, re.DOTALL)
            for dkod, sname, idx, pname in items:
                name = urllib.parse.unquote_plus(sname.strip()) or pname.strip()
                stops.append({'sira': int(idx), 'kod': dkod, 'adi': name.strip()})
            return stops

        gidis = parse_stops_from_block(gidis_match.group(1) if gidis_match else html_content[:len(html_content)//2])
        donus = parse_stops_from_block(donus_match.group(1) if donus_match else html_content[len(html_content)//2:])

        # Fetch GPS coordinates for all unique stops in parallel
        all_codes = list({s['kod'] for s in gidis + donus})
        print(f"Durak GPS çekiliyor: {len(all_codes)} durak ({hat_kodu})")
        coords_map = get_stop_coords_batch(all_codes)

        # Merge coordinates into stops
        for stop in gidis + donus:
            c = coords_map.get(stop['kod'])
            if c:
                stop['lat'] = c['lat']
                stop['lon'] = c['lon']

        # Build OSRM road-following polylines
        def build_route_line(stops):
            pts = [(s['lat'], s['lon']) for s in stops if s.get('lat') and s.get('lon')]
            if len(pts) < 2:
                return []
            print(f"  OSRM yol geometrisi: {len(pts)} durak noktası")
            return get_osrm_route(pts)

        print(f"Gidiş OSRM...")
        gidis_line = build_route_line(gidis)
        print(f"Dönüş OSRM...")
        donus_line = build_route_line(donus)

        data = {
            'G': gidis,
            'D': donus,
            'routeLine': {
                'G': gidis_line,
                'D': donus_line,
            }
        }
        
        if len(gidis) == 0 and len(donus) == 0:
            raise Exception("Boş güzergah verisi alındı (Cloudflare engellemesi veya API hatası). Cache'lenmiyor.")
            
        cache[ck] = {'data': data, 'ts': now}
        return data
    except Exception as e:
        print(f"Durak hatası ({hat_kodu}): {e}")
        import traceback; traceback.print_exc()
        return {'G': [], 'D': [], 'routeLine': {'G': [], 'D': []}}


def get_line_info(hat_kodu):
    """Hat bilgisi - iett.rednexie.workers.dev"""
    try:
        resp = http_post_json(f'{WORKERS_BASE}/line-information', {'line': hat_kodu})
        return json.loads(resp)
    except Exception as e:
        print(f"Hat bilgisi hatası ({hat_kodu}): {e}")
        return {}


class APIProxyHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=os.path.join(os.path.dirname(__file__), 'public'), **kwargs)

    def log_message(self, format, *args):
        if '/api/' in (args[0] if args else ''):
            super().log_message(format, *args)

    def end_headers(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(200)
        self.end_headers()

    def do_GET(self):
        if not self.path.startswith('/api/'):
            # Normalize path
            clean_path = self.path.split('?')[0].split('#')[0].rstrip('/')
            
            # Serve mobile.html as the primary application
            if clean_path in ('', '/mobile', '/mobil', '/index.html'):
                self.path = '/mobile.html'
            
            return super().do_GET()

        try:
            parsed = urllib.parse.urlparse(self.path)
            path_parts = parsed.path.split('/')
            endpoint = path_parts[2] if len(path_parts) > 2 else ''
            query = urllib.parse.parse_qs(parsed.query)

            self.send_response(200)
            self.send_header('Content-type', 'application/json; charset=utf-8')
            self.end_headers()

            if endpoint == 'hatlar':
                data = get_all_lines()
                self.wfile.write(json.dumps(data, ensure_ascii=False).encode('utf-8'))

            elif endpoint == 'guzergah' and len(path_parts) > 3:
                hat_kodu = urllib.parse.unquote(path_parts[3])
                stations = get_route_stations(hat_kodu)
                line_info = get_line_info(hat_kodu)
                self.wfile.write(json.dumps({
                    'duraklar': {'G': stations['G'], 'D': stations['D']},
                    'routeLine': stations.get('routeLine', {'G': [], 'D': []}),
                    'bilgi': line_info,
                }, ensure_ascii=False).encode('utf-8'))

            elif endpoint == 'otobus-konum' and len(path_parts) > 3:
                hat_kodu = urllib.parse.unquote(path_parts[3])
                otobusler = get_line_vehicles(hat_kodu)
                # Get unique sub-routes
                variants = {}
                for v in otobusler:
                    key = f"{v['dir']}_{v['variant']}" if v.get('variant') else v['dir']
                    if key not in variants:
                        variants[key] = {
                            'dir': v['dir'],
                            'variant': v.get('variant', ''),
                            'label': v.get('direction', key),
                            'count': 0,
                        }
                    variants[key]['count'] += 1

                self.wfile.write(json.dumps({
                    'hatKodu': hat_kodu,
                    'otobusler': otobusler,
                    'toplamOtobus': len(otobusler),
                    'zaman': time.strftime('%H:%M:%S'),
                    'varyantlar': list(variants.values()),
                }, ensure_ascii=False).encode('utf-8'))

            elif endpoint == 'hat-ara':
                q = query.get('q', [''])[0]
                resp = http_get(f'{WORKERS_BASE}/api/line-suggestions?q={urllib.parse.quote(q)}')
                self.wfile.write(resp.encode('utf-8'))

            elif endpoint == 'durak-ara':
                q = query.get('q', [''])[0]
                results = search_stops(q)
                self.wfile.write(json.dumps(results, ensure_ascii=False).encode('utf-8'))

            elif endpoint == 'durak-detay' and len(path_parts) > 3:
                durak_kodu = urllib.parse.unquote(path_parts[3])
                data = get_stop_detail(durak_kodu)
                self.wfile.write(json.dumps(data, ensure_ascii=False).encode('utf-8'))

            elif endpoint == 'sefer-saatleri' and len(path_parts) > 3:
                hat_kodu = urllib.parse.unquote(path_parts[3])
                data = get_line_schedules(hat_kodu)
                self.wfile.write(json.dumps(data, ensure_ascii=False).encode('utf-8'))

            elif endpoint == 'osrm-traffic' and len(path_parts) > 4:
                hat_kodu = urllib.parse.unquote(path_parts[3])
                yon = path_parts[4]  # G or D
                data = get_osrm_traffic_segments(hat_kodu, yon)
                self.wfile.write(json.dumps(data, ensure_ascii=False).encode('utf-8'))

            elif endpoint == 'variant-stops' and len(path_parts) > 4:
                hat_kodu = urllib.parse.unquote(path_parts[3])
                variant = urllib.parse.unquote(path_parts[4])
                all_v = get_iett_variant_stops(hat_kodu)
                v_data = all_v.get(variant, {'stops': [], 'polyline': []})
                self.wfile.write(json.dumps(v_data, ensure_ascii=False).encode('utf-8'))

            elif endpoint == 'line-variants' and len(path_parts) > 3:
                hat_kodu = urllib.parse.unquote(path_parts[3])
                all_v = get_iett_variant_stops(hat_kodu)
                # Sadece metadata (kod, label) dönelim, stop listesi ağır gelebilir
                result = []
                for code, info in all_v.items():
                    result.append({'variant': code, 'label': info.get('label', '')})
                self.wfile.write(json.dumps(result, ensure_ascii=False).encode('utf-8'))

            elif endpoint == 'debug-cache':
                res = { k: len(v.get('data', {})) if isinstance(v.get('data'), (dict, list)) else True for k,v in cache.items() }
                self.wfile.write(json.dumps({'cache_keys': len(cache), 'details': res}, ensure_ascii=False).encode('utf-8'))

            else:
                self.wfile.write(json.dumps({'error': 'Unknown endpoint'}).encode('utf-8'))

        except Exception as e:
            import traceback
            traceback.print_exc()
            try:
                self.send_response(500)
                self.send_header('Content-type', 'application/json')
                self.end_headers()
                self.wfile.write(json.dumps({'error': str(e)}).encode('utf-8'))
            except:
                pass

def build_global_route_cache():
    """Arka planda tüm hatların durak bilgilerini ve OSRM rotalarını önbelleğe alır. 
    Bu işlem duraktan geçen otobüs ETA hesaplaması için kritiktir."""
    print(">>> Arka planda global güzergah önbelleği oluşturuluyor (ETA hesaplama için) <<<")
    try:
        from concurrent.futures import ThreadPoolExecutor
        
        lines = get_all_lines()
        print(f"Toplam {len(lines)} hat bulundu, önbellekleme başladı...")
        
        import time
        
        # Max 3 thread ile yavaş yavaş tüm hatların verisini çekelim (Cloudflare rate limitinden kaçınmak için)
        with ThreadPoolExecutor(max_workers=3) as executor:
            for line in lines:
                hat_kodu = line.get('SHPIETT')
                if hat_kodu:
                    executor.submit(get_route_stations, hat_kodu)
                    time.sleep(0.5)
        
        print(f">>> Global güzergah önbelleği tamamlandı! <<<")
    except Exception as e:
        print(f"[HATA] build_global_route_cache başarısız: {e}")

if __name__ == '__main__':
    import socket as _socket
    os.makedirs(os.path.join(os.path.dirname(__file__), 'public'), exist_ok=True)
    server_address = ('0.0.0.0', PORT)
    httpd = HTTPServer(server_address, APIProxyHandler)
    # Initialize cache for stops and cache lines passing data in background
    threading.Thread(target=get_all_stops, daemon=True).start()
    threading.Thread(target=build_global_route_cache, daemon=True).start()
    # Detect local IP for WiFi access
    try:
        s = _socket.socket(_socket.AF_INET, _socket.SOCK_DGRAM)
        s.connect(('8.8.8.8', 80))
        local_ip = s.getsockname()[0]
        s.close()
    except Exception:
        local_ip = '0.0.0.0'
    print(f"🚌 IETT Canlı Takip sunucusu başlatıldı")
    print(f"📱 Lokal  : http://localhost:{PORT}")
    print(f"🌐 WiFi   : http://{local_ip}:{PORT}")
    print(f"📱 Mobil  : http://{local_ip}:{PORT}/mobile")
    print(f"📡 Veri   : {WORKERS_BASE} | OSRM | IBB SOAP")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    httpd.server_close()
