import css from "./card.css";
import leafletCss from "leaflet/dist/leaflet.css";
import {getSegmentedTracks} from "./segmentation.js";
import {
    escapeHtml,
    formatDate,
    formatErrorMessage,
    getTrackColor,
    isToday,
    normalizeEntityEntries,
    normalizeList,
    startOfDay,
    today,
} from "./utils.js";
import {TimelineLeafletMap} from "./leaflet-map.js";
import {clearPersistentCache, clearReverseGeocodingQueue} from "./reverse-geocoding.js";
import {renderTimeline} from "./timeline.js";
import {getConfigFormSchema} from "./config-flow.js";
import {localize} from "./localize/localize.js";
import {
    FULL_DAY_TIME_RANGE,
    filterDayDataByTimeRange,
    formatMinutesAsTime,
    isDateInsideTimeRange,
    isFullDayTimeRange,
    parseTimeToMinutes,
} from "./time-range.js";

const DEFAULT_CONFIG = {
    entity: [],
    places_entity: [],
    osm_api_key: null,
    stay_radius_m: 75,
    min_stay_minutes: 10,
    max_reasonable_speed_kmh: 300,
    map_appearance: "auto",
    map_height_px: 200,
    distance_unit: "metric",
    colors: [],
    hide_current_location: false,
    hide_unselected_on_map: false,
    hide_moving: false,
    reverse_timeline_order: false,
    collapse_timeline: false,
    timeline_use_entity_color: false,
    debug: false,
    activity_icon_map: {},
    update_interval: 300,
};

class TimelineCard extends HTMLElement {
    constructor() {
        super();
        this.attachShadow({mode: "open"});
        this._config = {...DEFAULT_CONFIG};
        this._cache = new Map();
        this._selectedDate = startOfDay(new Date());
        this._hass = null;
        this._rendered = false;
        this._touchStart = null;
        this._activeEntityIndex = 0;
        this._selectedSegmentIndex = null;
        this._timeRange = {...FULL_DAY_TIME_RANGE};
        this._timelineCollapsed = false;
        this._updateIntervalId = null;
        this._viewportAnimationFrame = null;
        this._viewportListenersBound = false;
        this._boundViewportChange = () => this._scheduleViewportSync();
        this._resetMapFitMode();
        this._addEventListeners();
    }

    // noinspection JSUnusedGlobalSymbols
    setConfig(config) {
        this._config = {...DEFAULT_CONFIG, ...config};
        this._checkConfig();

        this._cache.clear();
        if (this._config.debug) {
            clearPersistentCache();
        }

        this._activeEntityIndex = 0;
        this._selectedSegmentIndex = null;
        this._timeRange = {...FULL_DAY_TIME_RANGE};
        this._timelineCollapsed = Boolean(this._config.collapse_timeline);
        this._selectedDate = startOfDay(new Date());
        this._resetMapFitMode();
        this._setDarkMode();
        this._renderEntitySelector(true);
        this._applyMapHeight();
        if (this._hass) {
            this._ensureDay(this._selectedDate);
        }
        this._setupUpdateInterval();
        this._render();
    }

    // noinspection JSUnusedGlobalSymbols
    set hass(hass) {
        this._hass = hass;
        this._setDarkMode();
        this._renderEntitySelector();
        if (!this._config.entity) return;
        this._config.entity = normalizeEntityEntries(this._config, this._hass);
        const dateKey = formatDate(this._selectedDate);
        if (!this._cache.has(dateKey)) {
            this._ensureDay(this._selectedDate);
        }
        if (!this._rendered) {
            this._render();
            this._rendered = true;
        }
    }

    // noinspection JSUnusedGlobalSymbols
    static getConfigForm() {
        return getConfigFormSchema();
    }

    // noinspection JSUnusedGlobalSymbols
    getCardSize() {
        return 10;
    }

    // noinspection JSUnusedGlobalSymbols
    connectedCallback() {
        if (this._viewportListenersBound) return;
        this._viewportListenersBound = true;
        window.addEventListener("scroll", this._boundViewportChange, {capture: true, passive: true});
        window.addEventListener("resize", this._boundViewportChange, {passive: true});
        window.visualViewport?.addEventListener("resize", this._boundViewportChange, {passive: true});
        window.visualViewport?.addEventListener("scroll", this._boundViewportChange, {passive: true});
        this._scheduleViewportSync(true);
    }

