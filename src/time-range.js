import {endOfDay, haversineMeters, startOfDay, toLatLon} from "./utils.js";

export const FULL_DAY_TIME_RANGE = Object.freeze({startMinutes: 0, endMinutes: 24 * 60});

export function isFullDayTimeRange(range) {
    return Number(range?.startMinutes) === 0 && Number(range?.endMinutes) === 24 * 60;
}

export function parseTimeToMinutes(value) {
    if (typeof value !== "string" || !/^\d{2}:\d{2}$/.test(value)) return null;
    const [hours, minutes] = value.split(":").map(Number);
    if (!Number.isInteger(hours) || !Number.isInteger(minutes)) return null;
    if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;
    return hours * 60 + minutes;
}

export function formatMinutesAsTime(minutes) {
    const normalized = Math.min(24 * 60 - 1, Math.max(0, Number(minutes) || 0));
    const hours = Math.floor(normalized / 60);
    const mins = normalized % 60;
    return `${String(hours).padStart(2, "0")}:${String(mins).padStart(2, "0")}`;
}

export function getTimeRangeBounds(date, range) {
    if (isFullDayTimeRange(range)) {
        return {start: startOfDay(date).getTime(), end: endOfDay(date).getTime()};
    }

    const start = startOfDay(date);
    start.setMinutes(Number(range.startMinutes), 0, 0);
    const end = startOfDay(date);
    end.setMinutes(Number(range.endMinutes), 0, 0);
    return {start: start.getTime(), end: end.getTime()};
}

export function isDateInsideTimeRange(date, selectedDate, range) {
    if (isFullDayTimeRange(range)) return true;
    const timestamp = date instanceof Date ? date.getTime() : Number(date);
    const {start, end} = getTimeRangeBounds(selectedDate, range);
    return Number.isFinite(timestamp) && timestamp >= start && timestamp <= end;
}

export function filterDayDataByTimeRange(dayData, date, range) {
    if (!dayData || dayData.loading || dayData.error || !Array.isArray(dayData.tracks)) return dayData;
    if (isFullDayTimeRange(range)) return dayData;

    const bounds = getTimeRangeBounds(date, range);
    return {
        ...dayData,
        tracks: dayData.tracks.map((track) => clipTrackToRange(track, bounds.start, bounds.end)),
    };
}

export function clipTrackToRange(track, rangeStart, rangeEnd) {
    const segments = Array.isArray(track?.segments)
        ? track.segments.map((segment) => clipSegmentToRange(segment, rangeStart, rangeEnd)).filter(Boolean)
        : [];
    const points = clipPointSeries(Array.isArray(track?.points) ? track.points : [], rangeStart, rangeEnd);
    return {...track, points, segments};
}

export function clipSegmentToRange(segment, rangeStart, rangeEnd) {
    if (!segment) return null;
    const segmentStart = toTimestamp(segment.start);
    const segmentEnd = toTimestamp(segment.end);
    if (!Number.isFinite(segmentStart) || !Number.isFinite(segmentEnd)) return null;
    if (segmentEnd < rangeStart || segmentStart > rangeEnd) return null;

    const start = Math.max(segmentStart, rangeStart);
    const end = Math.min(segmentEnd, rangeEnd);
    if (end <= start) return null;

    if (segment.type === "stay") {
        return {
            ...segment,
            start: new Date(start),
            end: new Date(end),
            durationMs: Math.max(0, end - start),
        };
    }

    if (segment.type === "move") {
        const points = clipPointSeries(Array.isArray(segment.points) ? segment.points : [], start, end);
        if (points.length < 2) return null;
        return {
            ...segment,
            start: new Date(start),
            end: new Date(end),
            durationMs: Math.max(0, end - start),
            distanceM: calculateDistance(points),
            points,
        };
    }

    return null;
}

export function clipPointSeries(points, rangeStart, rangeEnd) {
    const sorted = points
        .filter(
            (point) =>
                Array.isArray(point?.point) && point.point.length >= 2 && Number.isFinite(toTimestamp(point.timestamp)),
        )
        .slice()
        .sort((a, b) => toTimestamp(a.timestamp) - toTimestamp(b.timestamp));
    if (sorted.length === 0 || rangeEnd < rangeStart) return [];

    const firstTime = toTimestamp(sorted[0].timestamp);
    const lastTime = toTimestamp(sorted[sorted.length - 1].timestamp);
    if (rangeEnd < firstTime || rangeStart > lastTime) return [];

    const start = Math.max(rangeStart, firstTime);
    const end = Math.min(rangeEnd, lastTime);
    const result = [];

    pushUniquePoint(result, pointAtTimestamp(sorted, start));
    for (const point of sorted) {
        const timestamp = toTimestamp(point.timestamp);
        if (timestamp > start && timestamp < end) {
            pushUniquePoint(result, clonePoint(point, timestamp));
        }
    }
    pushUniquePoint(result, pointAtTimestamp(sorted, end));

    return result;
}

function pointAtTimestamp(points, targetTimestamp) {
    const firstTime = toTimestamp(points[0].timestamp);
    if (targetTimestamp <= firstTime) return clonePoint(points[0], firstTime);

    const last = points[points.length - 1];
    const lastTime = toTimestamp(last.timestamp);
    if (targetTimestamp >= lastTime) return clonePoint(last, lastTime);

    for (let index = 0; index < points.length - 1; index += 1) {
        const a = points[index];
        const b = points[index + 1];
        const aTime = toTimestamp(a.timestamp);
        const bTime = toTimestamp(b.timestamp);
        if (targetTimestamp === aTime) return clonePoint(a, aTime);
        if (targetTimestamp === bTime) return clonePoint(b, bTime);
        if (targetTimestamp > aTime && targetTimestamp < bTime) {
            const ratio = (targetTimestamp - aTime) / (bTime - aTime);
            const lat = Number(a.point[0]) + (Number(b.point[0]) - Number(a.point[0])) * ratio;
            const lon = Number(a.point[1]) + (Number(b.point[1]) - Number(a.point[1])) * ratio;
            return {...a, point: [lat, lon], timestamp: new Date(targetTimestamp)};
        }
    }
    return null;
}

function clonePoint(point, timestamp) {
    return {
        ...point,
        point: [Number(point.point[0]), Number(point.point[1])],
        timestamp: new Date(timestamp),
    };
}

function pushUniquePoint(points, point) {
    if (!point) return;
    const previous = points[points.length - 1];
    if (
        previous &&
        toTimestamp(previous.timestamp) === toTimestamp(point.timestamp) &&
        previous.point[0] === point.point[0] &&
        previous.point[1] === point.point[1]
    ) {
        return;
    }
    points.push(point);
}

function calculateDistance(points) {
    let distance = 0;
    for (let index = 1; index < points.length; index += 1) {
        distance += haversineMeters(toLatLon(points[index - 1]), toLatLon(points[index]));
    }
    return distance;
}

function toTimestamp(value) {
    if (value instanceof Date) return value.getTime();
    const timestamp = Number(value);
    return Number.isFinite(timestamp) ? timestamp : new Date(value).getTime();
}
