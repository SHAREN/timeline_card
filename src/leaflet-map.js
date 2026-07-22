import Leaflet from "leaflet";
import {getTrackColor} from "./utils.js";

const DEFAULT_ZOOM = 13;

export class TimelineLeafletMap {
    constructor(mapElement, homeZoneCenter = null, onViewportChange = null) {
        if (!mapElement?.isConnected) {
            throw new Error("Cannot setup Leaflet map on disconnected element");
        }

        this._Leaflet = Leaflet;
        this._mapElement = mapElement;
        this._homeZoneCenter = homeZoneCenter;
        this._onViewportChange = typeof onViewportChange === "function" ? onViewportChange : null;
        this._lastViewportSignature = null;
        this._leafletMap = Leaflet.map(mapElement, {zoomControl: true});

        const attribution =
            '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>, &copy; <a href="https://carto.com/attributions">CARTO</a>';
        const tileLayer = Leaflet.tileLayer(`https://basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png`, {
            attribution,
            subdomains: "abcd",
            minZoom: 0,
            maxZoom: 20,
            referrerPolicy: "no-referrer-when-downgrade",
        });
        tileLayer.addTo(this._leafletMap);

        if (this._homeZoneCenter) this._leafletMap.setView(this._homeZoneCenter, DEFAULT_ZOOM);

        this._mapLayers = [];
        this._fullDayPaths = [];
        this._fullDayPath = [];
        this._currentLocations = [];
        this._highlightedPath = [];
        this._highlightedStay = null;
        this._isTravelHighlightActive = false;
        this._highlightedSegmentIndex = null;

        this._resizeObserver =
            typeof ResizeObserver === "function"
                ? new ResizeObserver(() => {
                      const changed = this.refreshViewport();
                      if (changed) this._onViewportChange?.();
                  })
                : null;
        this._resizeObserver?.observe(this._mapElement);

        this.setDarkMode(false);
        requestAnimationFrame(() => {
            this.refreshViewport();
            this._onViewportChange?.();
        });
    }

    setDarkMode(isDarkMode) {
        this._mapElement?.classList.toggle("dark", Boolean(isDarkMode));
    }

    destroy() {
        this._resizeObserver?.disconnect();
        this._resizeObserver = null;
        this._leafletMap.remove();
        this._mapLayers = [];
        this._fullDayPath = [];
        this._fullDayPaths = [];
        this._currentLocations = [];
        this._highlightedPath = [];
        this._highlightedStay = null;
        this._highlightedSegmentIndex = null;
    }

    setDaySegments(
        tracks = [],
        activeEntityIndex = 0,
        onTrackClick = null,
        onSegmentClick = null,
        colors = [],
        hideUnselected = false,
    ) {
        this._fullDayPaths = tracks
            .map((track, index) => {
                const points = [];
                const segments = Array.isArray(track?.segments) ? track.segments : [];
                segments.forEach((segment) => {
                    if (segment?.type === "stay" && segment.center) {
                        points.push({
                            point: [segment.center.lat, segment.center.lon],
                            timestamp: segment.start,
                        });
                    }
                    if (segment?.type === "move" && Array.isArray(segment.points)) {
                        points.push(...segment.points);
                    }
                });

                return {
                    entityIndex: index,
                    isActive: index === activeEntityIndex,
                    points,
                    color: getTrackColor(index, colors),
                    opacity: index === activeEntityIndex ? 1 : 0.8,
                    weight: 4,
                    borderWeight: 7,
                };
            })
            .filter((path) => !hideUnselected || path.isActive);

        const activeTrackPath = this._fullDayPaths.find((path) => path.isActive);
        this._fullDayPath = activeTrackPath || {points: []};
        this._activeTrackColor = activeTrackPath?.color || "var(--primary-color)";
        this._onTrackClick = typeof onTrackClick === "function" ? onTrackClick : null;
        this._onSegmentClick = typeof onSegmentClick === "function" ? onSegmentClick : null;

        this._highlightedPath = [];
        this._highlightedStay = null;
        this._isTravelHighlightActive = false;
        this._highlightedSegmentIndex = null;

        const activeSegments = tracks[activeEntityIndex]?.segments || [];
        this._drawMapSegments(activeSegments);
    }

