from __future__ import annotations

import argparse
import logging
import os
import sys
import time

from .matching import MATCH_THRESHOLD
from .services import SERVICES, create_service
from .state import SyncState
from .sync import sync_likes

log = logging.getLogger("crossfade")


def _data_dir() -> str:
    return os.environ.get("CROSSFADE_DATA_DIR") or os.path.join(
        os.path.expanduser("~"), ".config", "crossfade"
    )


def _load_dotenv() -> None:
    try:
        from dotenv import load_dotenv
    except ImportError:
        return
    load_dotenv()


def cmd_auth(args: argparse.Namespace) -> int:
    service = create_service(args.service, args.data_dir)
    print(f"{args.service}: вход выполнен как {service.whoami()}")
    return 0


def _run_sync(args: argparse.Namespace) -> None:
    source = create_service(args.source, args.data_dir)
    target = create_service(args.target, args.data_dir)
    state = SyncState(args.state or os.path.join(args.data_dir, "state.json"))
    report = sync_likes(
        source, target, state,
        dry_run=args.dry_run,
        retry_missing=args.retry_missing,
        limit=args.limit,
        threshold=args.threshold,
    )
    if args.dry_run:
        print("Пробный запуск: лайки не ставились, состояние не сохранялось.")
        for original, match in report.liked:
            print(f"  + {original.display()}  =>  {match.display()}")
    for track in report.not_found:
        print(f"  ? не найдено: {track.display()}")
    print(report.summary())


def cmd_sync(args: argparse.Namespace) -> int:
    if args.source == args.target:
        print("Источник и цель должны различаться.", file=sys.stderr)
        return 2
    if not args.watch:
        _run_sync(args)
        return 0

    log.info("Режим наблюдения: синхронизация каждые %d мин. Ctrl+C для выхода.", args.watch)
    while True:
        try:
            _run_sync(args)
        except KeyboardInterrupt:
            raise
        except Exception:
            log.exception("Синхронизация не удалась, повторю в следующий раз")
        time.sleep(args.watch * 60)


def cmd_missing(args: argparse.Namespace) -> int:
    state = SyncState(args.state or os.path.join(args.data_dir, "state.json"))
    missing = state.not_found(args.source, args.target)
    for entry in missing:
        print(f"{entry['id']}\t{entry['title']}")
    print(f"Не найдено треков: {len(missing)}", file=sys.stderr)
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="crossfade",
        description="Перенос лайкнутых треков между стриминговыми сервисами.",
    )
    parser.add_argument("--data-dir", default=_data_dir(),
                        help="папка для токенов и состояния (по умолчанию ~/.config/crossfade)")
    parser.add_argument("--state", help="путь к файлу состояния (по умолчанию <data-dir>/state.json)")
    parser.add_argument("-v", "--verbose", action="store_true", help="подробный лог")
    sub = parser.add_subparsers(dest="command", required=True)

    auth = sub.add_parser("auth", help="проверить вход в сервис (для Spotify — первичная авторизация)")
    auth.add_argument("service", choices=SERVICES)
    auth.set_defaults(func=cmd_auth)

    sync = sub.add_parser("sync", help="перенести лайки из SOURCE в TARGET")
    sync.add_argument("source", choices=SERVICES)
    sync.add_argument("target", choices=SERVICES)
    sync.add_argument("--dry-run", action="store_true",
                      help="только показать, что будет перенесено")
    sync.add_argument("--retry-missing", action="store_true",
                      help="заново искать треки, которые раньше не нашлись")
    sync.add_argument("--limit", type=int, help="обработать не больше N новых треков")
    sync.add_argument("--threshold", type=float, default=MATCH_THRESHOLD,
                      help=f"порог похожести 0..1 (по умолчанию {MATCH_THRESHOLD})")
    sync.add_argument("--watch", type=int, metavar="MINUTES",
                      help="повторять синхронизацию каждые MINUTES минут")
    sync.set_defaults(func=cmd_sync)

    missing = sub.add_parser("missing", help="список треков, которые не удалось найти")
    missing.add_argument("source", choices=SERVICES)
    missing.add_argument("target", choices=SERVICES)
    missing.set_defaults(func=cmd_missing)
    return parser


def main(argv: list[str] | None = None) -> int:
    _load_dotenv()
    args = build_parser().parse_args(argv)
    logging.basicConfig(
        level=logging.INFO if args.verbose or getattr(args, "watch", None) else logging.WARNING,
        format="%(asctime)s %(levelname)s %(message)s",
    )
    try:
        return args.func(args)
    except KeyboardInterrupt:
        return 130
    except RuntimeError as exc:
        print(f"Ошибка: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
