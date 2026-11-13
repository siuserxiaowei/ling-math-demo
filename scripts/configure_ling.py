#!/usr/bin/env python3
"""Interactively create a local Ling API configuration.

The API key is deliberately not accepted as an argument or environment
variable.  Configuration files are written atomically with private file
permissions so a failed write cannot leave a partial JSON document behind.
"""

from __future__ import annotations

import argparse
import getpass
import json
import os
import stat
import sys
import tempfile
from typing import List, Optional, Sequence
from urllib.parse import urlsplit


DEFAULT_BASE_URL = "https://api.ant-ling.com/v1"
DEFAULT_CONFIG = "~/.config/ling-math-demo/ling.json"
MODEL = "Ling-3.2-flash"


class ConfigError(Exception):
    """An expected, user-facing configuration error."""


class _SafeArgumentParser(argparse.ArgumentParser):
    """Keep unexpected command-line values out of diagnostics."""

    def error(self, message: str) -> None:
        # argparse includes unknown argument values in ``message``.  A user
        # who accidentally supplies a plaintext key must not have that value
        # echoed back to the terminal.
        self.print_usage(sys.stderr)
        self.exit(2, f"{self.prog}: error: invalid command-line arguments.\n")


def _build_parser() -> argparse.ArgumentParser:
    parser = _SafeArgumentParser(
        description="Create or replace a local Ling API configuration.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    parser.add_argument(
        "--config",
        default=DEFAULT_CONFIG,
        help="configuration file path",
    )
    parser.add_argument(
        "--base-url",
        default=DEFAULT_BASE_URL,
        help="Ling API base URL (HTTPS is required)",
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="replace an existing regular configuration file",
    )
    return parser


def _validate_base_url(base_url: str) -> str:
    if not isinstance(base_url, str) or not base_url:
        raise ConfigError("--base-url must be an HTTPS URL.")

    try:
        parsed = urlsplit(base_url)
        hostname = parsed.hostname
        parsed.port  # Force validation of a supplied port.
    except ValueError:
        raise ConfigError("--base-url must be an HTTPS URL.") from None

    if parsed.scheme.lower() != "https" or not parsed.netloc or not hostname:
        raise ConfigError("--base-url must be an HTTPS URL.")
    if any(character.isspace() for character in base_url):
        raise ConfigError("--base-url must be an HTTPS URL.")
    if parsed.username is not None or parsed.password is not None:
        raise ConfigError("--base-url must not contain credentials.")
    if parsed.query or parsed.fragment:
        raise ConfigError("--base-url must not contain a query or fragment.")
    return base_url


def _skill_root() -> str:
    script_path = os.path.realpath(os.path.abspath(__file__))
    return os.path.realpath(os.path.dirname(os.path.dirname(script_path)))


def _path_is_within(path: str, directory: str) -> bool:
    try:
        return os.path.commonpath([path, directory]) == directory
    except ValueError:
        return False


def _resolve_config_path(config_value: str) -> str:
    if not isinstance(config_value, str) or not config_value.strip():
        raise ConfigError("--config must name a file path.")

    expanded = os.path.expanduser(config_value)
    path = os.path.abspath(expanded)
    # Resolve existing symlink components for the package-boundary check.  The
    # path used for the actual write remains the user-provided path, allowing
    # a target-level symlink to be detected and refused with lstat below.
    real_path = os.path.realpath(path)
    if _path_is_within(real_path, _skill_root()):
        raise ConfigError("configuration cannot be written inside the Skill package.")
    return path


def _inspect_target(path: str) -> Optional[str]:
    """Return ``None`` for absent, or the target kind for an existing path."""
    try:
        target_stat = os.lstat(path)
    except FileNotFoundError:
        return None
    except OSError as exc:
        raise ConfigError("cannot inspect the configuration path.") from exc

    mode = target_stat.st_mode
    if stat.S_ISLNK(mode):
        return "symlink"
    if stat.S_ISREG(mode):
        return "regular"
    return "non-regular"


def _check_target_for_write(path: str, force: bool) -> None:
    kind = _inspect_target(path)
    if kind is None:
        return
    if kind == "regular" and force:
        return
    if kind == "regular":
        raise ConfigError("configuration already exists; use --force to replace it.")
    if kind == "symlink":
        raise ConfigError("refusing to write through a configuration symlink.")
    raise ConfigError("refusing to replace a non-regular configuration path.")


