// =====================================================
// IETT Canlı Takip - mobile.js
// =====================================================

// Use relative URL so it works on both localhost AND WiFi IP
const API = '/api';
const REFRESH_MS = 15000;

// ── State ─────────────────────────────────────────────
const ms = {
    map: null,
    currentLine: null,
    currentStop: null,
    direction: 'G',
    selectedVariant: null,
    routeData: null,
    busData: null,
    busMarkers: {},
    stopMarkers: [],
    routePolyline: null,
    routeGlow: null,
    routeDecorator: null,
    trafficLayers: [],
    refreshTimer: null,
    allLines: [],
    favorites: JSON.parse(localStorage.getItem('iett-fav-mobile') || '[]'),
    recentScans: JSON.parse(localStorage.getItem('iett-scans') || '[]'),
    _hasFit: false,
    _hasActiveTargetBus: false, // New flag
    currentScreen: 'harita',
    variantLabelMap: {},
};

// ── Line badge colors ──────────────────────────────────
function lineColor(code) {
    if (!code) return '#607d8b';
    const c = code.toUpperCase();
    if (c.startsWith('T')) return '#2e7d32';
    if (c.startsWith('M')) return '#1565c0';
    if (c.endsWith('D')) return '#6a1b9a';
    if (c.endsWith('T')) return '#e65100';
    const num = parseInt(c) || 0;
    if (num < 50) return '#c62828';
    if (num < 100) return '#1565c0';
    if (num < 200) return '#2e7d32';
    if (num < 300) return '#6a1b9a';
    if (num < 500) return '#e65100';
    return '#37474f';
}

function esc(s) {
    return String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function haversine(lat1, lon1, lat2, lon2) {
    const R = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ── Screen Switching ───────────────────────────────────
function switchScreen(name) {
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
    const screen = document.getElementById(`screen-${name}`);
    if (screen) screen.classList.add('active');
    const navBtn = document.querySelector(`.nav-btn[data-screen="${name}"]`);
    if (navBtn) navBtn.classList.add('active');
    ms.currentScreen = name;

    // Side effects
    if (name === 'harita' && !ms.map) initMap();
    if (name === 'harita' && ms.map) setTimeout(() => ms.map.invalidateSize(), 100);
    if (name === 'hatlar') loadLinesList();
    if (name === 'favoriler') renderFavoritesList();
    if (name === 'qr') renderRecentScans();
}

// ── Map ────────────────────────────────────────────────
function initMap() {
    ms.map = L.map('map', {
        center: [41.015, 28.98],
        zoom: 12,
        zoomControl: false,
    });

    L.control.zoom({ position: 'bottomright' }).addTo(ms.map);

    L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', {
        attribution: '© <a href="https://carto.com/">CARTO</a> · © <a href="https://osm.org/">OSM</a>',
        maxZoom: 20,
        subdomains: 'abcd',
    }).addTo(ms.map);

    // Locate button
    document.getElementById('locateBtn').addEventListener('click', locateMe);

    // Init search, nearby, bottom sheet etc. -- the rest of DOMContentLoaded continues below

    function locateMe() {
        if (!navigator.geolocation) {
            alert('Cihazınız konum özelliğini desteklemiyor.');
            return;
        }

        navigator.geolocation.getCurrentPosition(pos => {
            ms.map.setView([pos.coords.latitude, pos.coords.longitude], 15);
            L.circleMarker([pos.coords.latitude, pos.coords.longitude], {
                radius: 8, fillColor: '#1a73e8', fillOpacity: 1,
                color: 'white', weight: 2,
            }).addTo(ms.map).bindPopup('📍 Konumunuz').openPopup();
            loadNearbyStops(pos.coords.latitude, pos.coords.longitude);
        }, err => {
            if (err.code === 1) {
                alert('Konum izni reddedildi. Lütfen tarayıcı ayarlarından İETT Canlı Takip için konum izni verin.');
            } else if (err.code === 2) {
                alert('Konum bulunamadı. Lütfen cihazınızın GPS (Konum) özelliğinin açık olduğundan emin olun.');
            } else if (err.code === 3) {
                alert('Konum isteği zaman aşımına uğradı, bağlantınız zayıf olabilir.');
            } else if (window.location.protocol !== 'https:' && window.location.hostname !== 'localhost') {
                alert('Tarayıcı güvenlik politikası gereği, konumunuzu almak için uygulamanın HTTPS üzerinden veya localhost (127.0.0.1) ile açılması gerekiyor.');
            } else {
                alert('Konum alınırken hata oluştu: ' + err.message);
            }
        }, { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 });
    }
} // end initMap()

// ── Map Search ─────────────────────────────────────────
let mapSearchInput, mapSearchResults;
let searchDebounce;

function initSearch() {
    mapSearchInput = document.getElementById('mapSearchInput');
    mapSearchResults = document.getElementById('mapSearchResults');
    if (!mapSearchInput) return;

    mapSearchInput.addEventListener('input', (e) => {
        const q = e.target.value.trim();
        clearTimeout(searchDebounce);
        if (q.length < 1) { mapSearchResults.style.display = 'none'; return; }
        searchDebounce = setTimeout(() => doMobileSearch(q), 300);
    });

    mapSearchInput.addEventListener('focus', () => {
        if (mapSearchInput.value.trim().length > 0) mapSearchResults.style.display = 'block';
    });

    document.addEventListener('click', (e) => {
        if (!e.target.closest('#mapSearchBar') && !e.target.closest('#mapSearchResults')) {
            mapSearchResults.style.display = 'none';
        }
    });
}

async function doMobileSearch(q) {
    try {
        // Search both lines and stops in parallel
        const [lineResp, stopResp] = await Promise.all([
            fetch(`${API}/hat-ara?q=${encodeURIComponent(q)}`),
            fetch(`${API}/durak-ara?q=${encodeURIComponent(q)}`),
        ]);
        const lines = await lineResp.json().catch(() => []);
        const stops = await stopResp.json().catch(() => []);

        let html = '';

        // Line results (max 5)
        const lineArr = Array.isArray(lines) ? lines.slice(0, 5) : [];
        lineArr.forEach(r => {
            const line = r.line || r.SHPIETT || '';
            const name = r.name || r.SHAT_ADI || '';
            html += `<div class="search-result-item" onclick="mobileSelectLine('${esc(line)}','${esc(name)}')">
                <span class="sri-badge" style="background:${lineColor(line)}">${esc(line)}</span>
                <span class="sri-name">${esc(name)}</span>
            </div>`;
        });

        // Stop results (max 5)
        const stopArr = Array.isArray(stops) ? stops.slice(0, 5) : [];
        if (stopArr.length > 0) {
            if (lineArr.length > 0) {
                html += `<div style="padding:6px 16px;font-size:10px;font-weight:700;color:#94a3b8;letter-spacing:.5px;text-transform:uppercase;border-top:1px solid rgba(148,163,184,0.12)">DURAKLAR</div>`;
            }
            stopArr.forEach(s => {
                const yonStr = s.yon ? `<div style="font-size:11px;color:#94a3b8;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">Hata Yönü: <span style="font-weight:600;color:#6366f1">${esc(s.yon)}</span></div>` : '';
                html += `<div class="search-result-item" onclick="mobileSelectStop('${esc(s.kod)}','${esc(s.adi)}','${esc(s.yon || '')}')">
                    <div class="sri-stop-icon">
                        <div style="width:14px;height:14px;border-radius:50%;background:#6366f1;border:2px solid white;box-shadow:0 1px 4px rgba(0,0,0,0.2)"></div>
                    </div>
                    <div style="flex:1;min-width:0;display:flex;flex-direction:column;justify-content:center;">
                        <span class="sri-name" style="white-space:normal;line-height:1.2">${esc(s.adi)} <small style="color:#94a3b8;margin-left:4px">#${esc(s.kod)}</small></span>
                        ${yonStr}
                    </div>
                </div>`;
            });
        }

        if (!html) {
            html = '<div class="empty-state">Sonuç bulunamadı</div>';
        }

        mapSearchResults.innerHTML = html;
        mapSearchResults.style.display = 'block';
    } catch (e) {
        console.error(e);
    }
}