    // noinspection JSUnusedGlobalSymbols
    disconnectedCallback() {
        if (this._updateIntervalId) {
            clearInterval(this._updateIntervalId);
            this._updateIntervalId = null;
        }
        if (this._viewportListenersBound) {
            window.removeEventListener("scroll", this._boundViewportChange, true);
            window.removeEventListener("resize", this._boundViewportChange);
            window.visualViewport?.removeEventListener("resize", this._boundViewportChange);
            window.visualViewport?.removeEventListener("scroll", this._boundViewportChange);
            this._viewportListenersBound = false;
        }
        if (this._viewportAnimationFrame !== null) {
            cancelAnimationFrame(this._viewportAnimationFrame);
            this._viewportAnimationFrame = null;
        }
    }

    _checkConfig() {
        this._config.entity = normalizeEntityEntries(this._config);
        this._config.places_entity = normalizeList(this._config.places_entity);
        this._config.colors = normalizeList(this._config.colors);
        if (this._config.entity.length === 0) {
            throw new Error("You need to define an entity");
        }
        if (!["metric", "imperial"].includes(this._config.distance_unit)) {
            throw new Error("distance_unit must be either 'metric' or 'imperial'");
        }
        if (!["auto", "light", "dark"].includes(this._config.map_appearance)) {
            throw new Error("map_appearance must be one of 'auto', 'light', or 'dark'");
        }
    }

    _setDarkMode() {
        let darkMode = Boolean(this._hass?.themes?.darkMode);
        if (this._config.map_appearance === "dark") {
            darkMode = true;
        } else if (this._config.map_appearance === "light") {
            darkMode = false;
        }
        this._mapView?.setDarkMode(darkMode);
    }

    _applyMapHeight() {
        const mapElement = this.shadowRoot?.getElementById("overview-map");
        if (!mapElement) return;
        mapElement.style.setProperty("height", `${this._config.map_height_px}px`, "important");
    }

    // Actions
    _shiftDate(direction) {
        clearReverseGeocodingQueue();

        const today = startOfDay(new Date());
        if (direction > 0 && this._selectedDate >= today) {
            return;
        }

        const next = new Date(this._selectedDate);
        next.setDate(next.getDate() + direction);
        this._selectedDate = startOfDay(next);
        this._selectedSegmentIndex = null;
        this._resetMapFitMode();
        this._ensureDay(this._selectedDate).then(() => this._render());
    }

    _resetMapFitMode() {
        if (isToday(this._selectedDate) && !this._config.hide_current_location) {
            this._mapFitMode = "current_location";
        } else {
            this._mapFitMode = "selected_entity_path";
        }
    }

    _refreshCurrentDay() {
        this._selectedSegmentIndex = null;
        const key = formatDate(this._selectedDate);
        this._cache.delete(key);
        this._ensureDay(this._selectedDate).then(() => this._render());
    }

    _logCacheToConsole() {
        console.log("%c[Location Timeline Debug]", "color: white; background-color: #03a9f4; font-weight: bold;");
        console.log(JSON.stringify(this._cache.get(formatDate(this._selectedDate))));
    }

    _setupUpdateInterval() {
        if (this._updateIntervalId) {
            clearInterval(this._updateIntervalId);
            this._updateIntervalId = null;
        }

        const interval = Number(this._config.update_interval);
        if (interval > 0) {
            this._updateIntervalId = setInterval(() => {
                if (isToday(this._selectedDate)) {
                    this._refreshCurrentDay();
                }
            }, interval * 1000);
        }
    }

    // Rendering
    _render() {
        if (!this.shadowRoot) return;
        this._ensureBaseLayout();

        const dateKey = formatDate(this._selectedDate);
        const rawDayData = this._cache.get(dateKey) || {
            loading: false,
            tracks: null,
            error: null,
        };
        const dayData = this._applyTimeRangeToDayData(rawDayData);

        this.shadowRoot.getElementById("timeline-date").textContent = formatDate(
            this._selectedDate,
            this._hass?.locale,
        );
        const datePicker = this.shadowRoot.getElementById("timeline-date-picker");
        datePicker.value = formatDate(this._selectedDate);
        datePicker.max = formatDate(new Date());
        this._updateTimeRangeControls();

        this.shadowRoot
            .querySelector("[data-action='next']")
            .toggleAttribute("disabled", this._selectedDate >= today());
        this._applyMapHeight();

        this._updateMapFitButton();
        this._updateCollapseButtons();

        const activeEntityColor = getTrackColor(
            this._activeEntityIndex,
            this._config?.colors,
            this._config?.entity?.[this._activeEntityIndex]?.color,
        );
        if (this._config.timeline_use_entity_color) {
            this.shadowRoot.querySelector(".card")?.style.setProperty("--timeline-color", activeEntityColor);
        }

        const activeDayData = this._getCurrentTrackDayData(dayData);
        this.shadowRoot.getElementById("timeline-body").innerHTML = this._renderTimelineContent(activeDayData);
        this._updateSelectedTimelineEntry(false);

        this._attachMapCard();
        this._rendered = true;
        requestAnimationFrame(() => this._drawMapPaths());
    }

