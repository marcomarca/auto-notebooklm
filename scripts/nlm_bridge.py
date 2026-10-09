#!/usr/bin/env python3
"""
Bridge and extension module for Gemini Notebook / NotebookLM CLI.
Adds support for deferred audio generation ("Generate later" / "Generar más tarde")
without consuming immediate compute quota limits.
"""

import argparse
import json
import os
import sys
from typing import Any, List, Optional

try:
    from notebooklm_tools.core.client import NotebookLMClient
    from notebooklm_tools.core.auth import AuthManager
    from notebooklm_tools.core import constants
    from notebooklm_tools.cli.utils import get_client
except ImportError:
    sys.stderr.write("Error: notebooklm_tools package not found. Run with uv tool run or ensure environment is configured.\n")
    sys.exit(1)


class ExtendedNotebookLMClient(NotebookLMClient):
    """Extended client supporting deferred audio generation ('Generate later')."""

    def create_audio_overview(
        self,
        notebook_id: str,
        source_ids: Optional[List[str]] = None,
        format_code: int = 1,
        length_code: int = 2,
        language: str = "es-419",
        focus_prompt: str = "",
        defer: bool = False,
    ) -> Optional[dict[str, Any]]:
        """Create an Audio Overview (podcast), with optional deferred off-peak scheduling."""
        if source_ids is None:
            source_ids = self._get_all_source_ids(notebook_id)

        if not source_ids:
            raise ValueError(f"No sources found in notebook {notebook_id}.")

        sources_nested = [[[sid]] for sid in source_ids]
        sources_simple = [[sid] for sid in source_ids]

        # Base audio options structure
        # [focus_prompt, length_code, None, sources_simple, language, None, format_code]
        audio_options_inner = [
            focus_prompt,
            length_code,
            None,
            sources_simple,
            language,
            None,
            format_code,
        ]

        # Envelope config: [2] is standard immediate execution; [3] indicates deferred off-peak queue
        header_mode = 3 if defer else 2
        custom_header = os.environ.get("NOTEBOOKLM_DEFER_HEADER")
        if defer and custom_header:
            try:
                header_mode = int(custom_header)
            except ValueError:
                pass

        audio_options = [None, audio_options_inner]

        params = [
            [header_mode],
            notebook_id,
            [None, None, self.STUDIO_TYPE_AUDIO, sources_nested, None, None, audio_options],
        ]

        result = self._call_rpc(self.RPC_CREATE_STUDIO, params, f"/notebook/{notebook_id}")

        if result and isinstance(result, list) and len(result) > 0:
            artifact_data = result[0]
            artifact_id = (
                artifact_data[0]
                if isinstance(artifact_data, list) and len(artifact_data) > 0
                else None
            )

            status = self._normalize_studio_status(artifact_data)
            if defer and status == "in_progress":
                status = "deferred"

            return {
                "artifact_id": artifact_id,
                "notebook_id": notebook_id,
                "type": "audio",
                "status": status,
                "deferred": defer,
                "format": constants.AUDIO_FORMATS.get_name(format_code),
                "length": constants.AUDIO_LENGTHS.get_name(length_code),
                "language": language,
            }

        return None


def get_extended_client(profile: Optional[str] = None) -> ExtendedNotebookLMClient:
    """Instantiate authenticated ExtendedNotebookLMClient."""
    base = get_client(profile)
    ext = ExtendedNotebookLMClient(
        cookies=base.cookies,
        csrf_token=base.csrf_token,
        session_id=base._session_id,
        build_label=base._bl,
        base_host=base._base_host,
        profile_name=base._profile_name,
        location=base._location,
        project_id=base._enterprise_project_id,
    )
    return ext


def handle_audio_create(args: argparse.Namespace) -> None:
    client = get_extended_client(args.profile)
    sources = [s.strip() for s in args.source_ids.split(",") if s.strip()] if args.source_ids else None
    
    format_code = constants.AUDIO_FORMATS.get_code(args.format) if hasattr(constants.AUDIO_FORMATS, "get_code") else constants.AUDIO_FORMATS.get(args.format, 1)
    length_code = constants.AUDIO_LENGTHS.get_code(args.length) if hasattr(constants.AUDIO_LENGTHS, "get_code") else constants.AUDIO_LENGTHS.get(args.length, 2)
    
    res = client.create_audio_overview(
        notebook_id=args.notebook_id,
        source_ids=sources,
        format_code=format_code,
        length_code=length_code,
        language=args.language or "es-419",
        focus_prompt=args.focus or "",
        defer=args.later,
    )
    
    if res is None:
        sys.stderr.write(json.dumps({"error": "Failed to create audio overview."}) + "\n")
        sys.exit(1)
        
    print(json.dumps(res, indent=2 if not args.json_compact else None))


def main():
    parser = argparse.ArgumentParser(description="NotebookLM Bridge Extension CLI")
    subparsers = parser.add_subparsers(dest="command")

    # audio create
    audio_parser = subparsers.add_parser("audio")
    audio_sub = audio_parser.add_subparsers(dest="subcommand")
    
    create_parser = audio_sub.add_parser("create")
    create_parser.add_argument("notebook_id", help="Notebook ID")
    create_parser.add_argument("-s", "--source-ids", default=None, help="Comma-separated source IDs")
    create_parser.add_argument("-f", "--format", default="deep_dive", help="Audio format")
    create_parser.add_argument("-l", "--length", default="default", help="Audio length")
    create_parser.add_argument("--language", default="es-419", help="Language code")
    create_parser.add_argument("--focus", default="", help="Focus prompt")
    create_parser.add_argument("-p", "--profile", default=os.environ.get("NLM_PROFILE", "default"), help="Profile name")
    create_parser.add_argument("--later", "--defer", action="store_true", help="Queue for deferred generation without consuming immediate quota")
    create_parser.add_argument("-y", "--confirm", action="store_true", help="Confirm execution")
    create_parser.add_argument("-j", "--json", action="store_true", help="Output as JSON")
    create_parser.add_argument("--json-compact", action="store_true", help="Compact JSON")

    args = parser.parse_args()
    if args.command == "audio" and args.subcommand == "create":
        handle_audio_create(args)
    else:
        parser.print_help()
        sys.exit(1)


if __name__ == "__main__":
    main()