    highlightSegment(segment, segments, segmentIndex = null) {
        this._highlightedPath = [];
        this._highlightedStay = null;
        this._isTravelHighlightActive = false;
        this._highlightedSegmentIndex = Number.isInteger(segmentIndex) ? segmentIndex : null;

        if (segment?.type === "stay") {
            this._highlightedStay = segment;
        } else if (segment?.type === "move") {
            this._highlightedPath = [
                {
                    points: segment.points,
                    color: "var(--accent-color)",
                    weight: 7,
                    opacity: 1,
                    borderWeight: 10,
                },
            ];
            this._isTravelHighlightActive = true;
        }

        this._drawMapSegments(segments);
    }

    clearHighlight(segments) {
        if (!this._highlightedPath.length && !this._highlightedStay && !this._isTravelHighlightActive) {
            return;
        }

        this._highlightedPath = [];
        this._highlightedStay = null;
        this._isTravelHighlightActive = false;
        this._highlightedSegmentIndex = null;

        this._drawMapSegments(segments);
    }

    refreshViewport() {
        if (!this._leafletMap || !this._mapElement?.isConnected) return false;
        const signature = this._getViewportSignature();
        const changed = signature !== this._lastViewportSignature;
        this._lastViewportSignature = signature;
        this._leafletMap.invalidateSize({pan: false, debounceMoveend: true});
        return changed;
    }

    fitMap(bounds = null, options = {}) {
        if (bounds === null) {
            bounds = this._fullDayPath?.points?.map((point) => point.point) || [];
        }
        if (!bounds.length) {
            if (this._homeZoneCenter) this._leafletMap.setView(this._homeZoneCenter, DEFAULT_ZOOM);
            return;
        }
        const normalizedBounds = bounds
            .map(normalizeLatLng)
            .filter((point) => point && Number.isFinite(point.lat) && Number.isFinite(point.lng));
        if (!normalizedBounds.length) return;
        this.refreshViewport();
        const paddedBounds = this._Leaflet.latLngBounds(normalizedBounds).pad(0.1);
        const viewportPadding = this._getVisibleViewportPadding();
        this._leafletMap.fitBounds(paddedBounds, {
            maxZoom: 14,
            animate: options.animate ?? false,
            paddingTopLeft: viewportPadding.paddingTopLeft,
            paddingBottomRight: viewportPadding.paddingBottomRight,
        });
    }

    _getViewportSignature() {
        const rect = this._mapElement.getBoundingClientRect();
        const padding = this._getVisibleViewportPadding(rect);
        return [
            Math.round(rect.width),
            Math.round(rect.height),
            padding.paddingTopLeft[0],
            padding.paddingTopLeft[1],
            padding.paddingBottomRight[0],
            padding.paddingBottomRight[1],
        ].join(":");
    }

    _getVisibleViewportPadding(rect = this._mapElement.getBoundingClientRect()) {
        const viewport = window.visualViewport;
        const viewportLeft = viewport?.offsetLeft ?? 0;
        const viewportTop = viewport?.offsetTop ?? 0;
        const viewportRight = viewportLeft + (viewport?.width ?? window.innerWidth);
        const viewportBottom = viewportTop + (viewport?.height ?? window.innerHeight);
        const basePadding = 12;
        const maxHorizontal = Math.max(0, Math.floor(rect.width / 2) - 24);
        const maxVertical = Math.max(0, Math.floor(rect.height / 2) - 24);
        const clippedLeft = Math.min(maxHorizontal, Math.max(0, Math.round(viewportLeft - rect.left)));
        const clippedTop = Math.min(maxVertical, Math.max(0, Math.round(viewportTop - rect.top)));
        const clippedRight = Math.min(maxHorizontal, Math.max(0, Math.round(rect.right - viewportRight)));
        const clippedBottom = Math.min(maxVertical, Math.max(0, Math.round(rect.bottom - viewportBottom)));

        return {
            paddingTopLeft: [basePadding + clippedLeft, basePadding + clippedTop],
            paddingBottomRight: [basePadding + clippedRight, basePadding + clippedBottom],
        };
    }

