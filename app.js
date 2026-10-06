"use strict";

if ("scrollRestoration" in history) history.scrollRestoration = "manual";
window.scrollTo(0, 0);

const CONFIG = {
  weights: { geology: 7.51, soil: 36.45, slope: 38.47, hydro: 17.57 },
  labels: { geology: "Géologie", soil: "Pédologie", slope: "Pente", hydro: "Hydrographie" },
  landcover: { 1: "Végétation", 2: "Sol nu", 3: "Habitat", 4: "Eau", 5: "Culture" },
  susceptibility: { 1: "Faible", 2: "Moyenne", 3: "Forte" },
  colors: { low: "#2f855a", medium: "#d97706", high: "#b42318" },
  center: [10.285, -3.205],
};

const state = {
  data: null,
  selected: null,
  weights: { ...CONFIG.weights },
  scores: {},
  originalScores: {},
  markers: new Map(),
  buffers: new Map(),
  importedLayer: null,
  analysePoint: false,
  radius: 2000,
  grids: null,
  lastPoint: null,
  updateLog: [],
};

const map = L.map("map", { zoomControl: true, preferCanvas: true }).setView(CONFIG.center, 11);
const streetLayer = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution: "&copy; contributeurs OpenStreetMap",
}).addTo(map);
const sitesLayer = L.layerGroup().addTo(map);
const buffersLayer = L.layerGroup().addTo(map);
const pointLayer = L.layerGroup().addTo(map);

function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }
function round(value, digits = 1) { return Number(value).toFixed(digits); }
function fr(value, digits = 1) { return Number(value).toLocaleString("fr-FR", { minimumFractionDigits: digits, maximumFractionDigits: digits }); }
function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[ch]));
}

function normalisedWeights() {
  const total = Object.values(state.weights).reduce((a, b) => a + Number(b), 0) || 1;
  return Object.fromEntries(Object.entries(state.weights).map(([key, value]) => [key, Number(value) / total]));
}

function susceptibilityFromScores(values) {
  const weights = normalisedWeights();
  return Object.keys(weights).reduce((sum, key) => sum + weights[key] * Number(values[key] || 0), 0);
}
function susceptibility(feature) { return susceptibilityFromScores(state.scores[feature.properties.name]); }
function socialUrgency(feature) {
  const p = feature.properties;
  return 0.45 * (100 - p.ica) + 0.35 * (100 - p.knowledge_danger_pct) + 0.20 * (100 - p.sensitized_pct);
}
function priority(feature) {
  const physical = ((susceptibility(feature) - 1) / 4) * 100;
  return clamp(0.65 * physical + 0.35 * socialUrgency(feature), 0, 100);
}
function priorityLevel(score) {
  if (score >= 60) return { key: "high", label: "Élevée" };
  if (score >= 40) return { key: "medium", label: "Modérée" };
  return { key: "low", label: "Faible" };
}

function recommendation(feature) {
  const p = feature.properties;
  const level = priorityLevel(priority(feature));
  if (level.key === "high" && p.sensitized_pct < 10) {
    return ["Vérification environnementale et sensibilisation ciblée", "Programmer une mission de contrôle, documenter les usages de l’eau et déployer une sensibilisation de proximité. La susceptibilité ne constitue pas une mesure de contamination."];
  }
  if (p.ica < 35) {
    return ["Renforcer les capacités locales d’adaptation", "Prioriser l’accès à une source d’eau de remplacement, les relais communautaires et les pratiques sans mercure, puis suivre les indicateurs dans le temps."];
  }
  return ["Surveillance active", "Maintenir une veille, actualiser les couches physiques et contrôler les indicateurs sociaux avant toute décision restrictive."];
}

function popup(feature) {
  const p = feature.properties;
  const score = priority(feature);
  const level = priorityLevel(score);
  return `<h3 class="popup-title">${escapeHtml(p.name)}</h3>
    <div class="popup-kpis">
      <span>Priorité<strong style="color:${CONFIG.colors[level.key]}">${fr(score)} / 100</strong></span>
      <span>Susceptibilité<strong>${fr(susceptibility(feature), 2)} / 5</strong></span>
      <span>Classe cartographique<strong>${escapeHtml(p.susceptibility_label)}</strong></span>
      <span>Occupation au point<strong>${escapeHtml(p.landcover_label)}</strong></span>
      <span>IPRM<strong>${fr(p.iprm)} / 100</strong></span>
      <span>ICA<strong>${fr(p.ica)} / 100</strong></span>
    </div>`;
}