    _ensureBaseLayout() {
        if (this._baseLayoutReady) return;
        this._baseLayoutReady = true;

        this.shadowRoot.innerHTML = `
          <style>${css}\n${leafletCss}</style>
          <ha-card>
            <div class="card">
              <div class="map-wrap">
                <div id="overview-map"></div>
                <ha-icon-button id="map-fit-mode" class="map-reset" data-action="update-map-fit-mode"><ha-icon></ha-icon></ha-icon-button>
                <ha-icon-button id="timeline-collapse-map" class="map-reset map-reset-left" data-action="toggle-timeline-collapse" hidden>
                  <ha-icon></ha-icon>
                </ha-icon-button>
              </div>
              <div class="selector-row" id="selector-row" hidden>
                <ha-icon-button id="timeline-collapse-selector" class="selector-collapse" data-action="toggle-timeline-collapse">
                  <ha-icon></ha-icon>
                </ha-icon-button>
                <div id="entity-selector" class="entity-selector"></div>
              </div>
              <div id="timeline-section" class="timeline-section">
                <div class="timeline-content">
                <div class="header my-header">
                  <div class="header-actions">
                      <ha-icon-button class="nav-button" data-action="prev" label="${localize("card.labels.previous_day")}"><ha-icon icon="mdi:chevron-left"></ha-icon></ha-icon-button>
                      ${this._config.debug ? `<ha-icon-button class="nav-button" data-action="debug" label="${localize("card.labels.debug")}"><ha-icon icon="mdi:bug"></ha-icon></ha-icon-button>` : ""}
                  </div>
                  <div class="date-wrap">
                    <button class="date-trigger" data-action="open-date-picker" type="button" aria-label="${localize("card.labels.pick_date")}">
                      <span id="timeline-date" class="date"></span>
                      <ha-icon class="date-caret" icon="mdi:menu-down"></ha-icon>
                    </button>
                    <span id="time-range-summary" class="time-range-summary"></span>
                    <input id="timeline-date-picker" class="date-picker-input" type="date">
                  </div>
                  <div class="header-actions">
                    <ha-icon-button class="nav-button" data-action="refresh" label="${localize("card.labels.refresh")}"><ha-icon icon="mdi:refresh"></ha-icon></ha-icon-button>
                    <ha-icon-button class="nav-button" data-action="next" label="${localize("card.labels.next_day")}"><ha-icon icon="mdi:chevron-right"></ha-icon></ha-icon-button>
                    <ha-icon-button id="time-range-button" class="nav-button time-range-button" data-action="open-time-range" label="${localize("card.labels.pick_time_range")}"><ha-icon icon="mdi:clock-time-four-outline"></ha-icon></ha-icon-button>
                  </div>
                </div>
                <div id="timeline-body" class="body"></div>
                </div>
              </div>
            </div>
            <dialog id="time-range-dialog" class="time-range-dialog">
              <form method="dialog" class="time-range-form">
                <div class="time-range-title">${localize("card.time_range.title")}</div>
                <div class="time-range-fields">
                  <label>
                    <span>${localize("card.time_range.from")}</span>
                    <input id="time-range-start" type="time" step="60">
                  </label>
                  <span class="time-range-separator">—</span>
                  <label>
                    <span>${localize("card.time_range.to")}</span>
                    <input id="time-range-end" type="time" step="60">
                  </label>
                </div>
                <div id="time-range-error" class="time-range-error" role="alert" hidden></div>
                <div class="time-range-actions">
                  <button type="button" class="time-range-all-day" data-action="time-range-full-day">${localize("card.time_range.all_day")}</button>
                  <button type="submit" value="cancel">${localize("card.time_range.cancel")}</button>
                  <button type="button" class="time-range-apply" data-action="apply-time-range">${localize("card.time_range.apply")}</button>
                </div>
              </form>
            </dialog>
          </ha-card>
        `;

        const body = this.shadowRoot.getElementById("timeline-body");
        this._bindTimelineTouch(body);
    }