def _ensure_parent_directory(path: str) -> List[str]:
    """Create missing parent components at mode 0700 and return those made."""
    parent = os.path.dirname(path)
    missing: List[str] = []
    current = parent

    while True:
        try:
            current_stat = os.lstat(current)
        except FileNotFoundError:
            missing.append(current)
            upper = os.path.dirname(current)
            if upper == current:
                raise ConfigError("cannot determine the configuration directory.")
            current = upper
            continue
        except OSError as exc:
            raise ConfigError("cannot inspect the configuration directory.") from exc

        if stat.S_ISDIR(current_stat.st_mode):
            break
        # A pre-existing symlink to a directory is not changed; the package
        # boundary was checked using realpath before this function is called.
        if stat.S_ISLNK(current_stat.st_mode) and os.path.isdir(current):
            break
        raise ConfigError("configuration parent is not a directory.")

    created: List[str] = []
    try:
        for directory in reversed(missing):
            try:
                os.mkdir(directory, 0o700)
            except FileExistsError:
                try:
                    directory_stat = os.lstat(directory)
                except OSError as exc:
                    raise ConfigError("cannot inspect the configuration directory.") from exc
                if stat.S_ISDIR(directory_stat.st_mode):
                    continue
                if stat.S_ISLNK(directory_stat.st_mode) and os.path.isdir(directory):
                    continue
                raise ConfigError("configuration parent is not a directory.")
            except OSError as exc:
                raise ConfigError("cannot create the configuration directory.") from exc

            # Track a directory as soon as mkdir succeeds so a later chmod
            # failure can remove this invocation's empty directory.
            created.append(directory)
            try:
                # chmod is only applied to directories this invocation created.
                os.chmod(directory, 0o700)
            except OSError as exc:
                raise ConfigError("cannot secure the configuration directory.") from exc
    except ConfigError:
        _cleanup_created_directories(created)
        raise

    return created


def _cleanup_created_directories(created: Sequence[str]) -> None:
    for directory in reversed(created):
        try:
            os.rmdir(directory)
        except OSError:
            # Do not remove a directory that another process populated while
            # this command was running.
            pass


def _sync_directory(directory: str) -> None:
    """Best-effort directory sync after an atomic rename."""
    try:
        directory_fd = os.open(directory, os.O_RDONLY)
    except OSError:
        return
    try:
        try:
            os.fsync(directory_fd)
        except OSError:
            pass
    finally:
        os.close(directory_fd)


def _require_interactive_terminal() -> None:
    try:
        interactive = bool(sys.stdin.isatty())
    except (AttributeError, OSError):
        interactive = False
    if not interactive:
        raise ConfigError(
            "API key input requires a local terminal; run this command in your own terminal."
        )


def _atomic_write(path: str, payload: dict, force: bool, created_dirs: Sequence[str]) -> None:
    parent = os.path.dirname(path)
    temporary_path: Optional[str] = None
    file_descriptor: Optional[int] = None
    committed = False

    try:
        file_descriptor, temporary_path = tempfile.mkstemp(
            prefix=".ling.json.",
            dir=parent,
            text=True,
        )
        try:
            os.fchmod(file_descriptor, 0o600)
        except AttributeError:
            os.chmod(temporary_path, 0o600)

        file_handle = os.fdopen(
            file_descriptor,
            "w",
            encoding="utf-8",
            newline="\n",
        )
        file_descriptor = None
        with file_handle:
            json.dump(payload, file_handle, ensure_ascii=False, indent=2)
            file_handle.write("\n")
            file_handle.flush()
            os.fsync(file_handle.fileno())

        # Re-check immediately before the atomic commit.  Neither commit path
        # follows a target symlink, and refusing a changed target makes the
        # intended no-symlink guarantee explicit as well.
        _check_target_for_write(path, force)
        if force:
            os.replace(temporary_path, path)
            temporary_path = None
            committed = True
        else:
            # A hard link creates the destination only when it is absent.  It
            # closes the check-then-replace race for the non-force path while
            # retaining the same-directory atomicity of the temporary file.
            os.link(temporary_path, path)
            committed = True
            os.unlink(temporary_path)
            temporary_path = None
        _sync_directory(parent)
    except ConfigError:
        raise
    except Exception as exc:
        raise ConfigError("could not write the configuration file.") from exc
    finally:
        if file_descriptor is not None:
            try:
                os.close(file_descriptor)
            except OSError:
                pass
        if temporary_path is not None:
            try:
                os.unlink(temporary_path)
            except OSError:
                pass
        if not committed:
            _cleanup_created_directories(created_dirs)


def configure(config_value: str, base_url: str, force: bool) -> str:
    """Prompt for a key and write the requested configuration.

    The returned string is the absolute path written.  The API key is never
    returned, logged, or included in any error text.
    """
    validated_base_url = _validate_base_url(base_url)
    config_path = _resolve_config_path(config_value)
    _check_target_for_write(config_path, force)

    _require_interactive_terminal()
    try:
        api_key = getpass.getpass("Ling API key: ")
    except KeyboardInterrupt:
        raise
    except Exception as exc:
        raise ConfigError("could not read the API key.") from exc

    if not isinstance(api_key, str) or not api_key.strip():
        raise ConfigError("API key cannot be empty.")
    if any(character in api_key for character in ("\r", "\n", "\x00")):
        raise ConfigError("API key cannot contain control characters.")

    payload = {
        "api_key": api_key,
        "base_url": validated_base_url,
        "model": MODEL,
    }

    created_dirs = _ensure_parent_directory(config_path)
    _atomic_write(config_path, payload, force, created_dirs)
    return config_path


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = _build_parser()
    args = parser.parse_args(argv)
    try:
        config_path = configure(args.config, args.base_url, args.force)
    except KeyboardInterrupt:
        print("cancelled", file=sys.stderr)
        return 130
    except ConfigError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1

    print(f"Ling configuration saved to {config_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