function markerIcon(level, selected = false) {
  const size = selected ? 20 : 15;
  return L.divIcon({
    className: "",
    html: `<div class="site-marker" style="width:${size}px;height:${size}px;background:${CONFIG.colors[level]};"></div>`,
    iconSize: [size, size], iconAnchor: [size / 2, size / 2], popupAnchor: [0, -8],
  });
}

function buildControls() {
  const weightBox = document.getElementById("weightControls");
  const scoreBox = document.getElementById("scoreControls");
  weightBox.innerHTML = "";
  scoreBox.innerHTML = "";
  for (const key of Object.keys(CONFIG.weights)) {
    weightBox.insertAdjacentHTML("beforeend", `<div class="range-row">
      <div class="range-label"><span>${CONFIG.labels[key]}</span><strong id="weightValue-${key}">${fr(normalisedWeights()[key] * 100)} %</strong></div>
      <input type="range" min="1" max="70" step="0.5" value="${state.weights[key]}" data-weight="${key}" aria-label="Poids ${CONFIG.labels[key]}">
    </div>`);
    scoreBox.insertAdjacentHTML("beforeend", `<div class="range-row">
      <div class="range-label"><span>${CONFIG.labels[key]}</span><strong id="scoreValue-${key}">—</strong></div>
      <input type="range" min="1" max="5" step="0.5" value="3" data-score="${key}" aria-label="Score ${CONFIG.labels[key]}">
    </div>`);
  }
  weightBox.addEventListener("input", event => {
    if (!event.target.dataset.weight) return;
    state.weights[event.target.dataset.weight] = Number(event.target.value);
    updateWeightLabels();
    render();
    if (state.lastPoint) analysePoint(state.lastPoint, false);
  });
  scoreBox.addEventListener("input", event => {
    if (!event.target.dataset.score || !state.selected) return;
    state.scores[state.selected][event.target.dataset.score] = Number(event.target.value);
    document.getElementById(`scoreValue-${event.target.dataset.score}`).textContent = fr(event.target.value);
    render();
  });
}

function updateWeightLabels() {
  const weights = normalisedWeights();
  for (const [key, value] of Object.entries(weights)) {
    document.getElementById(`weightValue-${key}`).textContent = `${fr(value * 100)} %`;
  }
}
function updateScoreControls(name) {
  const values = state.scores[name];
  document.querySelectorAll("[data-score]").forEach(input => {
    input.value = values[input.dataset.score];
    document.getElementById(`scoreValue-${input.dataset.score}`).textContent = fr(input.value);
  });
}
function selectSite(name, pan = true) {
  state.selected = name;
  document.getElementById("siteSelect").value = name;
  updateScoreControls(name);
  const feature = state.data.features.find(item => item.properties.name === name);
  if (pan) map.panTo([feature.geometry.coordinates[1], feature.geometry.coordinates[0]]);
  render();
}

function renderMap() {
  const hideLow = document.getElementById("filterToggle").checked;
  for (const feature of state.data.features) {
    const name = feature.properties.name;
    const level = priorityLevel(priority(feature));
    const marker = state.markers.get(name);
    marker.setIcon(markerIcon(level.key, name === state.selected));
    marker.bindPopup(popup(feature));
    const shouldShow = !(hideLow && level.key === "low");
    if (shouldShow && !sitesLayer.hasLayer(marker)) sitesLayer.addLayer(marker);
    if (!shouldShow && sitesLayer.hasLayer(marker)) sitesLayer.removeLayer(marker);
    const buffer = state.buffers.get(name);
    buffer.setRadius(state.radius);
    buffer.setStyle({ color: CONFIG.colors[level.key], fillColor: CONFIG.colors[level.key] });
  }
}

function renderSelected() {
  const feature = state.data.features.find(item => item.properties.name === state.selected);
  const p = feature.properties;
  const score = priority(feature);
  const level = priorityLevel(score);
  const [title, text] = recommendation(feature);
  document.getElementById("resultSite").textContent = p.name;
  const badge = document.getElementById("priorityBadge");
  badge.textContent = `Priorité ${level.label.toLowerCase()}`;
  badge.className = `priority-badge ${level.key}`;
  document.getElementById("priorityScore").textContent = fr(score);
  document.getElementById("gaugeValue").textContent = fr(score, 0);
  document.getElementById("gauge").style.setProperty("--score", score);
  document.getElementById("susceptibilityScore").textContent = fr(susceptibility(feature), 2);
  document.querySelector("#susceptibilityScore + small").textContent = `${p.susceptibility_label.toLowerCase()} · ${p.landcover_label.toLowerCase()}`;
  document.getElementById("iprmScore").textContent = fr(p.iprm);
  document.getElementById("icaScore").textContent = fr(p.ica);
  document.getElementById("sensitizedScore").textContent = `${fr(p.sensitized_pct)} %`;
  document.getElementById("recommendationTitle").textContent = title;
  document.getElementById("recommendationText").textContent = text;
}