    _openDatePicker() {
        const input = this.shadowRoot?.getElementById("timeline-date-picker");
        if (!input) return;
        if (typeof input.showPicker === "function") {
            input.showPicker();
            return;
        }
        input.focus();
        input.click();
    }

    _openTimeRangeDialog() {
        const dialog = this.shadowRoot?.getElementById("time-range-dialog");
        const startInput = this.shadowRoot?.getElementById("time-range-start");
        const endInput = this.shadowRoot?.getElementById("time-range-end");
        if (!dialog || !startInput || !endInput) return;

        startInput.value = isFullDayTimeRange(this._timeRange)
            ? "00:00"
            : formatMinutesAsTime(this._timeRange.startMinutes);
        endInput.value = isFullDayTimeRange(this._timeRange)
            ? "23:59"
            : formatMinutesAsTime(this._timeRange.endMinutes);
        this._showTimeRangeError("");

        if (typeof dialog.showModal === "function") {
            if (!dialog.open) dialog.showModal();
        } else {
            dialog.setAttribute("open", "");
        }
    }

    _closeTimeRangeDialog() {
        const dialog = this.shadowRoot?.getElementById("time-range-dialog");
        if (!dialog) return;
        if (typeof dialog.close === "function") {
            if (dialog.open) dialog.close();
        } else {
            dialog.removeAttribute("open");
        }
    }

    _applyTimeRangeDialog() {
        const startInput = this.shadowRoot?.getElementById("time-range-start");
        const endInput = this.shadowRoot?.getElementById("time-range-end");
        const startMinutes = parseTimeToMinutes(startInput?.value || "");
        const endMinutes = parseTimeToMinutes(endInput?.value || "");

        if (startMinutes === null || endMinutes === null) {
            this._showTimeRangeError(localize("card.time_range.invalid"));
            return;
        }
        if (startMinutes >= endMinutes) {
            this._showTimeRangeError(localize("card.time_range.end_after_start"));
            return;
        }

        this._setTimeRange({startMinutes, endMinutes});
        this._closeTimeRangeDialog();
    }

    _setFullDayTimeRange() {
        this._setTimeRange({...FULL_DAY_TIME_RANGE});
        this._closeTimeRangeDialog();
    }

    _setTimeRange(range) {
        this._timeRange = {
            startMinutes: Number(range.startMinutes),
            endMinutes: Number(range.endMinutes),
        };
        this._selectedSegmentIndex = null;
        this._resetMapFitMode();
        this._updateSelectedTimelineEntry(false);
        this._updateTimeRangeControls();
        this._render();
    }

    _updateTimeRangeControls() {
        const summary = this.shadowRoot?.getElementById("time-range-summary");
        const button = this.shadowRoot?.getElementById("time-range-button");
        const label = this._timeRangeLabel();
        if (summary) summary.textContent = label;
        if (button) {
            const active = !isFullDayTimeRange(this._timeRange);
            button.classList.toggle("active", active);
            button.setAttribute("label", `${localize("card.labels.pick_time_range")}: ${label}`);
        }
    }

    _timeRangeLabel() {
        if (isFullDayTimeRange(this._timeRange)) return localize("card.time_range.all_day");
        return `${formatMinutesAsTime(this._timeRange.startMinutes)}–${formatMinutesAsTime(this._timeRange.endMinutes)}`;
    }

    _showTimeRangeError(message) {
        const error = this.shadowRoot?.getElementById("time-range-error");
        if (!error) return;
        error.textContent = message;
        error.toggleAttribute("hidden", !message);
    }

    _applyTimeRangeToDayData(dayData) {
        return filterDayDataByTimeRange(dayData, this._selectedDate, this._timeRange);
    }

