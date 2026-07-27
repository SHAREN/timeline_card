const BASE_ELEMENT = "location-timeline-card-2gis-v4";
const FILTERED_ELEMENT = "location-timeline-card-2gis-v5";
const EARTH_RADIUS_M = 6371000;

const DEFAULT_FILTER_OPTIONS = Object.freeze({
    enabled: true,
    minJumpDistanceM: 120,
    returnRadiusM: 80,
    returnWindowMs: 180000,
    maxExcursionSpeedKmh: 80,
    maxSegmentSpeedKmh: 120,
    maxAccuracyM: 0,
    maxPasses: 4,
});

function finiteNumber(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
}

function stateAttributes(state) {
    return state?.a ?? state?.attributes ?? {};
}

function stateTimestampMs(state) {
    const seconds = finiteNumber(state?.lu ?? state?.last_updated_ts ?? state?.last_changed_ts);
    if (seconds !== null) return seconds * 1000;
    const iso = state?.last_updated ?? state?.last_changed;
    const parsed = iso ? Date.parse(iso) : Number.NaN;
    return Number.isFinite(parsed) ? parsed : Number.NaN;
}

function stateCoordinate(state) {
    const attrs = stateAttributes(state);
    const lat = finiteNumber(attrs.latitude ?? attrs.lat);
    const lon = finiteNumber(attrs.longitude ?? attrs.lon);
    if (lat === null || lon === null) return null;
    if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
    return {lat, lon};
}

function stateAccuracyM(state) {
    const attrs = stateAttributes(state);
    const accuracy = finiteNumber(attrs.gps_accuracy ?? attrs.accuracy ?? attrs.horizontal_accuracy);
    return accuracy !== null && accuracy > 0 ? accuracy : null;
}

function haversineDistanceM(firstState, secondState) {
    const first = stateCoordinate(firstState);
    const second = stateCoordinate(secondState);
    if (!first || !second) return Number.POSITIVE_INFINITY;

    const toRad = (degrees) => (degrees * Math.PI) / 180;
    const dLat = toRad(second.lat - first.lat);
    const dLon = toRad(second.lon - first.lon);
    const lat1 = toRad(first.lat);
    const lat2 = toRad(second.lat);
    const h =
        Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
    return 2 * EARTH_RADIUS_M * Math.atan2(Math.sqrt(h), Math.sqrt(Math.max(0, 1 - h)));
}

function speedKmh(firstState, secondState) {
    const elapsedMs = stateTimestampMs(secondState) - stateTimestampMs(firstState);
    if (!(elapsedMs > 0)) return Number.POSITIVE_INFINITY;
    return (haversineDistanceM(firstState, secondState) / elapsedMs) * 3600;
}

function selectBestDuplicate(group, previous) {
    if (group.length === 1) return group[0];
    const copy = [...group];
    copy.sort((a, b) => {
        if (previous) {
            const distanceDelta = haversineDistanceM(previous, a) - haversineDistanceM(previous, b);
            if (distanceDelta !== 0) return distanceDelta;
        }
        return (stateAccuracyM(a) ?? Number.POSITIVE_INFINITY) -
            (stateAccuracyM(b) ?? Number.POSITIVE_INFINITY);
    });
    return copy[0];
}

function normalizeLocationStates(states, options) {
    const sorted = states
        .filter((state) => stateCoordinate(state) && Number.isFinite(stateTimestampMs(state)))
        .filter((state) => {
            const accuracy = stateAccuracyM(state);
            return !(options.maxAccuracyM > 0 && accuracy !== null && accuracy > options.maxAccuracyM);
        })
        .map((state, index) => ({state, index, time: stateTimestampMs(state)}))
        .sort((a, b) => a.time - b.time || a.index - b.index);

    const normalized = [];
    let index = 0;
    while (index < sorted.length) {
        const time = sorted[index].time;
        const group = [];
        while (index < sorted.length && sorted[index].time === time) {
            group.push(sorted[index].state);
            index += 1;
        }
        normalized.push(selectBestDuplicate(group, normalized[normalized.length - 1]));
    }
    return normalized;
}

function isIsolatedTriangleSpike(a, b, c, options) {
    const totalElapsed = stateTimestampMs(c) - stateTimestampMs(a);
    if (!(totalElapsed > 0 && totalElapsed <= options.returnWindowMs)) return false;

    const ab = haversineDistanceM(a, b);
    const bc = haversineDistanceM(b, c);
    const ac = haversineDistanceM(a, c);
    if (ab < options.minJumpDistanceM || bc < options.minJumpDistanceM) return false;

    const detourDistance = ab + bc;
    const excessDistance = detourDistance - ac;
    const detourRatio = detourDistance / Math.max(ac, options.returnRadiusM);
    if (excessDistance < options.minJumpDistanceM || detourRatio < 2.5) return false;

    const excursionSpeed = (detourDistance / totalElapsed) * 3600;
    const fastestSegment = Math.max(speedKmh(a, b), speedKmh(b, c));
    return excursionSpeed >= options.maxExcursionSpeedKmh ||
        fastestSegment >= options.maxSegmentSpeedKmh;
}

function removeIsolatedSpikes(states, options) {
    if (states.length < 3) return states;
    const filtered = [states[0]];
    for (let index = 1; index < states.length - 1; index += 1) {
        const previous = filtered[filtered.length - 1];
        const candidate = states[index];
        const next = states[index + 1];
        if (!isIsolatedTriangleSpike(previous, candidate, next, options)) {
            filtered.push(candidate);
        }
    }
    filtered.push(states[states.length - 1]);
    return filtered;
}

