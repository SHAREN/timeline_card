#!/usr/bin/env python3
"""Idempotently wire the GPS outlier filter into the timeline card."""

from __future__ import annotations

import json
from pathlib import Path


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count == 0 and new in text:
        return text
    if count != 1:
        raise RuntimeError(f"{label}: expected one match, found {count}")
    return text.replace(old, new, 1)


def patch_segmentation() -> None:
    path = Path("src/segmentation.js")
    text = path.read_text(encoding="utf-8")
    text = replace_once(
        text,
        'import {resolveActivities} from "./activity.js";\n',
        'import {resolveActivities} from "./activity.js";\n'
        'import {filterTrackOutliers} from "./track-filter.js";\n',
        "segmentation import",
    )
    text = replace_once(
        text,
        "                const simplifiedPoints = simplifyHistoryPoints(rawPoints);\n"
        "                const points = filterSpeedOutliers(simplifiedPoints, config.max_reasonable_speed_kmh);\n",
        "                const cleanedPoints = filterTrackOutliers(rawPoints, {\n"
        "                    enabled: config.filter_gps_outliers !== false,\n"
        "                    minJumpDistanceM: Number(config.teleport_min_jump_m) || 120,\n"
        "                    returnRadiusM: Number(config.teleport_return_radius_m) || 80,\n"
        "                    returnWindowMs: (Number(config.teleport_return_window_s) || 180) * 1000,\n"
        "                    maxExcursionSpeedKmh: Number(config.teleport_max_excursion_speed_kmh) || 35,\n"
        "                    maxSegmentSpeedKmh: Number(config.teleport_max_segment_speed_kmh) || 120,\n"
        "                    maxAccuracyM: Number(config.max_gps_accuracy_m) || 0,\n"
        "                });\n"
        "                const simplifiedPoints = simplifyHistoryPoints(cleanedPoints);\n"
        "                const points = filterSpeedOutliers(simplifiedPoints, config.max_reasonable_speed_kmh);\n",
        "segmentation pipeline",
    )
    path.write_text(text, encoding="utf-8")


def patch_card_defaults() -> None:
    path = Path("src/card.js")
    text = path.read_text(encoding="utf-8")
    text = replace_once(
        text,
        "    max_reasonable_speed_kmh: 300,\n",
        "    max_reasonable_speed_kmh: 300,\n"
        "    filter_gps_outliers: true,\n"
        "    teleport_min_jump_m: 120,\n"
        "    teleport_return_radius_m: 80,\n"
        "    teleport_return_window_s: 180,\n"
        "    teleport_max_excursion_speed_kmh: 35,\n"
        "    teleport_max_segment_speed_kmh: 120,\n"
        "    max_gps_accuracy_m: 0,\n",
        "card defaults",
    )
    path.write_text(text, encoding="utf-8")


def patch_point_accuracy() -> None:
    path = Path("src/utils.js")
    text = path.read_text(encoding="utf-8")
    text = replace_once(
        text,
        "    return {point: [lat, lon], timestamp: new Date(state.lu * 1000)};\n",
        "    const rawAccuracy = attrs.gps_accuracy ?? attrs.accuracy;\n"
        "    const parsedAccuracy = Number(rawAccuracy);\n"
        "    return {\n"
        "        point: [lat, lon],\n"
        "        timestamp: new Date(state.lu * 1000),\n"
        "        ...(Number.isFinite(parsedAccuracy) && parsedAccuracy > 0 ? {accuracyM: parsedAccuracy} : {}),\n"
        "    };\n",
        "point accuracy",
    )
    path.write_text(text, encoding="utf-8")


def patch_package() -> None:
    path = Path("package.json")
    package = json.loads(path.read_text(encoding="utf-8"))
    package.setdefault("scripts", {})["test"] = "node --test tests/*.test.mjs"
    path.write_text(json.dumps(package, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def main() -> None:
    patch_segmentation()
    patch_card_defaults()
    patch_point_accuracy()
    patch_package()


if __name__ == "__main__":
    main()