// ── Line Selection ─────────────────────────────────────
async function mobileSelectLine(code, name) {
    mapSearchResults.style.display = 'none';
    mapSearchInput.value = code;

    // Switch to harita if not there
    if (ms.currentScreen !== 'harita') switchScreen('harita');

    // Reset state
    clearMobileMap();
    stopMobileRefresh();
    ms.currentLine = code;
    ms.direction = 'G';
    ms.selectedVariant = null;
    ms._hasFit = false;

    // Show panel and expand sheet
    showLineDetailPanel(code, name);
    expandSheet('half');
    setLoading(true);

    try {
        const [routeResp, variantResp] = await Promise.all([
            fetch(`${API}/guzergah/${encodeURIComponent(code)}`),
            fetch(`${API}/line-variants/${encodeURIComponent(code)}`),
        ]);
        ms.routeData = await routeResp.json();
        const variants = await variantResp.json();
        ms.variantLabelMap = {};
        variants.forEach(v => ms.variantLabelMap[v.variant] = v.label);

        await refreshMobileBusPositions();
        renderMobileStopsPanel();
        setLoading(false);
        startMobileRefresh();
        loadTimetable(code);  // Fetch timetable in background
    } catch (e) {
        console.error(e);
        setLoading(false);
    }
}

function showLineDetailPanel(code, name) {
    document.getElementById('nearbyPanel').style.display = 'none';
    document.getElementById('lineDetailPanel').style.display = 'block';
    document.getElementById('detailLineBadge').textContent = code;
    document.getElementById('detailLineBadge').style.background = lineColor(code);
    document.getElementById('detailLineName').textContent = name;
    // Fav button
    const isFav = ms.favorites.some(f => f.code === code);
    document.getElementById('detailFavBtn').textContent = isFav ? '★' : '☆';
    document.getElementById('detailFavBtn').style.color = isFav ? '#f9ab00' : '#9aa0b0';
}

function closeLineDetail() {
    clearMobileMap();
    stopMobileRefresh();
    ms.currentLine = null;
    ms.selectedVariant = null;
    ms.routeData = null;
    ms.busData = null;
    ms.timetableData = null;
    ms._hasFit = false;
    ms._hasActiveTargetBus = false;
    document.getElementById('lineDetailPanel').style.display = 'none';
    document.getElementById('nearbyPanel').style.display = 'block';
    if (mapSearchInput) mapSearchInput.value = '';
    setSheetSnap('peek');
}

// ── Timetable ──────────────────────────────────────────
async function loadTimetable(lineCode) {
    try {
        const resp = await fetch(`${API}/sefer-saatleri/${encodeURIComponent(lineCode)}`);
        ms.timetableData = await resp.json();
        // Auto-detect today's day type
        const dow = new Date().getDay(); // 0=Sun, 6=Sat
        const autoDay = dow === 0 ? 'P' : dow === 6 ? 'C' : 'I';
        // Activate correct chip
        document.querySelectorAll('.tt-chip').forEach(c => c.classList.remove('active'));
        const activeChip = document.querySelector(`.tt-chip[data-day="${autoDay}"]`);
        if (activeChip) activeChip.classList.add('active');
        renderTimetable(autoDay);
    } catch (e) {
        console.error('Timetable error:', e);
        document.getElementById('timetableGrid').innerHTML = '<div class="empty-state">⚠️ Sefer saatleri alınamadı</div>';
    }
}