    _updateMapFitButton() {
        const fitToggleBtn = this.shadowRoot?.getElementById("map-fit-mode");
        if (!fitToggleBtn) return;
        const icon = fitToggleBtn.querySelector("ha-icon");

        if (this._mapFitMode === "segment") {
            fitToggleBtn.toggleAttribute("hidden", false);
            icon.setAttribute("icon", "mdi:magnify-scan");
            fitToggleBtn.setAttribute("label", "Switch to full path fit");
        } else if (isToday(this._selectedDate) && !this._config.hide_current_location) {
            fitToggleBtn.toggleAttribute("hidden", false);
            if (this._mapFitMode === "current_location") {
                icon.setAttribute("icon", "mdi:magnify-scan");
                fitToggleBtn.setAttribute("label", "Switch to full path fit");
            } else {
                icon.setAttribute("icon", "mdi:crosshairs-gps");
                fitToggleBtn.setAttribute("label", "Switch to current location fit");
            }
        } else {
            fitToggleBtn.toggleAttribute("hidden", true);
        }
    }

    _attachMapCard() {
        const container = this.shadowRoot.getElementById("overview-map");
        if (!container || this._mapView || this._isLoadingMap) return;
        if (!this.isConnected || !container.isConnected) {
            requestAnimationFrame(() => this._attachMapCard());
            return;
        }

        this._isLoadingMap = true;
        try {
            this._mapView = new TimelineLeafletMap(container, this._getHomeZoneCenter(), () =>
                this._scheduleViewportSync(true),
            );
            this._setDarkMode();
            this._drawMapPaths();
        } catch (err) {
            console.warn("Timeline card: map setup failed", err);
        } finally {
            this._isLoadingMap = false;
        }
    }

    _drawMapPaths() {
        const dayData = this._getCurrentDayData();
        if (!dayData || dayData.loading || dayData.error || !this._mapView) return;

        try {
            const tracks = Array.isArray(dayData.tracks) ? dayData.tracks : [];
            if (!this._config.hide_current_location) {
                this._mapView._currentLocations = this._getCurrentEntityLocations();
            }
            this._mapView.setDaySegments(
                tracks,
                this._activeEntityIndex,
                (entityIndex) => this._setActiveEntityIndex(entityIndex),
                (segmentIndex) => this._selectSegment(segmentIndex, {fit: true, scrollIntoView: true}),
                this._config.colors,
                this._config.hide_unselected_on_map,
            );
            this._touchStart = null;
            this._restoreSelectedSegmentHighlight();

            this._updateMapFitButton();
            this._fitMapToCurrentMode();
        } catch (err) {
            this._setCurrentDayError(err);
            this._render();
        }
    }

    _renderEntitySelector(force_rerender = false) {
        if (!this._baseLayoutReady) return;
        if (this._entitySelectorRendered && !force_rerender) return;
        this._entitySelectorRendered = true;

        const entities = this._config.entity;
        const selector = this.shadowRoot?.getElementById("entity-selector");
        const selectorRow = this.shadowRoot?.getElementById("selector-row");
        if (!selector || !selectorRow) return;
        if (entities.length < 2) {
            selectorRow.toggleAttribute("hidden", true);
            return;
        }

        selectorRow.toggleAttribute("hidden", false);
        selector.innerHTML = entities
            .map(({entity: entityId}, index) => {
                const state = this._hass?.states?.[entityId];
                const picture = state?.attributes?.entity_picture;
                const name = state?.attributes?.friendly_name || entityId;
                const escapedName = escapeHtml(name);
                const escapedPicture = escapeHtml(picture || "");
                const entityDef = this._config.entity[index];
                const trackColor = getTrackColor(index, this._config?.colors, entityDef?.color);
                return `
              <button type="button" style="--entity-track-color:${trackColor};" class="entity-chip ${index === this._activeEntityIndex ? "active" : ""}" data-action="select-entity" data-entity-index="${index}">
                ${picture ? `<img src="${escapedPicture}" alt="${escapedName}">` : '<ha-icon class="entity-avatar-icon" icon="mdi:account-circle"></ha-icon>'}
                <span>${escapedName}</span>
              </button>
            `;
            })
            .join("");
        selector.toggleAttribute("hidden", this._config.entity.length < 2);
        this._updateCollapseButtons();
    }