function renderRanking() {
  const ranked = [...state.data.features].sort((a, b) => priority(b) - priority(a));
  document.getElementById("rankingBody").innerHTML = ranked.map((feature, index) => {
    const score = priority(feature);
    const level = priorityLevel(score);
    return `<tr data-site="${escapeHtml(feature.properties.name)}" class="${feature.properties.name === state.selected ? "selected" : ""}">
      <td>${index + 1}</td><td>${escapeHtml(feature.properties.name)}</td><td><strong>${fr(score)}</strong></td><td class="level-cell ${level.key}">${level.label}</td>
    </tr>`;
  }).join("");
  document.getElementById("rankingStamp").textContent = new Intl.DateTimeFormat("fr-FR", { hour: "2-digit", minute: "2-digit" }).format(new Date());
}

function renderDecisionSignals() {
  const features = state.data.features;
  const leastSensitized = [...features].sort((a, b) => a.properties.sensitized_pct - b.properties.sensitized_pct)[0];
  const leastAlternative = [...features].sort((a, b) => a.properties.alternative_water_pct - b.properties.alternative_water_pct)[0];
  const highest = [...features].sort((a, b) => priority(b) - priority(a))[0];
  const combined = features.filter(feature => feature.properties.susceptibility_class === 3).sort((a, b) => a.properties.ica - b.properties.ica)[0];
  document.getElementById("decisionSignals").innerHTML = `
    <article><span>Priorité la plus élevée</span><strong>${escapeHtml(highest.properties.name)}</strong><small>${fr(priority(highest))}/100</small></article>
    <article><span>Moins sensibilisée</span><strong>${escapeHtml(leastSensitized.properties.name)}</strong><small>${fr(leastSensitized.properties.sensitized_pct)} %</small></article>
    <article><span>Moins d’eau alternative</span><strong>${escapeHtml(leastAlternative.properties.name)}</strong><small>${fr(leastAlternative.properties.alternative_water_pct)} %</small></article>
    <article><span>Forte susceptibilité + faible adaptation</span><strong>${combined ? escapeHtml(combined.properties.name) : "Aucun site"}</strong><small>${combined ? `ICA ${fr(combined.properties.ica)}/100` : "—"}</small></article>`;
}
function renderUpdateLog() {
  document.getElementById("updateLog").innerHTML = state.updateLog.map(item => `
    <div class="update-row"><strong>${escapeHtml(item.dataset)}</strong><span>${escapeHtml(item.date)} · ${escapeHtml(item.responsible)}</span><small>${escapeHtml(item.action)}</small></div>`).join("");
}
function render() {
  if (!state.data || !state.selected) return;
  renderMap(); renderSelected(); renderRanking(); renderDecisionSignals();
}

function haversine(a, b) {
  const rad = value => value * Math.PI / 180;
  const R = 6371;
  const dLat = rad(b[0] - a[0]);
  const dLon = rad(b[1] - a[1]);
  const q = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[0])) * Math.cos(rad(b[0])) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.atan2(Math.sqrt(q), Math.sqrt(1 - q));
}

