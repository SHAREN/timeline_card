import assert from "node:assert/strict";
import test from "node:test";
import {filterTrackOutliers, normalizeTrackPoints} from "../src/track-filter.js";

const origin = {lat: 54.4832, lon: 53.4737};
const point = (seconds, northM, eastM, extra = {}) => {
    const lat = origin.lat + northM / 111320;
    const lon = origin.lon + eastM / (111320 * Math.cos((origin.lat * Math.PI) / 180));
    return {point: [lat, lon], timestamp: new Date(1785000000000 + seconds * 1000), ...extra};
};

test("removes an isolated out-and-back teleport", () => {
    const input = [point(0, 0, 0), point(6, 500, 0), point(12, 2, 3), point(18, 5, 7)];
    const result = filterTrackOutliers(input);
    assert.equal(result.length, 3);
    assert.deepEqual(
        result.map((item) => item.timestamp.getTime()),
        [input[0], input[2], input[3]].map((item) => item.timestamp.getTime()),
    );
});

test("removes a short multi-point excursion that returns to the origin", () => {
    const input = [
        point(0, 0, 0),
        point(5, 450, 0),
        point(10, 460, 10),
        point(15, 5, 4),
        point(20, 8, 8),
    ];
    const result = filterTrackOutliers(input);
    assert.deepEqual(
        result.map((item) => item.timestamp.getTime()),
        [input[0], input[3], input[4]].map((item) => item.timestamp.getTime()),
    );
});

test("preserves steady pedestrian movement", () => {
    const input = Array.from({length: 20}, (_, index) => point(index * 10, index * 14, index * 2));
    assert.equal(filterTrackOutliers(input).length, input.length);
});

test("preserves continuous vehicle movement even above pedestrian speed", () => {
    const input = Array.from({length: 10}, (_, index) => point(index * 10, 0, index * 180));
    assert.equal(filterTrackOutliers(input).length, input.length);
});

test("preserves a plausible walking out-and-back trip", () => {
    const input = [
        point(0, 0, 0),
        point(120, 100, 0),
        point(240, 200, 0),
        point(360, 100, 0),
        point(480, 0, 0),
    ];
    assert.equal(filterTrackOutliers(input).length, input.length);
});

test("sorts points and resolves duplicate timestamps toward the previous track", () => {
    const a = point(0, 0, 0);
    const bad = point(10, 500, 0);
    const good = point(10, 10, 0);
    const c = point(20, 20, 0);
    const result = normalizeTrackPoints([c, bad, a, good]);
    assert.equal(result.length, 3);
    assert.equal(result[1], good);
});

test("drops points with explicitly poor accuracy when configured", () => {
    const input = [point(0, 0, 0), point(10, 10, 0, {accuracyM: 500}), point(20, 20, 0)];
    assert.equal(filterTrackOutliers(input, {maxAccuracyM: 100}).length, 2);
});