    _drawMapSegments(segments) {
        this._mapLayers.forEach((layer) => layer.remove());
        this._mapLayers = [];

        this._drawMapLines();
        this._drawMapSegmentHitAreas(segments);
        this._drawMapMarkers(segments);
        this._drawCurrentLocationMarkers();
        this._mapLayers.forEach((layer) => this._leafletMap.addLayer(layer));
    }

    _drawMapMarkers(segments) {
        const stayMarkers = Array.isArray(segments)
            ? segments.map((segment, index) => ({segment, index})).filter(({segment}) => segment?.type === "stay")
            : [];

        stayMarkers.forEach(({segment: stay, index}) => {
            const iconName = stay.zoneIcon || "mdi:map-marker";
            const icon = createMarkerIcon({
                iconName: iconName,
                markerSize: 18,
                iconSize: 14,
                backgroundColor: this._activeTrackColor,
                borderColor: `color-mix(in srgb, black 30%, ${this._activeTrackColor})`,
                iconPadding: "2px",
                leafletIconSize: [22, 22],
            });
            const marker = this._Leaflet.marker(stay.center, {icon, zIndexOffset: 100});
            marker.on("click", () => this._onSegmentClick?.(index));
            this._mapLayers.push(marker);
        });

        if (!this._highlightedStay) return;

        const iconName = this._highlightedStay.zoneIcon || "mdi:map-marker";
        const icon = createMarkerIcon({
            iconName: iconName,
            markerSize: 22,
            iconSize: 22,
            backgroundColor: "var(--accent-color)",
            borderColor: "color-mix(in srgb, black 30%, var(--accent-color))",
            leafletIconSize: [26, 26],
        });
        const marker = this._Leaflet.marker(this._highlightedStay.center, {
            icon,
            zIndexOffset: 1000,
        });
        marker.on("click", () => {
            if (Number.isInteger(this._highlightedSegmentIndex)) {
                this._onSegmentClick?.(this._highlightedSegmentIndex);
            }
        });
        this._mapLayers.push(marker);
    }

    _drawMapSegmentHitAreas(segments) {
        if (!Array.isArray(segments) || !this._onSegmentClick) return;
        segments.forEach((segment, index) => {
            if (segment?.type !== "move" || !Array.isArray(segment.points) || segment.points.length < 2) return;
            const latLngs = segment.points.map((point) => point.point);
            const hitArea = this._Leaflet.polyline(latLngs, {
                color: "#000000",
                opacity: 0,
                weight: 18,
                interactive: true,
            });
            hitArea.on("click", () => this._onSegmentClick?.(index));
            this._mapLayers.push(hitArea);
        });
    }

    _drawMapLines() {
        const inactivePaths = this._fullDayPaths.filter((path) => !path.isActive);
        const activePaths = this._fullDayPaths.filter((path) => path.isActive);
        const paths = [...inactivePaths, ...activePaths, ...this._highlightedPath];

        paths.forEach((path) => {
            if (!Array.isArray(path.points) || path.points.length < 2) return;
            const latLngs = path.points.map((point) => point.point);

            if (path.isActive || path.entityIndex === undefined) {
                this._mapLayers.push(
                    this._Leaflet.polyline(latLngs, {
                        color: `color-mix(in srgb, black 30%, ${path.color})`,
                        opacity: path.opacity ?? 1,
                        weight: path.borderWeight ?? path.weight + 3,
                    }),
                );
            }

            const line = this._Leaflet.polyline(latLngs, {
                color: path.color,
                opacity: path.opacity ?? 1,
                weight: path.weight,
            });
            line.on("click", () => {
                if (!Number.isInteger(path.entityIndex) || !this._onTrackClick) return;
                this._onTrackClick(path.entityIndex);
            });
            this._mapLayers.push(line);
        });
    }