function switchDetailTab(tabName, btnEl) {
    document.querySelectorAll('.detail-tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
    if (btnEl) btnEl.classList.add('active');
    const tabEl = document.getElementById(`tab-${tabName}`);
    if (tabEl) tabEl.classList.add('active');
}

function setTimetableDay(dayCode, chipEl) {
    document.querySelectorAll('.tt-chip').forEach(c => c.classList.remove('active'));
    if (chipEl) chipEl.classList.add('active');
    renderTimetable(dayCode);
}

function renderTimetable(dayCode) {
    const grid = document.getElementById('timetableGrid');
    if (!ms.timetableData) { grid.innerHTML = '<div class="empty-state">Veri yükleniyor...</div>'; return; }

    const dayData = ms.timetableData[dayCode];
    if (!dayData) { grid.innerHTML = '<div class="empty-state">Bu gün tipi için veri bulunamadı</div>'; return; }

    const dir = ms.direction || 'G';
    const times = dayData[dir] || [];
    if (times.length === 0) {
        grid.innerHTML = `<div class="empty-state">Bu yön için sefer saati bulunamadı</div>`;
        return;
    }

    // Group by hour
    const hourGroups = {};
    times.forEach(t => {
        const hour = t.t.split(':')[0];
        if (!hourGroups[hour]) hourGroups[hour] = [];
        hourGroups[hour].push(t.t);
    });

    const nowH = new Date().getHours();
    const nowM = new Date().getMinutes();
    const nowStr = `${String(nowH).padStart(2, '0')}:${String(nowM).padStart(2, '0')}`;
    let foundNext = false;

    let html = '';
    const sortedHours = Object.keys(hourGroups).sort();
    sortedHours.forEach(hour => {
        const mins = hourGroups[hour];
        const pillsHtml = mins.map(t => {
            let cls = '';
            if (t < nowStr) cls = 'past';
            else if (!foundNext) { cls = 'next'; foundNext = true; }
            return `<span class="tt-time-pill ${cls}">${t}</span>`;
        }).join('');
        html += `<div class="tt-hour-group" id="tt-hour-${hour}">
            <div class="tt-hour-label">${hour}</div>
            <div class="tt-minutes">${pillsHtml}</div>
        </div>`;
    });

    grid.innerHTML = html;

    // Scroll to current hour
    const currentHourEl = document.getElementById(`tt-hour-${String(nowH).padStart(2, '0')}`);
    if (currentHourEl) {
        setTimeout(() => currentHourEl.scrollIntoView({ behavior: 'smooth', block: 'center' }), 300);
    }
}

function showNearbyPanel() {
    closeLineDetail();
}

// ── Bus Refresh ────────────────────────────────────────
async function refreshMobileBusPositions() {
    // If we have a specific bus selected (selectIncomingBus), it has its own timer.
    // If not, and we have a current line, refresh it.
    if (ms.currentLine && !ms._hasActiveTargetBus) {
        try {
            const r = await fetch(`${API}/otobus-konum/${encodeURIComponent(ms.currentLine)}`);
            ms.busData = await r.json();
            renderMobileBusMarkers();
            updateMobileStats();
            if (ms.openStopCode) renderMobileStopsPanel();
        } catch (e) { console.error(e); }
    }

    // If stop detail is open, refresh ETAs
    if (ms.currentStop && !ms._hasActiveTargetBus) {
        try {
            const resp = await fetch(`${API}/durak-detay/${encodeURIComponent(ms.currentStop.kod)}`);
            const data = await resp.json();
            renderStopDetail(data);
        } catch (e) { console.error(e); }
    }
}

async function manualRefreshMobile() {
    const btn = document.getElementById('refreshMapBtn');
    if (btn) { btn.disabled = true; btn.textContent = '⏳'; }
    await refreshMobileBusPositions();
    if (btn) { btn.disabled = false; btn.textContent = '🔄'; }
}

function startMobileRefresh() {
    stopMobileRefresh();
    ms.refreshTimer = setInterval(async () => {
        if (ms.currentLine) await refreshMobileBusPositions();
    }, REFRESH_MS);
}

function stopMobileRefresh() {
    if (ms.refreshTimer) { clearInterval(ms.refreshTimer); ms.refreshTimer = null; }
}

// ── Map Rendering ──────────────────────────────────────
function renderMobileBusMarkers() {
    const buses = ms.busData?.otobusler || [];
    const dir = ms.direction;

    const filtered = buses.filter(b => {
        // If we are artificially tracking just one specific bus, skip all direction/variant filters
        if (buses.length === 1) return true;

        const matchDir = b.dir === dir || (!b.dir && (dir === 'G' ? b.guzergah?.includes('_G_') : b.guzergah?.includes('_D_')));
        if (!matchDir) return false;
        if (ms.selectedVariant && b.variant) return b.variant === ms.selectedVariant;
        return true;
    });

    console.log('renderMobileBusMarkers input buses:', buses.length, 'filtered:', filtered.length);

    const newIds = new Set(filtered.map(b => b.kapino));
    Object.keys(ms.busMarkers).forEach(id => {
        if (!newIds.has(id)) { ms.map.removeLayer(ms.busMarkers[id]); delete ms.busMarkers[id]; }
    });

    filtered.forEach(bus => {
        if (!bus.lat || !bus.lon) return;
        const color = lineColor(ms.currentLine);
        const icon = L.divIcon({
            html: `<div class="bus-marker" style="width:42px;height:42px;">
                <span class="material-symbols-outlined z-10" style="font-size:24px;color:${color}">directions_bus</span>
                <div style="position:absolute;inset:0;border-radius:50%;background:white;opacity:0.2"></div>
            </div>`,
            className: '',
            iconSize: [42, 42],
            iconAnchor: [21, 21],
            popupAnchor: [0, -21],
        });
        if (ms.busMarkers[bus.kapino]) {
            ms.busMarkers[bus.kapino].setLatLng([bus.lat, bus.lon]);
        } else {
            ms.busMarkers[bus.kapino] = L.marker([bus.lat, bus.lon], { icon, zIndexOffset: 1000 })
                .addTo(ms.map)
                .bindPopup(`<b>${bus.kapino}</b><br><small>${bus.direction || ''}</small>`);
        }
    });
}

function renderMobileStopsOnMap() {
    if (!ms.map) return;
    ms.stopMarkers.forEach(m => ms.map.removeLayer(m));
    ms.stopMarkers = [];
    if (ms.routeGlow) { ms.map.removeLayer(ms.routeGlow); ms.routeGlow = null; }
    if (ms.routePolyline) { ms.map.removeLayer(ms.routePolyline); ms.routePolyline = null; }
    if (ms.routeDecorator) { ms.map.removeLayer(ms.routeDecorator); ms.routeDecorator = null; }
    clearTrafficLayers();

    const stops = ms.routeData?.duraklar?.[ms.direction] || [];
    const routeLinePts = ms.routeData?.routeLine?.[ms.direction] || [];
    if (stops.length === 0) return;

    const isGidis = ms.direction === 'G';
    const routeColor = isGidis ? '#34a853' : '#ff9800';
    const midColor = isGidis ? '#81c784' : '#ffb74d';

    const latlngs = routeLinePts.length >= 2 ? routeLinePts :
        stops.filter(s => s.lat && s.lon).map(s => [s.lat, s.lon]);

    stops.forEach((stop, idx) => {
        if (!stop.lat || !stop.lon) return;

        // Snap stop coordinate to the closest point on the actual route geometry to ensure it lies exactly on the line visually
        let sLat = stop.lat;
        let sLon = stop.lon;
        if (latlngs.length >= 2) {
            let minDist = Infinity;
            latlngs.forEach(p => {
                const d = haversine(stop.lat, stop.lon, p[0], p[1]);
                if (d < minDist) { minDist = d; sLat = p[0]; sLon = p[1]; }
            });
        }

        const isFirst = idx === 0;
        const isLast = idx === stops.length - 1;
        const isTerminal = isFirst || isLast;

        let iconHtml;
        if (isFirst) {
            iconHtml = `<div style="position:relative"><div class="stop-marker" style="width:16px;height:16px;background:#34a853"></div><div style="position:absolute;left:20px;top:-2px;background:#34a853;color:white;font-size:10px;font-weight:700;font-family:Inter,sans-serif;padding:2px 7px;border-radius:4px;white-space:nowrap;box-shadow:0 1px 4px rgba(0,0,0,.2)">${esc(stop.adi)}</div></div>`;
        } else if (isLast) {
            iconHtml = `<div style="position:relative"><div class="stop-marker" style="width:16px;height:16px;background:#ea4335"></div><div style="position:absolute;left:20px;top:-2px;background:#ea4335;color:white;font-size:10px;font-weight:700;font-family:Inter,sans-serif;padding:2px 7px;border-radius:4px;white-space:nowrap;box-shadow:0 1px 4px rgba(0,0,0,.2)">${esc(stop.adi)}</div></div>`;
        } else {
            iconHtml = `<div class="stop-marker" style="width:16px;height:16px;background:${midColor}"></div>`;
        }

        const icon = L.divIcon({
            html: iconHtml, className: '',
            iconSize: [16, 16],
            iconAnchor: [8, 8],
            popupAnchor: [0, -8],
        });

        const popup = `<div style="font-family:Inter,sans-serif;min-width:140px">
            <b style="color:${isFirst ? '#34a853' : isLast ? '#ea4335' : routeColor}">${isFirst ? '🟢' : isLast ? '🔴' : '🚏'} ${stop.adi}</b>
            <br><small style="color:#888">${idx + 1}. Durak · Kod: ${stop.kod}</small></div>`;

        const marker = L.marker([sLat, sLon], { icon, zIndexOffset: isTerminal ? 600 : 300 })
            .addTo(ms.map).bindPopup(popup);

        if (!isTerminal) {
            marker.bindTooltip(stop.adi, { permanent: false, direction: 'top', offset: [0, -8], className: 'm-stop-tooltip', opacity: 0.95 });
        }

        marker.on('click', () => highlightMobileStop(stop.kod));
        ms.stopMarkers.push(marker);
    });
    if (latlngs.length > 1) {
        // Glass frame: zoom-adaptive width, CSS blur via className
        const glassWeight = () => {
            const z = ms.map.getZoom();
            return Math.min(24, Math.max(10, 6 + (z - 10) * 2));
        };

        ms.routeGlow = L.polyline(latlngs, {
            color: '#ffffff', weight: glassWeight(), opacity: 0.5,
            lineJoin: 'round', lineCap: 'round',
            className: 'glass-route-path',
        }).addTo(ms.map);

        // Update glass weight on zoom
        ms.map.on('zoomend', () => {
            if (ms.routeGlow) {
                ms.routeGlow.setStyle({ weight: glassWeight() });
            }
        });

        // Main colored route line (will be hidden if traffic loads)
        ms.routePolyline = L.polyline(latlngs, {
            color: routeColor, weight: 5, opacity: 0.9,
            lineJoin: 'round', lineCap: 'round',
        }).addTo(ms.map);

        if (L.polylineDecorator) {
            ms.routeDecorator = L.polylineDecorator(ms.routePolyline, {
                patterns: [{
                    offset: '5%', repeat: '10%', symbol: L.Symbol.arrowHead({
                        pixelSize: 8, polygon: true,
                        pathOptions: { fillOpacity: 0.8, fill: true, color: 'white', fillColor: 'white', weight: 0 },
                    })
                }],
            }).addTo(ms.map);
        }

        if (!ms._hasFit) {
            ms.map.fitBounds(ms.routePolyline.getBounds().pad(0.12));
            ms._hasFit = true;
        }

        // Load traffic overlay
        loadTrafficOverlay();
    }
}

function clearMobileMap() {
    if (!ms.map) return;
    Object.values(ms.busMarkers).forEach(m => ms.map.removeLayer(m));
    ms.busMarkers = {};
    ms.stopMarkers.forEach(m => ms.map.removeLayer(m));
    ms.stopMarkers = [];
    if (ms.routeGlow) { ms.map.removeLayer(ms.routeGlow); ms.routeGlow = null; }
    if (ms.routePolyline) { ms.map.removeLayer(ms.routePolyline); ms.routePolyline = null; }
    if (ms.routeDecorator) { ms.map.removeLayer(ms.routeDecorator); ms.routeDecorator = null; }
    clearTrafficLayers();
}

// ── Direction & Variant ─────────────────────────────────
function setMobileDir(dir) {
    ms.direction = dir;
    ms.selectedVariant = null;
    ms._hasFit = false;
    document.getElementById('mDirG').classList.toggle('active', dir === 'G');
    document.getElementById('mDirD').classList.toggle('active', dir === 'D');
    renderMobileStopsOnMap();
    renderMobileBusMarkers();
    renderMobileStopsPanel();
    renderMobileVariantSelector();
    // Re-render timetable for the new direction
    const activeChip = document.querySelector('.tt-chip.active');
    if (activeChip && ms.timetableData) renderTimetable(activeChip.dataset.day);
}

function renderMobileVariantSelector() {
    const container = document.getElementById('mVariantSelector');
    const variants = ms.busData?.varyantlar || [];
    const dirVariants = variants.filter(v => v.dir === ms.direction || v.dir === '');

    if (dirVariants.length <= 1) {
        container.style.display = 'none';
        return;
    }

    container.style.display = 'block';
    container.innerHTML = `<div class="mvariant-btns">
        <button class="mvariant-btn ${!ms.selectedVariant ? 'active' : ''}" onclick="selectMobileVariant(null)">
            Hepsi (${dirVariants.reduce((s, v) => s + v.count, 0)})
        </button>
        ${dirVariants.map(v => {
        const label = ms.variantLabelMap[v.variant] || v.label || v.variant;
        return `
            <button class="mvariant-btn ${ms.selectedVariant === v.variant ? 'active' : ''}" onclick="selectMobileVariant('${esc(v.variant)}')" title="${esc(label)}">
                ${esc(v.variant)} <span style="opacity:.7">${v.count} Araç</span>
            </button>
        `}).join('')}
    </div>`;
}

async function selectMobileVariant(variant) {
    ms.selectedVariant = variant;
    setLoading(true);
    try {
        if (variant) {
            // Fetch variant-specific stops and polyline
            const resp = await fetch(`${API}/variant-stops/${encodeURIComponent(ms.currentLine)}/${encodeURIComponent(variant)}`);
            const data = await resp.json();
            ms.routeData = {
                duraklar: { [ms.direction]: data.stops },
                routeLine: { [ms.direction]: data.polyline }
            };
        } else {
            // Revert to all (original) route data
            const resp = await fetch(`${API}/guzergah/${encodeURIComponent(ms.currentLine)}`);
            ms.routeData = await resp.json();
        }
        renderMobileStopsOnMap();
        renderMobileStopsPanel();
        renderMobileBusMarkers();
        renderMobileVariantSelector();
        setLoading(false);
    } catch (e) {
        console.error(e);
        setLoading(false);
    }
}

// ── Stops Panel ────────────────────────────────────────
function renderMobileStopsPanel() {
    const stops = ms.routeData?.duraklar?.[ms.direction] || [];
    const buses = ms.busData?.otobusler || [];
    const container = document.getElementById('mStopsList');

    if (!container) return;
    document.getElementById('detailStopCount').textContent = stops.length;

    // Find the single nearest stop for each bus (not all stops within 300m)
    const nearestStopPerBus = {};
    buses.forEach(bus => {
        if (!bus.lat || !bus.lon) return;
        let bestStop = null, bestDist = Infinity;
        stops.forEach(stop => {
            if (!stop.lat || !stop.lon) return;
            const dist = haversine(bus.lat, bus.lon, stop.lat, stop.lon);
            if (dist < 0.1 && dist < bestDist) {
                bestDist = dist;
                bestStop = stop.kod;
            }
        });
        if (bestStop) nearestStopPerBus[bestStop] = { ...bus, dist: bestDist };
    });

    container.innerHTML = stops.map((stop, idx) => {
        const isFirst = idx === 0;
        const isLast = idx === stops.length - 1;
        const hasBus = nearestStopPerBus[stop.kod];
        const dotClass = isFirst ? 'first' : isLast ? 'last' : '';

        return `<div class="m-stop-item ${hasBus ? 'has-bus' : ''}" id="mstop-${esc(stop.kod)}"
            onclick="zoomToMobileStop(${stop.lat || 0}, ${stop.lon || 0})">
            <div class="m-stop-timeline">
                <div class="m-stop-dot ${dotClass}"></div>
                ${idx < stops.length - 1 ? '<div class="m-stop-line"></div>' : ''}
            </div>
            <div class="m-stop-info">
                <div class="m-stop-name">${esc(stop.adi)}</div>
                ${hasBus ? `<div class="m-bus-here">${esc(hasBus.kapino)} yaklaşıyor</div>` : ''}
            </div>
        </div>`;
    }).join('');
}

function highlightMobileStop(kod) {
    document.querySelectorAll('.m-stop-item.highlighted').forEach(e => e.classList.remove('highlighted'));
    const el = document.getElementById(`mstop-${kod}`);
    if (el) { el.classList.add('highlighted'); el.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
}

function zoomToMobileStop(lat, lon) {
    if (lat && lon && ms.map) ms.map.setView([lat, lon], 17);
}

function updateMobileStats() {
    const buses = ms.busData?.otobusler || [];
    document.getElementById('detailBusCount').textContent = buses.length;
    document.getElementById('detailUpdateTime').textContent = new Date().toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' });
    renderMobileVariantSelector();
}

function setLoading(show) {
    const el = document.getElementById('detailLoading');
    if (el) el.style.display = show ? 'flex' : 'none';
}

// ── Nearby Stops ───────────────────────────────────────
async function loadNearbyStops(lat, lon) {
    // Show some favorite lines as "nearby" — or use bus data if we have it
    const container = document.getElementById('nearbyList');
    container.innerHTML = `<div class="empty-state">📡 Yakın duraklar aranıyor...</div>`;

    // Since we don't have a "nearby stops" IETT API endpoint, show recent favorites
    const favs = ms.favorites.slice(0, 3);
    if (favs.length === 0) {
        container.innerHTML = `<div class="empty-state">📍 Yakın durak bulunamadı. Hat aramayı deneyin.</div>`;
        return;
    }

    container.innerHTML = favs.map((f, i) => {
        const color = lineColor(f.code);
        const mins = [3, 8, 15][i];
        const status = ['Yaklaşıyor', `${(Math.random() * 2).toFixed(1)} km`, 'Zamanında'][i];
        return `<div class="nearby-card" onclick="mobileSelectLine('${esc(f.code)}','${esc(f.name)}')">
            <div class="nc-badge" style="background:${color}">${esc(f.code)}</div>
            <div class="nc-info">
                <div class="nc-title">${esc(f.name)}</div>
                <div class="nc-sub">Favori durak</div>
            </div>
            <div class="nc-time">
                <div class="nc-mins">${mins} dk</div>
                <div class="nc-status">${status}</div>
            </div>
        </div>`;
    }).join('');
}

// ── Lines Screen ───────────────────────────────────────
let linesLoaded = false;
let linesFilter = 'all';

async function loadLinesList() {
    if (linesLoaded && ms.allLines.length > 0) { renderLinesList(); return; }
    const container = document.getElementById('linesList');
    container.innerHTML = '<div class="empty-state">Hat listesi yükleniyor...</div>';

    try {
        const r = await fetch(`${API}/hatlar`);
        ms.allLines = await r.json();
        linesLoaded = true;
        renderLinesList();

        // Search handler
        document.getElementById('linesSearchInput').addEventListener('input', (e) => {
            renderLinesList(e.target.value.trim());
        });
    } catch (e) {
        container.innerHTML = '<div class="empty-state">Hat listesi yüklenemedi.</div>';
    }
}

function filterLines(filter, btn) {
    linesFilter = filter;
    document.querySelectorAll('.fchip').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    renderLinesList(document.getElementById('linesSearchInput').value.trim());
}

function renderLinesList(q = '') {
    const container = document.getElementById('linesList');
    let lines = ms.allLines;

    if (q) {
        const ql = q.toLowerCase();
        lines = lines.filter(l => (l.SHPIETT || '').toLowerCase().includes(ql) || (l.SHAT_ADI || '').toLowerCase().includes(ql));
    }

    if (linesFilter !== 'all') {
        lines = lines.filter(l => {
            const c = (l.SHPIETT || '').toUpperCase();
            if (linesFilter === 'tramvay') return c.startsWith('T');
            if (linesFilter === 'metrobus') return c.startsWith('M') || c.endsWith('BÜS');
            if (linesFilter === 'bus') return !c.startsWith('T') && !c.startsWith('M');
            return true;
        });
    }

    if (lines.length === 0) {
        container.innerHTML = '<div class="empty-state">Sonuç bulunamadı.</div>';
        return;
    }

    // Simple list, no sections for performance
    container.innerHTML = lines.slice(0, 100).map(l => {
        const code = l.SHPIETT || '';
        const name = l.SHAT_ADI || '';
        const color = lineColor(code);
        return `<div class="line-card" onclick="mobileSelectLine('${esc(code)}','${esc(name)}');switchScreen('harita')">
            <div class="lc-badge" style="background:${color}">${esc(code)}</div>
            <div class="lc-info">
                <div class="lc-name">${esc(name)}</div>
                <div class="lc-sub">${code} Hattı</div>
            </div>
            <span class="lc-arrow">›</span>
        </div>`;
    }).join('');
}

// ── QR ─────────────────────────────────────────────────
function renderRecentScans() {
    const container = document.getElementById('recentScans');
    if (ms.recentScans.length === 0) {
        container.innerHTML = '<div class="empty-state">Son tarama bulunamadı</div>';
        return;
    }
    container.innerHTML = ms.recentScans.map(s => `
        <div class="nearby-card" onclick="mobileSelectLine('${esc(s.code)}','${esc(s.name)}');switchScreen('harita')">
            <div class="nc-badge" style="background:${lineColor(s.code)}">${esc(s.code)}</div>
            <div class="nc-info">
                <div class="nc-title">${esc(s.name)}</div>
                <div class="nc-sub">${esc(s.time)}</div>
            </div>
            <span style="color:#9aa0b0;font-size:18px">›</span>
        </div>`).join('');
}

// ── Favorites ──────────────────────────────────────────
function toggleMobileFav() {
    if (!ms.currentLine) return;
    const code = ms.currentLine;
    const name = document.getElementById('detailLineName').textContent;
    const idx = ms.favorites.findIndex(f => f.code === code);

    if (idx >= 0) {
        ms.favorites.splice(idx, 1);
        document.getElementById('detailFavBtn').textContent = '☆';
        document.getElementById('detailFavBtn').style.color = '#9aa0b0';
    } else {
        ms.favorites.push({ code, name });
        document.getElementById('detailFavBtn').textContent = '★';
        document.getElementById('detailFavBtn').style.color = '#f9ab00';
    }
    localStorage.setItem('iett-fav-mobile', JSON.stringify(ms.favorites));
}

function renderFavoritesList() {
    const container = document.getElementById('favorilesList');
    if (ms.favorites.length === 0) {
        container.innerHTML = `<div class="empty-state">⭐ Henüz favori hat eklenmedi.<br><small>Bir hat seçip ☆ tuşuna bas.</small></div>`;
        return;
    }

    container.innerHTML = ms.favorites.map((f, i) => {
        const color = lineColor(f.code);
        const icons = ['🏠', '💼', '⭐', '❤️'];
        return `<div class="fav-group-card">
            <div class="fav-group-header">
                <div class="fav-group-left">
                    <div class="fav-group-icon" style="background:${color}22">${icons[i % icons.length]}</div>
                    <div>
                        <div class="fav-group-title">Favori Hat ${i + 1}</div>
                        <div class="fav-group-sub">${esc(f.code)}</div>
                    </div>
                </div>
                <button class="fav-delete-btn" onclick="removeFav('${esc(f.code)}')">✕</button>
            </div>
            <div class="fav-line-row" onclick="mobileSelectLine('${esc(f.code)}','${esc(f.name)}');switchScreen('harita')">
                <div class="flr-badge" style="background:${color}">${esc(f.code)}</div>
                <div class="flr-name">${esc(f.name)}</div>
                <div class="flr-time">
                    <div class="flr-mins">-</div>
                    <div class="flr-sub">dk</div>
                </div>
            </div>
        </div>`;
    }).join('');
}

function removeFav(code) {
    ms.favorites = ms.favorites.filter(f => f.code !== code);
    localStorage.setItem('iett-fav-mobile', JSON.stringify(ms.favorites));
    renderFavoritesList();
}

function addFavPrompt() {
    const code = prompt('Hat numarası gir (örn: 15F, 500T):');
    if (code) {
        const name = prompt('Hat adı (örn: BEYKOZ - KADIKÖY):') || code;
        ms.favorites.push({ code: code.toUpperCase(), name });
        localStorage.setItem('iett-fav-mobile', JSON.stringify(ms.favorites));
        renderFavoritesList();
    }
}

// ── Stop Selection & Detail ────────────────────────────
async function mobileSelectStop(kod, adi, yon = '') {
    mapSearchResults.style.display = 'none';
    if (mapSearchInput) mapSearchInput.value = adi;
    if (ms.currentScreen !== 'harita') switchScreen('harita');

    ms.currentStop = { kod, adi };
    ms.currentLine = null;

    // Show stop detail panel
    document.getElementById('nearbyPanel').style.display = 'none';
    document.getElementById('lineDetailPanel').style.display = 'none';
    document.getElementById('stopDetailPanel').style.display = 'block';
    document.getElementById('stopDetailName').textContent = adi;
    const yonHtml = yon ? ` &middot; Yön: <span style="color:#6366f1">${esc(yon)}</span>` : '';
    document.getElementById('stopDetailCode').innerHTML = `#${kod}${yonHtml}`;
    document.getElementById('stopEtaList').innerHTML = '<div class="loading-row"><div class="spinner"></div><span>Gelen otobüsler yükleniyor...</span></div>';
    expandSheet('half');

    // Place marker on stop location
    clearMobileMap();

    try {
        const resp = await fetch(`${API}/durak-detay/${encodeURIComponent(kod)}`);
        const data = await resp.json();
        if (data.error) {
            document.getElementById('stopEtaList').innerHTML = `<div class="empty-state">❌ ${data.error}</div>`;
            return;
        }

        // Place stop marker on map
        ms.currentStop = data.durak;
        if (ms.currentStop && ms.currentStop.lat && ms.currentStop.lon) {
            const icon = L.divIcon({
                html: `<div style="position:relative"><div style="width:24px;height:24px;border-radius:50%;background:#6366f1;border:3px solid white;box-shadow:0 2px 12px rgba(99,102,241,0.6)"></div><div style="position:absolute;left:30px;top:-2px;background:#6366f1;color:white;font-size:12px;font-weight:700;font-family:'Plus Jakarta Sans',sans-serif;padding:3px 10px;border-radius:6px;white-space:nowrap;box-shadow:0 2px 8px rgba(0,0,0,0.2)">${esc(adi)}</div></div>`,
                className: '', iconSize: [24, 24], iconAnchor: [12, 12],
            });
            const marker = L.marker([ms.currentStop.lat, ms.currentStop.lon], { icon, zIndexOffset: 900 }).addTo(ms.map);
            ms.stopMarkers.push(marker);
            ms.map.setView([ms.currentStop.lat, ms.currentStop.lon], 15);
        }

        renderStopDetail(data);
        startMobileRefresh(); // Ensure background refresh is running for live ETAs
    } catch (e) {
        console.error('Stop detail error:', e);
        document.getElementById('stopEtaList').innerHTML = '<div class="empty-state">⚠️ Veri alınamadı</div>';
    }
}

function renderStopDetail(data) {
    const list = document.getElementById('stopEtaList');
    const gelenler = data.gelenler || [];

    if (gelenler.length === 0) {
        list.innerHTML = `<div class="empty-state">Şu an bu durağa yaklaşan otobüs bulunamadı.<br><small>Kontrol edilen hat: ${data.kontrol_edilen_hat || 0}</small></div>`;
        return;
    }

    list.innerHTML = gelenler.map((g, idx) => {
        const etaColor = g.eta_dk <= 5 ? '#22c55e' : g.eta_dk <= 15 ? '#f59e0b' : '#94a3b8';
        const etaText = g.eta_dk <= 1 ? 'Yaklaşıyor' : `${g.eta_dk} dk`;

        // Simplify direction text (e.g. "X PERONLAR => Y" -> "Y")
        let displayYon = g.hedef ? g.hedef : g.yon;
        if (displayYon && displayYon.includes('=>')) {
            displayYon = displayYon.split('=>')[1].trim();
        }

        return `<div class="nearby-card glass-card" id="eta-card-${idx}" onclick="selectIncomingBus('${esc(g.hat)}', '${esc(g.kapino)}', '${esc(g.yon)}', this)">
            <div class="nc-badge" style="color:${lineColor(g.hat)}">${esc(g.hat)}</div>
            <div class="nc-info">
                <div class="nc-title" style="display:flex; align-items:center; gap:6px;">
                    <span>${esc(g.kapino)}</span>
                    <span class="nc-yon-badge">${esc(displayYon)}</span>
                </div>
                <div class="nc-sub">${g.mesafe_km} km mesafe</div>
            </div>
            <div class="nc-time">
                <div class="nc-mins" style="color:${etaColor}">${etaText}</div>
                <div class="nc-status">tahmini</div>
            </div>
        </div>`;
    }).join('');
}

function closeStopDetail() {
    ms.currentStop = null;
    ms._hasFit = false;
    ms._hasActiveTargetBus = false;
    if (!ms.currentLine) stopMobileRefresh();
    clearMobileMap();
    document.getElementById('stopDetailPanel').style.display = 'none';
    document.getElementById('nearbyPanel').style.display = 'block';
    if (mapSearchInput) mapSearchInput.value = '';
    setSheetSnap('peek');
}

async function selectIncomingBus(lineCode, busKapiNo, directionStr, cardEl) {
    if (ms.refreshTimer) clearInterval(ms.refreshTimer);

    // Visual selection state
    if (cardEl) {
        document.querySelectorAll('#stopEtaList .nearby-card').forEach(c => {
            c.style.border = 'none';
            c.style.background = 'rgba(255,255,255,0.7)';
        });
        cardEl.style.border = '2px solid #6366f1';
        cardEl.style.background = 'rgba(99,102,241,0.05)';
    }

    // Filter bus markers to just this specific bus
    ms.currentLine = lineCode;
    ms.direction = directionStr.includes('KADIK') ? 'D' : 'G'; // heuristic fallback, will be overwritten by live data

    const loadBusRouteAndLocation = async () => {
        try {
            // 1) Load the route geometry
            const routeResp = await fetch(`${API}/guzergah/${encodeURIComponent(lineCode)}`);
            const routeData = await routeResp.json();
            ms.routeData = routeData;

            // 2) Load bus live locations
            const busResp = await fetch(`${API}/otobus-konum/${encodeURIComponent(lineCode)}`);
            const busData = await busResp.json();

            // Find the specific bus we clicked to determine exactly its direction
            const targetBus = (busData.otobusler || busData).find(b =>
                (b.kapino && b.kapino === busKapiNo) ||
                (b.kapiNo && b.kapiNo === busKapiNo) ||
                (b.vehicleDoorCode && b.vehicleDoorCode === busKapiNo)
            );
            console.log('API returned buses:', (busData.otobusler || busData).map(b => b.kapino || b.kapiNo || b.vehicleDoorCode));
            console.log('Searching for target kapino:', busKapiNo, 'Found target bus:', targetBus);

            if (targetBus) {
                if (targetBus.dir) ms.direction = targetBus.dir;
                else if (targetBus.guzergah && targetBus.guzergah.includes('_D_')) ms.direction = 'D';
                else ms.direction = 'G';
            }

            // Trick map rendering: we only want THIS bus to be shown
            // standardizing the bus object for renderMobileBusMarkers
            if (targetBus && !targetBus.kapino) {
                targetBus.kapino = targetBus.kapiNo || targetBus.vehicleDoorCode || busKapiNo;
            }
            if (targetBus && !targetBus.lon) targetBus.lon = targetBus.longitude || 0;
            if (targetBus && !targetBus.lat) targetBus.lat = targetBus.latitude || 0;

            ms.busData = { otobusler: targetBus ? [targetBus] : [] };

            // Render
            renderMobileStopsOnMap(); // draws route and stops for current direction
            renderMobileBusMarkers(); // draws just the isolated bus

            // Re-draw the main highlighted stop marker so it stands out
            if (ms.currentStop && ms.currentStop.lat && ms.currentStop.lon) {
                const icon = L.divIcon({
                    html: `<div style="position:relative"><div style="width:24px;height:24px;border-radius:50%;background:#6366f1;border:3px solid white;box-shadow:0 2px 12px rgba(99,102,241,0.6)"></div><div style="position:absolute;left:30px;top:-2px;background:#6366f1;color:white;font-size:12px;font-weight:700;font-family:'Plus Jakarta Sans',sans-serif;padding:3px 10px;border-radius:6px;white-space:nowrap;box-shadow:0 2px 8px rgba(0,0,0,0.2)">${esc(ms.currentStop.adi)}</div></div>`,
                    className: '', iconSize: [24, 24], iconAnchor: [12, 12],
                });
                const mainMarker = L.marker([ms.currentStop.lat, ms.currentStop.lon], { icon, zIndexOffset: 900 }).addTo(ms.map);
                ms.stopMarkers.push(mainMarker);
            }

            // Adjust view to show both the bus and the stop - ONLY ONCE
            if (!ms._hasActiveTargetBus) {
                if (targetBus && targetBus.lat && targetBus.lon && ms.currentStop && ms.currentStop.lat) {
                    const bounds = L.latLngBounds(
                        [targetBus.lat, targetBus.lon],
                        [ms.currentStop.lat, ms.currentStop.lon]
                    );
                    ms.map.fitBounds(bounds, { padding: [50, 50], maxZoom: 16 });
                } else if (targetBus && targetBus.lat && targetBus.lon) {
                    ms.map.setView([targetBus.lat, targetBus.lon], 16);
                }
                ms._hasActiveTargetBus = true; // Mark as fitted
            }

            // Set sheet to half to show the map easily without losing the list
            setSheetSnap('half');

        } catch (e) {
            console.error('Error auto-loading incoming bus:', e);
        }
    };

    ms._hasActiveTargetBus = false; // Reset flag so it fits bounds on first load
    await loadBusRouteAndLocation();
    ms.refreshTimer = setInterval(loadBusRouteAndLocation, REFRESH_MS);
}

// ── Traffic Overlay ────────────────────────────────────
function clearTrafficLayers() {
    if (!ms.map) return;
    ms.trafficLayers.forEach(l => ms.map.removeLayer(l));
    ms.trafficLayers = [];
}

async function loadTrafficOverlay() {
    if (!ms.currentLine || !ms.direction || !ms.map) return;
    try {
        const resp = await fetch(`${API}/osrm-traffic/${encodeURIComponent(ms.currentLine)}/${ms.direction}`);
        const data = await resp.json();
        if (!data.segments || data.segments.length === 0) return;

        // Create colored segments based on traffic data
        data.segments.forEach(seg => {
            const line = L.polyline([seg.from, seg.to], {
                color: seg.color,
                weight: 6,
                opacity: 1,
                lineJoin: 'round',
                lineCap: 'round',
                className: 'osrm-traffic-segment',
            }).addTo(ms.map);
            ms.trafficLayers.push(line);
        });

        // Hide the original solid polyline since we draw colored segments
        if (ms.routePolyline) {
            ms.routePolyline.setStyle({ opacity: 0 });
        }
    } catch (e) {
        console.error('Traffic overlay err:', e);
    }
}

// ── Bottom Sheet Drag System ───────────────────────────
const SNAP_PEEK = 130;       // just the handle + title visible (above nav bar)
const SNAP_HALF_PCT = 0.45;  // 45% of viewport
const SNAP_FULL_PCT = 0.88;  // 88% of viewport

let sheetEl, sheetBody, sheetHandleArea;
let sheetState = 'peek'; // peek | half | full
let dragStartY = 0, dragStartTranslate = 0, isDragging = false;
let lastMoveTime = 0, lastMoveY = 0, velocity = 0;

function getSheetHeight() { return sheetEl ? sheetEl.offsetHeight : window.innerHeight * SNAP_FULL_PCT; }

function snapValuePx(snap) {
    const h = getSheetHeight();
    switch (snap) {
        case 'peek': return h - SNAP_PEEK;
        case 'half': return h - (window.innerHeight * SNAP_HALF_PCT);
        case 'full': return h - (window.innerHeight * SNAP_FULL_PCT);
        default: return h - SNAP_PEEK;
    }
}

function setSheetSnap(snap, animate = true) {
    if (!sheetEl) return;
    sheetState = snap;
    const ty = snapValuePx(snap);
    if (animate) {
        sheetEl.classList.remove('dragging');
    }
    sheetEl.style.transform = `translateY(${ty}px)`;
    // Always allow scrolling
    if (sheetBody) {
        sheetBody.style.overflowY = 'auto';
    }
}

function initBottomSheet() {
    sheetEl = document.getElementById('bottomSheet');
    sheetBody = document.getElementById('sheetBody');
    sheetHandleArea = document.getElementById('sheetHandleArea');
    if (!sheetEl || !sheetHandleArea) return;

    // Initial snap to peek
    setSheetSnap('peek', false);

    // Touch events on handle area
    sheetHandleArea.addEventListener('touchstart', onSheetTouchStart, { passive: true });
    sheetHandleArea.addEventListener('touchmove', onSheetTouchMove, { passive: false });
    sheetHandleArea.addEventListener('touchend', onSheetTouchEnd, { passive: true });

    // Mouse events for desktop browser testing
    sheetHandleArea.addEventListener('mousedown', onSheetMouseDown);
    document.addEventListener('mousemove', onSheetMouseMove);
    document.addEventListener('mouseup', onSheetMouseUp);

    // Also allow dragging from sheet header
    sheetEl.querySelectorAll('.sheet-header').forEach(hdr => {
        hdr.addEventListener('touchstart', onSheetTouchStart, { passive: true });
        hdr.addEventListener('touchmove', onSheetTouchMove, { passive: false });
        hdr.addEventListener('touchend', onSheetTouchEnd, { passive: true });
    });

    // Enable scrolling gracefully
    if (sheetBody) {
        // We removed the aggressive e.preventDefault() that was blocking all scrolling
        // when sheetState !== 'full'. Now users can scroll lists inside the half sheet too.

        // If user scrolls to top of sheet-body and pulls down, collapse sheet
        sheetBody.addEventListener('touchstart', (e) => {
            if (sheetBody.scrollTop <= 0) {
                // Allow drag-to-collapse from scrolled-to-top state
                dragStartY = e.touches[0].clientY;
                dragStartTranslate = getCurrentTranslateY();
                isDragging = false; // will set true if they drag down enough
            }
        }, { passive: true });

        sheetBody.addEventListener('touchmove', (e) => {
            if (sheetBody.scrollTop <= 0) {
                const dy = e.touches[0].clientY - dragStartY;
                if (dy > 10) {
                    // User is pulling down from top → enter drag mode
                    isDragging = true;
                    sheetEl.classList.add('dragging');
                    const newY = dragStartTranslate + dy;
                    const minY = snapValuePx('full');
                    const maxY = snapValuePx('peek');
                    sheetEl.style.transform = `translateY(${Math.max(minY, Math.min(maxY, newY))}px)`;
                    e.preventDefault();
                }
            }
        }, { passive: false });

        sheetBody.addEventListener('touchend', () => {
            if (isDragging) {
                isDragging = false;
                snapToNearest();
            }
        }, { passive: true });
    }
}

function onSheetTouchStart(e) {
    const touch = e.touches[0];
    dragStartY = touch.clientY;
    dragStartTranslate = getCurrentTranslateY();
    isDragging = true;
    lastMoveY = touch.clientY;
    lastMoveTime = Date.now();
    velocity = 0;
    sheetEl.classList.add('dragging');
}

function onSheetTouchMove(e) {
    if (!isDragging) return;
    e.preventDefault();
    const touch = e.touches[0];
    const dy = touch.clientY - dragStartY;
    const newY = dragStartTranslate + dy;
    const minY = snapValuePx('full');
    const maxY = snapValuePx('peek') + 30; // allow slight overshoot
    sheetEl.style.transform = `translateY(${Math.max(minY, Math.min(maxY, newY))}px)`;

    // Track velocity
    const now = Date.now();
    const dt = now - lastMoveTime;
    if (dt > 0) {
        velocity = (touch.clientY - lastMoveY) / dt; // px/ms, positive = downward
    }
    lastMoveY = touch.clientY;
    lastMoveTime = now;
}

function onSheetTouchEnd() {
    if (!isDragging) return;
    isDragging = false;
    snapToNearest();
}

function getCurrentTranslateY() {
    if (!sheetEl) return 0;
    const st = window.getComputedStyle(sheetEl);
    const matrix = new DOMMatrix(st.transform);
    return matrix.m42;
}

function snapToNearest() {
    const currentY = getCurrentTranslateY();
    const peekY = snapValuePx('peek');
    const halfY = snapValuePx('half');
    const fullY = snapValuePx('full');

    // Velocity-based fling: if fast enough, go in that direction
    const FLING_THRESHOLD = 0.5; // px/ms
    if (Math.abs(velocity) > FLING_THRESHOLD) {
        if (velocity > 0) {
            // Fling down
            if (sheetState === 'full') { setSheetSnap('half'); return; }
            setSheetSnap('peek'); return;
        } else {
            // Fling up
            if (sheetState === 'peek') { setSheetSnap('half'); return; }
            setSheetSnap('full'); return;
        }
    }

    // Otherwise snap to nearest
    const dPeek = Math.abs(currentY - peekY);
    const dHalf = Math.abs(currentY - halfY);
    const dFull = Math.abs(currentY - fullY);
    const min = Math.min(dPeek, dHalf, dFull);

    if (min === dPeek) setSheetSnap('peek');
    else if (min === dHalf) setSheetSnap('half');
    else setSheetSnap('full');
}

// Expose for use when selecting a line
function expandSheet(snap = 'half') {
    setSheetSnap(snap);
}

// Mouse drag handlers (for desktop browser testing)
let isMouseDragging = false;

function onSheetMouseDown(e) {
    isMouseDragging = true;
    dragStartY = e.clientY;
    dragStartTranslate = getCurrentTranslateY();
    lastMoveY = e.clientY;
    lastMoveTime = Date.now();
    velocity = 0;
    sheetEl.classList.add('dragging');
    e.preventDefault();
}

function onSheetMouseMove(e) {
    if (!isMouseDragging) return;
    const dy = e.clientY - dragStartY;
    const newY = dragStartTranslate + dy;
    const minY = snapValuePx('full');
    const maxY = snapValuePx('peek') + 30;
    sheetEl.style.transform = `translateY(${Math.max(minY, Math.min(maxY, newY))}px)`;
    const now = Date.now();
    const dt = now - lastMoveTime;
    if (dt > 0) velocity = (e.clientY - lastMoveY) / dt;
    lastMoveY = e.clientY;
    lastMoveTime = now;
}

function onSheetMouseUp() {
    if (!isMouseDragging) return;
    isMouseDragging = false;
    snapToNearest();
}

document.addEventListener('DOMContentLoaded', () => {
    initSearch();
    initBottomSheet();
    switchScreen('harita');
});
