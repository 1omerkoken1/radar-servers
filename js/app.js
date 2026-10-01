// Seyahat & Gerçek Fiziki Harita - Frontend Engine 2026
// Temiz Harita Altyapısı: Sokak, Mahalle ve Tarihi Yerler Odaklı (Ticari Reklam Kirliliğinden Arındırılmış)
document.addEventListener('DOMContentLoaded', () => {

  // Register Service Worker for Android Native Push Notifications
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(err => {
      console.warn('Service worker registration failed:', err);
    });
  }

  // Server API Base Resolver (Supports Web & APK File Scheme)
  function resolveApiBase() {
    const saved = localStorage.getItem('travel_map_server_url');
    if (saved && saved.trim()) return saved.trim().replace(/\/+$/, '');

    const origin = window.location.origin;
    if (origin && origin.startsWith('http')) return origin;
    return 'http://192.168.1.104:3000';
  }

  let API_BASE = resolveApiBase();

  // Application State
  const state = {
    locations: [],
    currentLocation: null,
    selectedLocation: null,
    tempPoint: null,
    map: null,
    markers: {},
    markerGroup: null, // FeatureGroup for instant show/hide toggle
    showMarkers: localStorage.getItem('show_map_markers') !== 'false', // Default true
    userMarker: null,
    baseLayers: {},
    currentLayerName: 'terrain', // Default to Real Physical Terrain!
    selectedNewFiles: [],
    activeCategoryFilter: 'all',
    searchQuery: '',
    isConnected: false,
    notificationsEnabled: false,
    notifyOnNewLocation: localStorage.getItem('notify_on_new_location') !== 'false', // Default true!
    notifyOnProximity: localStorage.getItem('notify_on_proximity') !== 'false', // Default true!
    proximityDistanceMeters: Math.max(1, Math.min(1000, parseInt(localStorage.getItem('proximity_distance_meters'), 10) || 250)),
    notifySound: localStorage.getItem('notify_sound') !== 'false', // Default true!
    notifiedLocationIds: new Set(),
    proximityWatchId: null,
    accuracyCircle: null,
    trailTrackingActive: false,
    currentTrail: [],
    savedTrails: JSON.parse(localStorage.getItem('saved_trails') || '[]'),
    trailColor: localStorage.getItem('trail_color') || '#10b981',
    showTrailsOnMap: localStorage.getItem('show_trails_on_map') !== 'false',
    activeTrailPolyline: null,
    archivedTrailsGroup: null
  };

  // Sound Chime Generator for Proximity (Web Audio API)
  function playProximityChime() {
    if ('vibrate' in navigator) {
      try { navigator.vibrate([300, 150, 300]); } catch (e) {}
    }
    if (!state.notifySound) return;
    try {
      const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(587.33, audioCtx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(880, audioCtx.currentTime + 0.15);
      gain.gain.setValueAtTime(0.3, audioCtx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 0.6);
      osc.connect(gain);
      gain.connect(audioCtx.destination);
      osc.start();
      osc.stop(audioCtx.currentTime + 0.65);
    } catch (e) {}
  }

  // Sound Chime Generator for New Location Added (Web Audio API - Pleasant tri-tone chord + Haptic Vibration)
  function playNewLocationChime() {
    // Hardware Vibration (Runs on Android without Notification permission)
    if ('vibrate' in navigator) {
      try { navigator.vibrate([250, 100, 250, 100, 350]); } catch (e) {}
    }
    if (!state.notifySound) return;
    try {
      const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const notes = [523.25, 659.25, 783.99]; // C5, E5, G5
      notes.forEach((freq, idx) => {
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        osc.type = 'triangle';
        const startT = audioCtx.currentTime + idx * 0.1;
        osc.frequency.setValueAtTime(freq, startT);
        gain.gain.setValueAtTime(0.25, startT);
        gain.gain.exponentialRampToValueAtTime(0.01, startT + 0.5);
        osc.connect(gain);
        gain.connect(audioCtx.destination);
        osc.start(startT);
        osc.stop(startT + 0.55);
      });
    } catch (e) {}
  }

  // Socket.io Connection
  let socket = null;
  function setupSocket() {
    if (typeof io === 'undefined') return;
    if (socket) socket.disconnect();

    try {
      socket = io(API_BASE, {
        transports: ['websocket', 'polling'],
        reconnectionAttempts: 5,
        timeout: 5000
      });

      socket.on('connect', () => {
        state.isConnected = true;
        updateConnectionBadge(true);
      });

      socket.on('disconnect', () => {
        state.isConnected = false;
        updateConnectionBadge(false);
      });

      socket.on('connect_error', () => {
        state.isConnected = false;
        updateConnectionBadge(false);
      });

      socket.on('init:locations', (locations) => {
        state.locations = locations;
        localStorage.setItem('cached_locations', JSON.stringify(locations));
        updateLocationsCount();
        rebuildAllMarkers();
        renderDrawerList();
      });

      socket.on('location:created', (loc) => {
        if (!state.locations.some(l => l.id === loc.id)) {
          state.locations.unshift(loc);
          localStorage.setItem('cached_locations', JSON.stringify(state.locations));
          if (state.showMarkers) addMarkerToMap(loc);
          updateLocationsCount();
          renderDrawerList();

          // Haritaya yeni ekleme yapıldığında bildirim gönder
          if (state.notifyOnNewLocation) {
            playNewLocationChime();
            sendNativeNotification(`🗺️ Yeni Konum Eklendi: ${loc.title}`, {
              body: `${loc.author || 'Gezgin'} tarafından yeni bir seyahat noktası eklendi (${loc.category})${loc.altitude ? ' • ' + loc.altitude + 'm' : ''}. Haritada görmek için dokunun.`,
              icon: './icon.svg',
              vibrate: [200, 100, 200],
              tag: 'new-location-' + loc.id
            });
            showNewLocationBanner(loc);
          } else {
            showToast(`Yeni Konum Eklendi: "${loc.title}"`, 'info');
          }
        }
      });

      socket.on('location:updated', (loc) => {
        const idx = state.locations.findIndex(l => l.id === loc.id);
        if (idx !== -1) {
          state.locations[idx] = loc;
          localStorage.setItem('cached_locations', JSON.stringify(state.locations));
          if (state.showMarkers) addMarkerToMap(loc);
          renderDrawerList();

          if (state.selectedLocation && state.selectedLocation.id === loc.id) {
            state.selectedLocation = loc;
            renderViewImages(loc);
            viewTitle.textContent = loc.title;
            viewNoteText.value = loc.note || '';
          }
        }
      });

      socket.on('location:deleted', (id) => {
        state.locations = state.locations.filter(l => l.id !== id);
        localStorage.setItem('cached_locations', JSON.stringify(state.locations));
        removeMarkerFromMap(id);
        updateLocationsCount();
        renderDrawerList();

        if (state.selectedLocation && state.selectedLocation.id === id) {
          closeModals();
        }
      });
    } catch (e) {
      updateConnectionBadge(false);
    }
  }

  function updateConnectionBadge(connected) {
    const badge = document.getElementById('connStatusBadge');
    if (!badge) return;
    if (connected) {
      badge.className = 'text-[9px] sm:text-[10px] font-medium text-emerald-400 flex items-center gap-1.5 cursor-pointer';
      badge.innerHTML = `<span class="w-2 h-2 rounded-full bg-emerald-400 animate-pulse"></span> <span>Canlı</span>`;
    } else {
      badge.className = 'text-[9px] sm:text-[10px] font-medium text-amber-400 flex items-center gap-1.5 cursor-pointer';
      badge.innerHTML = `<span class="w-2 h-2 rounded-full bg-amber-400"></span> <span>Çevrimdışı</span>`;
      badge.onclick = () => document.getElementById('btnServerConfig').click();
    }
  }

  // DOM Elements
  const btnGetLocation = document.getElementById('btnGetLocation');
  const btnCenterMe = document.getElementById('btnCenterMe');
  const btnFitAll = document.getElementById('btnFitAll');
  const btnLayers = document.getElementById('btnLayers');
  const layersDropdown = document.getElementById('layersDropdown');
  const btnQuickTerrain = document.getElementById('btnQuickTerrain');
  const btnQuickSatellite = document.getElementById('btnQuickSatellite');
  const btnQuickStreet = document.getElementById('btnQuickStreet');
  const btnTogglePins = document.getElementById('btnTogglePins');
  const iconTogglePins = document.getElementById('iconTogglePins');
  const textTogglePins = document.getElementById('textTogglePins');
  const btnToggleNewLocNotif = document.getElementById('btnToggleNewLocNotif');
  const iconToggleNewLocNotif = document.getElementById('iconToggleNewLocNotif');
  const textToggleNewLocNotif = document.getElementById('textToggleNewLocNotif');
  const btnOpenNotifSettings = document.getElementById('btnOpenNotifSettings');
  const modalNotifSettings = document.getElementById('modalNotifSettings');
  const toggleNotifyNewLoc = document.getElementById('toggleNotifyNewLoc');
  const toggleNotifyProximity = document.getElementById('toggleNotifyProximity');
  const toggleNotifySound = document.getElementById('toggleNotifySound');
  const systemNotifStatusText = document.getElementById('systemNotifStatusText');
  const btnRequestSysNotifPerm = document.getElementById('btnRequestSysNotifPerm');
  const btnSendTestNotification = document.getElementById('btnSendTestNotification');
  const notifStatusBadge = document.getElementById('notifStatusBadge');
  const notifStatusText = document.getElementById('notifStatusText');
  const proximityAlertBanner = document.getElementById('proximityAlertBanner');
  const proxTitle = document.getElementById('proxTitle');
  const proxDistance = document.getElementById('proxDistance');
  const btnCloseProximityBanner = document.getElementById('btnCloseProximityBanner');
  const btnToggleList = document.getElementById('btnToggleList');
  const btnCloseDrawer = document.getElementById('btnCloseDrawer');
  const sideDrawer = document.getElementById('sideDrawer');
  const drawerListContainer = document.getElementById('drawerListContainer');
  const locationCountBadge = document.getElementById('locationCountBadge');
  const mapSearchInput = document.getElementById('mapSearchInput');
  const drawerSearchInput = document.getElementById('drawerSearchInput');
  const toastContainer = document.getElementById('toastContainer');

  // Modals
  const modalNewLocation = document.getElementById('modalNewLocation');
  const formNewLocation = document.getElementById('formNewLocation');
  const modalViewLocation = document.getElementById('modalViewLocation');
  const modalShare = document.getElementById('modalShare');
  const btnShareModal = document.getElementById('btnShareModal');
  const modalServerConfig = document.getElementById('modalServerConfig');
  const btnServerConfig = document.getElementById('btnServerConfig');
  const lightboxModal = document.getElementById('lightboxModal');
  const lightboxImage = document.getElementById('lightboxImage');

  // Form Fields
  const newTitle = document.getElementById('newTitle');
  const newCategory = document.getElementById('newCategory');
  const newNote = document.getElementById('newNote');
  const inputCameraPhoto = document.getElementById('inputCameraPhoto');
  const inputGalleryPhoto = document.getElementById('inputGalleryPhoto');
  const newPhotoPreviews = document.getElementById('newPhotoPreviews');
  const newAuthor = document.getElementById('newAuthor');
  const displayLat = document.getElementById('displayLat');
  const displayLng = document.getElementById('displayLng');
  const displayAltitude = document.getElementById('displayAltitude');
  const displayDateTime = document.getElementById('displayDateTime');
  const altitudeStatusBadge = document.getElementById('altitudeStatusBadge');
  const rawLat = document.getElementById('rawLat');
  const rawLng = document.getElementById('rawLng');
  const rawAltitude = document.getElementById('rawAltitude');
  const rawAccuracy = document.getElementById('rawAccuracy');

  // View Modal Fields
  const viewTitle = document.getElementById('viewTitle');
  const viewCategoryBadge = document.getElementById('viewCategoryBadge');
  const viewNoteText = document.getElementById('viewNoteText');
  const btnSaveNoteEdit = document.getElementById('btnSaveNoteEdit');
  const viewDate = document.getElementById('viewDate');
  const viewTime = document.getElementById('viewTime');
  const viewAltitude = document.getElementById('viewAltitude');
  const viewAuthor = document.getElementById('viewAuthor');
  const viewCoordinates = document.getElementById('viewCoordinates');
  const viewAccuracy = document.getElementById('viewAccuracy');
  const btnGoogleDirections = document.getElementById('btnGoogleDirections');
  const btnDeleteLocation = document.getElementById('btnDeleteLocation');
  const modalConfirmDelete = document.getElementById('modalConfirmDelete');
  const confirmDeleteMsg = document.getElementById('confirmDeleteMsg');
  const btnCancelDelete = document.getElementById('btnCancelDelete');
  const btnApproveDelete = document.getElementById('btnApproveDelete');
  const viewMainImage = document.getElementById('viewMainImage');
  const viewNoImagePlaceholder = document.getElementById('viewNoImagePlaceholder');
  const viewThumbnailsStrip = document.getElementById('viewThumbnailsStrip');
  const viewAddMorePhotos = document.getElementById('viewAddMorePhotos');

  // Proximity Distance Fields
  const inputProximityMeters = document.getElementById('inputProximityMeters');
  const rangeProximityMeters = document.getElementById('rangeProximityMeters');
  const proximitySettingTitle = document.getElementById('proximitySettingTitle');

  // Ayak İzi & Rota Takip DOM Öğeleri
  const btnToggleTrailRecord = document.getElementById('btnToggleTrailRecord');
  const trailRecordDot = document.getElementById('trailRecordDot');
  const trailRecordText = document.getElementById('trailRecordText');
  const toggleShowTrails = document.getElementById('toggleShowTrails');
  const inputTrailColorPicker = document.getElementById('inputTrailColorPicker');
  const btnClearSavedTrails = document.getElementById('btnClearSavedTrails');

  // Server Settings Fields
  const inputServerUrl = document.getElementById('inputServerUrl');
  const btnTestServerConn = document.getElementById('btnTestServerConn');
  const serverTestResult = document.getElementById('serverTestResult');
  const btnSaveServerUrl = document.getElementById('btnSaveServerUrl');
  const btnResetServerUrl = document.getElementById('btnResetServerUrl');

  // Category Configuration
  const categoryConfig = {
    'Seyahat': { icon: 'fa-campground', color: '#10b981', bg: 'bg-emerald-500/20', text: 'text-emerald-300', border: 'border-emerald-500/30' },
    'Manzara': { icon: 'fa-mountain-sun', color: '#06b6d4', bg: 'bg-cyan-500/20', text: 'text-cyan-300', border: 'border-cyan-500/30' },
    'Tarih': { icon: 'fa-landmark-dome', color: '#f59e0b', bg: 'bg-amber-500/20', text: 'text-amber-300', border: 'border-amber-500/30' },
    'Mola': { icon: 'fa-mug-hot', color: '#f43f5e', bg: 'bg-rose-500/20', text: 'text-rose-300', border: 'border-rose-500/30' },
    'Konaklama': { icon: 'fa-hotel', color: '#8b5cf6', bg: 'bg-purple-500/20', text: 'text-purple-300', border: 'border-purple-500/30' },
    'Diğer': { icon: 'fa-map-pin', color: '#64748b', bg: 'bg-slate-500/20', text: 'text-slate-300', border: 'border-slate-500/30' }
  };

  function getFullImageUrl(url) {
    if (!url) return '';
    if (url.startsWith('http://') || url.startsWith('https://') || url.startsWith('data:')) return url;
    return `${API_BASE}${url.startsWith('/') ? '' : '/'}${url}`;
  }

  // Özel Temiz Harita Filtresi:
  // - s.t:33|p.v:off (Ticari dükkanlar, kafeler, marketler ve reklam kirliliği KAPALI)
  // - s.t:34|p.v:off, s.t:35|p.v:off, s.t:37|p.v:off (Gereksiz ofis/kurum kirliliği KAPALI)
  // - s.t:17|p.v:on (Sokaklar, caddeler, bulvarlar ve sokak isimleri AÇIK)
  // - s.t:4|p.v:on, s.t:3|p.v:on, s.t:2|p.v:on (Mahalle isimleri, semtler ve şehir isimleri AÇIK)
  // - s.t:32|p.v:on, s.t:38|p.v:on, s.t:36|p.v:on (Tarihi yapılar, kaleler, antik kentler, ibadethaneler ve doğa parkları AÇIK)
  const cleanMapStyle = 's.t:33|p.v:off,s.t:34|p.v:off,s.t:35|p.v:off,s.t:37|p.v:off,s.t:32|p.v:on,s.t:38|p.v:on,s.t:36|p.v:on,s.t:4|p.v:on,s.t:17|p.v:on';

  // 1. INITIALIZE LEAFLET MAP
  function initMap() {
    const defaultCenter = [39.0, 35.2];
    state.map = L.map('map', {
      zoomControl: true,
      attributionControl: false,
      maxZoom: 22
    }).setView(defaultCenter, 6);

    state.markerGroup = L.featureGroup().addTo(state.map);

    // Reliable Tile Providers with Clean Cartography
    state.baseLayers = {
      // 1. Google Gerçek Fiziki Arazi (3D Rölyef + Sokaklar + Mahalleler + Tarihi Yerler)
      terrain: L.tileLayer(`https://mt1.google.com/vt/lyrs=p&apistyle=${cleanMapStyle}&x={x}&y={y}&z={z}`, {
        maxNativeZoom: 18,
        maxZoom: 22,
        subdomains: ['mt0', 'mt1', 'mt2', 'mt3']
      }),
      // 2. Google Sade Sokak & Mahalle (Sokak İsimleri, Mahalle İsimleri, Tarihi Eserler - Reklamsız)
      streets: L.tileLayer(`https://mt1.google.com/vt/lyrs=m&apistyle=${cleanMapStyle}&x={x}&y={y}&z={z}`, {
        maxNativeZoom: 19,
        maxZoom: 22,
        subdomains: ['mt0', 'mt1', 'mt2', 'mt3']
      }),
      // 3. Google Net Hibrit Uydu (Uydu + Temiz Sokak ve Mahalle İsimleri)
      satellite: L.tileLayer(`https://mt1.google.com/vt/lyrs=y&apistyle=${cleanMapStyle}&x={x}&y={y}&z={z}`, {
        maxNativeZoom: 19,
        maxZoom: 22,
        subdomains: ['mt0', 'mt1', 'mt2', 'mt3']
      }),
      // 4. Esri Topoğrafik Fiziki Harita
      esriTopo: L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}', {
        maxNativeZoom: 18,
        maxZoom: 22
      })
    };

    // Default to Real Physical Terrain!
    state.baseLayers.terrain.addTo(state.map);

    // Map Click Handler
    state.map.on('click', (e) => {
      openNewLocationModal({
        lat: e.latlng.lat,
        lng: e.latlng.lng,
        accuracy: null
      });
    });

    updatePinsToggleUI();
    loadInitialData();
    setupProximityTracking();
    initTrailLayers();
  }

  // 2. SHOW / HIDE PINS (İŞARETLERİ GÖSTER / GİZLE)
  function updatePinsToggleUI() {
    if (state.showMarkers) {
      iconTogglePins.className = 'fa-solid fa-eye text-emerald-400 text-xs';
      textTogglePins.textContent = 'İşaretleri Gizle';
      btnTogglePins.classList.add('border-emerald-500/30');
      btnTogglePins.classList.remove('border-white/10');
    } else {
      iconTogglePins.className = 'fa-solid fa-eye-slash text-slate-400 text-xs';
      textTogglePins.textContent = 'İşaretleri Göster';
      btnTogglePins.classList.remove('border-emerald-500/30');
      btnTogglePins.classList.add('border-white/10');
    }
  }

  btnTogglePins.addEventListener('click', () => {
    state.showMarkers = !state.showMarkers;
    localStorage.setItem('show_map_markers', state.showMarkers ? 'true' : 'false');
    updatePinsToggleUI();

    if (state.showMarkers) {
      rebuildAllMarkers();
      showToast('Konum işaretleri gösteriliyor', 'success');
    } else {
      state.markerGroup.clearLayers();
      state.markers = {};
      showToast('Konum işaretleri gizlendi (Sade Fiziki Harita)', 'info');
    }
  });

  // Switch Layer Function
  function switchMapLayer(layerKey) {
    if (!state.baseLayers[layerKey]) return;
    Object.values(state.baseLayers).forEach(layer => state.map.removeLayer(layer));
    state.baseLayers[layerKey].addTo(state.map);
    state.currentLayerName = layerKey;

    const quickButtons = [
      { id: 'btnQuickTerrain', key: 'terrain' },
      { id: 'btnQuickSatellite', key: 'satellite' },
      { id: 'btnQuickStreet', key: 'streets' }
    ];
    quickButtons.forEach(qb => {
      const el = document.getElementById(qb.id);
      if (el) {
        if (qb.key === layerKey) {
          el.className = 'px-2.5 sm:px-3 py-1.5 rounded-xl text-xs font-bold text-white flex items-center gap-1.5 transition-all bg-gradient-to-r from-emerald-600 to-teal-600 shadow-md shadow-emerald-600/30';
        } else {
          el.className = 'px-2.5 sm:px-3 py-1.5 rounded-xl text-xs font-medium text-slate-300 hover:text-white flex items-center gap-1.5 transition-all hover:bg-white/5';
        }
      }
    });

    document.querySelectorAll('.layer-opt').forEach(btn => {
      if (btn.dataset.layer === layerKey) {
        btn.classList.add('bg-emerald-500/20', 'border', 'border-emerald-500/30', 'text-white');
        btn.classList.remove('text-slate-200');
      } else {
        btn.classList.remove('bg-emerald-500/20', 'border', 'border-emerald-500/30', 'text-white');
        btn.classList.add('text-slate-200');
      }
    });
  }

  if (btnQuickTerrain) btnQuickTerrain.addEventListener('click', () => switchMapLayer('terrain'));
  if (btnQuickSatellite) btnQuickSatellite.addEventListener('click', () => switchMapLayer('satellite'));
  if (btnQuickStreet) btnQuickStreet.addEventListener('click', () => switchMapLayer('streets'));

  btnLayers.addEventListener('click', (e) => {
    e.stopPropagation();
    layersDropdown.classList.toggle('hidden');
    layersDropdown.classList.toggle('flex');
  });

  document.querySelectorAll('.layer-opt').forEach(btn => {
    btn.addEventListener('click', () => {
      const layerKey = btn.dataset.layer;
      switchMapLayer(layerKey);
      layersDropdown.classList.add('hidden');
      layersDropdown.classList.remove('flex');
    });
  });

  document.addEventListener('click', (e) => {
    if (!layersDropdown.contains(e.target) && e.target !== btnLayers) {
      layersDropdown.classList.add('hidden');
      layersDropdown.classList.remove('flex');
    }
  });

  // 3. NOTIFICATION PERMISSION & SETTINGS
  async function requestNotificationPermission() {
    if (!('Notification' in window)) {
      showToast('Bu cihaz veya tarayıcı sistem bildirimlerini desteklemiyor.', 'error');
      return false;
    }

    try {
      const permission = await Notification.requestPermission();
      updateNotifSettingsUI();
      if (permission === 'granted') {
        state.notificationsEnabled = true;
        showToast('Bildirim izni verildi! Yeni eklenen konumlar anında bildirilecek.', 'success');
        return true;
      } else {
        state.notificationsEnabled = false;
        showToast('Bildirim izni verilmedi.', 'error');
        return false;
      }
    } catch (e) {
      console.warn('Notification error:', e);
      return false;
    }
  }

  function updateNotifSettingsUI() {
    // 1. Top bar toggle button
    if (btnToggleNewLocNotif) {
      if (state.notifyOnNewLocation) {
        btnToggleNewLocNotif.className = 'flex items-center gap-1.5 bg-amber-500/15 hover:bg-amber-500/25 text-amber-300 border border-amber-500/30 px-2.5 sm:px-3 py-1.5 rounded-xl text-xs font-semibold transition-all shadow-sm active:scale-95';
        iconToggleNewLocNotif.className = 'fa-solid fa-bell text-xs text-amber-400';
        textToggleNewLocNotif.textContent = 'Ekleme Bildirimi: Açık';
      } else {
        btnToggleNewLocNotif.className = 'flex items-center gap-1.5 bg-slate-800/80 hover:bg-slate-750 text-slate-400 border border-white/10 px-2.5 sm:px-3 py-1.5 rounded-xl text-xs font-semibold transition-all shadow-sm active:scale-95';
        iconToggleNewLocNotif.className = 'fa-solid fa-bell-slash text-xs text-slate-500';
        textToggleNewLocNotif.textContent = 'Ekleme Bildirimi: Kapalı';
      }
    }

    // 2. Header subtitle badge
    if (notifStatusText && notifStatusBadge) {
      notifStatusText.textContent = state.notifyOnNewLocation ? 'Ekleme Bildirimi: Açık' : 'Ekleme Bildirimi: Kapalı';
      notifStatusBadge.className = state.notifyOnNewLocation
        ? 'text-[9px] sm:text-[10px] font-medium text-amber-400 flex items-center gap-1 cursor-pointer hover:underline'
        : 'text-[9px] sm:text-[10px] font-medium text-slate-400 flex items-center gap-1 cursor-pointer hover:underline';
    }

    // 3. Modal checkboxes & distance controls
    if (toggleNotifyNewLoc) toggleNotifyNewLoc.checked = state.notifyOnNewLocation;
    if (toggleNotifyProximity) toggleNotifyProximity.checked = state.notifyOnProximity;
    if (toggleNotifySound) toggleNotifySound.checked = state.notifySound;
    if (inputProximityMeters) inputProximityMeters.value = state.proximityDistanceMeters;
    if (rangeProximityMeters) rangeProximityMeters.value = state.proximityDistanceMeters;
    if (proximitySettingTitle) {
      proximitySettingTitle.textContent = `Kayıtlı Konuma Yaklaşınca Bildir (${state.proximityDistanceMeters}m)`;
    }
    if (toggleShowTrails) toggleShowTrails.checked = state.showTrailsOnMap;
    if (inputTrailColorPicker) inputTrailColorPicker.value = state.trailColor;
    updateTrailColorSwatches();

    // 4. Device permission status
    if (systemNotifStatusText) {
      const helpBox = document.getElementById('notifPermissionHelpBox');
      const btnReload = document.getElementById('btnReloadPermissions');
      if (btnReload) {
        btnReload.onclick = () => location.reload();
      }

      if (!('Notification' in window)) {
        systemNotifStatusText.innerHTML = `<span>Uygulama İçi & Titreşim Aktif 🔔</span>`;
        systemNotifStatusText.className = 'font-bold text-emerald-400';
        if (btnRequestSysNotifPerm) btnRequestSysNotifPerm.style.display = 'none';
        if (helpBox) helpBox.classList.add('hidden');
      } else if (Notification.permission === 'granted') {
        systemNotifStatusText.innerHTML = `<span>Sistem Bildirimi Aktif ✅</span>`;
        systemNotifStatusText.className = 'font-bold text-emerald-400';
        if (btnRequestSysNotifPerm) {
          btnRequestSysNotifPerm.textContent = 'İzin Aktif ✅';
          btnRequestSysNotifPerm.className = 'px-3 py-1.5 bg-emerald-600/30 text-emerald-300 rounded-xl text-xs font-bold border border-emerald-500/30 pointer-events-none';
        }
        if (helpBox) helpBox.classList.add('hidden');
      } else if (Notification.permission === 'denied') {
        // In-app notifications & haptic vibration are 100% active, offer unblock instructions
        systemNotifStatusText.innerHTML = `<span class="text-emerald-400">Titreşim & Ekran Aktif 🔔</span> <span class="text-[10px] text-amber-400 font-normal">(Tarayıcı Kilitli)</span>`;
        systemNotifStatusText.className = 'font-bold text-emerald-400';
        if (btnRequestSysNotifPerm) {
          btnRequestSysNotifPerm.textContent = 'Engeli Aç 🔓';
          btnRequestSysNotifPerm.className = 'px-3 py-1.5 bg-amber-500 hover:bg-amber-400 text-slate-950 rounded-xl text-xs font-extrabold transition-all shadow-md active:scale-95';
          btnRequestSysNotifPerm.onclick = () => {
            if (helpBox) helpBox.classList.toggle('hidden');
          };
        }
        if (helpBox) helpBox.classList.remove('hidden');
      } else {
        systemNotifStatusText.textContent = 'İzin Bekleniyor ⚠️';
        systemNotifStatusText.className = 'font-bold text-amber-400';
        if (btnRequestSysNotifPerm) {
          btnRequestSysNotifPerm.textContent = 'İzin Ver';
          btnRequestSysNotifPerm.className = 'px-3 py-1.5 bg-emerald-600 hover:bg-emerald-500 text-white rounded-xl text-xs font-bold transition-all shadow active:scale-95';
          btnRequestSysNotifPerm.onclick = requestNotificationPermission;
        }
        if (helpBox) helpBox.classList.add('hidden');
      }
    }
  }

  // Toggle location notification from top bar button
  if (btnToggleNewLocNotif) {
    btnToggleNewLocNotif.addEventListener('click', async () => {
      state.notifyOnNewLocation = !state.notifyOnNewLocation;
      localStorage.setItem('notify_on_new_location', state.notifyOnNewLocation ? 'true' : 'false');

      if (state.notifyOnNewLocation && 'Notification' in window && Notification.permission !== 'granted') {
        await requestNotificationPermission();
      }

      updateNotifSettingsUI();
      showToast(state.notifyOnNewLocation 
        ? 'Haritaya yeni konum eklendiğinde bildirim gönder: AÇIK 🔔' 
        : 'Haritaya yeni konum eklendiğinde bildirim gönder: KAPALI 🔕', 
        state.notifyOnNewLocation ? 'success' : 'info'
      );
    });
  }

  // Open notification modal
  if (btnOpenNotifSettings) {
    btnOpenNotifSettings.addEventListener('click', () => {
      updateNotifSettingsUI();
      modalNotifSettings.classList.remove('hidden');
      modalNotifSettings.classList.add('flex');
    });
  }
  if (notifStatusBadge) {
    notifStatusBadge.addEventListener('click', () => {
      updateNotifSettingsUI();
      modalNotifSettings.classList.remove('hidden');
      modalNotifSettings.classList.add('flex');
    });
  }

  // Modal checkbox change listeners
  if (toggleNotifyNewLoc) {
    toggleNotifyNewLoc.addEventListener('change', async (e) => {
      state.notifyOnNewLocation = e.target.checked;
      localStorage.setItem('notify_on_new_location', state.notifyOnNewLocation ? 'true' : 'false');
      if (state.notifyOnNewLocation && 'Notification' in window && Notification.permission !== 'granted') {
        await requestNotificationPermission();
      }
      updateNotifSettingsUI();
    });
  }

  if (toggleNotifyProximity) {
    toggleNotifyProximity.addEventListener('change', async (e) => {
      state.notifyOnProximity = e.target.checked;
      localStorage.setItem('notify_on_proximity', state.notifyOnProximity ? 'true' : 'false');
      if (state.notifyOnProximity && 'Notification' in window && Notification.permission !== 'granted') {
        await requestNotificationPermission();
      }
      updateNotifSettingsUI();
    });
  }

  function setProximityDistance(val) {
    let meters = parseInt(val, 10);
    if (isNaN(meters)) meters = 250;
    meters = Math.max(1, Math.min(1000, meters));
    state.proximityDistanceMeters = meters;
    localStorage.setItem('proximity_distance_meters', meters.toString());
    if (inputProximityMeters) inputProximityMeters.value = meters;
    if (rangeProximityMeters) rangeProximityMeters.value = meters;
    if (proximitySettingTitle) {
      proximitySettingTitle.textContent = `Kayıtlı Konuma Yaklaşınca Bildir (${meters}m)`;
    }
  }

  if (rangeProximityMeters) {
    rangeProximityMeters.addEventListener('input', (e) => setProximityDistance(e.target.value));
  }
  if (inputProximityMeters) {
    inputProximityMeters.addEventListener('input', (e) => setProximityDistance(e.target.value));
    inputProximityMeters.addEventListener('blur', (e) => setProximityDistance(e.target.value));
  }

  if (toggleNotifySound) {
    toggleNotifySound.addEventListener('change', (e) => {
      state.notifySound = e.target.checked;
      localStorage.setItem('notify_sound', state.notifySound ? 'true' : 'false');
      if (state.notifySound) playNewLocationChime();
    });
  }

  if (btnRequestSysNotifPerm) {
    btnRequestSysNotifPerm.addEventListener('click', requestNotificationPermission);
  }

  // Send Test Notification
  if (btnSendTestNotification) {
    btnSendTestNotification.addEventListener('click', async () => {
      // 1. Play melody chime
      playNewLocationChime();

      // 2. Hardware vibration
      if ('vibrate' in navigator) {
        try { navigator.vibrate([250, 100, 250, 100, 350]); } catch (e) {}
      }

      // 3. Drop down in-app notification banner
      showNewLocationBanner({
        id: 'test_demo_' + Date.now(),
        title: 'Örnek Seyahat Noktası (Bolu Dağı)',
        category: 'Manzara',
        author: 'Siz',
        time: new Date().toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' }),
        altitude: 1570,
        lat: 40.73,
        lng: 31.60
      });

      // 4. Send native push if permission is granted
      if ('Notification' in window && Notification.permission === 'granted') {
        sendNativeNotification('🔔 Radar Test Bildirimi', {
          body: 'Radara yeni konum eklendiğinde bu şekilde bildirim alacaksınız!',
          icon: './icon.svg',
          vibrate: [200, 100, 200]
        });
      }

      showToast('Test bildirimi çalıştırıldı: Telefon titredi ve ses çaldı! 📱🔔', 'success');
    });
  }

  function sendNativeNotification(title, options = {}) {
    const bodyText = options.body || '';

    // 1. Android Sistem Bildirimi (Doğrudan telefonun üst bildirim çubuğunda görünür!)
    if (window.AndroidBridge && typeof window.AndroidBridge.postNotification === 'function') {
      try {
        window.AndroidBridge.postNotification(title, bodyText);
      } catch (err) {
        console.warn('AndroidBridge notification error:', err);
      }
    }

    // 2. Tarayıcı / Web Bildirim Desteği (Varsa)
    if ('Notification' in window && Notification.permission === 'granted') {
      try {
        if ('serviceWorker' in navigator && navigator.serviceWorker.controller) {
          navigator.serviceWorker.ready.then(reg => {
            reg.showNotification(title, options);
          }).catch(() => {
            new Notification(title, options);
          });
        } else {
          new Notification(title, options);
        }
      } catch (e) {}
    }

    // 3. Titreşim ve ses
    if ('vibrate' in navigator) {
      try {
        navigator.vibrate(options.vibrate || [250, 150, 250]);
      } catch (e) {}
    }
  }

  // Interactive In-App Notification Banner for New Added Locations
  function showNewLocationBanner(loc) {
    const banner = document.createElement('div');
    const cat = categoryConfig[loc.category] || categoryConfig['Diğer'];
    banner.className = 'toast-enter pointer-events-auto flex items-center justify-between gap-3 p-3.5 bg-[#090d16]/95 border border-amber-500/40 rounded-2xl shadow-2xl backdrop-blur-2xl text-xs text-white max-w-sm w-full animate-in slide-in-from-top-4 duration-300';
    banner.innerHTML = `
      <div class="flex items-center gap-3 overflow-hidden">
        <div class="w-9 h-9 rounded-xl ${cat.bg} ${cat.text} flex items-center justify-center flex-shrink-0 text-base shadow">
          <i class="fa-solid ${cat.icon}"></i>
        </div>
        <div class="overflow-hidden">
          <div class="flex items-center gap-1.5">
            <span class="text-[9px] font-bold px-1.5 py-0.2 rounded ${cat.bg} ${cat.text}">${loc.category}</span>
            <span class="text-[10px] text-slate-400 font-mono">${loc.time || ''}</span>
          </div>
          <h4 class="font-extrabold text-white text-xs truncate mt-0.5">${escapeHtml(loc.title)}</h4>
          <p class="text-[10px] text-slate-300 truncate">${escapeHtml(loc.author || 'Gezgin')} yeni konum ekledi</p>
        </div>
      </div>
      <button class="btn-go-to-loc flex-shrink-0 px-2.5 py-1.5 bg-gradient-to-r from-amber-500 to-emerald-500 hover:from-amber-400 hover:to-emerald-400 text-slate-950 font-extrabold rounded-xl text-[11px] shadow-md transition-all active:scale-95">
        Haritada Gör
      </button>
    `;

    banner.querySelector('.btn-go-to-loc').addEventListener('click', () => {
      state.map.flyTo([loc.lat, loc.lng], 16, { duration: 1.2 });
      if (state.markers[loc.id]) {
        setTimeout(() => state.markers[loc.id].openPopup(), 1300);
      }
      banner.remove();
    });

    toastContainer.appendChild(banner);
    setTimeout(() => {
      banner.style.opacity = '0';
      banner.style.transform = 'translateY(-10px)';
      banner.style.transition = 'all 0.3s ease';
      setTimeout(() => banner.remove(), 300);
    }, 7000);
  }

  function getDistanceMeters(lat1, lon1, lat2, lon2) {
    const R = 6371e3;
    const phi1 = (lat1 * Math.PI) / 180;
    const phi2 = (lat2 * Math.PI) / 180;
    const deltaPhi = ((lat2 - lat1) * Math.PI) / 180;
    const deltaLambda = ((lon2 - lon1) * Math.PI) / 180;

    const a =
      Math.sin(deltaPhi / 2) * Math.sin(deltaPhi / 2) +
      Math.cos(phi1) * Math.cos(phi2) * Math.sin(deltaLambda / 2) * Math.sin(deltaLambda / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

    return R * c;
  }

  // --- AYAK İZİ & GEZİLEN YERLERİ BOYAMA SİSTEMİ (TRAIL TRACKING) ---
  function initTrailLayers() {
    state.archivedTrailsGroup = L.featureGroup().addTo(state.map);
    state.activeTrailPolyline = L.polyline([], {
      color: state.trailColor,
      weight: 6,
      opacity: 0.95,
      lineJoin: 'round',
      lineCap: 'round'
    }).addTo(state.map);

    renderArchivedTrails();
    updateTrailRecordUI();
    setupTrailEventListeners();
  }

  function updateTrailRecordUI() {
    if (!btnToggleTrailRecord) return;
    if (state.trailTrackingActive) {
      if (trailRecordDot) trailRecordDot.className = 'w-2.5 h-2.5 rounded-full bg-rose-500 animate-ping inline-block';
      if (trailRecordText) trailRecordText.textContent = 'İz Bitir';
      btnToggleTrailRecord.className = 'px-3 py-1.5 rounded-2xl bg-rose-950/90 hover:bg-rose-900 border border-rose-500/50 text-rose-200 text-xs font-bold shadow-2xl backdrop-blur-xl flex items-center gap-2 active:scale-95 transition-all animate-pulse';
    } else {
      if (trailRecordDot) trailRecordDot.className = 'w-2.5 h-2.5 rounded-full bg-emerald-400 inline-block';
      if (trailRecordText) trailRecordText.textContent = 'İz Başlat';
      btnToggleTrailRecord.className = 'px-3 py-1.5 rounded-2xl bg-[#090d16]/95 hover:bg-slate-800 text-xs font-bold border border-white/15 text-slate-200 shadow-2xl backdrop-blur-xl flex items-center gap-2 active:scale-95 transition-all';
    }
  }

  function updateTrailColorSwatches() {
    document.querySelectorAll('.trail-color-btn').forEach(btn => {
      const c = btn.dataset.color;
      if (c && c.toLowerCase() === state.trailColor.toLowerCase()) {
        btn.classList.add('ring-2', 'ring-white', 'scale-110');
      } else {
        btn.classList.remove('ring-2', 'ring-white', 'scale-110');
      }
    });
  }

  function renderArchivedTrails() {
    if (!state.archivedTrailsGroup) return;
    state.archivedTrailsGroup.clearLayers();
    if (!state.showTrailsOnMap) return;

    state.savedTrails.forEach(trail => {
      if (trail.points && trail.points.length > 1) {
        L.polyline(trail.points, {
          color: trail.color || state.trailColor,
          weight: 5,
          opacity: 0.35, // Bitirilen yerler silik boya ile gösterilir!
          dashArray: '3, 6', // Ayak izi etkisi
          lineJoin: 'round',
          lineCap: 'round'
        }).addTo(state.archivedTrailsGroup);
      }
    });
  }

  function startTrailTracking() {
    state.trailTrackingActive = true;
    state.currentTrail = [];
    if (state.currentLocation && state.currentLocation.lat && state.currentLocation.lng) {
      state.currentTrail.push([state.currentLocation.lat, state.currentLocation.lng]);
    }
    state.activeTrailPolyline.setStyle({ color: state.trailColor });
    state.activeTrailPolyline.setLatLngs(state.currentTrail);
    updateTrailRecordUI();
    showToast('Ayak izi kaydı başladı! Yürüdüğünüz rotalar canlı boyanıyor 👣🎨', 'success');
  }

  function stopTrailTracking() {
    state.trailTrackingActive = false;
    if (state.currentTrail && state.currentTrail.length >= 2) {
      const newArchived = {
        id: 'trail_' + Date.now(),
        color: state.trailColor,
        points: [...state.currentTrail],
        date: new Date().toLocaleDateString('tr-TR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })
      };
      state.savedTrails.push(newArchived);
      localStorage.setItem('saved_trails', JSON.stringify(state.savedTrails));
      renderArchivedTrails();
      showToast('Ayak izi tamamlandı! Gezilen yerler silik boya olarak haritada saklandı 👣✨', 'success');
    } else {
      showToast('Ayak izi kaydı bitirildi (Yeterli hareket algılanmadı).', 'info');
    }
    state.currentTrail = [];
    state.activeTrailPolyline.setLatLngs([]);
    updateTrailRecordUI();
  }

  function recordTrailPoint(lat, lng, accuracy) {
    if (!state.trailTrackingActive) return;
    // GPS Sapma / Hata önleme: Çok yüksek sapmalı (doğruluğu 45 metreden kötü) noktaları çizgiye ekleme
    if (accuracy && accuracy > 45) return;

    const pt = [lat, lng];
    if (state.currentTrail.length > 0) {
      const last = state.currentTrail[state.currentTrail.length - 1];
      const dist = getDistanceMeters(last[0], last[1], lat, lng);
      // Yerinde dururken gereksiz nokta birikmesini önlemek için min 3 metre hareket şartı
      if (dist < 3) return;
    }

    state.currentTrail.push(pt);
    if (state.showTrailsOnMap) {
      state.activeTrailPolyline.setLatLngs(state.currentTrail);
    }
  }

  function setTrailColor(color) {
    state.trailColor = color;
    localStorage.setItem('trail_color', color);
    if (state.activeTrailPolyline) {
      state.activeTrailPolyline.setStyle({ color: color });
    }
    if (inputTrailColorPicker) inputTrailColorPicker.value = color;
    updateTrailColorSwatches();
    renderArchivedTrails();
    showToast('Ayak izi boya rengi güncellendi 🎨', 'info');
  }

  function toggleTrailsVisibility(show) {
    state.showTrailsOnMap = show;
    localStorage.setItem('show_trails_on_map', show ? 'true' : 'false');
    if (show) {
      if (!state.map.hasLayer(state.archivedTrailsGroup)) state.map.addLayer(state.archivedTrailsGroup);
      if (!state.map.hasLayer(state.activeTrailPolyline)) state.map.addLayer(state.activeTrailPolyline);
      renderArchivedTrails();
      if (state.activeTrailPolyline) state.activeTrailPolyline.setLatLngs(state.currentTrail);
      showToast('Ayak izi rotaları gösteriliyor 👣', 'success');
    } else {
      if (state.map.hasLayer(state.archivedTrailsGroup)) state.map.removeLayer(state.archivedTrailsGroup);
      if (state.map.hasLayer(state.activeTrailPolyline)) state.map.removeLayer(state.activeTrailPolyline);
      showToast('Ayak izi rotaları gizlendi 👁️‍🗨️', 'info');
    }
    if (toggleShowTrails) toggleShowTrails.checked = show;
  }

  function clearSavedTrails() {
    state.savedTrails = [];
    localStorage.removeItem('saved_trails');
    if (state.archivedTrailsGroup) state.archivedTrailsGroup.clearLayers();
    showToast('Tüm kaydedilmiş ayak izi rotaları temizlendi 🗑️', 'info');
  }

  function setupTrailEventListeners() {
    if (btnToggleTrailRecord) {
      btnToggleTrailRecord.addEventListener('click', () => {
        if (state.trailTrackingActive) {
          stopTrailTracking();
        } else {
          startTrailTracking();
        }
      });
    }

    if (toggleShowTrails) {
      toggleShowTrails.addEventListener('change', (e) => {
        toggleTrailsVisibility(e.target.checked);
      });
    }

    if (inputTrailColorPicker) {
      inputTrailColorPicker.addEventListener('input', (e) => {
        setTrailColor(e.target.value);
      });
    }

    document.querySelectorAll('.trail-color-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const c = btn.dataset.color;
        if (c) setTrailColor(c);
      });
    });

    if (btnClearSavedTrails) {
      btnClearSavedTrails.addEventListener('click', () => {
        if (confirm('Kayıtlı tüm geçmiş ayak izi rotalarını silmek istediğinize emin misiniz?')) {
          clearSavedTrails();
        }
      });
    }
  }

  // --- MERKEZİ KULLANICI KONUMU & GPS SAPMA (DRIFT) FİLTRESİ ---
  function updateUserLocationMarker(lat, lng, accuracy, altitude, force = false) {
    // GPS Sapma / Drift Koruması:
    // Eğer elimizde zaten iyi bir GPS konumu varsa (accuracy <= 35m) ve gelen yeni sinyal baz istasyonu sapmasıysa (accuracy > 80m),
    // kullanıcının haritada aniden kilometrelerce uzağa zıplamasını engelle!
    if (!force && state.currentLocation && state.currentLocation.accuracy && state.currentLocation.accuracy <= 35 && accuracy && accuracy > 80) {
      console.warn('GPS Sapması (Drift) engellendi:', accuracy, 'metre hata payı');
      return;
    }

    state.currentLocation = {
      lat,
      lng,
      altitude: altitude !== null && altitude !== undefined ? altitude : (state.currentLocation ? state.currentLocation.altitude : null),
      accuracy: accuracy || null
    };

    if (state.userMarker) {
      state.userMarker.setLatLng([lat, lng]);
    } else {
      const userIcon = L.divIcon({
        className: 'pulse-user-marker',
        iconSize: [24, 24],
        iconAnchor: [12, 12]
      });
      state.userMarker = L.marker([lat, lng], { icon: userIcon }).addTo(state.map);
    }

    // Doğruluk Halesi (Accuracy Circle)
    if (accuracy && accuracy > 0) {
      const circleRadius = Math.max(10, Math.min(300, accuracy));
      if (!state.accuracyCircle) {
        state.accuracyCircle = L.circle([lat, lng], {
          radius: circleRadius,
          color: '#10b981',
          weight: 1,
          fillColor: '#10b981',
          fillOpacity: 0.12
        }).addTo(state.map);
      } else {
        state.accuracyCircle.setLatLng([lat, lng]);
        state.accuracyCircle.setRadius(circleRadius);
      }
    }
  }

  function setupProximityTracking() {
    if (!navigator.geolocation) return;

    if ('Notification' in window && Notification.permission === 'granted') {
      state.notificationsEnabled = true;
    }
    updateNotifSettingsUI();

    state.proximityWatchId = navigator.geolocation.watchPosition(
      (pos) => {
        const uLat = pos.coords.latitude;
        const uLng = pos.coords.longitude;
        const altitude = pos.coords.altitude ? Math.round(pos.coords.altitude) : null;
        const accuracy = pos.coords.accuracy ? Math.round(pos.coords.accuracy) : null;

        // Anti-Drift and User Marker Update
        updateUserLocationMarker(uLat, uLng, accuracy, altitude);

        // Record trail breadcrumb if tracking is active
        recordTrailPoint(uLat, uLng, accuracy);

        checkProximityToSavedLocations(uLat, uLng);
      },
      (err) => {},
      { enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 }
    );
  }

  function checkProximityToSavedLocations(userLat, userLng) {
    if (!state.notifyOnProximity) return;
    if (!state.locations || state.locations.length === 0) return;

    const threshold = Math.max(1, Math.min(1000, parseInt(state.proximityDistanceMeters, 10) || 250));

    state.locations.forEach(loc => {
      const dist = getDistanceMeters(userLat, userLng, loc.lat, loc.lng);

      if (dist <= threshold) {
        if (!state.notifiedLocationIds.has(loc.id)) {
          triggerProximityAlert(loc, Math.round(dist));
          state.notifiedLocationIds.add(loc.id);
        }
      } else if (dist > threshold * 1.5) {
        state.notifiedLocationIds.delete(loc.id);
      }
    });
  }

  function triggerProximityAlert(loc, distanceMeters) {
    playProximityChime();

    if (navigator.vibrate) {
      navigator.vibrate([300, 100, 300, 100, 400]);
    }

    sendNativeNotification(`Konuma Yaklaştınız! 📍 ${loc.title}`, {
      body: `${distanceMeters}m yakındasınız. Rakım: ${loc.altitude ? loc.altitude + 'm' : 'Belirtilmedi'}. Not: ${loc.note || 'Not bulunmuyor'}`,
      icon: './icon.svg',
      badge: './icon.svg',
      vibrate: [300, 100, 300, 100, 400],
      tag: 'proximity_' + loc.id
    });

    proxTitle.textContent = loc.title;
    proxDistance.textContent = `Yaklaşık ${distanceMeters} metre yakındasınız (${loc.category})`;
    proximityAlertBanner.classList.remove('hidden');
    proximityAlertBanner.classList.add('flex');

    proximityAlertBanner.onclick = () => {
      state.map.flyTo([loc.lat, loc.lng], 17, { duration: 1.2 });
      window.appOpenLocation(loc.id);
      proximityAlertBanner.classList.add('hidden');
      proximityAlertBanner.classList.remove('flex');
    };
  }

  btnCloseProximityBanner.addEventListener('click', (e) => {
    e.stopPropagation();
    proximityAlertBanner.classList.add('hidden');
    proximityAlertBanner.classList.remove('flex');
  });

  // 4. LOAD INITIAL DATA
  async function loadInitialData() {
    const cached = localStorage.getItem('cached_locations');
    if (cached) {
      try {
        state.locations = JSON.parse(cached);
        updateLocationsCount();
        rebuildAllMarkers();
        renderDrawerList();
      } catch (e) {}
    }

    try {
      const res = await fetch(`${API_BASE}/api/locations`, { signal: AbortSignal.timeout(4000) });
      if (res.ok) {
        const json = await res.json();
        if (json.success && Array.isArray(json.data)) {
          state.locations = json.data;
          localStorage.setItem('cached_locations', JSON.stringify(state.locations));
          updateLocationsCount();
          rebuildAllMarkers();
          renderDrawerList();
          updateConnectionBadge(true);
        }
      }
    } catch (err) {
      updateConnectionBadge(false);
    }
  }

  // 5. ELEVATION API
  async function fetchElevation(lat, lng) {
    try {
      const res = await fetch(`https://api.open-meteo.com/v1/elevation?latitude=${lat}&longitude=${lng}`, { signal: AbortSignal.timeout(2500) });
      if (res.ok) {
        const data = await res.json();
        if (data.elevation && data.elevation.length > 0) return Math.round(data.elevation[0]);
      }
    } catch (e) {}

    try {
      const res = await fetch(`https://api.open-elevation.com/api/v1/lookup?locations=${lat},${lng}`, { signal: AbortSignal.timeout(2500) });
      if (res.ok) {
        const data = await res.json();
        if (data.results && data.results.length > 0) return Math.round(data.results[0]);
      }
    } catch (e) {}
    return null;
  }

  // 6. GPS GEOLOCATION
  async function getCurrentGpsLocation() {
    if (!navigator.geolocation) {
      showToast('Cihazınız konum servisini desteklemiyor.', 'error');
      return;
    }

    // Hızlı yol: Eğer arka plandaki konum zaten hazırsa hemen modalı aç
    if (state.currentLocation && state.currentLocation.lat && state.currentLocation.lng) {
      const pt = state.currentLocation;
      state.map.setView([pt.lat, pt.lng], 16);
      updateUserLocationMarker(pt.lat, pt.lng, pt.accuracy, pt.altitude, true);
      openNewLocationModal(pt);
      return;
    }

    btnGetLocation.disabled = true;
    const originalContent = btnGetLocation.innerHTML;
    btnGetLocation.innerHTML = `
      <div class="flex items-center gap-3 p-2">
        <i class="fa-solid fa-spinner fa-spin text-base text-white"></i>
        <div class="text-xs font-bold text-white">Konum ve Fiziki Rakım Alınıyor...</div>
      </div>
    `;

    const handleGpsSuccess = (pos) => {
      btnGetLocation.disabled = false;
      btnGetLocation.innerHTML = originalContent;

      const coords = pos.coords;
      const lat = coords.latitude;
      const lng = coords.longitude;
      const accuracy = coords.accuracy ? Math.round(coords.accuracy) : null;
      let altitude = coords.altitude ? Math.round(coords.altitude) : null;

      state.map.setView([lat, lng], 16);
      updateUserLocationMarker(lat, lng, accuracy, altitude, true);
      recordTrailPoint(lat, lng, accuracy);

      openNewLocationModal({ lat, lng, altitude, accuracy });
    };

    navigator.geolocation.getCurrentPosition(
      handleGpsSuccess,
      (err) => {
        // İkinci deneme: Şebeke / WiFi bazlı hızlı konum
        navigator.geolocation.getCurrentPosition(
          handleGpsSuccess,
          (fallbackErr) => {
            btnGetLocation.disabled = false;
            btnGetLocation.innerHTML = originalContent;
            showToast('Konum alınamadı: ' + (fallbackErr.message || err.message || 'Lütfen GPS izni verin'), 'error');
          },
          { enableHighAccuracy: false, timeout: 5000, maximumAge: 30000 }
        );
      },
      { enableHighAccuracy: true, timeout: 6000, maximumAge: 10000 }
    );
  }

  // 6. REFRESH & SHOW LIVE POSITION (RIGHT CROSSHAIR BUTTON - NO MODAL)
  function refreshLivePositionAndCenter(animate = true) {
    if (!navigator.geolocation) {
      showToast('Cihazınız konum servisini desteklemiyor.', 'error');
      return;
    }

    const updateMarkerAndMap = (lat, lng, altitude, accuracy) => {
      updateUserLocationMarker(lat, lng, accuracy, altitude, true);
      recordTrailPoint(lat, lng, accuracy);
      if (animate) {
        state.map.flyTo([lat, lng], 16, { duration: 1.2 });
      } else {
        state.map.setView([lat, lng], 16);
      }
    };

    // Varsa mevcut konumu anında göster
    if (state.currentLocation && state.currentLocation.lat && state.currentLocation.lng) {
      updateMarkerAndMap(
        state.currentLocation.lat,
        state.currentLocation.lng,
        state.currentLocation.altitude,
        state.currentLocation.accuracy
      );
      showToast('Canlı konum gösteriliyor 🎯', 'info');
    } else {
      showToast('Canlı konum alınıyor...', 'info');
    }

    // Donanım / ağdan anlık GPS güncellemesi al
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const coords = pos.coords;
        const lat = coords.latitude;
        const lng = coords.longitude;
        const accuracy = coords.accuracy ? Math.round(coords.accuracy) : null;
        let altitude = coords.altitude ? Math.round(coords.altitude) : null;
        updateMarkerAndMap(lat, lng, altitude, accuracy);
        showToast('Canlı konum güncellendi 📍', 'success');
      },
      (err) => {
        navigator.geolocation.getCurrentPosition(
          (fallbackPos) => {
            const coords = fallbackPos.coords;
            updateMarkerAndMap(coords.latitude, coords.longitude, null, coords.accuracy);
            showToast('Canlı konum güncellendi 📍', 'success');
          },
          (fallbackErr) => {
            showToast('Konum alınamadı: ' + (fallbackErr.message || err.message), 'error');
          },
          { enableHighAccuracy: false, timeout: 5000, maximumAge: 30000 }
        );
      },
      { enableHighAccuracy: true, timeout: 6000, maximumAge: 5000 }
    );
  }

  // Alt Buton: Konumumu Al & Kaydet (Modalı Açar)
  btnGetLocation.addEventListener('click', getCurrentGpsLocation);

  // Sağ Buton: Canlı Konumu Göster / Güncelle (Modalı ASLA açmaz, sadece haritayı ortalar)
  btnCenterMe.addEventListener('click', () => {
    refreshLivePositionAndCenter(true);
  });

  btnFitAll.addEventListener('click', () => {
    if (state.locations.length === 0) {
      showToast('Henüz kayıtlı konum yok.');
      return;
    }
    const bounds = L.latLngBounds(state.locations.map(l => [l.lat, l.lng]));
    state.map.fitBounds(bounds, { padding: [60, 60], maxZoom: 15 });
  });

  // 7. OPEN NEW LOCATION MODAL
  async function openNewLocationModal(point) {
    state.tempPoint = point;
    state.selectedNewFiles = [];
    newPhotoPreviews.innerHTML = '';
    formNewLocation.reset();

    const lat = point.lat.toFixed(5);
    const lng = point.lng.toFixed(5);
    rawLat.value = point.lat;
    rawLng.value = point.lng;
    rawAccuracy.value = point.accuracy || '';

    displayLat.textContent = `${lat}°`;
    displayLng.textContent = `${lng}°`;

    const now = new Date();
    displayDateTime.textContent = now.toLocaleDateString('tr-TR', { day: '2-digit', month: 'short' }) + ' ' + now.toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' });

    if (point.altitude !== undefined && point.altitude !== null) {
      displayAltitude.textContent = `${point.altitude} m`;
      rawAltitude.value = point.altitude;
      altitudeStatusBadge.textContent = 'GPS Rakımı';
      altitudeStatusBadge.className = 'text-[10px] px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-300 font-semibold border border-emerald-500/30';
    } else {
      displayAltitude.textContent = 'Hesaplanıyor...';
      altitudeStatusBadge.textContent = 'Fiziki Rakım Alınıyor...';
      altitudeStatusBadge.className = 'text-[10px] px-2 py-0.5 rounded-full bg-amber-500/20 text-amber-300 font-semibold border border-amber-500/30';

      fetchElevation(point.lat, point.lng).then(elev => {
        if (elev !== null) {
          displayAltitude.textContent = `${elev} m`;
          rawAltitude.value = elev;
          altitudeStatusBadge.textContent = 'Fiziki Rakım Tespit Edildi';
          altitudeStatusBadge.className = 'text-[10px] px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-300 font-semibold border border-emerald-500/30';
        } else {
          displayAltitude.textContent = 'Bilinmiyor';
          altitudeStatusBadge.textContent = 'Rakım Alınamadı';
          altitudeStatusBadge.className = 'text-[10px] px-2 py-0.5 rounded-full bg-slate-700 text-slate-300 font-semibold';
        }
      });
    }

    modalNewLocation.classList.remove('hidden');
    modalNewLocation.classList.add('flex');
    setTimeout(() => newTitle.focus(), 150);
  }

  // Handle Photos
  function handlePhotoSelect(files) {
    Array.from(files).forEach(file => {
      const reader = new FileReader();
      reader.onload = (ev) => {
        file._dataUrl = ev.target.result;
        state.selectedNewFiles.push(file);
        const thumb = document.createElement('div');
        thumb.className = 'relative w-16 h-16 rounded-xl overflow-hidden border border-white/20 bg-slate-800 flex-shrink-0 group shadow-md';
        thumb.innerHTML = `
          <img src="${ev.target.result}" class="w-full h-full object-cover">
          <button type="button" class="absolute top-1 right-1 bg-red-600/90 text-white w-4 h-4 rounded-full flex items-center justify-center text-[10px]">&times;</button>
        `;
        thumb.querySelector('button').addEventListener('click', () => {
          state.selectedNewFiles = state.selectedNewFiles.filter(f => f !== file);
          thumb.remove();
        });
        newPhotoPreviews.appendChild(thumb);
      };
      reader.readAsDataURL(file);
    });
  }

  if (inputCameraPhoto) {
    inputCameraPhoto.addEventListener('change', (e) => {
      handlePhotoSelect(e.target.files);
      e.target.value = '';
    });
  }
  if (inputGalleryPhoto) {
    inputGalleryPhoto.addEventListener('change', (e) => {
      handlePhotoSelect(e.target.files);
      e.target.value = '';
    });
  }

  // SUBMIT NEW LOCATION
  formNewLocation.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btnSubmit = document.getElementById('btnSubmitNewLocation');
    btnSubmit.disabled = true;
    btnSubmit.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Kaydediliyor...`;

    try {
      const payload = {
        title: newTitle.value.trim() || 'Yeni Konum',
        category: newCategory.value,
        note: newNote.value.trim(),
        author: newAuthor.value.trim() || 'Gezgin',
        lat: parseFloat(rawLat.value),
        lng: parseFloat(rawLng.value),
        altitude: rawAltitude.value ? parseFloat(rawAltitude.value) : null,
        accuracy: rawAccuracy.value ? parseFloat(rawAccuracy.value) : null
      };

      let savedLocation = null;

      // Yalnızca sunucuya bağlıysa ve hızlı yanıt veriyorsa (1.2 saniye zaman aşımı)
      if (state.isConnected) {
        try {
          const res = await fetch(`${API_BASE}/api/locations`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(1200)
          });
          const data = await res.json();
          if (data.success) savedLocation = data.data;
        } catch (netErr) {
          console.warn('Sunucuya ulaşılamadı, anında yerel hafızaya kaydediliyor:', netErr);
        }
      }

      // Çevrimdışı / Bağımsız mod: Anında yerel kayıt
      if (!savedLocation) {
        const now = new Date();
        const localImages = state.selectedNewFiles.map(f => f._dataUrl).filter(Boolean);
        savedLocation = {
          id: 'loc_local_' + Date.now(),
          ...payload,
          date: now.toLocaleDateString('tr-TR', { day: '2-digit', month: 'long', year: 'numeric' }),
          time: now.toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' }),
          timestamp: now.toISOString(),
          images: localImages
        };
        state.locations.unshift(savedLocation);
        localStorage.setItem('cached_locations', JSON.stringify(state.locations));
        if (state.showMarkers) addMarkerToMap(savedLocation);
        updateLocationsCount();
        renderDrawerList();
      }

      // Fotoğraf yükleme (Sadece bağlı sunucu varsa)
      if (state.isConnected && state.selectedNewFiles.length > 0 && !savedLocation.id.startsWith('loc_local_')) {
        try {
          const formData = new FormData();
          state.selectedNewFiles.forEach(file => formData.append('photos', file));
          await fetch(`${API_BASE}/api/locations/${savedLocation.id}/images`, {
            method: 'POST',
            body: formData,
            signal: AbortSignal.timeout(2500)
          });
        } catch (imgErr) {
          console.warn('Upload error:', imgErr);
        }
      }

      closeModals();
      showToast('Konum başarıyla kaydedildi!', 'success');
      state.map.setView([savedLocation.lat, savedLocation.lng], 16);

      // Haritaya ekleme yapıldığında bildirim gönder
      if (state.notifyOnNewLocation) {
        playNewLocationChime();
        sendNativeNotification(`🗺️ Konumunuz Kaydedildi: ${savedLocation.title}`, {
          body: `"${savedLocation.title}" (${savedLocation.category}) başarıyla haritaya eklendi.`,
          icon: './icon.svg',
          vibrate: [200, 100, 200]
        });
      }
    } catch (err) {
      showToast('Hata: ' + err.message, 'error');
    } finally {
      btnSubmit.disabled = false;
      btnSubmit.innerHTML = `<i class="fa-solid fa-check"></i> <span>Konumu Kaydet</span>`;
    }
  });

  // 8. RENDER MARKERS ON MAP
  function createCustomPinIcon(category) {
    const config = categoryConfig[category] || categoryConfig['Diğer'];
    return L.divIcon({
      className: 'custom-pin-wrapper',
      html: `
        <div class="custom-pin" style="background-color: ${config.color};">
          <i class="fa-solid ${config.icon}"></i>
        </div>
      `,
      iconSize: [40, 40],
      iconAnchor: [20, 40],
      popupAnchor: [0, -40]
    });
  }

  function addMarkerToMap(loc) {
    if (state.markers[loc.id]) {
      state.markerGroup.removeLayer(state.markers[loc.id]);
    }

    const icon = createCustomPinIcon(loc.category);
    const marker = L.marker([loc.lat, loc.lng], { icon });

    const firstImg = loc.images && loc.images.length > 0 ? getFullImageUrl(loc.images[0]) : null;
    const cat = categoryConfig[loc.category] || categoryConfig['Diğer'];

    const popupHtml = `
      <div class="w-64 overflow-hidden cursor-pointer" onclick="window.appOpenLocation('${loc.id}')">
        ${firstImg ? `<div class="w-full h-32 bg-slate-900 overflow-hidden"><img src="${firstImg}" class="w-full h-full object-cover"></div>` : ''}
        <div class="p-3.5">
          <div class="flex items-center justify-between mb-1.5">
            <span class="text-[10px] font-bold px-2 py-0.5 rounded-full ${cat.bg} ${cat.text} border ${cat.border}">${loc.category}</span>
            <span class="text-[10px] text-emerald-400 font-bold font-mono">${loc.altitude !== null ? '🏔️ ' + loc.altitude + ' m' : ''}</span>
          </div>
          <h4 class="font-extrabold text-xs text-white line-clamp-1">${escapeHtml(loc.title)}</h4>
          <p class="text-[11px] text-slate-300 line-clamp-2 mt-1 leading-relaxed">${escapeHtml(loc.note || 'Not eklenmemiş.')}</p>
          <div class="flex items-center justify-between mt-2.5 pt-2 border-t border-white/10 text-[10px] text-slate-400">
            <span>${loc.date}</span>
            <span class="text-emerald-400 font-bold flex items-center gap-1">Detayları Aç <i class="fa-solid fa-arrow-right text-[9px]"></i></span>
          </div>
        </div>
      </div>
    `;

    marker.bindPopup(popupHtml);
    state.markerGroup.addLayer(marker);
    state.markers[loc.id] = marker;
  }

  function removeMarkerFromMap(id) {
    if (state.markers[id]) {
      state.markerGroup.removeLayer(state.markers[id]);
      delete state.markers[id];
    }
  }

  function rebuildAllMarkers() {
    state.markerGroup.clearLayers();
    state.markers = {};
    if (state.showMarkers) {
      state.locations.forEach(addMarkerToMap);
    }
  }

  // 9. VIEW / EDIT MODAL
  window.appOpenLocation = function(id) {
    const loc = state.locations.find(l => l.id === id);
    if (!loc) return;
    state.selectedLocation = loc;

    const cat = categoryConfig[loc.category] || categoryConfig['Diğer'];
    viewCategoryBadge.textContent = loc.category;
    viewCategoryBadge.className = `text-xs px-3 py-1 rounded-full ${cat.bg} ${cat.text} ${cat.border} font-bold`;

    viewTitle.textContent = loc.title;
    viewNoteText.value = loc.note || '';
    btnSaveNoteEdit.classList.add('hidden');

    viewDate.textContent = loc.date || '-';
    viewTime.textContent = loc.time || '-';
    viewAltitude.textContent = loc.altitude !== null ? `${loc.altitude} metre` : 'Belirtilmemiş';
    viewAuthor.textContent = loc.author || 'Gezgin';

    viewCoordinates.textContent = `${loc.lat.toFixed(5)}°, ${loc.lng.toFixed(5)}°`;
    viewAccuracy.textContent = loc.accuracy ? `(±${loc.accuracy}m)` : '';

    btnGoogleDirections.href = `https://www.google.com/maps/dir/?api=1&destination=${loc.lat},${loc.lng}`;

    renderViewImages(loc);

    modalViewLocation.classList.remove('hidden');
    modalViewLocation.classList.add('flex');
  };

  function renderViewImages(loc) {
    const images = loc.images || [];
    viewThumbnailsStrip.innerHTML = '';

    if (images.length === 0) {
      viewMainImage.classList.add('hidden');
      viewNoImagePlaceholder.classList.remove('hidden');
    } else {
      viewNoImagePlaceholder.classList.add('hidden');
      viewMainImage.classList.remove('hidden');
      viewMainImage.src = getFullImageUrl(images[0]);

      images.forEach((rawImgUrl, idx) => {
        const fullUrl = getFullImageUrl(rawImgUrl);
        const thumb = document.createElement('div');
        thumb.className = `relative w-14 h-14 rounded-xl overflow-hidden border ${idx === 0 ? 'border-emerald-500 scale-105' : 'border-white/10 opacity-70'} cursor-pointer flex-shrink-0 transition-all`;
        thumb.innerHTML = `
          <img src="${fullUrl}" class="w-full h-full object-cover">
          <button title="Görseli Sil" class="absolute top-1 right-1 bg-black/80 hover:bg-red-600 text-white w-4 h-4 rounded-full flex items-center justify-center text-[10px]">&times;</button>
        `;

        thumb.querySelector('img').addEventListener('click', () => {
          viewMainImage.src = fullUrl;
          document.querySelectorAll('#viewThumbnailsStrip > div').forEach(d => d.className = 'relative w-14 h-14 rounded-xl overflow-hidden border border-white/10 opacity-70 cursor-pointer flex-shrink-0 transition-all');
          thumb.className = 'relative w-14 h-14 rounded-xl overflow-hidden border border-emerald-500 scale-105 cursor-pointer flex-shrink-0 transition-all';
        });

        thumb.querySelector('button').addEventListener('click', async (e) => {
          e.stopPropagation();
          if (confirm('Bu görseli silmek istediğinizden emin misiniz?')) {
            try {
              const res = await fetch(`${API_BASE}/api/locations/${loc.id}/images`, {
                method: 'DELETE',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ imageUrl: rawImgUrl })
              });
              const data = await res.json();
              if (data.success) {
                loc.images = data.images;
                renderViewImages(loc);
                showToast('Fotoğraf silindi');
              }
            } catch (err) {
              showToast('Silme hatası', 'error');
            }
          }
        });

        viewThumbnailsStrip.appendChild(thumb);
      });
    }
  }

  viewMainImage.addEventListener('click', () => {
    if (viewMainImage.src) {
      lightboxImage.src = viewMainImage.src;
      lightboxModal.classList.remove('hidden');
      lightboxModal.classList.add('flex');
    }
  });

  lightboxModal.addEventListener('click', () => {
    lightboxModal.classList.add('hidden');
    lightboxModal.classList.remove('flex');
  });

  viewAddMorePhotos.addEventListener('change', async (e) => {
    if (!state.selectedLocation) return;
    const files = Array.from(e.target.files);
    if (files.length === 0) return;

    const formData = new FormData();
    files.forEach(file => formData.append('photos', file));

    showToast('Fotoğraflar yükleniyor...');
    try {
      const res = await fetch(`${API_BASE}/api/locations/${state.selectedLocation.id}/images`, {
        method: 'POST',
        body: formData
      });
      const data = await res.json();
      if (data.success) {
        state.selectedLocation.images = data.images;
        renderViewImages(state.selectedLocation);
        showToast('Fotoğraflar eklendi!', 'success');
      }
    } catch (err) {
      showToast('Yükleme hatası', 'error');
    }
  });

  viewNoteText.addEventListener('input', () => {
    btnSaveNoteEdit.classList.remove('hidden');
  });

  btnSaveNoteEdit.addEventListener('click', async () => {
    if (!state.selectedLocation) return;
    btnSaveNoteEdit.textContent = 'Kaydediliyor...';
    try {
      const res = await fetch(`${API_BASE}/api/locations/${state.selectedLocation.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ note: viewNoteText.value })
      });
      const data = await res.json();
      if (data.success) {
        state.selectedLocation.note = viewNoteText.value;
        btnSaveNoteEdit.classList.add('hidden');
        btnSaveNoteEdit.textContent = 'Kaydet';
        showToast('Not güncellendi!', 'success');
      }
    } catch (err) {
      showToast('Güncelleme hatası', 'error');
    }
  });

  btnDeleteLocation.addEventListener('click', () => {
    if (!state.selectedLocation) return;
    if (confirmDeleteMsg) {
      confirmDeleteMsg.textContent = `"${state.selectedLocation.title}" konumunu kalıcı olarak silmek istediğinizden emin misiniz?`;
    }
    if (modalConfirmDelete) {
      modalConfirmDelete.classList.remove('hidden');
      modalConfirmDelete.classList.add('flex');
    }
  });

  if (btnCancelDelete) {
    btnCancelDelete.addEventListener('click', () => {
      if (modalConfirmDelete) {
        modalConfirmDelete.classList.add('hidden');
        modalConfirmDelete.classList.remove('flex');
      }
    });
  }

  async function deleteLocationById(locId, locTitle) {
    if (!locId) return;

    // 1. Yerel hafıza ve state'ten sil
    state.locations = state.locations.filter(l => l.id !== locId);
    localStorage.setItem('cached_locations', JSON.stringify(state.locations));

    // 2. Haritadaki pini kaldır
    if (state.markers[locId]) {
      state.markerGroup.removeLayer(state.markers[locId]);
      delete state.markers[locId];
    }

    // 3. Çekmece listesi ve sayaçları güncelle
    updateLocationsCount();
    renderDrawerList();

    // 4. Modalları kapat ve bildirim ver
    if (modalConfirmDelete) {
      modalConfirmDelete.classList.add('hidden');
      modalConfirmDelete.classList.remove('flex');
    }
    closeModals();
    showToast(`"${locTitle || 'Konum'}" başarıyla silindi.`, 'info');

    // 5. Sunucu bağlıysa ve yerel ID değilse sunucudan da sil
    if (state.isConnected && !locId.startsWith('loc_local_')) {
      try {
        fetch(`${API_BASE}/api/locations/${locId}`, {
          method: 'DELETE',
          signal: AbortSignal.timeout(1500)
        }).catch(() => {});
      } catch (e) {}
    }
  }

  if (btnApproveDelete) {
    btnApproveDelete.addEventListener('click', () => {
      const loc = state.selectedLocation;
      if (loc) {
        deleteLocationById(loc.id, loc.title);
      }
    });
  }

  // 10. SIDEBAR DRAWER & LIST VIEW
  btnToggleList.addEventListener('click', () => {
    sideDrawer.classList.toggle('translate-x-full');
  });

  btnCloseDrawer.addEventListener('click', () => {
    sideDrawer.classList.add('translate-x-full');
  });

  document.querySelectorAll('.cat-filter').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.cat-filter').forEach(b => {
        b.classList.remove('active', 'bg-emerald-500/20', 'text-emerald-300', 'border-emerald-500/30');
        b.classList.add('bg-slate-800/80', 'text-slate-300', 'border-white/10');
      });
      btn.classList.add('active', 'bg-emerald-500/20', 'text-emerald-300', 'border-emerald-500/30');
      btn.classList.remove('bg-slate-800/80', 'text-slate-300', 'border-white/10');

      state.activeCategoryFilter = btn.dataset.cat;
      renderDrawerList();
    });
  });

  mapSearchInput.addEventListener('input', (e) => {
    state.searchQuery = e.target.value.toLowerCase().trim();
    drawerSearchInput.value = e.target.value;
    renderDrawerList();
  });

  drawerSearchInput.addEventListener('input', (e) => {
    state.searchQuery = e.target.value.toLowerCase().trim();
    mapSearchInput.value = e.target.value;
    renderDrawerList();
  });

  function renderDrawerList() {
    drawerListContainer.innerHTML = '';

    const filtered = state.locations.filter(loc => {
      const matchCat = state.activeCategoryFilter === 'all' || loc.category === state.activeCategoryFilter;
      const matchQuery = !state.searchQuery || 
        (loc.title && loc.title.toLowerCase().includes(state.searchQuery)) ||
        (loc.note && loc.note.toLowerCase().includes(state.searchQuery)) ||
        (loc.author && loc.author.toLowerCase().includes(state.searchQuery));
      return matchCat && matchQuery;
    });

    if (filtered.length === 0) {
      drawerListContainer.innerHTML = `
        <div class="text-center py-16 text-slate-500">
          <i class="fa-solid fa-map-location-dot text-4xl mb-3 opacity-60"></i>
          <p class="text-xs font-semibold">Kayıtlı seyahat noktası bulunamadı</p>
        </div>
      `;
      return;
    }

    filtered.forEach(loc => {
      const cat = categoryConfig[loc.category] || categoryConfig['Diğer'];
      const card = document.createElement('div');
      card.className = 'relative overflow-hidden p-3 bg-slate-900/80 hover:bg-slate-800/90 border border-white/10 hover:border-emerald-500/40 rounded-2xl cursor-pointer group transition-all duration-200 shadow-sm select-none';
      card.innerHTML = `
        <div class="flex items-start gap-3">
          <div class="w-12 h-12 rounded-xl bg-slate-800 border border-white/10 flex-shrink-0 overflow-hidden flex items-center justify-center">
            ${loc.images && loc.images.length > 0 ? 
              `<img src="${getFullImageUrl(loc.images[0])}" class="w-full h-full object-cover">` : 
              `<i class="fa-solid ${cat.icon} text-lg" style="color: ${cat.color}"></i>`
            }
          </div>
          <div class="flex-1 min-w-0">
            <div class="flex items-center justify-between gap-1">
              <h4 class="font-extrabold text-xs text-white truncate group-hover:text-emerald-400 transition-colors">${escapeHtml(loc.title)}</h4>
              <span class="text-[10px] text-emerald-400 font-bold font-mono flex-shrink-0">${loc.altitude !== null ? '🏔️ ' + loc.altitude + ' m' : ''}</span>
            </div>
            <p class="text-[11px] text-slate-400 line-clamp-1 mt-1">${escapeHtml(loc.note || 'Not eklenmemiş.')}</p>
            <div class="flex items-center justify-between mt-2 text-[10px] text-slate-500">
              <span class="px-2 py-0.5 rounded-full ${cat.bg} ${cat.text} font-bold">${loc.category}</span>
              <span>${loc.date}</span>
            </div>
          </div>
        </div>

        <!-- Uzun Basınca Açılan Silme Çubuğu -->
        <div class="card-delete-bar hidden absolute inset-0 bg-red-950/95 backdrop-blur-md rounded-2xl border border-red-500/70 p-3 items-center justify-between z-10 transition-all">
          <div class="flex items-center gap-2 text-white min-w-0">
            <div class="w-7 h-7 rounded-lg bg-red-500/20 text-red-400 flex items-center justify-center flex-shrink-0 text-xs">
              <i class="fa-solid fa-trash-can"></i>
            </div>
            <span class="text-xs font-bold truncate">"${escapeHtml(loc.title)}" silinsin mi?</span>
          </div>
          <div class="flex items-center gap-2 flex-shrink-0">
            <button type="button" class="btn-cancel-card-delete px-2.5 py-1.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-semibold active:scale-95 transition-transform">Vazgeç</button>
            <button type="button" class="btn-confirm-card-delete px-3 py-1.5 rounded-xl bg-red-600 hover:bg-red-500 text-white text-xs font-bold shadow-lg shadow-red-600/40 active:scale-95 flex items-center gap-1 transition-transform">
              <i class="fa-solid fa-trash-can text-[10px]"></i> Sil
            </button>
          </div>
        </div>
      `;

      let pressTimer = null;
      let isLongPress = false;
      let touchStartX = 0, touchStartY = 0;

      const deleteBar = card.querySelector('.card-delete-bar');
      const btnCancel = card.querySelector('.btn-cancel-card-delete');
      const btnConfirm = card.querySelector('.btn-confirm-card-delete');

      btnCancel.addEventListener('click', (e) => {
        e.stopPropagation();
        deleteBar.classList.add('hidden');
        deleteBar.classList.remove('flex');
      });

      btnConfirm.addEventListener('click', (e) => {
        e.stopPropagation();
        deleteLocationById(loc.id, loc.title);
      });

      const startPress = (e) => {
        isLongPress = false;
        const pt = e.touches ? e.touches[0] : e;
        touchStartX = pt.clientX;
        touchStartY = pt.clientY;
        pressTimer = setTimeout(() => {
          isLongPress = true;
          if ('vibrate' in navigator) {
            try { navigator.vibrate(60); } catch(err) {}
          }
          document.querySelectorAll('.card-delete-bar').forEach(b => {
            b.classList.add('hidden');
            b.classList.remove('flex');
          });
          deleteBar.classList.remove('hidden');
          deleteBar.classList.add('flex');
        }, 500);
      };

      const cancelPress = () => {
        if (pressTimer) {
          clearTimeout(pressTimer);
          pressTimer = null;
        }
      };

      const movePress = (e) => {
        if (!pressTimer) return;
        const pt = e.touches ? e.touches[0] : e;
        if (Math.abs(pt.clientX - touchStartX) > 10 || Math.abs(pt.clientY - touchStartY) > 10) {
          cancelPress();
        }
      };

      card.addEventListener('touchstart', startPress, { passive: true });
      card.addEventListener('touchend', cancelPress);
      card.addEventListener('touchcancel', cancelPress);
      card.addEventListener('touchmove', movePress, { passive: true });
      card.addEventListener('mousedown', startPress);
      card.addEventListener('mouseup', cancelPress);
      card.addEventListener('mouseleave', cancelPress);

      card.addEventListener('click', () => {
        if (isLongPress) {
          isLongPress = false;
          return;
        }
        if (!deleteBar.classList.contains('hidden')) return;

        state.map.flyTo([loc.lat, loc.lng], 16, { duration: 1.2 });
        if (state.markers[loc.id]) {
          state.markers[loc.id].openPopup();
        }
        if (window.innerWidth < 640) {
          sideDrawer.classList.add('translate-x-full');
        }
      });

      drawerListContainer.appendChild(card);
    });
  }

  // 11. SERVER CONFIG MODAL (APK)
  btnServerConfig.addEventListener('click', () => {
    inputServerUrl.value = API_BASE;
    serverTestResult.textContent = '';
    modalServerConfig.classList.remove('hidden');
    modalServerConfig.classList.add('flex');
  });

  btnTestServerConn.addEventListener('click', async () => {
    const url = inputServerUrl.value.trim().replace(/\/+$/, '');
    serverTestResult.innerHTML = `<span class="text-slate-400"><i class="fa-solid fa-spinner fa-spin"></i> Test ediliyor...</span>`;
    try {
      const res = await fetch(`${url}/api/server-info`, { signal: AbortSignal.timeout(3500) });
      if (res.ok) {
        serverTestResult.innerHTML = `<span class="text-emerald-400 font-bold"><i class="fa-solid fa-check"></i> Bağlantı Başarılı!</span>`;
      } else {
        serverTestResult.innerHTML = `<span class="text-red-400 font-bold"><i class="fa-solid fa-xmark"></i> Hata (${res.status})</span>`;
      }
    } catch (e) {
      serverTestResult.innerHTML = `<span class="text-red-400 font-bold"><i class="fa-solid fa-triangle-exclamation"></i> Bağlanılamadı</span>`;
    }
  });

  btnSaveServerUrl.addEventListener('click', () => {
    const url = inputServerUrl.value.trim().replace(/\/+$/, '');
    if (url) {
      localStorage.setItem('travel_map_server_url', url);
      API_BASE = url;
      setupSocket();
      loadInitialData();
      closeModals();
      showToast('Sunucu adresi kaydedildi!', 'success');
    }
  });

  btnResetServerUrl.addEventListener('click', () => {
    localStorage.removeItem('travel_map_server_url');
    API_BASE = resolveApiBase();
    inputServerUrl.value = API_BASE;
    setupSocket();
    loadInitialData();
    showToast('Varsayılan sunucuya dönüldü');
  });

  // 12. SHARE MODAL
  btnShareModal.addEventListener('click', async () => {
    try {
      const res = await fetch(`${API_BASE}/api/server-info`);
      const info = await res.json();
      
      const shareUrl = info.allUsersUrl || API_BASE;
      document.getElementById('shareUrlInput').value = shareUrl;

      const qrcodeContainer = document.getElementById('qrcodeContainer');
      qrcodeContainer.innerHTML = '';
      new QRCode(qrcodeContainer, {
        text: shareUrl,
        width: 170,
        height: 170,
        colorDark: '#090d16',
        colorLight: '#ffffff',
        correctLevel: QRCode.CorrectLevel.M
      });

      modalShare.classList.remove('hidden');
      modalShare.classList.add('flex');
    } catch (e) {
      showToast('Paylaşım bilgisi alınamadı');
    }
  });

  document.getElementById('btnCopyShareUrl').addEventListener('click', () => {
    const input = document.getElementById('shareUrlInput');
    input.select();
    navigator.clipboard.writeText(input.value);
    showToast('Link kopyalandı!', 'success');
  });

  function updateLocationsCount() {
    locationCountBadge.textContent = state.locations.length;
  }

  function closeModals() {
    [modalNewLocation, modalViewLocation, modalShare, modalServerConfig, modalNotifSettings, lightboxModal, modalConfirmDelete].forEach(m => {
      if (m) {
        m.classList.add('hidden');
        m.classList.remove('flex');
      }
    });
  }

  document.querySelectorAll('.btn-close-modal').forEach(btn => {
    btn.addEventListener('click', closeModals);
  });

  window.addEventListener('popstate', () => {
    closeModals();
    sideDrawer.classList.add('translate-x-full');
  });

  function showToast(message, type = 'info') {
    const toast = document.createElement('div');
    const bg = type === 'success' ? 'bg-gradient-to-r from-emerald-600 to-teal-600' : type === 'error' ? 'bg-red-600' : 'bg-slate-900 border border-white/15';
    const icon = type === 'success' ? 'fa-circle-check text-white' : type === 'error' ? 'fa-triangle-exclamation text-white' : 'fa-bell text-emerald-400';

    toast.className = `toast-enter flex items-center gap-3 px-4 py-3 rounded-2xl shadow-2xl text-xs text-white ${bg} pointer-events-auto backdrop-blur-xl border border-white/10`;
    toast.innerHTML = `<i class="fa-solid ${icon} text-sm"></i> <span class="font-medium">${escapeHtml(message)}</span>`;

    toastContainer.appendChild(toast);
    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateY(-10px)';
      toast.style.transition = 'all 0.3s ease';
      setTimeout(() => toast.remove(), 300);
    }, 3500);
  }

  function escapeHtml(str) {
    if (!str) return '';
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // Initialize
  initMap();
  setupSocket();
  updateNotifSettingsUI();
});
