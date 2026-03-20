/**
 * Mygration Viewer - Full-screen Leaflet map with auto-rotating zoom levels.
 * Polls for content updates every 5 minutes.
 */
(function() {
    'use strict';

    const POLL_INTERVAL = 5 * 60 * 1000;
    const API_BASE = '/api/mygration';
    const TILE_URLS = {
        street: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
        dark: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
        satellite: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
        voyager: 'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png'
    };

    const state = {
        token: null, isDemo: false, map: null, tileLayer: null, markerLayer: null,
        content: null, contentHash: null,
        views: [], viewIndex: 0, rotationTimer: null, pollTimer: null
    };

    function init() {
        const params = new URLSearchParams(window.location.search);
        state.token = params.get('t');
        state.isDemo = (state.token === 'demo');
        if (!state.token) { showError('No display token provided. Use a valid viewer link.'); return; }

        state.map = L.map('map', { center: [39, -98.5], zoom: 4, zoomControl: false, attributionControl: false, fadeAnimation: true, zoomAnimation: true });
        state.markerLayer = L.layerGroup().addTo(state.map);
        state.map.on('moveend zoomend', function() { updateVisibleCounts(); });
        fetchContent();
        state.pollTimer = setInterval(fetchContent, POLL_INTERVAL);
    }

    async function fetchContent() {
        try {
            // Demo mode uses the public demo endpoint
            const url = state.isDemo
                ? API_BASE + '/demo/sightings'
                : API_BASE + '/viewer/' + state.token + '/content';
            const res = await fetch(url);
            if (!res.ok) { if (res.status === 404) showError('Invalid display token.'); return; }
            const data = await res.json();
            if (!data.success) return;

            // Demo mode: transform demo response into viewer format
            if (state.isDemo && !data.preferences) {
                data.preferences = {
                    location_lat: 39.75, location_lng: -105.0, location_label: 'Denver, CO',
                    map_format: 'dark', rotation_interval_sec: 12, rare_birds_enabled: false,
                    primary_group_key: 'hummingbirds'
                };
                data.species_info = {
                    group_name: 'Hummingbirds', dot_color: '#10b981',
                    species: data.species || []
                };
                data.rare_sightings = [];
            }

            const hash = (data.sightings?.length || 0) + ':' + (data.preferences?.primary_group_key || '');
            if (hash === state.contentHash) return;
            state.contentHash = hash;
            state.content = data;
            applyContent();
        } catch (err) { console.error('Fetch error:', err); }
    }

    function applyContent() {
        const { preferences, sightings, species_info, rare_sightings } = state.content;

        // If no sightings, show a message instead of blank map
        if ((!sightings || sightings.length === 0) && (!rare_sightings || rare_sightings.length === 0)) {
            showError('No sightings available yet for ' + (species_info?.group_name || 'this species group') + '. Data updates automatically \u2014 check back soon.');
            return;
        }

        document.getElementById('loadingScreen').classList.add('hidden');

        // Tile layer
        const tileUrl = TILE_URLS[preferences.map_format] || TILE_URLS.dark;
        if (state.tileLayer) state.map.removeLayer(state.tileLayer);
        state.tileLayer = L.tileLayer(tileUrl, { maxZoom: 18, subdomains: 'abcd' }).addTo(state.map);
        // Redraw tiles after delay to catch failures before SW was ready
        setTimeout(function() { if (state.tileLayer) state.tileLayer.redraw(); }, 5000);
        setTimeout(function() { if (state.tileLayer) state.tileLayer.redraw(); }, 15000);

        plotSightings(sightings, species_info);
        buildLegend(species_info, sightings);
        document.getElementById('viewTitle').textContent = (species_info?.group_name || 'Bird') + ' Migration';
        const lgName = document.getElementById('legendGroupName');
        if (lgName) lgName.textContent = species_info?.group_name || 'Species';

        // Data timestamp
        const dtEl = document.getElementById('dataTime');
        if (dtEl) {
            const now = new Date();
            dtEl.textContent = 'Data as of ' + now.toLocaleDateString() + ' ' + now.toLocaleTimeString();
        }

        // Build views
        const lat = preferences.location_lat || 39.74, lng = preferences.location_lng || -104.99;
        state.views = [
            { name: 'North America', center: [45, -98], zoom: 3 },
            { name: 'United States', center: [39, -98], zoom: 5 },
            { name: 'Regional', center: [lat, lng], zoom: 7 },
            { name: 'Local', center: [lat, lng], zoom: 10 }
        ];
        if (preferences.rare_birds_enabled && rare_sightings?.length) {
            rare_sightings.slice(0, 8).forEach(rs => {
                state.views.push({ name: 'Rare: ' + rs.common_name, center: [rs.lat, rs.lng], zoom: 12, rare: rs });
            });
        }

        stopRotation();
        state.viewIndex = 0;
        showView(0);
        scheduleNextView(preferences.rotation_interval_sec || 15);
    }

    // Scale dot size based on zoom level
    function dotRadius() {
        const z = state.map ? state.map.getZoom() : 4;
        if (z <= 3) return 2;
        if (z <= 5) return 3;
        if (z <= 7) return 4;
        if (z <= 9) return 5;
        return 6;
    }

    function plotSightings(sightings, speciesInfo) {
        state.markerLayer.clearLayers();
        if (!sightings?.length) return;
        state.allSightings = sightings;
        state.speciesInfo = speciesInfo;
        const colorMap = {};
        if (speciesInfo?.species) speciesInfo.species.forEach(sp => { colorMap[sp.code] = sp.color; });
        const defaultColor = speciesInfo?.dot_color || '#3b82f6';
        const r = dotRadius();
        sightings.forEach(s => {
            L.circleMarker([s.la, s.ln], { radius: r, fillColor: colorMap[s.sc] || defaultColor, fillOpacity: 0.8, color: colorMap[s.sc] || defaultColor, weight: 0, interactive: false }).addTo(state.markerLayer);
        });
    }

    // Update legend counts based on what's visible in the current map bounds
    function updateVisibleCounts() {
        if (!state.allSightings || !state.speciesInfo) return;
        const bounds = state.map.getBounds();
        const counts = {};
        state.allSightings.forEach(s => {
            if (bounds.contains([s.la, s.ln])) {
                counts[s.sc] = (counts[s.sc] || 0) + 1;
            }
        });
        document.querySelectorAll('.legend-count').forEach(el => {
            const code = el.dataset.code;
            if (code) el.textContent = (counts[code] || 0).toLocaleString();
        });
    }

    function buildLegend(speciesInfo, sightings) {
        const container = document.getElementById('legendItems');
        if (!speciesInfo?.species) { container.innerHTML = ''; return; }
        const counts = {};
        (sightings || []).forEach(s => { counts[s.sc] = (counts[s.sc] || 0) + 1; });
        container.innerHTML = speciesInfo.species.map(sp =>
            '<div class="legend-item"><span class="legend-dot" style="background:' + sp.color + '"></span><span>' + sp.name + '</span><span class="legend-count" data-code="' + sp.code + '">' + (counts[sp.code] || 0) + '</span></div>'
        ).join('');
    }

    function showView(index) {
        if (index >= state.views.length) index = 0;
        state.viewIndex = index;
        const view = state.views[index];
        document.getElementById('viewBadge').textContent = view.name;
        state.map.flyTo(view.center, view.zoom, { duration: 2, easeLinearity: 0.25 });
        if (view.rare) showRareAlert(view.rare); else hideRareAlert();
    }

    function scheduleNextView(seconds) {
        const bar = document.getElementById('progressBar');
        bar.style.transition = 'none'; bar.style.width = '0';
        requestAnimationFrame(() => { requestAnimationFrame(() => { bar.style.transition = 'width ' + seconds + 's linear'; bar.style.width = '100%'; }); });
        state.rotationTimer = setTimeout(() => {
            showView((state.viewIndex + 1) % state.views.length);
            scheduleNextView(seconds);
        }, seconds * 1000);
    }

    function stopRotation() { clearTimeout(state.rotationTimer); document.getElementById('progressBar').style.cssText = 'width:0;transition:none'; }

    function showRareAlert(rare) {
        document.getElementById('rareAlertName').textContent = rare.common_name;
        document.getElementById('rareAlertLocation').textContent = (rare.location_name || '') + (rare.observation_date ? ' (' + rare.observation_date + ')' : '');
        document.getElementById('rareAlert').classList.add('show');
    }
    function hideRareAlert() { document.getElementById('rareAlert').classList.remove('show'); }

    function showError(msg) {
        const el = document.getElementById('loadingScreen');
        el.querySelector('.loading-spinner').style.display = 'none';
        el.querySelector('.loading-text').textContent = msg;
    }

    // Keyboard controls
    document.addEventListener('keydown', e => {
        const sec = state.content?.preferences?.rotation_interval_sec || 15;
        if (e.key === 'ArrowRight' || e.key === ' ') { e.preventDefault(); stopRotation(); showView((state.viewIndex + 1) % state.views.length); scheduleNextView(sec); }
        else if (e.key === 'ArrowLeft') { e.preventDefault(); stopRotation(); showView((state.viewIndex - 1 + state.views.length) % state.views.length); scheduleNextView(sec); }
    });

    // Touch swipe
    let touchStartX = 0;
    document.addEventListener('touchstart', e => { touchStartX = e.touches[0].clientX; }, { passive: true });
    document.addEventListener('touchend', e => {
        const diff = e.changedTouches[0].clientX - touchStartX;
        if (Math.abs(diff) < 50) return;
        const sec = state.content?.preferences?.rotation_interval_sec || 15;
        stopRotation();
        showView(diff < 0 ? (state.viewIndex + 1) % state.views.length : (state.viewIndex - 1 + state.views.length) % state.views.length);
        scheduleNextView(sec);
    }, { passive: true });

    // Register tile-caching service worker
    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('/sw.js').catch(function() {});
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
