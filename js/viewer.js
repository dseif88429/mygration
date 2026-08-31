/**
 * Mygration Viewer - Full-screen Leaflet map with auto-rotating zoom levels.
 * Polls for content updates every 5 minutes.
 * Uses density-aware rendering: grid-based spatial decimation at low zoom,
 * full detail at high zoom. Legend always shows real sighting counts.
 */
(function() {
    'use strict';

    var POLL_INTERVAL = 5 * 60 * 1000;
    var API_BASE = '/api/mygration';
    // street/dark are CARTO VECTOR (MapLibre GL); satellite is Esri RASTER, so
    // each basemap has to be built as the right kind of Leaflet layer.
    var TILE_URLS = {
        street: { type: 'vector', style: 'https://basemaps.cartocdn.com/gl/voyager-gl-style/style.json?key=cb1_2np3_1_ea0bf568fe59eb853dc1e926' },
        dark: { type: 'vector', style: 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json?key=cb1_2np3_1_ea0bf568fe59eb853dc1e926' },
        satellite: { type: 'raster', url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}' }
    };

    function makeBasemap(fmt) {
        var t = TILE_URLS[fmt] || TILE_URLS.dark;
        return t.type === 'vector'
            ? L.maplibreGL({ style: t.style })
            : L.tileLayer(t.url, { maxZoom: 18 });
    }

    // Grid size in degrees per zoom level - controls dot density
    // Lower zoom = larger grid cells = more aggressive thinning
    var GRID_SIZE_BY_ZOOM = {
        1: 8, 2: 6, 3: 4, 4: 3, 5: 2, 6: 1, 7: 0.5, 8: 0.25,
        9: 0.12, 10: 0.06, 11: 0.03, 12: 0.015, 13: 0.008,
        14: 0.004, 15: 0.002, 16: 0.001, 17: 0.0005, 18: 0.00025
    };

    var state = {
        token: null, isDemo: false, map: null, tileLayer: null, markerLayer: null,
        content: null, contentHash: null,
        allSightings: null, speciesInfo: null, speciesCounts: null, colorMap: {},
        views: [], viewIndex: 0, rotationTimer: null, pollTimer: null,
        _renderDebounce: null
    };

    function init() {
        var params = new URLSearchParams(window.location.search);
        state.token = params.get('t');
        state.isDemo = (state.token === 'demo');
        state.forceFresh = !!params.get('fresh');
        if (!state.token) { showError('No display token provided. Use a valid viewer link.'); return; }

        state.map = L.map('map', { center: [39, -98.5], zoom: 4, zoomControl: false, attributionControl: false, fadeAnimation: true, zoomAnimation: true });
        state.markerLayer = L.layerGroup().addTo(state.map);

        // Re-render dots on zoom/pan with debounce to avoid thrashing during flyTo
        state.map.on('moveend zoomend', function() {
            if (state._renderDebounce) clearTimeout(state._renderDebounce);
            state._renderDebounce = setTimeout(function() {
                renderVisibleDots();
                updateVisibleCounts();
            }, 150);
        });

        fetchContent();
        state.pollTimer = setInterval(fetchContent, POLL_INTERVAL);
    }

    async function fetchContent() {
        try {
            var url = state.isDemo
                ? API_BASE + '/demo/sightings'
                : API_BASE + '/viewer/' + state.token + '/content';
            var res = await fetch(url);
            if (!res.ok) { if (res.status === 404) showError('Invalid display token.'); return; }
            var data = await res.json();
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

            var hash = (data.sightings?.length || 0) + ':' + (data.preferences?.primary_group_key || '');
            if (hash === state.contentHash && !state.forceFresh) return;
            state.forceFresh = false;
            state.contentHash = hash;
            state.content = data;
            applyContent();
        } catch (err) { console.error('Fetch error:', err); }
    }

    function applyContent() {
        var preferences = state.content.preferences;
        var sightings = state.content.sightings;
        var species_info = state.content.species_info;
        var species_counts = state.content.species_counts;
        var rare_sightings = state.content.rare_sightings;

        if ((!sightings || sightings.length === 0) && (!rare_sightings || rare_sightings.length === 0)) {
            showError('No sightings available yet for ' + (species_info?.group_name || 'this species group') + '. Data updates automatically \u2014 check back soon.');
            return;
        }

        document.getElementById('loadingScreen').classList.add('hidden');

        // Tile layer
        if (state.tileLayer) state.map.removeLayer(state.tileLayer);
        state.tileLayer = makeBasemap(preferences.map_format).addTo(state.map);

        // Store data for density rendering
        state.allSightings = sightings;
        state.speciesInfo = species_info;
        state.speciesCounts = species_counts || {};
        state.colorMap = {};
        if (species_info?.species) species_info.species.forEach(function(sp) { state.colorMap[sp.code] = sp.color; });

        // Initial render + legend
        renderVisibleDots();
        buildLegend(species_info);

        document.getElementById('viewTitle').textContent = (species_info?.group_name || 'Bird') + ' Sightings';
        var lgName = document.getElementById('legendGroupName');
        if (lgName) lgName.textContent = species_info?.group_name || 'Species';

        // Data timestamp
        var dtEl = document.getElementById('dataTime');
        if (dtEl) {
            var now = new Date();
            dtEl.textContent = 'Data as of ' + now.toLocaleDateString() + ' ' + now.toLocaleTimeString();
        }

        // Big sighting counter shows REAL total (not dot count)
        var counterEl = document.getElementById('counterNum');
        if (counterEl) {
            var total = 0;
            for (var k in state.speciesCounts) total += state.speciesCounts[k];
            if (total === 0) total = sightings?.length || 0;
            counterEl.textContent = total.toLocaleString();
        }

        // Build views
        var lat = preferences.location_lat || 39.74;
        var lng = preferences.location_lng || -104.99;
        state.views = [
            { name: 'North America', center: [45, -98], zoom: 3 },
            { name: 'United States', center: [39, -98], zoom: 5 },
            { name: 'Regional', center: [lat, lng], zoom: 7 },
            { name: 'Local', center: [lat, lng], zoom: 10 }
        ];
        if (preferences.rare_birds_enabled && rare_sightings?.length) {
            rare_sightings.slice(0, 4).forEach(function(rs) {
                state.views.push({ name: 'Rare: ' + rs.common_name, center: [rs.lat, rs.lng], zoom: 12, rare: rs });
            });
        }

        stopRotation();
        state.viewIndex = 0;
        buildViewDots();
        showView(0);
        scheduleNextView(preferences.rotation_interval_sec || 15);
    }

    // Scale dot size based on zoom level
    function dotRadius(isRare) {
        if (isRare) return 20;
        var z = state.map ? state.map.getZoom() : 4;
        if (z <= 3) return 2;
        if (z <= 5) return 3;
        if (z <= 7) return 4;
        if (z <= 9) return 5;
        return 6;
    }

    // Grid size for spatial decimation at current zoom
    function getGridSize() {
        var z = state.map ? Math.round(state.map.getZoom()) : 4;
        if (z < 1) z = 1;
        if (z > 18) z = 18;
        return GRID_SIZE_BY_ZOOM[z] || 0.001;
    }

    // Density-aware rendering: only plot one dot per species per grid cell
    // within the visible viewport. Re-called on zoom/pan.
    function renderVisibleDots() {
        state.markerLayer.clearLayers();
        if (!state.allSightings?.length) return;

        var bounds = state.map.getBounds();
        var gridSize = getGridSize();
        var r = dotRadius();
        var defaultColor = state.speciesInfo?.dot_color || '#3b82f6';
        var occupied = {};  // "species_gridX_gridY" => true

        // Expand bounds slightly to avoid dots popping in at edges
        var padLat = gridSize * 2;
        var padLng = gridSize * 2;
        var south = bounds.getSouth() - padLat;
        var north = bounds.getNorth() + padLat;
        var west = bounds.getWest() - padLng;
        var east = bounds.getEast() + padLng;

        for (var i = 0; i < state.allSightings.length; i++) {
            var s = state.allSightings[i];
            // Viewport filter
            if (s.la < south || s.la > north || s.ln < west || s.ln > east) continue;

            // Grid cell dedup - one dot per species per cell
            var gx = Math.floor(s.ln / gridSize);
            var gy = Math.floor(s.la / gridSize);
            var cellKey = s.sc + '_' + gx + '_' + gy;
            if (occupied[cellKey]) continue;
            occupied[cellKey] = true;

            L.circleMarker([s.la, s.ln], {
                radius: r,
                fillColor: state.colorMap[s.sc] || defaultColor,
                fillOpacity: 0.8,
                color: state.colorMap[s.sc] || defaultColor,
                weight: 0,
                interactive: false
            }).addTo(state.markerLayer);
        }
    }

    // Update legend counts - show viewport-visible REAL counts (not deduplicated dots)
    function updateVisibleCounts() {
        if (!state.allSightings || !state.speciesInfo) return;
        var bounds = state.map.getBounds();
        var counts = {};
        state.allSightings.forEach(function(s) {
            if (bounds.contains([s.la, s.ln])) {
                counts[s.sc] = (counts[s.sc] || 0) + 1;
            }
        });
        document.querySelectorAll('.legend-count').forEach(function(el) {
            var code = el.dataset.code;
            if (code) el.textContent = (counts[code] || 0).toLocaleString();
        });

        // Update big counter to show viewport total
        var counterEl = document.getElementById('counterNum');
        if (counterEl) {
            var total = 0;
            for (var k in counts) total += counts[k];
            counterEl.textContent = total.toLocaleString();
        }
    }

    // Build legend with real species counts (from server, not dot counts)
    function buildLegend(speciesInfo) {
        var container = document.getElementById('legendItems');
        if (!speciesInfo?.species) { container.innerHTML = ''; return; }
        container.innerHTML = speciesInfo.species.map(function(sp) {
            var cnt = state.speciesCounts[sp.code] || 0;
            return '<div class="legend-item"><span class="legend-dot" style="background:' + sp.color + '"></span><span>' + sp.name + '</span><span class="legend-count" data-code="' + sp.code + '">' + cnt.toLocaleString() + '</span></div>';
        }).join('');
    }

    function buildViewDots() {
        var dotsEl = document.getElementById('viewDots');
        if (!dotsEl || !state.views.length) return;
        dotsEl.innerHTML = state.views.map(function(v, i) {
            return '<span class="view-dot' + (v.rare ? ' rare' : '') + (i === state.viewIndex ? ' active' : '') + '" onclick="navTo(' + i + ')" title="' + (v.name || '') + '"></span>';
        }).join('');
    }

    function updateActiveDot() {
        document.querySelectorAll('.view-dot').forEach(function(d, i) {
            d.classList.toggle('active', i === state.viewIndex);
        });
    }

    // Legend toggle (mobile)
    window.toggleLegend = function() {
        var legend = document.getElementById('legend');
        var tab = document.getElementById('legendTab');
        legend.classList.toggle('mobile-open');
        if (tab) tab.style.display = legend.classList.contains('mobile-open') ? 'none' : '';
    };

    // Expose nav functions globally for onclick
    window.navPrev = function() {
        stopRotation();
        var idx = (state.viewIndex - 1 + state.views.length) % state.views.length;
        showView(idx);
        scheduleNextView(state.content?.preferences?.rotation_interval_sec || 15);
    };
    window.navNext = function() {
        stopRotation();
        var idx = (state.viewIndex + 1) % state.views.length;
        showView(idx);
        scheduleNextView(state.content?.preferences?.rotation_interval_sec || 15);
    };
    window.navTo = function(idx) {
        stopRotation();
        showView(idx);
        scheduleNextView(state.content?.preferences?.rotation_interval_sec || 15);
    };

    function showView(index) {
        if (index >= state.views.length) index = 0;
        state.viewIndex = index;
        var view = state.views[index];
        document.getElementById('viewBadge').textContent = view.name;
        state.map.flyTo(view.center, view.zoom, { duration: 2, easeLinearity: 0.25 });
        updateActiveDot();
        if (view.rare) {
            document.getElementById('viewTitle').textContent = 'Rare Bird Sighting';
            document.getElementById('viewBadge').textContent = view.rare.common_name;
            state.markerLayer.remove();
            if (state.rareMarker) { state.rareMarker.remove(); }
            state.rareMarker = L.circleMarker([view.rare.lat, view.rare.lng], {
                radius: 20, fillColor: '#ef4444', fillOpacity: 0.9, color: '#fff', weight: 3, interactive: false
            }).addTo(state.map);
            showRareCard(view.rare);
            var sc = document.getElementById('sightingCounter'); if (sc) sc.style.display = 'none';
        } else {
            document.getElementById('viewTitle').textContent = (state.content?.species_info?.group_name || 'Bird') + ' Sightings';
            if (state.rareMarker) { state.rareMarker.remove(); state.rareMarker = null; }
            if (!state.map.hasLayer(state.markerLayer)) state.markerLayer.addTo(state.map);
            hideRareCard();
            var sc = document.getElementById('sightingCounter'); if (sc) sc.style.display = '';
        }
    }

    function scheduleNextView(seconds) {
        var bar = document.getElementById('progressBar');
        bar.style.transition = 'none'; bar.style.width = '0';
        requestAnimationFrame(function() { requestAnimationFrame(function() { bar.style.transition = 'width ' + seconds + 's linear'; bar.style.width = '100%'; }); });
        state.rotationTimer = setTimeout(function() {
            showView((state.viewIndex + 1) % state.views.length);
            scheduleNextView(seconds);
        }, seconds * 1000);
    }

    function stopRotation() { clearTimeout(state.rotationTimer); document.getElementById('progressBar').style.cssText = 'width:0;transition:none'; }

    function showRareCard(rare) {
        var card = document.getElementById('rareCard');
        document.getElementById('rareCardName').textContent = rare.common_name || '';
        document.getElementById('rareCardSci').textContent = rare.scientific_name || '';
        document.getElementById('rareCardLoc').textContent = rare.location_name || '';
        document.getElementById('rareCardDate').textContent = rare.observation_date ? 'Observed: ' + rare.observation_date : '';
        document.getElementById('rareCardCount').textContent = rare.observation_count ? rare.observation_count + ' observed' : '';

        var img = document.getElementById('rareCardImg');
        var noimg = document.getElementById('rareCardNoImg');
        if (rare.image_url) {
            img.src = rare.image_url;
            img.alt = rare.common_name;
            img.style.display = 'block';
            noimg.style.display = 'none';
        } else {
            img.style.display = 'none';
            noimg.style.display = 'flex';
        }

        card.classList.add('show');
        var legend = document.getElementById('legend');
        if (legend) legend.style.display = 'none';
    }

    function hideRareCard() {
        document.getElementById('rareCard').classList.remove('show');
        var legend = document.getElementById('legend');
        if (legend) legend.style.display = '';
    }

    function showError(msg) {
        var el = document.getElementById('loadingScreen');
        el.querySelector('.loading-spinner').style.display = 'none';
        el.querySelector('.loading-text').textContent = msg;
    }

    // Keyboard controls
    document.addEventListener('keydown', function(e) {
        var sec = state.content?.preferences?.rotation_interval_sec || 15;
        if (e.key === 'ArrowRight' || e.key === ' ') { e.preventDefault(); stopRotation(); showView((state.viewIndex + 1) % state.views.length); scheduleNextView(sec); }
        else if (e.key === 'ArrowLeft') { e.preventDefault(); stopRotation(); showView((state.viewIndex - 1 + state.views.length) % state.views.length); scheduleNextView(sec); }
    });

    // Touch swipe
    var touchStartX = 0;
    document.addEventListener('touchstart', function(e) { touchStartX = e.touches[0].clientX; }, { passive: true });
    document.addEventListener('touchend', function(e) {
        var diff = e.changedTouches[0].clientX - touchStartX;
        if (Math.abs(diff) < 50) return;
        var sec = state.content?.preferences?.rotation_interval_sec || 15;
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