function latLonToUtm30(lat, lon) {
  const a = 6378137.0;
  const eccSquared = 0.00669438;
  const k0 = 0.9996;
  const latRad = lat * Math.PI / 180;
  const lonRad = lon * Math.PI / 180;
  const lonOriginRad = -3 * Math.PI / 180;
  const eccPrimeSquared = eccSquared / (1 - eccSquared);
  const N = a / Math.sqrt(1 - eccSquared * Math.sin(latRad) ** 2);
  const T = Math.tan(latRad) ** 2;
  const C = eccPrimeSquared * Math.cos(latRad) ** 2;
  const A = Math.cos(latRad) * (lonRad - lonOriginRad);
  const M = a * ((1 - eccSquared / 4 - 3 * eccSquared ** 2 / 64 - 5 * eccSquared ** 3 / 256) * latRad
    - (3 * eccSquared / 8 + 3 * eccSquared ** 2 / 32 + 45 * eccSquared ** 3 / 1024) * Math.sin(2 * latRad)
    + (15 * eccSquared ** 2 / 256 + 45 * eccSquared ** 3 / 1024) * Math.sin(4 * latRad)
    - (35 * eccSquared ** 3 / 3072) * Math.sin(6 * latRad));
  const easting = k0 * N * (A + (1 - T + C) * A ** 3 / 6 + (5 - 18 * T + T ** 2 + 72 * C - 58 * eccPrimeSquared) * A ** 5 / 120) + 500000;
  let northing = k0 * (M + N * Math.tan(latRad) * (A ** 2 / 2 + (5 - T + 9 * C + 4 * C ** 2) * A ** 4 / 24 + (61 - 58 * T + T ** 2 + 600 * C - 330 * eccPrimeSquared) * A ** 6 / 720));
  if (lat < 0) northing += 10000000;
  return [easting, northing];
}

function loadImageData(url) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
      const context = canvas.getContext("2d", { willReadFrequently: true });
      context.drawImage(image, 0, 0);
      resolve(context.getImageData(0, 0, canvas.width, canvas.height));
    };
    image.onerror = () => reject(new Error(`Impossible de charger ${url}`));
    image.src = url;
  });
}

function sampleGrid(latlng) {
  if (!state.grids) return null;
  const { meta, scoresA, scoresB, distanceA, distanceB } = state.grids;
  const [x, y] = latLonToUtm30(latlng.lat, latlng.lng);
  const [a, , c, , e, f] = meta.transform;
  const col = Math.floor((x - c) / a);
  const row = Math.floor((y - f) / e);
  if (row < 0 || col < 0 || row >= meta.height || col >= meta.width) return null;
  const index = (row * meta.width + col) * 4;
  const factors = { geology: scoresA.data[index], soil: scoresA.data[index + 1], slope: scoresA.data[index + 2], hydro: scoresB.data[index] };
  if (Object.values(factors).some(value => value < 1 || value > 5)) return null;
  const decodeDistance = value => value === meta.distance_nodata ? null : value * meta.distance_unit_m;
  return {
    utm: { x, y }, factors,
    susceptibilityClass: scoresB.data[index + 1], landcoverClass: scoresB.data[index + 2],
    distances: {
      "Végétation": decodeDistance(distanceA.data[index]), "Sol nu": decodeDistance(distanceA.data[index + 1]), "Habitat": decodeDistance(distanceA.data[index + 2]),
      "Eau": decodeDistance(distanceB.data[index]), "Culture": decodeDistance(distanceB.data[index + 1]),
    },
  };
}

function analysePoint(latlng, moveMarker = true) {
  state.lastPoint = latlng;
  const diagnostic = sampleGrid(latlng);
  const result = document.getElementById("pointResult");
  result.hidden = false;
  if (!diagnostic) {
    result.innerHTML = "<strong>Point hors emprise</strong>Aucune valeur valide n’est disponible sur la grille physique transmise.";
    return;
  }
  const nearest = state.data.features.map(feature => ({ feature, distance: haversine([latlng.lat, latlng.lng], [feature.geometry.coordinates[1], feature.geometry.coordinates[0]]) })).sort((a, b) => a.distance - b.distance);
  const nearby = nearest.filter(item => item.distance * 1000 <= state.radius);
  const score = susceptibilityFromScores(diagnostic.factors);
  if (moveMarker) {
    pointLayer.clearLayers();
    L.circleMarker(latlng, { radius: 7, color: "#17221f", weight: 2, fillColor: "#d9f99d", fillOpacity: 1 }).addTo(pointLayer);
    L.circle(latlng, { radius: state.radius, color: "#17221f", dashArray: "5 5", weight: 1.2, fillOpacity: 0.025 }).addTo(pointLayer);
  }
  const distanceRows = Object.entries(diagnostic.distances).map(([label, value]) => `<span>${label}<b>${value === null ? "hors portée" : `${fr(value, 0)} m`}</b></span>`).join("");
  result.innerHTML = `<strong>Diagnostic physique du point</strong>
    <div class="point-kpis"><span>Score multicritère<b>${fr(score, 2)} / 5</b></span><span>Classe cartographique<b>${CONFIG.susceptibility[diagnostic.susceptibilityClass] || "Non classée"}</b></span><span>Occupation au point<b>${CONFIG.landcover[diagnostic.landcoverClass] || "Non classée"}</b></span><span>Sites dans ${fr(state.radius, 0)} m<b>${nearby.length}</b></span></div>
    <div class="distance-list"><em>Distance à la classe d’occupation du sol la plus proche</em>${distanceRows}</div>
    <p>Site connu le plus proche : <b>${escapeHtml(nearest[0].feature.properties.name)}</b> à ${fr(nearest[0].distance, 2)} km.</p>
    <button id="addCandidateBtn" class="point-action">Ajouter comme site provisoire</button>
    <small>Diagnostic à 30 m, calculé à partir des quatre facteurs transmis. Il ne mesure pas une concentration de mercure.</small>`;
  document.getElementById("addCandidateBtn").addEventListener("click", () => {
    const name = window.prompt("Nom du nouveau site", `Site provisoire ${new Date().toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })}`);
    if (!name) return;
    L.marker(latlng).addTo(pointLayer).bindTooltip(`${escapeHtml(name)} · score ${fr(score, 2)}`, { permanent: true, direction: "top" }).openTooltip();
  });
}

