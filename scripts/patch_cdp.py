import os
import sys

if len(sys.argv) > 1:
    target = sys.argv[1]
    if os.path.isfile(target):
        cdp_path = target
    else:
        found = None
        for root_dir, _, files in os.walk(target):
            if "cdp.py" in files and os.path.basename(root_dir) == "utils":
                found = os.path.join(root_dir, "cdp.py")
                break
        if not found:
            sys.stderr.write(f"Error: cdp.py not found in {target}\n")
            sys.exit(1)
        cdp_path = found
else:
    try:
        import notebooklm_tools.utils.cdp as cdp_mod
        cdp_path = cdp_mod.__file__
    except ImportError:
        sys.stderr.write("Error: specify path to runtime or cdp.py as argument.\n")
        sys.exit(1)

with open(cdp_path, 'r', encoding='utf-8') as f:
    content = f.read()


old_block = """def _wait_for_page_ready(ws_url: str, timeout: int = 30) -> tuple[str, bool]:
    \"\"\"Poll until NotebookLM page is fully loaded (session tokens in DOM).

    Returns (html, ready) tuple.
    \"\"\"
    start = time.time()
    while time.time() - start < timeout:
        try:
            html = get_page_html(ws_url)
            if extract_session_id(html) or extract_build_label(html):
                return html, True
        except Exception:
            pass
        time.sleep(1)
    # Timeout — return last HTML we got
    try:
        return get_page_html(ws_url), False
    except Exception:
        return \"\", False


def extract_cookies_from_page(
    cdp_http_url: str,
    wait_for_login: bool = True,
    login_timeout: int = 300,
) -> dict[str, Any]:
    page = find_or_create_notebooklm_page_by_cdp_url(cdp_http_url)
    if not page:
        raise AuthenticationError(
            message=\"Failed to open NotebookLM page\",
            hint=f\"Try manually navigating to {get_base_url()} and try again.\",
        )

    ws_url = _normalize_ws_url(page.get(\"webSocketDebuggerUrl\"))
    if not ws_url:
        raise AuthenticationError(
            message=\"No WebSocket URL for NotebookLM page\",
            hint=\"The target browser may need a restart.\",
        )

    # Navigate to NotebookLM if needed
    current_url = page.get(\"url\", \"\")
    if not _is_notebooklm_url(current_url):
        navigate_to_url(ws_url, get_notebooklm_url())

    # Check login status
    current_url = get_current_url(ws_url)

    if not is_logged_in(current_url) and wait_for_login:
        _logger.warning(\"Waiting for sign-in in browser window (timeout: %ds)...\", login_timeout)
        start_time = time.time()
        last_log_at = 0
        while time.time() - start_time < login_timeout:
            time.sleep(0.5)
            try:
                current_url = get_current_url(ws_url)
                if is_logged_in(current_url):
                    break
            except Exception:
                pass
            elapsed = int(time.time() - start_time)
            if elapsed - last_log_at >= 30:
                last_log_at = elapsed
                _logger.warning(\"Still waiting for sign-in... (%ds elapsed)\", elapsed)

        if not is_logged_in(current_url):
            raise AuthenticationError(
                message=\"Login timeout\",
                hint=\"Please log in to NotebookLM in the connected browser window.\",
            )"""

new_block = """def _wait_for_page_ready(ws_url: str, timeout: int = 30) -> tuple[str, bool]:
    \"\"\"Poll until NotebookLM page is fully loaded (session tokens in DOM).

    Returns (html, ready) tuple.
    \"\"\"
    start = time.time()
    while time.time() - start < timeout:
        try:
            html = get_page_html(ws_url)
            if extract_session_id(html) or extract_csrf_token(html) or extract_email(html):
                return html, True
        except Exception:
            pass
        time.sleep(1)
    # Timeout — return last HTML we got
    try:
        return get_page_html(ws_url), False
    except Exception:
        return \"\", False


def extract_cookies_from_page(
    cdp_http_url: str,
    wait_for_login: bool = True,
    login_timeout: int = 300,
) -> dict[str, Any]:
    page = find_or_create_notebooklm_page_by_cdp_url(cdp_http_url)
    if not page:
        raise AuthenticationError(
            message=\"Failed to open NotebookLM page\",
            hint=f\"Try manually navigating to {get_base_url()} and try again.\",
        )

    ws_url = _normalize_ws_url(page.get(\"webSocketDebuggerUrl\"))
    if not ws_url:
        raise AuthenticationError(
            message=\"No WebSocket URL for NotebookLM page\",
            hint=\"The target browser may need a restart.\",
        )

    # Navigate to NotebookLM if needed
    current_url = page.get(\"url\", \"\")
    if not _is_notebooklm_url(current_url):
        navigate_to_url(ws_url, get_notebooklm_url())

    # Check login status
    if wait_for_login:
        _logger.warning(\"Waiting for sign-in in browser window (timeout: %ds)...\", login_timeout)
        start_time = time.time()
        last_log_at = 0
        authenticated = False
        while time.time() - start_time < login_timeout:
            time.sleep(1)
            try:
                current_url = get_current_url(ws_url)
                cookies = get_page_cookies(ws_url)
                flat = {c.get(\"name\"): c.get(\"value\") for c in cookies if isinstance(c, dict)}
                has_auth_cookies = any(k in flat for k in [\"SID\", \"HSID\", \"__Secure-1PSID\", \"SSID\", \"SAPISID\"])
                if is_logged_in(current_url) and has_auth_cookies:
                    html = get_page_html(ws_url)
                    if extract_session_id(html) or extract_csrf_token(html) or extract_email(html):
                        authenticated = True
                        break
            except Exception:
                pass
            elapsed = int(time.time() - start_time)
            if elapsed - last_log_at >= 30:
                last_log_at = elapsed
                _logger.warning(\"Still waiting for sign-in... (%ds elapsed)\", elapsed)

        if not authenticated:
            raise AuthenticationError(
                message=\"Login timeout\",
                hint=\"Please log in to NotebookLM in the connected browser window.\",
            )"""

if old_block in content:
    content = content.replace(old_block, new_block, 1)
    with open(cdp_path, 'w', encoding='utf-8') as f:
        f.write(content)
    print("SUCCESS: cdp.py patched")
elif new_block in content:
    print("ALREADY_PATCHED: cdp.py already contains patch")
else:
    print("WARNING: old_block not found in cdp.py (possibly upstream code changed)")