function findShortExcursionReturn(states, anchorIndex, options) {
    const anchor = states[anchorIndex];
    let maxDistance = 0;
    let pathDistance = 0;
    let fastestSegment = 0;
    let previous = anchor;

    for (let index = anchorIndex + 1; index < states.length; index += 1) {
        const elapsed = stateTimestampMs(states[index]) - stateTimestampMs(anchor);
        if (!(elapsed > 0) || elapsed > options.returnWindowMs) break;

        pathDistance += haversineDistanceM(previous, states[index]);
        fastestSegment = Math.max(fastestSegment, speedKmh(previous, states[index]));
        previous = states[index];
        const distanceFromAnchor = haversineDistanceM(anchor, states[index]);
        maxDistance = Math.max(maxDistance, distanceFromAnchor);

        if (index <= anchorIndex + 1 || distanceFromAnchor > options.returnRadiusM) continue;
        if (maxDistance < options.minJumpDistanceM) continue;

        const excursionSpeed = (pathDistance / elapsed) * 3600;
        if (excursionSpeed >= options.maxExcursionSpeedKmh ||
            fastestSegment >= options.maxSegmentSpeedKmh) {
            return index;
        }
    }
    return null;
}

function removeShortExcursions(states, options) {
    if (states.length < 4) return states;
    const filtered = [];
    let index = 0;
    while (index < states.length) {
        filtered.push(states[index]);
        const returnIndex = findShortExcursionReturn(states, index, options);
        index = returnIndex === null ? index + 1 : returnIndex;
    }
    return filtered;
}

function filterLocationStates(states, userOptions = {}) {
    if (!Array.isArray(states) || states.length < 3) return states;
    const locationCount = states.reduce((count, state) => count + (stateCoordinate(state) ? 1 : 0), 0);
    if (locationCount < 3) return states;

    const options = {...DEFAULT_FILTER_OPTIONS, ...userOptions};
    let filtered = normalizeLocationStates(states, options);
    if (!options.enabled || filtered.length < 3) return filtered;

    for (let pass = 0; pass < options.maxPasses; pass += 1) {
        const previousLength = filtered.length;
        filtered = removeIsolatedSpikes(filtered, options);
        filtered = removeShortExcursions(filtered, options);
        if (filtered.length === previousLength) break;
    }
    return filtered;
}

function filterHistoryResponse(response, message, options) {
    if (message?.type !== "history/history_during_period" || !response) return response;

    if (Array.isArray(response)) {
        if (response.length > 0 && Array.isArray(response[0])) {
            return response.map((states) => filterLocationStates(states, options));
        }
        return filterLocationStates(response, options);
    }

    if (typeof response === "object") {
        const filtered = {...response};
        for (const [entityId, states] of Object.entries(response)) {
            if (Array.isArray(states)) filtered[entityId] = filterLocationStates(states, options);
        }
        return filtered;
    }
    return response;
}

function wrapHass(hass, getOptions) {
    if (!hass || typeof hass !== "object") return hass;
    const wrapped = Object.create(hass);

    if (typeof hass.callWS === "function") {
        Object.defineProperty(wrapped, "callWS", {
            configurable: true,
            value: async (message) => filterHistoryResponse(
                await hass.callWS(message),
                message,
                getOptions(),
            ),
        });
    }

    if (hass.connection && typeof hass.connection.sendMessagePromise === "function") {
        const connection = Object.create(hass.connection);
        Object.defineProperty(connection, "sendMessagePromise", {
            configurable: true,
            value: async (message) => filterHistoryResponse(
                await hass.connection.sendMessagePromise(message),
                message,
                getOptions(),
            ),
        });
        Object.defineProperty(wrapped, "connection", {configurable: true, value: connection});
    }
    return wrapped;
}

await customElements.whenDefined(BASE_ELEMENT);
const BaseTimelineCard = customElements.get(BASE_ELEMENT);

if (!customElements.get(FILTERED_ELEMENT)) {
    class FilteredTimelineCard extends BaseTimelineCard {
        constructor() {
            super();
            this._gpsFilterOptions = {...DEFAULT_FILTER_OPTIONS};
        }

        setConfig(config) {
            this._gpsFilterOptions = {
                ...DEFAULT_FILTER_OPTIONS,
                enabled: config?.filter_gps_outliers !== false,
                minJumpDistanceM: Number(config?.teleport_min_jump_m) || DEFAULT_FILTER_OPTIONS.minJumpDistanceM,
                returnRadiusM: Number(config?.teleport_return_radius_m) || DEFAULT_FILTER_OPTIONS.returnRadiusM,
                returnWindowMs:
                    (Number(config?.teleport_return_window_s) || DEFAULT_FILTER_OPTIONS.returnWindowMs / 1000) * 1000,
                maxExcursionSpeedKmh:
                    Number(config?.teleport_max_excursion_speed_kmh) || DEFAULT_FILTER_OPTIONS.maxExcursionSpeedKmh,
                maxSegmentSpeedKmh:
                    Number(config?.teleport_max_segment_speed_kmh) || DEFAULT_FILTER_OPTIONS.maxSegmentSpeedKmh,
                maxAccuracyM: Number(config?.max_gps_accuracy_m) || DEFAULT_FILTER_OPTIONS.maxAccuracyM,
            };
            super.setConfig(config);
        }

        set hass(hass) {
            super.hass = wrapHass(hass, () => this._gpsFilterOptions);
        }
    }

    customElements.define(FILTERED_ELEMENT, FilteredTimelineCard);
    window.customCards = window.customCards || [];
    window.customCards.push({
        type: FILTERED_ELEMENT,
        name: "Location Timeline Card — GPS teleport filter v5",
        description: "Filters short GPS teleports while preserving raw Home Assistant history.",
    });
}

export {filterHistoryResponse, filterLocationStates};