async function loadData() {
  const [siteResponse, metaResponse, logResponse, scoresA, scoresB, distanceA, distanceB] = await Promise.all([
    fetch("data/sites_indicateurs.geojson"), fetch("data/grid_metadata.json"), fetch("data/update_log.json"),
    loadImageData("data/grid_scores_a.png"), loadImageData("data/grid_scores_b.png"), loadImageData("data/grid_distance_a.png"), loadImageData("data/grid_distance_b.png"),
  ]);
  if (!siteResponse.ok || !metaResponse.ok || !logResponse.ok) throw new Error("Échec du chargement des données locales");
  state.data = await siteResponse.json();
  const meta = await metaResponse.json();
  state.updateLog = await logResponse.json();
  state.grids = { meta, scoresA, scoresB, distanceA, distanceB };
  renderUpdateLog();

  const susceptibilityOverlay = L.imageOverlay("data/overlay_susceptibility.png", meta.wgs84_bounds, { opacity: 0.68, interactive: false }).addTo(map);
  const landcoverOverlay = L.imageOverlay("data/overlay_landcover.png", meta.wgs84_bounds, { opacity: 0.64, interactive: false });
  L.control.layers({ "Fond OpenStreetMap": streetLayer }, {
    "Susceptibilité physique": susceptibilityOverlay,
    "Occupation du sol": landcoverOverlay,
    "Rayons de proximité": buffersLayer,
  }, { collapsed: false, position: "bottomright" }).addTo(map);

  const select = document.getElementById("siteSelect");
  for (const feature of state.data.features) {
    const name = feature.properties.name;
    const sourceScores = feature.properties.factor_scores;
    state.originalScores[name] = { ...sourceScores };
    state.scores[name] = { ...sourceScores };
    select.insertAdjacentHTML("beforeend", `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`);
    const latlng = [feature.geometry.coordinates[1], feature.geometry.coordinates[0]];
    const marker = L.marker(latlng, { icon: markerIcon("medium") }).on("click", () => selectSite(name, false)).addTo(sitesLayer);
    const buffer = L.circle(latlng, { radius: state.radius, color: CONFIG.colors.medium, weight: 1.2, fillOpacity: .06 }).addTo(buffersLayer);
    state.markers.set(name, marker); state.buffers.set(name, buffer);
  }
  state.selected = state.data.features[0].properties.name;
  updateScoreControls(state.selected);
  map.fitBounds(L.geoJSON(state.data).getBounds().pad(.18));
  render();
}

function downloadRanking() {
  const rows = [["rang", "site", "classe_susceptibilite", "susceptibilite_1_5", "urgence_sociale_0_100", "indice_priorite_0_100", "occupation_au_point", "niveau"]];
  [...state.data.features].sort((a, b) => priority(b) - priority(a)).forEach((feature, index) => {
    const score = priority(feature); const p = feature.properties;
    rows.push([index + 1, p.name, p.susceptibility_label, round(susceptibility(feature), 3), round(socialUrgency(feature), 2), round(score, 2), p.landcover_label, priorityLevel(score).label]);
  });
  const csv = rows.map(row => row.map(value => `"${String(value).replaceAll('"', '""')}"`).join(";")).join("\n");
  const link = document.createElement("a");
  link.href = URL.createObjectURL(new Blob(["\ufeff" + csv], { type: "text/csv;charset=utf-8" }));
  link.download = "classement_priorite_gaoua.csv"; link.click(); URL.revokeObjectURL(link.href);
}