    _drawCurrentLocationMarkers() {
        let markerGroup = Leaflet.layerGroup();
        if (this._currentLocations.length === 1) {
            markerGroup.addLayer(
                this._Leaflet.marker(this._currentLocations[0].point, {
                    icon: createDefaultCurrentLocationIcon(),
                    zIndexOffset: 1000,
                }),
            );
        } else {
            this._currentLocations.forEach((location, index) => {
                if (!location?.point) return;
                const icon = createEntityIcon(location);
                const zIndexOffset = location.isActive ? 1500 : 1000;
                markerGroup.addLayer(
                    this._Leaflet.marker(location.point, {
                        icon,
                        zIndexOffset: zIndexOffset,
                    }),
                );
            });
        }
        this._mapLayers.push(markerGroup);
    }
}

function createMarkerIcon(options) {
    const haIcon = document.createElement("ha-icon");
    haIcon.setAttribute("icon", options.iconName);
    haIcon.setAttribute(
        "style",
        `color: white; --mdc-icon-size: ${options.iconSize}px; padding: ${options.iconPadding || 0}`,
    );

    const iconDiv = document.createElement("div");
    iconDiv.appendChild(haIcon);
    iconDiv.setAttribute(
        "style",
        `height: ${options.markerSize}px; width: ${options.markerSize}px; background-color: ${options.backgroundColor}; border-radius: 50%; border: 2px solid ${options.borderColor}; display: flex;`,
    );

    return Leaflet.divIcon({
        html: iconDiv,
        className: "my-leaflet-icon",
        iconSize: options.leafletIconSize,
    });
}

function createEntityIcon(location) {
    let icon;
    if (location.picture) {
        icon = document.createElement("img");
        icon.src = location.picture;
        icon.alt = location.name;
        icon.setAttribute("style", "height: 42px; width: 42px; border-radius: 50%; object-fit: cover;");
    } else {
        const getAbbreviation = (name) => {
            const words = name.split(" ");
            if (words.length === 1) {
                return words[0].charAt(0).toUpperCase() + words[0].charAt(1);
            }
            return (words[0].charAt(0) + words[1].charAt(0)).toUpperCase();
        };
        icon = document.createElement("div");
        icon.innerHTML = getAbbreviation(location.name);
        icon.setAttribute(
            "style",
            `height: 42px; width: 42px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 1.5em; font-weight: bold; color: white;`,
        );
    }
    const iconDiv = document.createElement("div");
    iconDiv.appendChild(icon);
    iconDiv.setAttribute(
        "style",
        `height: 42px; width: 42px; border-radius: 50%; border: 3px solid color-mix(in srgb, black 30%, ${location.color}); overflow: hidden; background-color: ${location.color}`,
    );

    return Leaflet.divIcon({
        html: iconDiv,
        className: "my-leaflet-icon",
        iconSize: [48, 48],
    });
}

function createDefaultCurrentLocationIcon() {
    const innerDot = document.createElement("div");
    innerDot.setAttribute(
        "style",
        "height: 14px; width: 14px; border-radius: 50%; background: #1a73e8; border: 3px solid white; box-shadow: 0 1px 6px #0006;",
    );

    const iconDiv = document.createElement("div");
    iconDiv.appendChild(innerDot);
    iconDiv.setAttribute(
        "style",
        "height: 20px; width: 20px; display: flex; align-items: center; justify-content: center;",
    );

    return Leaflet.divIcon({
        html: iconDiv,
        className: "my-leaflet-icon",
        iconSize: [20, 20],
    });
}

function normalizeLatLng(point) {
    if (Array.isArray(point) && point.length >= 2) {
        return {lat: Number(point[0]), lng: Number(point[1])};
    }
    if (!point || typeof point !== "object") return null;
    if (Number.isFinite(point.lat) && Number.isFinite(point.lng)) {
        return {lat: Number(point.lat), lng: Number(point.lng)};
    }
    if (Number.isFinite(point.lat) && Number.isFinite(point.lon)) {
        return {lat: Number(point.lat), lng: Number(point.lon)};
    }
    return null;
}