    _updateCollapseButtons() {
        const selectorCollapseBtn = this.shadowRoot?.getElementById("timeline-collapse-selector");
        const mapCollapseBtn = this.shadowRoot?.getElementById("timeline-collapse-map");
        const timelineSection = this.shadowRoot?.getElementById("timeline-section");
        if (!selectorCollapseBtn || !mapCollapseBtn || !timelineSection) return;

        const useSelectorButton = this._config.entity.length > 1;
        const useMapButton = this._config.entity.length < 2;
        const icon = this._timelineCollapsed ? "mdi:chevron-down" : "mdi:chevron-up";
        const label = this._timelineCollapsed ? "Expand timeline" : "Collapse timeline";

        selectorCollapseBtn.toggleAttribute("hidden", !useSelectorButton);
        mapCollapseBtn.toggleAttribute("hidden", !useMapButton);

        selectorCollapseBtn.querySelector("ha-icon")?.setAttribute("icon", icon);
        mapCollapseBtn.querySelector("ha-icon")?.setAttribute("icon", icon);
        selectorCollapseBtn.setAttribute("label", label);
        mapCollapseBtn.setAttribute("label", label);

        timelineSection.classList.toggle("collapsed", this._timelineCollapsed);
    }

    _renderTimelineContent(dayData) {
        if (dayData.loading || dayData.error) {
            const errorHtml = dayData.error ? `<div class="error">${dayData.error}</div>` : "";
            const loadingHtml = dayData.loading
                ? `<div class="loading">${localize("card.timeline.loading")}</div>`
                : "";
            return `${errorHtml}${loadingHtml}`;
        }

        try {
            const fullDay = isFullDayTimeRange(this._timeRange);
            return renderTimeline(
                dayData.segments,
                this._hass?.locale,
                this._config,
                this._selectedSegmentIndex,
                fullDay,
                !fullDay,
            );
        } catch (err) {
            const message = formatErrorMessage(err);
            console.warn("Timeline card: timeline render failed", err);
            this._setCurrentDayError(err);
            return `<div class="error">${message}</div>`;
        }
    }

    // Functions
    async _ensureDay(date) {
        const key = formatDate(date);
        const existing = this._cache.get(key);
        if (existing && (existing.tracks || existing.loading)) return;

        this._cache.set(key, {loading: true, tracks: null, error: null});

        try {
            const tracks = await getSegmentedTracks(date, this._config, this._hass, () => {
                this._render();
            });
            this._cache.set(key, {loading: false, tracks, error: null});
        } catch (err) {
            console.warn("Timeline card: history fetch failed", err);
            this._cache.set(key, {
                loading: false,
                tracks: null,
                error: formatErrorMessage(err),
            });
        }
        this._render();
        requestAnimationFrame(() => this._drawMapPaths());
    }

    _getCurrentDayData() {
        return this._applyTimeRangeToDayData(this._cache.get(formatDate(this._selectedDate)));
    }

    _getCurrentTrackDayData(dayData = this._getCurrentDayData()) {
        const tracks = Array.isArray(dayData?.tracks) ? dayData.tracks : [];
        const index = Math.min(this._activeEntityIndex, Math.max(0, tracks.length - 1));
        this._activeEntityIndex = index;
        return (
            tracks[index] || {
                segments: [],
                points: [],
                entityId: null,
                placeEntityId: null,
            }
        );
    }

    _setActiveEntityIndex(index) {
        if (
            !Number.isInteger(index) ||
            index < 0 ||
            index >= this._config.entity.length ||
            index === this._activeEntityIndex
        ) {
            return;
        }
        this._activeEntityIndex = index;
        this._selectedSegmentIndex = null;
        this._resetMapFitMode();
        this._renderEntitySelector(true);
        this._render();
    }

    _getHomeZoneCenter() {
        const state = this._hass?.states?.["zone.home"];
        const lat = Number(state?.attributes?.latitude);
        const lng = Number(state?.attributes?.longitude);
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
        return {lat, lng};
    }

    _fitMapToCurrentMode() {
        if (!this._mapView) return;
        let bounds = null;
        if (this._mapFitMode === "segment") {
            bounds = this._getSelectedSegmentBounds();
            if (!bounds.length) {
                this._selectedSegmentIndex = null;
                this._mapFitMode = "selected_entity_path";
            }
        } else if (isToday(this._selectedDate) && this._mapFitMode === "current_location") {
            bounds = this._getCurrentEntityLocations().map((point) => point.point);
        }
        this._mapView.fitMap(bounds, {animate: false});
    }