buildControls();
document.getElementById("siteSelect").addEventListener("change", event => selectSite(event.target.value));
document.getElementById("resetWeights").addEventListener("click", () => {
  state.weights = { ...CONFIG.weights };
  document.querySelectorAll("[data-weight]").forEach(input => { input.value = state.weights[input.dataset.weight]; });
  updateWeightLabels(); render();
});
document.getElementById("resetScores").addEventListener("click", () => {
  if (!state.selected) return;
  state.scores[state.selected] = { ...state.originalScores[state.selected] };
  updateScoreControls(state.selected); render();
});
document.getElementById("bufferToggle").addEventListener("change", event => event.target.checked ? buffersLayer.addTo(map) : map.removeLayer(buffersLayer));
document.getElementById("radiusInput").addEventListener("input", event => {
  state.radius = Number(event.target.value);
  document.getElementById("radiusValue").textContent = `${fr(state.radius, 0)} m`;
  renderMap(); if (state.lastPoint) analysePoint(state.lastPoint, false);
});
document.getElementById("filterToggle").addEventListener("change", render);
document.getElementById("fitBtn").addEventListener("click", () => map.fitBounds(L.geoJSON(state.data).getBounds().pad(.18)));
document.getElementById("analysePointBtn").addEventListener("click", event => {
  state.analysePoint = !state.analysePoint;
  event.target.classList.toggle("active", state.analysePoint);
  map.getContainer().style.cursor = state.analysePoint ? "crosshair" : "";
});
map.on("click", event => { if (state.analysePoint) analysePoint(event.latlng); });
document.getElementById("rankingBody").addEventListener("click", event => {
  const row = event.target.closest("tr[data-site]"); if (row) selectSite(row.dataset.site);
});
document.getElementById("exportBtn").addEventListener("click", downloadRanking);
document.getElementById("geojsonInput").addEventListener("change", event => {
  const file = event.target.files[0]; if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const data = JSON.parse(reader.result);
      if (state.importedLayer) map.removeLayer(state.importedLayer);
      state.importedLayer = L.geoJSON(data, {
        style: { color: "#2563eb", weight: 2, fillOpacity: .1 },
        pointToLayer: (_, latlng) => L.circleMarker(latlng, { radius: 6, color: "#2563eb", fillOpacity: .8 }),
      }).addTo(map);
      map.fitBounds(state.importedLayer.getBounds().pad(.1));
    } catch (error) { window.alert(`GeoJSON invalide : ${error.message}`); }
  };
  reader.readAsText(file);
});

loadData().catch(error => {
  document.getElementById("pointResult").hidden = false;
  document.getElementById("pointResult").textContent = `${error.message}. Lancez le dossier avec un serveur HTTP local.`;
  console.error(error);
});
/* ===== Ajout : diagnostic d'un site d'orpaillage (ne modifie aucun calcul) ===== */
state.orSite = null;

function orpaillageBlock(site) {
  const diagnostic = sampleGrid(site.latlng);
  if (!diagnostic) return "";
  const niveau = CONFIG.susceptibility[diagnostic.susceptibilityClass] || "Non classée";
  const colorKey = { 1: "low", 2: "medium", 3: "high" }[diagnostic.susceptibilityClass] || "medium";
  const score = susceptibilityFromScores(diagnostic.factors);
  const entries = Object.entries(diagnostic.distances);
  const inside = entries.filter(([, d]) => d !== null && d <= state.radius).sort((a, b) => a[1] - b[1]);
  const outside = entries.filter(([, d]) => d === null || d > state.radius).map(([label]) => label);
  const rows = inside.length
    ? inside.map(([label, d]) => `<span>${label}<b>${d === 0 ? "sur le site" : `à ${fr(d, 0)} m`}</b></span>`).join("")
    : "<span>Aucune classe dans le rayon</span>";
  return `<div class="distance-list" id="orpaillageBlock">
    <em>Site d’orpaillage : ${escapeHtml(site.name)}</em>
    <span>Niveau de vulnérabilité<b style="color:${CONFIG.colors[colorKey]}">${niveau}</b></span>
    <span>Score multicritère<b>${fr(score, 2)} / 5</b></span>
    <em>Occupation du sol présente dans ${fr(state.radius, 0)} m (zone potentiellement impactée)</em>
    ${rows}
    ${outside.length ? `<small>Hors rayon : ${outside.join(", ")}</small>` : ""}
    <small>Présence dans le rayon : ce n’est pas une preuve de contamination.</small>
  </div>`;
}

