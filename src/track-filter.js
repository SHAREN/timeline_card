const EARTH_RADIUS_M = 6371000;

export const DEFAULT_TRACK_FILTER_OPTIONS = Object.freeze({
    enabled: true,
    minJumpDistanceM: 120,
    returnRadiusM: 80,
    returnWindowMs: 180000,
    maxExcursionSpeedKmh: 35,
    maxSegmentSpeedKmh: 120,
    maxAccuracyM: 0,
    maxPasses: 4,
});

function timestampMs(point) {
    const value = point?.timestamp;
    const ms = value instanceof Date ? value.getTime() : Number(value);
    return Number.isFinite(ms) ? ms : Number.NaN;
}

function latLon(point) {
    const lat = Number(point?.point?.[0]);
    const lon = Number(point?.point?.[1]);
    return Number.isFinite(lat) && Number.isFinite(lon) ? {lat, lon} : null;
}

function accuracyM(point) {
    const value = Number(point?.accuracyM ?? point?.accuracy ?? point?.gpsAccuracy);
    return Number.isFinite(value) && value > 0 ? value : null;
}

export function haversineDistanceM(a, b) {
    const first = latLon(a);
    const second = latLon(b);
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

export function speedKmh(a, b) {
    const elapsedMs = timestampMs(b) - timestampMs(a);
    if (!(elapsedMs > 0)) return Number.POSITIVE_INFINITY;
    return (haversineDistanceM(a, b) / elapsedMs) * 3600;
}

export function normalizeTrackPoints(points, {maxAccuracyM = 0} = {}) {
    if (!Array.isArray(points)) return [];
    const sorted = points
        .filter((point) => latLon(point) && Number.isFinite(timestampMs(point)))
        .filter((point) => {
            const accuracy = accuracyM(point);
            return !(maxAccuracyM > 0 && accuracy !== null && accuracy > maxAccuracyM);
        })
        .map((point, index) => ({point, index, time: timestampMs(point)}))
        .sort((a, b) => a.time - b.time || a.index - b.index);

    const normalized = [];
    let index = 0;
    while (index < sorted.length) {
        const time = sorted[index].time;
        const group = [];
        while (index < sorted.length && sorted[index].time === time) {
            group.push(sorted[index].point);
            index += 1;
        }
        if (group.length === 1 || normalized.length === 0) {
            normalized.push(selectBestAccuracy(group));
            continue;
        }
        const previous = normalized[normalized.length - 1];
        group.sort((a, b) => {
            const distanceDelta = haversineDistanceM(previous, a) - haversineDistanceM(previous, b);
            if (distanceDelta !== 0) return distanceDelta;
            return (accuracyM(a) ?? Number.POSITIVE_INFINITY) - (accuracyM(b) ?? Number.POSITIVE_INFINITY);
        });
        normalized.push(group[0]);
    }
    return normalized;
}

function selectBestAccuracy(points) {
    return [...points].sort(
        (a, b) => (accuracyM(a) ?? Number.POSITIVE_INFINITY) - (accuracyM(b) ?? Number.POSITIVE_INFINITY),
    )[0];
}

function isIsolatedTriangleSpike(a, b, c, options) {
    const totalElapsed = timestampMs(c) - timestampMs(a);
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
    const fastSegment = Math.max(speedKmh(a, b), speedKmh(b, c));
    return excursionSpeed >= options.maxExcursionSpeedKmh || fastSegment >= options.maxSegmentSpeedKmh;
}

function removeIsolatedSpikes(points, options) {
    if (points.length < 3) return points;
    const filtered = [points[0]];
    for (let index = 1; index < points.length - 1; index += 1) {
        const previous = filtered[filtered.length - 1];
        const candidate = points[index];
        const next = points[index + 1];
        if (!isIsolatedTriangleSpike(previous, candidate, next, options)) {
            filtered.push(candidate);
        }
    }
    filtered.push(points[points.length - 1]);
    return filtered;
}

function findShortExcursionReturn(points, anchorIndex, options) {
    const anchor = points[anchorIndex];
    let maxDistance = 0;
    let pathDistance = 0;
    let previous = anchor;

    for (let index = anchorIndex + 1; index < points.length; index += 1) {
        const elapsed = timestampMs(points[index]) - timestampMs(anchor);
        if (!(elapsed > 0) || elapsed > options.returnWindowMs) break;

        pathDistance += haversineDistanceM(previous, points[index]);
        previous = points[index];
        const distanceFromAnchor = haversineDistanceM(anchor, points[index]);
        maxDistance = Math.max(maxDistance, distanceFromAnchor);

        if (index <= anchorIndex + 1 || distanceFromAnchor > options.returnRadiusM) continue;
        if (maxDistance < options.minJumpDistanceM) continue;

        const excursionSpeed = (pathDistance / elapsed) * 3600;
        if (excursionSpeed >= options.maxExcursionSpeedKmh) return index;
    }
    return null;
}

function removeShortExcursions(points, options) {
    if (points.length < 4) return points;
    const filtered = [];
    let index = 0;
    while (index < points.length) {
        filtered.push(points[index]);
        const returnIndex = findShortExcursionReturn(points, index, options);
        index = returnIndex === null ? index + 1 : returnIndex;
    }
    return filtered;
}

export function filterTrackOutliers(points, options = {}) {
    const merged = {...DEFAULT_TRACK_FILTER_OPTIONS, ...options};
    const normalized = normalizeTrackPoints(points, merged);
    if (!merged.enabled || normalized.length < 3) return normalized;

    let filtered = normalized;
    for (let pass = 0; pass < merged.maxPasses; pass += 1) {
        const previousLength = filtered.length;
        filtered = removeIsolatedSpikes(filtered, merged);
        filtered = removeShortExcursions(filtered, merged);
        if (filtered.length === previousLength) break;
    }
    return filtered;
}