    _getSelectedSegmentBounds() {
        if (!Number.isInteger(this._selectedSegmentIndex)) return [];
        const track = this._getCurrentTrackDayData();
        const segment = track?.segments?.[this._selectedSegmentIndex];
        if (!segment) return [];
        if (segment.type === "stay" && segment.center) return [segment.center];
        if (segment.type === "move" && Array.isArray(segment.points)) {
            return segment.points.map((point) => point.point);
        }
        return [];
    }

    _updateMapFitMode() {
        if (this._mapFitMode === "segment") {
            this._selectedSegmentIndex = null;
            this._mapFitMode = "selected_entity_path";
            this._updateSelectedTimelineEntry(false);
            const track = this._getCurrentTrackDayData();
            this._mapView?.clearHighlight(Array.isArray(track?.segments) ? track.segments : []);
        } else if (this._mapFitMode === "current_location") {
            this._mapFitMode = "selected_entity_path";
        } else {
            this._resetMapFitMode();
        }
        this._updateMapFitButton();
        this._fitMapToCurrentMode();
    }

    _getCurrentEntityLocations() {
        if (!isToday(this._selectedDate)) {
            return [];
        }
        if (!isDateInsideTimeRange(new Date(), this._selectedDate, this._timeRange)) {
            return [];
        }

        return this._config.entity
            .map(({entity: entityId}, index) => {
                if (this._config.hide_unselected_on_map && index !== this._activeEntityIndex) return null;

                const state = this._hass?.states?.[entityId];
                const lat = Number(state?.attributes?.latitude);
                const lon = Number(state?.attributes?.longitude);
                if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;

                return {
                    point: [lat, lon],
                    picture: state?.attributes?.entity_picture || null,
                    name: state?.attributes?.friendly_name || entityId,
                    color: getTrackColor(index, this._config?.colors, this._config.entity[index]?.color),
                    isActive: index === this._activeEntityIndex,
                };
            })
            .filter(Boolean);
    }

    _setCurrentDayError(err) {
        const key = formatDate(this._selectedDate);
        const current = this._cache.get(key) || {
            loading: false,
            segments: null,
            points: null,
            error: null,
        };
        this._cache.set(key, {
            ...current,
            loading: false,
            error: formatErrorMessage(err),
        });
    }

    // Event listeners
    _addEventListeners() {
        this.shadowRoot.addEventListener("click", (event) => {
            const target = event.target.closest("[data-action]");
            if (!target) return;
            const action = target.dataset.action;
            if (action === "prev") {
                this._shiftDate(-1);
            } else if (action === "next") {
                this._shiftDate(1);
            } else if (action === "refresh") {
                this._refreshCurrentDay();
            } else if (action === "update-map-fit-mode") {
                this._updateMapFitMode();
            } else if (action === "debug") {
                this._logCacheToConsole();
            } else if (action === "open-date-picker") {
                this._openDatePicker();
            } else if (action === "open-time-range") {
                this._openTimeRangeDialog();
            } else if (action === "time-range-full-day") {
                this._setFullDayTimeRange();
            } else if (action === "apply-time-range") {
                this._applyTimeRangeDialog();
            } else if (action === "select-entity") {
                this._setActiveEntityIndex(Number(target.dataset.entityIndex));
            } else if (action === "toggle-timeline-collapse") {
                this._timelineCollapsed = !this._timelineCollapsed;
                this._updateCollapseButtons();
            }
        });

        this.shadowRoot.addEventListener("change", (event) => {
            const target = event.target;
            if (!(target instanceof HTMLInputElement) || target.id !== "timeline-date-picker" || !target.value) return;
            const next = new Date(`${target.value}T00:00:00`);
            if (!Number.isNaN(next.getTime())) {
                this._selectedDate = startOfDay(next);
                this._selectedSegmentIndex = null;
                this._resetMapFitMode();
                this._ensureDay(this._selectedDate).then(() => this._render());
            }
        });

        this.shadowRoot.addEventListener("mouseover", (e) =>
            this._onSegmentEvent(e, (idx) => this._handleSegmentHoverStart(idx)),
        );
        this.shadowRoot.addEventListener("mouseout", (e) =>
            this._onSegmentEvent(e, (idx) => this._clearHoverHighlight(idx)),
        );
        this.shadowRoot.addEventListener("click", (e) =>
            this._onSegmentEvent(e, (idx) => this._handleSegmentClick(idx)),
        );
    }

    _onSegmentEvent(e, callback) {
        const entry = e.target.closest("[data-segment-index]");
        if (!entry || !this.shadowRoot.contains(entry)) return;
        if (entry.contains(e.relatedTarget)) return;
        callback(Number(entry.dataset.segmentIndex));
    }