function renderOrpaillage() {
  const old = document.getElementById("orpaillageBlock");
  if (old) old.remove();
  if (!state.orSite || state.lastPoint !== state.orSite.latlng) return;
  document.getElementById("pointResult").insertAdjacentHTML("afterbegin", orpaillageBlock(state.orSite));
}

document.getElementById("orBtn").addEventListener("click", () => {
  if (!state.grids) { window.alert("Les données ne sont pas encore chargées."); return; }
  const lat = parseFloat(document.getElementById("orLat").value.replace(",", "."));
  const lng = parseFloat(document.getElementById("orLng").value.replace(",", "."));
  const name = document.getElementById("orName").value.trim() || "Site d’orpaillage";
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    window.alert("Coordonnées invalides. Utilisez des degrés décimaux, par exemple 10.285 et -3.205.");
    return;
  }
  const latlng = L.latLng(lat, lng);
  state.orSite = { latlng, name };
  analysePoint(latlng);
  L.marker(latlng).addTo(pointLayer).bindTooltip(escapeHtml(name), { permanent: true, direction: "top" }).openTooltip();
  map.setView(latlng, Math.max(map.getZoom(), 13));
  renderOrpaillage();
});

document.getElementById("radiusInput").addEventListener("input", renderOrpaillage);
document.getElementById("weightControls").addEventListener("input", renderOrpaillage);
/* ===== Ajout : export du diagnostic d'un site d'orpaillage ===== */
function exportOrpaillage() {
  if (!state.orSite) { window.alert("Diagnostiquez d’abord un site."); return; }
  const site = state.orSite;
  const d = sampleGrid(site.latlng);
  if (!d) { window.alert("Point hors emprise : rien à exporter."); return; }
  const score = susceptibilityFromScores(d.factors);
  const dist = label => d.distances[label] === null ? "hors portée" : Math.round(d.distances[label]);
  const dansRayon = Object.entries(d.distances)
    .filter(([, v]) => v !== null && v <= state.radius).map(([k]) => k).join(" | ") || "aucune";
  const header = ["nom_site", "latitude", "longitude", "date_diagnostic", "rayon_m",
    "niveau_vulnerabilite", "score_1_5", "geologie", "pedologie", "pente", "hydrographie",
    "occupation_au_point", "classes_dans_le_rayon",
    "dist_vegetation_m", "dist_sol_nu_m", "dist_habitat_m", "dist_eau_m", "dist_culture_m", "avertissement"];
  const row = [site.name, site.latlng.lat.toFixed(6), site.latlng.lng.toFixed(6),
    new Date().toLocaleString("fr-FR"), state.radius,
    CONFIG.susceptibility[d.susceptibilityClass] || "Non classée", score.toFixed(2),
    d.factors.geology, d.factors.soil, d.factors.slope, d.factors.hydro,
    CONFIG.landcover[d.landcoverClass] || "Non classée", dansRayon,
    dist("Végétation"), dist("Sol nu"), dist("Habitat"), dist("Eau"), dist("Culture"),
    "Susceptibilité physique à 30 m ; ne mesure pas une concentration de mercure"];
  const csv = [header, row].map(r => r.map(v => `"${String(v).replaceAll('"', '""')}"`).join(";")).join("\n");
  const link = document.createElement("a");
  link.href = URL.createObjectURL(new Blob(["\ufeff" + csv], { type: "text/csv;charset=utf-8" }));
  link.download = `diagnostic_${site.name.replace(/[^\w-]+/g, "_")}.csv`;
  link.click();
  URL.revokeObjectURL(link.href);
}
document.getElementById("orExportBtn").addEventListener("click", exportOrpaillage);
/* ===== Ajout : diagnostic par lot à partir d'un fichier CSV ===== */
state.lot = [];
const lotLayer = L.layerGroup().addTo(map);

function lotCoord(text) {
  const s = String(text ?? "").trim();
  const nums = (s.match(/\d+(?:[.,]\d+)?/g) || []).map(n => parseFloat(n.replace(",", ".")));
  if (!nums.length) return NaN;
  const [d, m = 0, sec = 0] = nums;
  let value = d + m / 60 + sec / 3600;
  if (s.startsWith("-") || /[SWO]\s*$/i.test(s)) value = -value;
  return value;
}

