"""Состояние синхронизации: какие треки уже перенесены или не найдены.

Хранится в JSON, чтобы повторные запуски обрабатывали только новые лайки.
"""
from __future__ import annotations

import json
import os
from datetime import datetime, timezone

MATCHED = "matched"
NOT_FOUND = "not_found"


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


class SyncState:
    def __init__(self, path: str):
        self.path = path
        self.data: dict[str, dict[str, dict]] = {}
        if os.path.exists(path):
            with open(path, encoding="utf-8") as f:
                self.data = json.load(f).get("directions", {})

    @staticmethod
    def direction(source: str, target: str) -> str:
        return f"{source}->{target}"

    def entries(self, source: str, target: str) -> dict[str, dict]:
        return self.data.setdefault(self.direction(source, target), {})

    def get(self, source: str, target: str, track_id: str) -> dict | None:
        return self.entries(source, target).get(track_id)

    def mark_matched(self, source: str, target: str, source_id: str,
                     target_id: str, title: str) -> None:
        stamp = _now()
        self.entries(source, target)[source_id] = {
            "status": MATCHED, "target_id": target_id, "title": title, "at": stamp,
        }
        # Запоминаем пару и для обратного направления, чтобы при переносе
        # обратно этот трек не искался заново.
        self.entries(target, source).setdefault(target_id, {
            "status": MATCHED, "target_id": source_id, "title": title, "at": stamp,
        })

    def mark_not_found(self, source: str, target: str, source_id: str, title: str) -> None:
        self.entries(source, target)[source_id] = {
            "status": NOT_FOUND, "title": title, "at": _now(),
        }

    def not_found(self, source: str, target: str) -> list[dict]:
        return [
            {"id": key, **value}
            for key, value in self.entries(source, target).items()
            if value["status"] == NOT_FOUND
        ]

    def save(self) -> None:
        os.makedirs(os.path.dirname(os.path.abspath(self.path)), exist_ok=True)
        tmp = self.path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump({"version": 1, "directions": self.data}, f, ensure_ascii=False, indent=2)
        os.replace(tmp, self.path)