    _handleSegmentHoverStart(segmentIndex) {
        if (!Number.isInteger(segmentIndex)) return;
        const dayData = this._getCurrentDayData();
        const track = this._getCurrentTrackDayData(dayData);
        if (!track || !Array.isArray(track.segments)) return;

        const segment = track.segments[segmentIndex];
        if (!segment || !this._mapView) return;

        const segments = Array.isArray(track.segments) ? track.segments : [];
        this._touchStart = null;
        this._mapView.highlightSegment(segment, segments, segmentIndex);
    }

    _clearHoverHighlight() {
        if (!this._mapView) return;
        this._touchStart = null;
        this._restoreSelectedSegmentHighlight();
    }

    _handleSegmentClick(segmentIndex) {
        this._selectSegment(segmentIndex, {fit: true, scrollIntoView: false});
    }

    _selectSegment(segmentIndex, {fit = true, scrollIntoView = false} = {}) {
        if (!Number.isInteger(segmentIndex)) return;
        const track = this._getCurrentTrackDayData();
        const segments = Array.isArray(track?.segments) ? track.segments : [];
        const segment = segments[segmentIndex];
        if (!segment) return;

        this._selectedSegmentIndex = segmentIndex;
        this._mapFitMode = "segment";
        this._updateMapFitButton();
        this._updateSelectedTimelineEntry(scrollIntoView);
        this._mapView?.highlightSegment(segment, segments, segmentIndex);
        if (fit) this._fitMapToCurrentMode();
    }

    _updateSelectedTimelineEntry(scrollIntoView = false) {
        const entries = this.shadowRoot?.querySelectorAll(".entry[data-segment-index]") || [];
        let selectedEntry = null;
        entries.forEach((entry) => {
            const selected = Number(entry.dataset.segmentIndex) === this._selectedSegmentIndex;
            entry.classList.toggle("selected", selected);
            entry.setAttribute("aria-selected", selected ? "true" : "false");
            if (selected) selectedEntry = entry;
        });
        if (scrollIntoView && selectedEntry) {
            selectedEntry.scrollIntoView({behavior: "smooth", block: "nearest", inline: "nearest"});
        }
    }

    _restoreSelectedSegmentHighlight() {
        if (!this._mapView) return;
        const track = this._getCurrentTrackDayData();
        const segments = Array.isArray(track?.segments) ? track.segments : [];
        const segment = Number.isInteger(this._selectedSegmentIndex) ? segments[this._selectedSegmentIndex] : null;
        if (segment) {
            this._mapView.highlightSegment(segment, segments, this._selectedSegmentIndex);
        } else {
            this._mapView.clearHighlight(segments);
        }
    }

    _scheduleViewportSync(force = false) {
        if (this._viewportAnimationFrame !== null) return;
        this._viewportAnimationFrame = requestAnimationFrame(() => {
            this._viewportAnimationFrame = null;
            if (!this._mapView) return;
            const changed = this._mapView.refreshViewport();
            if (changed || force) {
                this._fitMapToCurrentMode();
            }
        });
    }

    _bindTimelineTouch(body) {
        if (!body || body.dataset.swipeBound === "true") return;
        body.dataset.swipeBound = "true";

        body.addEventListener(
            "touchstart",
            (event) => {
                const touch = event.changedTouches?.[0];
                if (!touch) return;
                this._touchStart = {x: touch.clientX, y: touch.clientY};
            },
            {passive: true},
        );

        body.addEventListener(
            "touchend",
            (event) => {
                const touch = event.changedTouches?.[0];
                if (!touch || !this._touchStart) return;

                const deltaX = touch.clientX - this._touchStart.x;
                const deltaY = touch.clientY - this._touchStart.y;
                this._touchStart = null;

                if (Math.abs(deltaX) < 60 || Math.abs(deltaX) < Math.abs(deltaY)) {
                    return;
                }

                this._shiftDate(deltaX > 0 ? -1 : 1);
            },
            {passive: true},
        );
    }
}

customElements.define("location-timeline-card-2gis", TimelineCard);

window.customCards = window.customCards || [];
window.customCards.push({
    type: "location-timeline-card-2gis",
    name: "Location Timeline Card — 2GIS patch",
    description: localize("card.description"),
});