function lotLigne(nom, lat, lng) {
  const d = sampleGrid(L.latLng(lat, lng));
  if (!d) return { nom, lat, lng, horsEmprise: true };
  const dansRayon = Object.entries(d.distances).filter(([, v]) => v !== null && v <= state.radius).map(([k]) => k);
  return {
    nom, lat, lng, horsEmprise: false,
    niveau: CONFIG.susceptibility[d.susceptibilityClass] || "Non classée",
    colorKey: { 1: "low", 2: "medium", 3: "high" }[d.susceptibilityClass] || "medium",
    score: susceptibilityFromScores(d.factors),
    occupation: CONFIG.landcover[d.landcoverClass] || "Non classée",
    dansRayon: dansRayon.join(" | ") || "aucune",
  };
}

document.getElementById("lotInput").addEventListener("change", async event => {
  const box = document.getElementById("lotResult");
  const files = [...event.target.files];
  if (!files.length) return;
  if (!state.grids) { box.textContent = "Les données ne sont pas encore chargées."; return; }
  const points = [], problemes = [];
  for (const file of files) {
    if (!/\.csv$/i.test(file.name)) { problemes.push(`${file.name} : choisissez un fichier .csv`); continue; }
    const text = (await file.text()).replace(/^\ufeff/, "");
    text.split(/\r?\n/).forEach((line, i) => {
      if (!line.trim()) return;
      const parts = line.split(line.includes(";") ? ";" : ",").map(s => s.trim().replace(/^"|"$/g, ""));
      const lat = lotCoord(parts[1]), lng = lotCoord(parts[2]);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) { if (i > 0) problemes.push(`ligne ${i + 1} : coordonnées illisibles`); return; }
      points.push([parts[0] || `Point ${points.length + 1}`, lat, lng]);
    });
  }
  state.lot = points.map(p => lotLigne(...p));
  lotLayer.clearLayers();
  state.lot.filter(r => !r.horsEmprise).forEach(r => {
    L.circleMarker([r.lat, r.lng], { radius: 6, color: "#17221f", weight: 1.5, fillColor: CONFIG.colors[r.colorKey], fillOpacity: 1 })
      .bindTooltip(`${escapeHtml(r.nom)} · ${r.niveau}`).addTo(lotLayer);
  });
  const valides = state.lot.filter(r => !r.horsEmprise);
  if (valides.length) map.fitBounds(L.latLngBounds(valides.map(r => [r.lat, r.lng])).pad(.2));
  const lignes = state.lot.map(r => r.horsEmprise
    ? `<tr><td>${escapeHtml(r.nom)}</td><td colspan="2">hors emprise</td></tr>`
    : `<tr><td>${escapeHtml(r.nom)}</td><td style="color:${CONFIG.colors[r.colorKey]}"><b>${r.niveau}</b></td><td>${fr(r.score, 2)}</td></tr>`).join("");
  box.innerHTML = `<b>${state.lot.length} point(s) diagnostiqué(s)</b>
    <div style="max-height:220px;overflow:auto"><table style="width:100%;font-size:12px"><tr><th>Nom</th><th>Niveau</th><th>Score</th></tr>${lignes}</table></div>
    ${problemes.length ? `<small>${problemes.map(escapeHtml).join("<br>")}</small>` : ""}`;
  event.target.value = "";
});

document.getElementById("lotExportBtn").addEventListener("click", () => {
  if (!state.lot.length) { window.alert("Importez d’abord un fichier CSV."); return; }
  const rows = [["nom", "latitude", "longitude", "niveau_vulnerabilite", "score_1_5", "occupation_au_point", "classes_dans_le_rayon", "rayon_m"]];
  state.lot.forEach(r => rows.push(r.horsEmprise
    ? [r.nom, r.lat.toFixed(6), r.lng.toFixed(6), "hors emprise", "", "", "", state.radius]
    : [r.nom, r.lat.toFixed(6), r.lng.toFixed(6), r.niveau, r.score.toFixed(2), r.occupation, r.dansRayon, state.radius]));
  const csv = rows.map(r => r.map(v => `"${String(v).replaceAll('"', '""')}"`).join(";")).join("\n");
  const link = document.createElement("a");
  link.href = URL.createObjectURL(new Blob(["\ufeff" + csv], { type: "text/csv;charset=utf-8" }));
  link.download = "diagnostic_lot_orpaillage.csv";
  link.click();
  URL.revokeObjectURL(link.href);
});
